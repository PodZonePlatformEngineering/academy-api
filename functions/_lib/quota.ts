// PROJ-011/ACP-448 — the persistent, non-expiring subscription-accrued
// quota balance (academy-admin migration 078 / vibecreations-db 006,
// `trainee_quota_balance`), replacing turnCap.ts's `countMonthlyTurns`
// calendar-month windowing entirely.
//
// Keyed by trainee, not subscription — a cancelled-but-not-depleted
// subscription keeps its balance and keeps granting `inference`/
// `examination` (see the migration's own `is_feature_entitled` change,
// decision 1). Credited on each PAYMENT.SALE.COMPLETED webhook delivery
// (webhook.ts), decremented by 1 per spent turn (tutor/chat.ts,
// examiner/chat.ts) — never merged with `access_token.turn_quota`
// (turnCap.ts's `countTokenTurns`), which stays a completely separate pool.
import type { PoolClient } from '@neondatabase/serverless'

// PROJ-011/ACP-409's QA-reachability override concept carries over: unset
// (production) means the real grant, 50, matching what
// DEFAULT_MONTHLY_TURN_CAP always paid out per month before this brief.
// QA sets QUOTA_GRANT_AMOUNT low (e.g. 2) so a single sandbox payment
// credits a balance an e2e run can actually exhaust.
export const DEFAULT_QUOTA_GRANT_AMOUNT = 50

export function resolveQuotaGrantAmount(env: { QUOTA_GRANT_AMOUNT?: string }): number {
  const override = env.QUOTA_GRANT_AMOUNT ? Number.parseInt(env.QUOTA_GRANT_AMOUNT, 10) : NaN
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_QUOTA_GRANT_AMOUNT
}

/** Current balance for `traineeId`, or 0 if the trainee has never had a
 * payment credited (no row yet — not an error, just "nothing accrued"). */
export async function getQuotaBalance(client: PoolClient, traineeId: number): Promise<number> {
  const result = await client.query<{ balance: number }>(
    `SELECT balance FROM trainee_quota_balance WHERE trainee_id = $1`,
    [traineeId],
  )
  return result.rows[0]?.balance ?? 0
}

/** Credits `amount` onto `traineeId`'s balance — an UPSERT, never a reset,
 * so this is safe to call for a trainee with no existing row (their first
 * payment) or an existing one (accrual, decision 2: it never resets). */
export async function creditQuota(client: PoolClient, traineeId: number, amount: number): Promise<void> {
  await client.query(
    `INSERT INTO trainee_quota_balance (trainee_id, balance)
     VALUES ($1, $2)
     ON CONFLICT (trainee_id) DO UPDATE SET
       balance = trainee_quota_balance.balance + EXCLUDED.balance,
       updated_at = now()`,
    [traineeId, amount],
  )
}

/** Spends one turn off `traineeId`'s balance. Guarded at the SQL level
 * (`WHERE balance > 0`) against a race between the pre-flight
 * `getQuotaBalance` check in chat.ts and this write landing after the
 * Gateway call completes — the same class of concurrent-request race
 * `recordCaptureId`'s idempotent UPDATE already tolerates for webhook
 * deliveries. A zero-row result here (already exhausted by a concurrent
 * request) is not surfaced as an error: the Gateway call has already
 * happened by this point, and there is nothing left to decrement past
 * zero — `balance >= 0`'s CHECK constraint (078) would reject it anyway. */
export async function decrementQuota(client: PoolClient, traineeId: number): Promise<void> {
  await client.query(
    `UPDATE trainee_quota_balance SET balance = balance - 1, updated_at = now()
     WHERE trainee_id = $1 AND balance > 0`,
    [traineeId],
  )
}
