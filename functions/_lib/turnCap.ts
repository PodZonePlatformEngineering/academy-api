// PROJ-011/T-158 — the operator's 2026-08-03 rate-limiting decision (T-161):
// a flat 50 turns per calendar month per subscription, deliberately generous
// (encourage testers to test, not protect margin — tiered/usage-based limits
// are parked until real usage data exists). `MONTHLY_TURN_CAP` is the single
// place a future tiered model changes this number.
//
// Count source is `ai_gateway_usage` (039_subscription_feature_gate.sql) —
// the synchronous row this route's own chat handler writes per turn
// (t157-inference-delivery-design.md §3). No new table or tracking
// mechanism: the row this feature already writes is the count source.
import type { PoolClient } from '@neondatabase/serverless'

export const MONTHLY_TURN_CAP = 50

/** Turns already used this calendar month for `traineeId` — the exact count
 * `assertUnderTurnCap` gates on. Plain admin-connection query, same posture
 * as `resolveActiveSubscriptionId`: no per-trainee GUC session needed since
 * `traineeId` is already a resolved, verified numeric id. */
export async function countMonthlyTurns(client: PoolClient, traineeId: number): Promise<number> {
  const result = await client.query(
    `SELECT count(*)::int AS count FROM ai_gateway_usage
      WHERE trainee_id = $1 AND created_at >= date_trunc('month', now())`,
    [traineeId],
  )
  return Number(result.rows[0]?.count ?? 0)
}

/**
 * PROJ-011/ACP-222 — turns already used against a redeemed `access_token`.
 * Unlike `countMonthlyTurns`, not scoped to the calendar month: a token's
 * `turn_quota` is a fixed lifetime budget (academy-admin migration 064),
 * not a recurring one, so every row against `accessTokenId` counts.
 */
export async function countTokenTurns(client: PoolClient, accessTokenId: number): Promise<number> {
  const result = await client.query(
    `SELECT count(*)::int AS count FROM ai_gateway_usage WHERE access_token_id = $1`,
    [accessTokenId],
  )
  return Number(result.rows[0]?.count ?? 0)
}
