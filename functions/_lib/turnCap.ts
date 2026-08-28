// PROJ-011/T-158, trimmed by PROJ-011/ACP-448 — this file used to also own
// the flat 50-turns-per-calendar-month subscription cap
// (`countMonthlyTurns`/`resolveMonthlyTurnCap`/`DEFAULT_MONTHLY_TURN_CAP`),
// counted live from `ai_gateway_usage` via `date_trunc('month', now())`
// windowing. That mechanism is gone — replaced by `_lib/quota.ts`'s
// persistent, non-expiring `trainee_quota_balance` (accrue-forever, not
// reset-monthly, per the operator's 2026-08-28 decisions).
//
// What's left here — `countTokenTurns` — is untouched by that redesign: a
// redeemed `access_token.turn_quota` (academy-admin migration 064) is a
// separate, fixed lifetime budget, never merged with the subscription-
// accrued quota balance (brief §5). It stays counted the same way it always
// was, off the same `ai_gateway_usage` rows the subscription path used to
// share the table with.
import type { PoolClient } from '@neondatabase/serverless'

/**
 * PROJ-011/ACP-222 — turns already used against a redeemed `access_token`.
 * Not scoped to the calendar month: a token's `turn_quota` is a fixed
 * lifetime budget (academy-admin migration 064), not a recurring one, so
 * every row against `accessTokenId` counts.
 */
export async function countTokenTurns(client: PoolClient, accessTokenId: number): Promise<number> {
  const result = await client.query(
    `SELECT count(*)::int AS count FROM ai_gateway_usage WHERE access_token_id = $1`,
    [accessTokenId],
  )
  return Number(result.rows[0]?.count ?? 0)
}
