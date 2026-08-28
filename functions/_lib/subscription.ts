// PROJ-011/T-151 — subscription upsert logic, the write side of T-150's
// `subscription` table (academy-admin/migrations/039_subscription_feature_gate.sql,
// live in red-sunset-16158933). Field extraction (extractSubscriptionFields)
// is a pure function, deliberately separated from the DB write
// (upsertSubscription), so parsing can be unit-tested against PayPal's
// documented resource shape without a live Postgres connection or PayPal
// credentials (brief §5) — test/subscription.test.ts exercises it against
// test/fixtures/*.json.
import type { PoolClient } from '@neondatabase/serverless'
import type { WebhookEvent } from './paypal'

export class UnattributedSubscriptionError extends Error {}

export interface SubscriptionFields {
  paypalSubscriptionId: string
  paypalPlanId: string | null
  status: string
  currentPeriodEnd: string | null
  /** PayPal's own `custom_id` field on the subscription resource — the
   * merchant-supplied identifier set when the subscription is created via
   * POST /v1/billing/subscriptions (openapi/billing_subscriptions_v1.json:
   * "The custom id for the subscription. Can be invoice id."). Set to the
   * resolved `trainee_id` by this repo's own
   * `functions/api/paypal/subscriptions.ts` (PROJ-011/T-152) — the gap
   * T-151's README flagged ("nothing in this repo sets custom_id yet") is
   * closed. */
  customId: string | null
}

/** Pull the fields `subscription` needs out of a webhook event's resource.
 * Pure — no network, no DB — so fixtures can exercise it directly. */
export function extractSubscriptionFields(event: WebhookEvent): SubscriptionFields {
  const r = event.resource
  return {
    paypalSubscriptionId: r.id,
    paypalPlanId: r.plan_id ?? null,
    status: r.status ?? '',
    currentPeriodEnd: r.billing_info?.next_billing_time ?? null,
    customId: r.custom_id ?? null,
  }
}

/**
 * Upsert one `subscription` row keyed on `paypal_subscription_id`.
 *
 * PayPal delivers webhooks at-least-once (its own documented guarantee),
 * so this must be idempotent, not a plain INSERT — the same delivery can
 * arrive twice and must produce the same end state both times.
 *
 * Two paths, chosen by whether this event carries a usable `custom_id`
 * (see SubscriptionFields.customId):
 *
 *   - customId present -> INSERT ... ON CONFLICT (paypal_subscription_id)
 *     DO UPDATE. Single atomic statement, no race between concurrent
 *     deliveries for the same subscription id (Cloudflare Pages Functions
 *     invocations run concurrently; a duplicate delivery mid-processing is
 *     a real scenario, not a hypothetical). custom_id is expected to be
 *     present on every event for a given subscription (it's a property of
 *     the subscription resource itself, not one specific event type), so
 *     this is now the common path — `subscriptions.ts` (T-152) sets
 *     custom_id at creation time.
 *   - customId absent -> UPDATE-only, matched on paypal_subscription_id.
 *     If it affects zero rows, there is no way to attribute a brand-new
 *     subscription to a trainee — throws UnattributedSubscriptionError
 *     rather than silently dropping the write. The caller (webhook.ts)
 *     still acks PayPal with 200 rather than returning a retryable
 *     status — **resolved, not left open, as of T-152** (brief §4): now
 *     that every subscription this repo creates always carries custom_id
 *     from its very first webhook event onward, a real subscription
 *     hitting this branch would mean either (a) a canned Webhook
 *     Simulator test delivery (a fake resource id that will never
 *     correspond to a real row or a real custom_id, however many times
 *     PayPal retried it — retrying doesn't fix a payload PayPal is
 *     replaying verbatim) or (b) a genuine data anomaly needing a human to
 *     triage, which PayPal auto-retrying also can't fix. Since neither
 *     realistic trigger benefits from a retry, 200-ack-and-log stays the
 *     safer default rather than switching to 404/5xx and risking a
 *     multi-hour retry storm against Simulator test traffic for no
 *     corresponding upside.
 */
export async function upsertSubscription(client: PoolClient, fields: SubscriptionFields): Promise<void> {
  let traineeId: number | null = null
  if (fields.customId) {
    const parsed = Number(fields.customId)
    if (Number.isInteger(parsed)) traineeId = parsed
  }

  if (traineeId !== null) {
    await client.query(
      `INSERT INTO subscription
         (trainee_id, paypal_subscription_id, paypal_plan_id, status, current_period_end)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (paypal_subscription_id) DO UPDATE SET
         paypal_plan_id = EXCLUDED.paypal_plan_id,
         status = EXCLUDED.status,
         current_period_end = EXCLUDED.current_period_end,
         cancelled_at = CASE WHEN EXCLUDED.status = 'CANCELLED' THEN now()
                              ELSE subscription.cancelled_at END,
         updated_at = now()`,
      [traineeId, fields.paypalSubscriptionId, fields.paypalPlanId, fields.status, fields.currentPeriodEnd],
    )
    return
  }

  const result = await client.query(
    `UPDATE subscription SET
       paypal_plan_id = $2,
       status = $3,
       current_period_end = $4,
       cancelled_at = CASE WHEN $3 = 'CANCELLED' THEN now() ELSE cancelled_at END,
       updated_at = now()
     WHERE paypal_subscription_id = $1`,
    [fields.paypalSubscriptionId, fields.paypalPlanId, fields.status, fields.currentPeriodEnd],
  )
  if (result.rowCount === 0) {
    throw new UnattributedSubscriptionError(
      `no existing subscription row for ${fields.paypalSubscriptionId} and no custom_id ` +
        'present on this event to attribute a new one to a trainee',
    )
  }
}

/**
 * ACP-441 — records the sale/capture id from a PAYMENT.SALE.COMPLETED
 * event's resource.id against the subscription it billed
 * (resource.billing_agreement_id). Separate from upsertSubscription (whose
 * ON CONFLICT insert path this deliberately does NOT reuse): a payment
 * event can only ever update an existing row — a sale can't be the first
 * event PayPal ever delivers for a subscription (BILLING.SUBSCRIPTION.
 * ACTIVATED precedes it in PayPal's own lifecycle), so there is no
 * "attribute a brand-new row to a trainee" branch to mirror here. If no row
 * matches (e.g. a stale Simulator test delivery, same class of harmless
 * mismatch upsertSubscription's UnattributedSubscriptionError already
 * tolerates), this silently no-ops rather than throwing — there is no
 * refund target to record either way, and PayPal's at-least-once redelivery
 * of a payload that will never match a real row gains nothing from an
 * error the caller would just ack past regardless (see webhook.ts's own
 * UnattributedSubscriptionError handling for the same reasoning).
 */
export async function recordCaptureId(
  client: PoolClient,
  paypalSubscriptionId: string,
  captureId: string,
): Promise<void> {
  await client.query(
    `UPDATE subscription SET last_capture_id = $1, updated_at = now()
     WHERE paypal_subscription_id = $2`,
    [captureId, paypalSubscriptionId],
  )
}

/**
 * ACP-445 — ownership check for the self-service cancel endpoint. Reads
 * this repo's own `subscription` row (the webhook-maintained mirror, not a
 * live PayPal call) with a plain `trainee_id = $2` predicate rather than
 * the RLS/GUC dance `entitlement.ts` uses elsewhere: `withClient`'s pool
 * already runs as the owner role, and a cancel endpoint's own query is a
 * simpler, more auditable place to assert "this row belongs to this
 * trainee" than round-tripping through `academy.current_trainee_id()` for
 * a single-table lookup. Returns null if there is no row at all, or the
 * row belongs to a different trainee — both cases the caller must treat
 * identically (a clean 404, never leaking which case it was).
 */
export async function findOwnedSubscription(
  client: PoolClient,
  traineeId: number,
  paypalSubscriptionId: string,
): Promise<{ status: string } | null> {
  const result = await client.query<{ status: string }>(
    'SELECT status FROM subscription WHERE paypal_subscription_id = $1 AND trainee_id = $2',
    [paypalSubscriptionId, traineeId],
  )
  return result.rows[0] ?? null
}
