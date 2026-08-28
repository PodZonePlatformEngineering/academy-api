// POST /api/admin/refund — PROJ-011/ACP-441. The academy-gui admin
// console's refund action. Sandwiches a real PayPal refund call between two
// academy-admin RPC calls (academy-admin migration 077 /
// vibecreations-db migration 005): admin_prepare_subscription_refund
// (require_admin-gated, returns the capture id to refund) then, only if
// PayPal's own call succeeds, admin_record_subscription_refund
// (require_admin-gated, writes refunded_at — picked up by the existing
// trg_audit_subscription trigger, no second audit path built here). See
// _lib/adminRefund.ts's header for why this route drives those RPCs over a
// direct NEON_DATABASE_URL connection rather than the Data API: Postgres
// itself cannot call PayPal.
//
// Full-refund-only (brief §4's safe default — no partial-refund amount
// anywhere in this route) and does not touch `subscription.status` /
// entitlement: a real product decision the brief explicitly left to the
// operator rather than guessing (see this repo's PR description).
import type { Env } from '../../_lib/env'
import { json, handleOptions } from '../../_lib/env'
import { withClient } from '../../_lib/db'
import { verifyTraineeSub, AuthError } from '../../_lib/jwt'
import { verifyBetterAuthTraineeSub } from '../../_lib/betterAuthJwt'
import { getAccessToken, refundCapture, PayPalApiError, PayPalVerificationError } from '../../_lib/paypal'
import {
  prepareSubscriptionRefund,
  recordSubscriptionRefund,
  AdminAuthError,
  AdminRequestError,
  SubscriptionNotFoundError,
} from '../../_lib/adminRefund'

export const onRequestOptions: PagesFunction<Env> = async (context) => handleOptions(context.request)

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context
  const origin = request.headers.get('Origin')

  let adminSub: string
  try {
    adminSub =
      env.AUTH_PRODUCT === 'better-auth'
        ? await verifyBetterAuthTraineeSub(request.headers.get('Authorization'), env.NEON_AUTH_URL!)
        : await verifyTraineeSub(request.headers.get('Authorization'), env.STACK_PROJECT_ID)
  } catch (e) {
    if (e instanceof AuthError) return json({ error: e.message }, 401, origin)
    throw e
  }

  let subscriptionId: number
  let reason: string | null
  try {
    const parsed = JSON.parse(await request.text()) as { subscriptionId?: unknown; reason?: unknown }
    if (typeof parsed.subscriptionId !== 'number' || !Number.isInteger(parsed.subscriptionId)) {
      return json({ error: 'subscriptionId (integer) required' }, 400, origin)
    }
    subscriptionId = parsed.subscriptionId
    reason = typeof parsed.reason === 'string' && parsed.reason ? parsed.reason : null
  } catch {
    return json({ error: 'invalid JSON body' }, 400, origin)
  }

  try {
    const prep = await withClient(env.NEON_DATABASE_URL, (client) =>
      prepareSubscriptionRefund(client, adminSub, subscriptionId),
    )

    const accessToken = await getAccessToken(env.PAYPAL_API_BASE, env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET)
    const refund = await refundCapture(env.PAYPAL_API_BASE, accessToken, prep.capture_id)

    const recorded = await withClient(env.NEON_DATABASE_URL, (client) =>
      recordSubscriptionRefund(client, adminSub, subscriptionId, refund.id, reason),
    )

    return json(
      {
        subscriptionId: recorded.id,
        paypalSubscriptionId: recorded.paypal_subscription_id,
        refundedAt: recorded.refunded_at,
        paypalRefundId: recorded.refund_paypal_id,
        paypalRefundStatus: refund.status,
      },
      200,
      origin,
    )
  } catch (e) {
    if (e instanceof AdminAuthError) return json({ error: e.message }, 403, origin)
    if (e instanceof SubscriptionNotFoundError) return json({ error: e.message }, 404, origin)
    if (e instanceof AdminRequestError) return json({ error: e.message }, 409, origin)
    if (e instanceof PayPalApiError || e instanceof PayPalVerificationError) {
      return json({ error: e.message }, 502, origin)
    }
    throw e
  }
}
