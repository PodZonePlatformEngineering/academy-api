// POST /api/paypal/webhook — PROJ-011/T-151 Phase 1.
//
// Server-to-server delivery from PayPal (no browser Origin, no trainee
// JWT — PayPal itself is the caller), verified via PayPal's own
// verify-webhook-signature endpoint (_lib/paypal.ts, confirmed against
// PayPal's current OpenAPI spec, not assumed). Verified writes land in
// `subscription` (academy-admin/migrations/040_subscription_feature_gate.sql,
// live) via _lib/subscription.ts's idempotent upsert.
//
// UNTESTED against a real PayPal delivery pending a sandbox app's
// Client ID/Secret/Webhook ID — see README.md's credential-boundary
// section. The parse + upsert path this handler drives (extractSubscriptionFields
// + upsertSubscription) is unit-tested against PayPal's documented resource
// shape independent of signature verification (test/subscription.test.ts).
import type { Env } from '../../_lib/env'
import { json } from '../../_lib/env'
import { withClient } from '../../_lib/db'
import {
  getAccessToken,
  verifyWebhookSignature,
  readTransmissionHeaders,
  hasAllTransmissionHeaders,
  isHandledEventType,
  PayPalVerificationError,
  type WebhookEvent,
} from '../../_lib/paypal'
import { extractSubscriptionFields, upsertSubscription, UnattributedSubscriptionError } from '../../_lib/subscription'

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context

  const rawBody = await request.text()
  let event: WebhookEvent
  try {
    event = JSON.parse(rawBody)
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  const headers = readTransmissionHeaders(request)
  if (!hasAllTransmissionHeaders(headers)) {
    return json({ error: 'missing PAYPAL-TRANSMISSION-*/PAYPAL-CERT-URL/PAYPAL-AUTH-ALGO headers' }, 400)
  }

  try {
    const accessToken = await getAccessToken(env.PAYPAL_API_BASE, env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET)
    // webhook_event must be posted back exactly as received (PayPal's own
    // documented requirement) — `event` here is the parsed body with no
    // reshaping, satisfying that.
    const verified = await verifyWebhookSignature(env.PAYPAL_API_BASE, accessToken, {
      ...headers,
      webhookId: env.PAYPAL_WEBHOOK_ID,
      webhookEvent: event,
    })
    if (!verified) return json({ error: 'signature verification failed' }, 400)
  } catch (e) {
    if (e instanceof PayPalVerificationError) return json({ error: e.message }, 502)
    throw e
  }

  if (!isHandledEventType(event.event_type)) {
    // Ack anything we don't act on yet (e.g. BILLING.SUBSCRIPTION.CREATED,
    // .PAYMENT.FAILED — real PayPal event types, just not ones that change
    // `subscription.status` by themselves, see _lib/paypal.ts). PayPal
    // retries on non-2xx, and there's nothing wrong with this delivery.
    return json({ received: true, handled: false }, 200)
  }

  try {
    await withClient(env.NEON_DATABASE_URL, async (client) => {
      const fields = extractSubscriptionFields(event)
      await upsertSubscription(client, fields)
    })
  } catch (e) {
    if (e instanceof UnattributedSubscriptionError) {
      // Ack (200) rather than let PayPal retry forever — this needs a human
      // to look at it (a subscription PayPal thinks exists but this DB has
      // no way to attribute to a trainee), not an automatic retry storm.
      console.error(`[paypal webhook] ${e.message}`)
      return json({ received: true, handled: false, error: e.message }, 200)
    }
    throw e
  }

  return json({ received: true, handled: true }, 200)
}
