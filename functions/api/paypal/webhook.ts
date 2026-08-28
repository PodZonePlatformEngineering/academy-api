// POST /api/paypal/webhook — PROJ-011/T-151 Phase 1.
//
// Server-to-server delivery from PayPal (no browser Origin, no trainee
// JWT — PayPal itself is the caller), verified via PayPal's own
// verify-webhook-signature endpoint (_lib/paypal.ts, confirmed against
// PayPal's current OpenAPI spec, not assumed). Verified writes land in
// `subscription` (academy-admin/migrations/039_subscription_feature_gate.sql,
// live) via _lib/subscription.ts's idempotent upsert.
//
// UNTESTED against a real PayPal delivery pending a sandbox app's
// Client ID/Secret/Webhook ID — see README.md's credential-boundary
// section. The parse + upsert path this handler drives (extractSubscriptionFields
// + upsertSubscription) is unit-tested against PayPal's documented resource
// shape independent of signature verification (test/subscription.test.ts).
//
// PROJ-011/ACP-444: ACTIVATED additionally sends an order-confirmation
// email via _lib/email.ts — see README's "Order-confirmation email"
// section for the design and the live-checked Resend domain-verification
// (RESEND_API_KEY/RESEND_FROM_ADDRESS are set as Pages secrets and
// confirmed delivering via mail.podzone.uk, domain verified 2026-08-28).
//
// PROJ-011/ACP-448 (folds in ACP-446): PAYMENT.SALE.COMPLETED now also
// credits the trainee's persistent quota balance (_lib/quota.ts) and sends
// a recurring-charge variant of the same order-confirmation email — see
// that branch's own comment below.
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
  PAYMENT_SALE_COMPLETED,
  type WebhookEvent,
} from '../../_lib/paypal'
import {
  extractSubscriptionFields,
  upsertSubscription,
  recordCaptureId,
  UnattributedSubscriptionError,
} from '../../_lib/subscription'
import { sendEmail, renderOrderConfirmationEmail } from '../../_lib/email'
import { creditQuota, resolveQuotaGrantAmount } from '../../_lib/quota'

const SUPPORT_EMAIL = 'podzone.cloud@gmail.com'

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

  // ACP-441 — PAYMENT.SALE.COMPLETED (the recurring-billing charge event)
  // carries a "sale" resource, not a "subscription" resource: handled
  // before isHandledEventType's BILLING.SUBSCRIPTION.*-shaped check below,
  // since running it through extractSubscriptionFields/upsertSubscription
  // would misread billing_agreement_id as nothing and status as ''.
  //
  // PROJ-011/ACP-448 + folded-in ACP-446 (2026-08-28): this is also the
  // quota-accrual event (decision 2 — +50 per successful payment, non-
  // resetting) and the recurring-charge email trigger. Both best-effort in
  // the sense that a Resend failure never fails the ack (same posture
  // ACP-444 took for the ACTIVATED path below) — but crediting quota is
  // NOT best-effort, it happens inside the same withClient block as
  // recordCaptureId, before the ack, since a silently-dropped credit is a
  // real product bug (a trainee paid and got nothing), not a soft failure.
  if (event.event_type === PAYMENT_SALE_COMPLETED) {
    const { id: captureId, billing_agreement_id: paypalSubscriptionId, amount } = event.resource
    if (paypalSubscriptionId) {
      const recipient = await withClient(env.NEON_DATABASE_URL, async (client) => {
        await recordCaptureId(client, paypalSubscriptionId, captureId)
        // Resolve the trainee this payment belongs to via the subscription
        // row's own trainee_id (same join key recordCaptureId's own UPDATE
        // matched on) — not fields.customId, since a sale resource carries
        // no custom_id at all (see paypal.ts's WebhookEvent comment).
        const row = await client.query<{
          trainee_id: number
          email: string | null
          display_name: string | null
          current_period_end: string | null
        }>(
          `SELECT s.trainee_id, t.email, t.display_name, s.current_period_end
             FROM subscription s JOIN trainee t ON t.id = s.trainee_id
            WHERE s.paypal_subscription_id = $1`,
          [paypalSubscriptionId],
        )
        const sub = row.rows[0]
        if (!sub) return null
        await creditQuota(client, sub.trainee_id, resolveQuotaGrantAmount(env))
        return sub.email ? { email: sub.email, displayName: sub.display_name, nextBillingTime: sub.current_period_end } : null
      })
      if (recipient) {
        try {
          const email = renderOrderConfirmationEmail({
            to: recipient.email,
            traineeName: recipient.displayName,
            planId: null, // a sale resource carries no plan_id (see paypal.ts)
            amount: amount?.total && amount.currency ? { value: amount.total, currencyCode: amount.currency } : null,
            nextBillingTime: recipient.nextBillingTime,
            supportEmail: SUPPORT_EMAIL,
            kind: 'renewal',
          })
          await sendEmail(env.RESEND_API_KEY, {
            from: env.RESEND_FROM_ADDRESS,
            to: recipient.email,
            subject: email.subject,
            html: email.html,
            text: email.text,
          })
        } catch (e) {
          // Never rethrown — same reasoning as the ACTIVATED path below:
          // the quota credit above has already committed either way, and
          // PayPal retrying an identical delivery wouldn't fix a broken
          // Resend send.
          const message = e instanceof Error ? e.message : String(e)
          console.error(`[paypal webhook] recurring-charge email failed: ${message}`)
        }
      }
    }
    return json({ received: true, handled: true }, 200)
  }

  if (!isHandledEventType(event.event_type)) {
    // Ack anything we don't act on yet (e.g. BILLING.SUBSCRIPTION.CREATED,
    // .PAYMENT.FAILED — real PayPal event types, just not ones that change
    // `subscription.status` by themselves, see _lib/paypal.ts). PayPal
    // retries on non-2xx, and there's nothing wrong with this delivery.
    return json({ received: true, handled: false }, 200)
  }

  let trainee: { email: string; display_name: string | null } | null = null
  try {
    trainee = await withClient(env.NEON_DATABASE_URL, async (client) => {
      const fields = extractSubscriptionFields(event)
      await upsertSubscription(client, fields)

      // PROJ-011/ACP-444 — order-confirmation email, ACTIVATED only (brief
      // §3: "trigger the email from the ACTIVATED handler path"). Resolved
      // via the same subscription -> trainee join fields.customId already
      // gives upsertSubscription (T-152 sets custom_id = trainee_id at
      // subscription-create time), not a second webhook-driven attribution
      // path. A trainee row with a NULL email (a real, live gap — see
      // academy-admin migrations/074's header) or an absent customId just
      // means no email goes out; the subscription upsert above has already
      // committed either way.
      if (event.event_type === 'BILLING.SUBSCRIPTION.ACTIVATED' && fields.customId) {
        const traineeId = Number(fields.customId)
        if (Number.isInteger(traineeId)) {
          const result = await client.query<{ email: string | null; display_name: string | null }>(
            'SELECT email, display_name FROM trainee WHERE id = $1',
            [traineeId],
          )
          const row = result.rows[0]
          if (row?.email) return { email: row.email, display_name: row.display_name }
        }
      }
      return null
    })
  } catch (e) {
    if (e instanceof UnattributedSubscriptionError) {
      // Ack (200) rather than let PayPal retry — reconfirmed, not just
      // carried over, now that PROJ-011/T-152's subscriptions.ts sets
      // custom_id on every subscription this repo creates: see
      // subscription.ts's upsertSubscription docstring for the full
      // reasoning (brief §4) on why a retryable 404/5xx isn't the safer
      // choice here even though real subscriptions can now be attributed.
      console.error(`[paypal webhook] ${e.message}`)
      return json({ received: true, handled: false, error: e.message }, 200)
    }
    throw e
  }

  if (trainee) {
    // Best-effort, deliberately outside the DB try/catch above and never
    // allowed to turn a successful subscription-upsert into a failed ack —
    // brief's own verification bar ("the email is an addition, not a
    // replacement of existing logic"). A Resend failure here (e.g. the
    // from-address's domain isn't verified yet, see README) is logged and
    // swallowed, not retried by PayPal, since retrying an identical
    // delivery wouldn't fix a Resend-side config problem either.
    try {
      const r = event.resource
      const email = renderOrderConfirmationEmail({
        to: trainee.email,
        traineeName: trainee.display_name,
        planId: r.plan_id ?? null,
        amount: r.billing_info?.last_payment?.amount?.value && r.billing_info.last_payment.amount.currency_code
          ? { value: r.billing_info.last_payment.amount.value, currencyCode: r.billing_info.last_payment.amount.currency_code }
          : null,
        nextBillingTime: r.billing_info?.next_billing_time ?? null,
        supportEmail: SUPPORT_EMAIL,
      })
      await sendEmail(env.RESEND_API_KEY, {
        from: env.RESEND_FROM_ADDRESS,
        to: trainee.email,
        subject: email.subject,
        html: email.html,
        text: email.text,
      })
    } catch (e) {
      // Never rethrown, even for a non-ResendApiError (e.g. a raw network
      // failure) — an ack failure here would make PayPal retry a delivery
      // whose subscription-upsert has already succeeded, and a broken send
      // path never becomes any less broken for the retry.
      const message = e instanceof Error ? e.message : String(e)
      console.error(`[paypal webhook] order-confirmation email failed: ${message}`)
    }
  }

  return json({ received: true, handled: true }, 200)
}
