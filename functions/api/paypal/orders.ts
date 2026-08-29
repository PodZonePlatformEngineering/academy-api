// POST /api/paypal/orders — PROJ-011/ACP-449, one-off top-up purchases.
// Mirrors subscriptions.ts's create+webhook-confirm shape, but against
// PayPal's Orders API (no Plan object, no billing agreement) — see
// _lib/paypal.ts's createOrder/captureOrder doc comments for the API-shape
// differences.
//
// Never trusts a client-supplied amount or trainee id: `priceGbp` is
// validated against exactly quota.ts's ONE_OFF_PRICES_GBP (£2/£5, brief
// §1), and `trainee_id` is resolved from the caller's own verified JWT —
// same pattern subscriptions.ts uses, set as the order's per-purchase-unit
// `custom_id` (createOrder) so the webhook (PAYMENT.CAPTURE.COMPLETED) can
// attribute the eventual capture back to this trainee without guessing.
import type { Env } from '../../_lib/env'
import { json, handleOptions } from '../../_lib/env'
import { withClient } from '../../_lib/db'
import { verifyTraineeSub, AuthError } from '../../_lib/jwt'
import { verifyBetterAuthTraineeSub } from '../../_lib/betterAuthJwt'
import { resolveTraineeId, UnknownTraineeError } from '../../_lib/entitlement'
import { getAccessToken, createOrder, PayPalApiError, PayPalVerificationError } from '../../_lib/paypal'
import { isOneOffPriceGbp } from '../../_lib/quota'

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

  let priceGbp: string
  let returnUrl: string | undefined
  let cancelUrl: string | undefined
  try {
    const parsed = JSON.parse(await request.text()) as {
      priceGbp?: unknown
      returnUrl?: unknown
      cancelUrl?: unknown
    }
    // Server-side validation against exactly the two allowed values (brief
    // §1) — a client-supplied "0.01" or "500" is rejected here, never
    // trusted through to PayPal. Accepts either a bare "2"/"5" or the full
    // "2.00"/"5.00" PayPal amount string, normalised to the latter.
    const normalised = typeof parsed.priceGbp === 'string' ? normalisePriceGbp(parsed.priceGbp) : null
    if (!normalised || !isOneOffPriceGbp(normalised)) {
      return json({ error: 'priceGbp must be one of the supported one-off amounts (£2, £5)' }, 400, origin)
    }
    priceGbp = normalised
    if (typeof parsed.returnUrl === 'string') returnUrl = parsed.returnUrl
    if (typeof parsed.cancelUrl === 'string') cancelUrl = parsed.cancelUrl
  } catch {
    return json({ error: 'invalid JSON body' }, 400, origin)
  }

  try {
    const traineeId = await withClient(env.NEON_DATABASE_URL, (client) => resolveTraineeId(client, traineeSub))

    const accessToken = await getAccessToken(env.PAYPAL_API_BASE, env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET)
    const order = await createOrder(env.PAYPAL_API_BASE, accessToken, {
      amountValue: priceGbp,
      customId: String(traineeId),
      returnUrl,
      cancelUrl,
    })

    const approveLink = order.links.find((l) => l.rel === 'approve')?.href
    if (!approveLink) {
      return json({ error: 'PayPal response had no approve link', order }, 502, origin)
    }

    return json(
      {
        orderId: order.id,
        status: order.status,
        approvalUrl: approveLink,
      },
      201,
      origin,
    )
  } catch (e) {
    if (e instanceof UnknownTraineeError) return json({ error: e.message }, 404, origin)
    if (e instanceof PayPalApiError || e instanceof PayPalVerificationError) {
      return json({ error: e.message }, 502, origin)
    }
    throw e
  }
}

function normalisePriceGbp(raw: string): string | null {
  const n = Number.parseFloat(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return n.toFixed(2)
}
