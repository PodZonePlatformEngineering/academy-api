// Curriculum/track entitlement: verbatim port of
// academy-web/functions/_lib/entitlement.ts (PROJ-011/T-141), which is
// itself a TS port of academy-admin/assessment/entitlement.py (T-136). See
// that module's docstring for why: academy.entitled_curriculum_ids()/
// entitled_track_ids() are SECURITY DEFINER functions keyed on
// academy.current_trainee_id(), resolved from the request.jwt.claims
// session GUC — the same contract the Neon Data API installs for a
// trainee's own RLS session. There is no PostgREST session here (this talks
// to Postgres directly), so this drives the same functions itself:
// set_config the GUC, SET LOCAL ROLE authenticated (exercising the real
// grant path, not owner-privilege bypass), then read the results.
import type { PoolClient } from '@neondatabase/serverless'

export class NotEntitled extends Error {}

export async function isEntitled(
  client: PoolClient,
  traineeSub: string,
  curriculumSlug: string,
  tracks: string[] | null | undefined,
): Promise<boolean> {
  if (!traineeSub) return false
  await client.query('BEGIN')
  try {
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: traineeSub }),
    ])
    await client.query('SET LOCAL ROLE authenticated')
    const byCurriculum = await client.query(
      `SELECT 1 FROM academy.entitled_curriculum_ids() eci
       JOIN curriculum c ON c.id = eci.curriculum_id
       WHERE c.slug = $1`,
      [curriculumSlug],
    )
    if (byCurriculum.rows.length > 0) {
      await client.query('COMMIT')
      return true
    }
    if (tracks && tracks.length > 0) {
      const byTrack = await client.query(
        `SELECT 1 FROM academy.entitled_track_ids() WHERE track = ANY($1)`,
        [tracks],
      )
      if (byTrack.rows.length > 0) {
        await client.query('COMMIT')
        return true
      }
    }
    await client.query('COMMIT')
    return false
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  }
}

export async function assertEntitled(
  client: PoolClient,
  traineeSub: string,
  curriculumSlug: string,
  tracks: string[] | null | undefined,
): Promise<void> {
  if (!(await isEntitled(client, traineeSub, curriculumSlug, tracks))) {
    throw new NotEntitled(
      `trainee is not entitled to curriculum ${curriculumSlug}` +
        (tracks && tracks.length ? ` or tracks ${JSON.stringify(tracks)}` : ''),
    )
  }
}

// --- Feature-level entitlement (PROJ-011/T-150, T-151) ----------------------
//
// TS equivalent of academy.is_feature_entitled/assert_feature_entitled
// (academy-admin/migrations/039_subscription_feature_gate.sql, live in
// red-sunset-16158933 — see t150-entitlement-schema-decision.md for the
// full design). Mirrors isEntitled/assertEntitled's shape exactly (same
// withClient caller pattern, same set_config + SET LOCAL ROLE GUC dance)
// because the underlying functions share that same SECURITY DEFINER +
// current_trainee_id() contract — the only difference is which Postgres
// function gets called and what it's keyed on (an ACTIVE `subscription`
// row, not entitled_curriculum_ids()/entitled_track_ids()).
//
// This is what any gated endpoint in this repo (and eventually
// academy-frontend, Phase 2) calls — assessment/gamification/inference/
// cohort_community/bookmarks/personal_library, per §6.2 of
// academy-api-three-tier-design-refresh.md. The PayPal webhook route itself
// (functions/api/paypal/webhook.ts) does NOT call this: a webhook delivery
// carries no trainee JWT to resolve current_trainee_id() from, and the
// webhook's job is to *write* subscription state, not check it.
export type Feature =
  | 'assessment'
  | 'gamification'
  | 'inference'
  | 'cohort_community'
  | 'bookmarks'
  | 'personal_library'

export async function isFeatureEntitled(
  client: PoolClient,
  traineeSub: string,
  feature: Feature,
): Promise<boolean> {
  if (!traineeSub) return false
  await client.query('BEGIN')
  try {
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: traineeSub }),
    ])
    await client.query('SET LOCAL ROLE authenticated')
    const result = await client.query('SELECT academy.is_feature_entitled($1) AS entitled', [feature])
    await client.query('COMMIT')
    return result.rows[0]?.entitled === true
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  }
}

export async function assertFeatureEntitled(
  client: PoolClient,
  traineeSub: string,
  feature: Feature,
): Promise<void> {
  if (!(await isFeatureEntitled(client, traineeSub, feature))) {
    throw new NotEntitled(`trainee is not entitled to feature ${feature}`)
  }
}

/**
 * Resolve the trainee's currently-ACTIVE `subscription.id`, or `null` if
 * none (shouldn't happen once `assertFeatureEntitled` has already passed,
 * since `is_feature_entitled` requires an ACTIVE row itself, but this is a
 * separate query so it's typed as optional rather than assumed). Runs on
 * the plain admin connection, not the GUC-scoped `authenticated` role —
 * `subscription` grants SELECT to `authenticated` too, but there's no
 * per-trainee session to establish here since `traineeId` is already
 * numeric; the admin role reads it directly (same pattern webhook.ts/
 * subscription.ts already use for `subscription` writes).
 */
export async function resolveActiveSubscriptionId(
  client: PoolClient,
  traineeId: number,
): Promise<number | null> {
  const result = await client.query(
    `SELECT id FROM subscription WHERE trainee_id = $1 AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1`,
    [traineeId],
  )
  return result.rows[0]?.id ?? null
}

/**
 * Synchronous half of the `ai_gateway_usage` write (t157-inference-delivery-
 * design.md §3): everything the Gateway's Anthropic-schema response carries
 * directly (`model`, token counts) is inserted immediately off the back of
 * the same request that already opened this connection. `cost` and
 * `gateway_log_id` are left NULL — they aren't in the inference response at
 * all (Anthropic's own API doesn't return dollar cost), only in the
 * Gateway's separate logs/analytics endpoint; backfilling them is T-158's
 * task-3 follow-on, out of scope here.
 */
export async function insertUsageRow(
  client: PoolClient,
  traineeId: number,
  subscriptionId: number | null,
  usage: { model: string | null; inputTokens: number; outputTokens: number; cacheReadTokens: number },
): Promise<void> {
  await client.query(
    `INSERT INTO ai_gateway_usage (trainee_id, subscription_id, provider, model, tokens_in, tokens_out, cached_tokens_in)
     VALUES ($1, $2, 'anthropic', $3, $4, $5, $6)`,
    [traineeId, subscriptionId, usage.model, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens],
  )
}

export class UnknownTraineeError extends Error {}

/**
 * Resolve the verified JWT `sub` (a Stack/Neon-Auth uuid) to this trainee's
 * numeric `trainee.id` — the same id `subscription.trainee_id` (039) and
 * PayPal's `custom_id` (T-152) are keyed on. Reuses
 * `academy.current_trainee_id()` (`SELECT id FROM trainee WHERE
 * neon_auth_user_id = auth.user_id()`, SECURITY DEFINER) via the identical
 * GUC dance as isEntitled/isFeatureEntitled, rather than querying `trainee`
 * directly — one resolution path for "JWT sub -> trainee_id", not two.
 */
export async function resolveTraineeId(client: PoolClient, traineeSub: string): Promise<number> {
  await client.query('BEGIN')
  try {
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: traineeSub }),
    ])
    await client.query('SET LOCAL ROLE authenticated')
    const result = await client.query('SELECT academy.current_trainee_id() AS trainee_id')
    const traineeId = result.rows[0]?.trainee_id
    if (traineeId === null || traineeId === undefined) {
      throw new UnknownTraineeError(`no trainee row for sub ${traineeSub}`)
    }
    await client.query('COMMIT')
    return Number(traineeId)
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  }
}
