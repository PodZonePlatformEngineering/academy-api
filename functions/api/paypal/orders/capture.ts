// POST /api/paypal/orders/capture — PROJ-011/ACP-449. Unlike the
// subscription channel (PayPal auto-activates a subscription once the
// buyer approves — BILLING.SUBSCRIPTION.ACTIVATED fires on its own), the
// Orders API requires an explicit server-to-server capture call after
// approval before PayPal will actually take the payment (POST
// /v2/checkout/orders/{id}/capture, confirmed against
// openapi/checkout_orders_v2.json — there is no "auto-capture on approve"
// option in this API). academy-frontend calls this once the trainee lands
// back on its own return route.
//
// This call only triggers PayPal's capture — it never credits quota or
// touches the database itself. Crediting happens off the resulting
// PAYMENT.CAPTURE.COMPLETED webhook delivery (webhook.ts), same division of
// responsibility the subscription channel already draws between
// subscriptions.ts (create, no credit) and webhook.ts (ACTIVATED/PAYMENT.*,
// credits). A trainee closing the tab right after this call still gets
// credited once the webhook lands.
//
// Requires a verified trainee JWT (this repo has no genuinely anonymous
// write route), but does not otherwise check order ownership: unlike
// subscription/cancel.ts's findOwnedSubscription (a stored row to check
// against), there is no orders table here to own — the orderId is PayPal's
// own opaque resource id, unguessable in practice, and capturing an
// already-approved order a second time is a safe no-op on PayPal's side
// (idempotent per PayPal's own documented ORDER_ALREADY_CAPTURED behaviour)
// rather than a duplicate charge.
import type { Env } from '../../../_lib/env'
import { json, handleOptions } from '../../../_lib/env'
import { verifyTraineeSub, AuthError } from '../../../_lib/jwt'
import { verifyBetterAuthTraineeSub } from '../../../_lib/betterAuthJwt'
import { getAccessToken, captureOrder, PayPalApiError, PayPalVerificationError } from '../../../_lib/paypal'

export const onRequestOptions: PagesFunction<Env> = async (context) => handleOptions(context.request)

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context
  const origin = request.headers.get('Origin')

  try {
    if (env.AUTH_PRODUCT === 'better-auth') {
      await verifyBetterAuthTraineeSub(request.headers.get('Authorization'), env.NEON_AUTH_URL!)
    } else {
      await verifyTraineeSub(request.headers.get('Authorization'), env.STACK_PROJECT_ID)
    }
  } catch (e) {
    if (e instanceof AuthError) return json({ error: e.message }, 401, origin)
    throw e
  }

  let orderId: string
  try {
    const parsed = JSON.parse(await request.text()) as { orderId?: unknown }
    if (typeof parsed.orderId !== 'string' || !parsed.orderId) {
      return json({ error: 'orderId is required' }, 400, origin)
    }
    orderId = parsed.orderId
  } catch {
    return json({ error: 'invalid JSON body' }, 400, origin)
  }

  try {
    const accessToken = await getAccessToken(env.PAYPAL_API_BASE, env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET)
    const result = await captureOrder(env.PAYPAL_API_BASE, accessToken, orderId)
    return json({ orderId: result.id, status: result.status }, 200, origin)
  } catch (e) {
    if (e instanceof PayPalApiError || e instanceof PayPalVerificationError) {
      return json({ error: e.message }, 502, origin)
    }
    throw e
  }
}
