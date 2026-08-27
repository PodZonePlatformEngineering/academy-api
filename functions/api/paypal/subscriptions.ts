// POST /api/paypal/subscriptions — PROJ-011/T-152, the other half of the
// PayPal channel T-151 built the webhook-receiving side of. T-151's own
// README named this exact gap: nothing in this codebase set PayPal's
// `custom_id` on a subscription, so `_lib/subscription.ts`'s attribution
// path (webhook -> trainee) had no way to ever succeed for a real
// subscription. This route is what sets it.
//
// Never trusts a client-supplied trainee id — resolves `trainee_id` from
// the caller's own verified Neon Auth JWT (`_lib/jwt.ts`, `sub` claim),
// then `_lib/entitlement.ts`'s `resolveTraineeId` (the same
// `academy.current_trainee_id()` GUC dance `isFeatureEntitled` already
// uses) to turn that into the numeric id `subscription.trainee_id` and
// PayPal's `custom_id` are both keyed on.
import type { Env } from '../../_lib/env'
import { json, handleOptions } from '../../_lib/env'
import { withClient } from '../../_lib/db'
import { verifyTraineeSub, AuthError } from '../../_lib/jwt'
import { verifyBetterAuthTraineeSub } from '../../_lib/betterAuthJwt'
import { resolveTraineeId, UnknownTraineeError } from '../../_lib/entitlement'
import { getAccessToken, createSubscription, PayPalApiError, PayPalVerificationError } from '../../_lib/paypal'

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

  // Optional buyer-redirect URLs — see _lib/paypal.ts's CreateSubscriptionInput
  // doc: no academy-frontend paywall page exists yet (Phase 2) to have a
  // real URL to default to, so these are caller-supplied, not guessed.
  let returnUrl: string | undefined
  let cancelUrl: string | undefined
  const rawBody = await request.text()
  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody) as { returnUrl?: unknown; cancelUrl?: unknown }
      if (typeof parsed.returnUrl === 'string') returnUrl = parsed.returnUrl
      if (typeof parsed.cancelUrl === 'string') cancelUrl = parsed.cancelUrl
    } catch {
      return json({ error: 'invalid JSON body' }, 400, origin)
    }
  }

  try {
    const traineeId = await withClient(env.NEON_DATABASE_URL, (client) => resolveTraineeId(client, traineeSub))

    const accessToken = await getAccessToken(env.PAYPAL_API_BASE, env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET)
    const subscription = await createSubscription(env.PAYPAL_API_BASE, accessToken, {
      planId: env.PAYPAL_PLAN_ID,
      customId: String(traineeId),
      returnUrl,
      cancelUrl,
    })

    const approveLink = subscription.links.find((l) => l.rel === 'approve')?.href
    if (!approveLink) {
      // PayPal's own documented response always includes this on a
      // successful create (confirmed against the OpenAPI spec's example) —
      // its absence means something unexpected came back, not a normal
      // error path to swallow.
      return json({ error: 'PayPal response had no approve link', subscription }, 502, origin)
    }

    return json(
      {
        subscriptionId: subscription.id,
        status: subscription.status,
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
