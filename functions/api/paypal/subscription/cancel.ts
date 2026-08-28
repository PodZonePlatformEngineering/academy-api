// POST /api/paypal/subscription/cancel — PROJ-011/ACP-445, self-service
// unsubscribe. Same JWT-dispatch/trainee-resolution pattern as
// subscriptions.ts (T-152): never trusts a client-supplied trainee id,
// resolves `trainee_id` from the caller's own verified JWT via
// `resolveTraineeId`, then confirms the `paypalSubscriptionId` the caller
// supplied actually belongs to that trainee (`findOwnedSubscription`)
// before ever calling PayPal — a trainee must never be able to cancel
// anyone else's subscription.
//
// This only stops future PayPal billing/quota accrual. Per the brief's
// operator decision (ACP-448), it must NOT and does NOT touch
// `trainee_quota_balance` or `subscription.status` directly — PayPal's own
// BILLING.SUBSCRIPTION.CANCELLED webhook (webhook.ts, already live) is what
// syncs `subscription.status` afterwards, same as any other PayPal-
// initiated status change.
import type { Env } from '../../../_lib/env'
import { json, handleOptions } from '../../../_lib/env'
import { withClient } from '../../../_lib/db'
import { verifyTraineeSub, AuthError } from '../../../_lib/jwt'
import { verifyBetterAuthTraineeSub } from '../../../_lib/betterAuthJwt'
import { resolveTraineeId, UnknownTraineeError } from '../../../_lib/entitlement'
import { findOwnedSubscription } from '../../../_lib/subscription'
import { getAccessToken, cancelSubscription, PayPalApiError, PayPalVerificationError } from '../../../_lib/paypal'

export const onRequestOptions: PagesFunction<Env> = async (context) => handleOptions(context.request)

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context
  const origin = request.headers.get('Origin')

  let traineeSub: string
  try {
    traineeSub =
      env.AUTH_PRODUCT === 'better-auth'
        ? await verifyBetterAuthTraineeSub(request.headers.get('Authorization'), env.NEON_AUTH_URL!)
        : await verifyTraineeSub(request.headers.get('Authorization'), env.STACK_PROJECT_ID)
  } catch (e) {
    if (e instanceof AuthError) return json({ error: e.message }, 401, origin)
    throw e
  }

  let paypalSubscriptionId: string
  let reason: string
  try {
    const parsed = JSON.parse(await request.text()) as { paypalSubscriptionId?: unknown; reason?: unknown }
    if (typeof parsed.paypalSubscriptionId !== 'string' || !parsed.paypalSubscriptionId) {
      return json({ error: 'paypalSubscriptionId is required' }, 400, origin)
    }
    paypalSubscriptionId = parsed.paypalSubscriptionId
    reason = typeof parsed.reason === 'string' && parsed.reason ? parsed.reason : 'Cancelled by trainee'
  } catch {
    return json({ error: 'invalid JSON body' }, 400, origin)
  }

  try {
    const owned = await withClient(env.NEON_DATABASE_URL, async (client) => {
      const traineeId = await resolveTraineeId(client, traineeSub)
      return findOwnedSubscription(client, traineeId, paypalSubscriptionId)
    })
    if (!owned) return json({ error: 'no such subscription' }, 404, origin)
    if (owned.status === 'CANCELLED' || owned.status === 'EXPIRED') {
      // Already in a terminal state — nothing for PayPal to cancel, and
      // PayPal's own cancel endpoint 4xxs on an already-cancelled
      // subscription anyway. Treat as a no-op success rather than an
      // error: the trainee's intent ("stop billing me") is already true.
      return json({ status: owned.status }, 200, origin)
    }

    const accessToken = await getAccessToken(env.PAYPAL_API_BASE, env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET)
    await cancelSubscription(env.PAYPAL_API_BASE, accessToken, paypalSubscriptionId, reason)

    return json({ cancelled: true }, 200, origin)
  } catch (e) {
    if (e instanceof UnknownTraineeError) return json({ error: e.message }, 404, origin)
    if (e instanceof PayPalApiError || e instanceof PayPalVerificationError) {
      return json({ error: e.message }, 502, origin)
    }
    throw e
  }
}
