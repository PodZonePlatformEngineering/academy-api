// ACP-441 — drives academy-admin migration 077's admin_prepare_subscription_
// refund/admin_record_subscription_refund RPCs over this repo's existing
// direct NEON_DATABASE_URL connection, the same set_config('request.jwt.
// claims', ...) + SET LOCAL ROLE authenticated dance _lib/entitlement.ts's
// isEntitled/isFeatureEntitled already established for exercising a
// SECURITY DEFINER RPC outside a real PostgREST session (no Data API
// dependency needed here — see 077's own header for why this shape, not a
// Data API round trip, was chosen). Setting request.jwt.claims to the
// caller's own verified JWT sub (not a service identity) is what makes
// require_admin() gate correctly AND makes 046's audit trigger attribute
// the write to the real admin, not 'system'.
import type { PoolClient } from '@neondatabase/serverless'

export class AdminAuthError extends Error {}
export class AdminRequestError extends Error {}
export class SubscriptionNotFoundError extends Error {}

interface PgError extends Error {
  code?: string
}

async function runAdminRpc<T>(
  client: PoolClient,
  adminSub: string,
  sql: string,
  params: unknown[],
): Promise<T> {
  await client.query('BEGIN')
  try {
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: adminSub }),
    ])
    await client.query('SET LOCAL ROLE authenticated')
    const result = await client.query(sql, params)
    await client.query('COMMIT')
    return result.rows[0] as T
  } catch (e) {
    await client.query('ROLLBACK')
    const code = (e as PgError).code
    // errcodes as raised by academy-admin migration 077 — require_admin()
    // itself raises 28000 (no JWT sub, shouldn't happen here since a JWT
    // already verified) / 42501 (verified caller isn't an admin_account
    // row); the RPCs raise P0002 for "no such subscription" and 22023 for
    // every other validation failure (already refunded, no capture id on
    // record, missing refund id).
    if (code === '28000' || code === '42501') {
      throw new AdminAuthError((e as Error).message)
    }
    if (code === 'P0002') {
      throw new SubscriptionNotFoundError((e as Error).message)
    }
    if (code === '22023') {
      throw new AdminRequestError((e as Error).message)
    }
    throw e
  }
}

export interface RefundPrep {
  subscription_id: number
  paypal_subscription_id: string
  capture_id: string
}

export function prepareSubscriptionRefund(
  client: PoolClient,
  adminSub: string,
  subscriptionId: number,
): Promise<RefundPrep> {
  return runAdminRpc<RefundPrep>(
    client,
    adminSub,
    'SELECT * FROM admin_prepare_subscription_refund($1)',
    [subscriptionId],
  )
}

export interface RefundedSubscription {
  id: number
  paypal_subscription_id: string
  refunded_at: string
  refund_paypal_id: string
}

export function recordSubscriptionRefund(
  client: PoolClient,
  adminSub: string,
  subscriptionId: number,
  paypalRefundId: string,
  reason: string | null,
): Promise<RefundedSubscription> {
  return runAdminRpc<RefundedSubscription>(
    client,
    adminSub,
    'SELECT * FROM admin_record_subscription_refund($1, $2, $3)',
    [subscriptionId, paypalRefundId, reason],
  )
}
