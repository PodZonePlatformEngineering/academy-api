// PROJ-011/ACP-444 — Resend transactional email, first use: an order-
// confirmation email on BILLING.SUBSCRIPTION.ACTIVATED (webhook.ts).
// Checked against Resend's own current API docs, not assumed — same
// discipline _lib/paypal.ts's header comment models for this repo:
//   - POST https://api.resend.com/emails, `Authorization: Bearer <API key>`
//     (not `X-Api-Key`), JSON body {from, to, subject, html, text?},
//     success response {id: string} (a bare UUID, no envelope), error
//     response {statusCode, message, name} — confirmed against
//     resend.com/docs/api-reference/emails/send-email and live against a
//     real send (see README's live-verification section), fetched 2026-08-28.
export class ResendApiError extends Error {}

export interface SendEmailInput {
  from: string
  to: string
  subject: string
  html: string
  text: string
}

export interface SendEmailResult {
  id: string
}

export async function sendEmail(apiKey: string, input: SendEmailInput): Promise<SendEmailResult> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string }
  if (!res.ok || !body.id) {
    throw new ResendApiError(body.message ?? `Resend send failed with status ${res.status}`)
  }
  return { id: body.id }
}

export interface OrderConfirmationInput {
  to: string
  traineeName: string | null
  planId: string | null
  amount: { currencyCode: string; value: string } | null
  nextBillingTime: string | null
  supportEmail: string
}

/** Pure — builds the email content, no network. Kept separate from
 * sendEmail so the copy can be unit-tested without a live Resend call
 * (mirrors subscription.ts's extractSubscriptionFields/upsertSubscription
 * split). Deliberately states only what's actually known from the PayPal
 * payload (brief: "do not invent legal/billing language") — plan_id is
 * shown as PayPal's own identifier since no human-readable plan/pricing
 * table exists yet (academy-admin migrations have no `plan` table), and
 * amount/next billing date are omitted from the copy, not guessed, when
 * the webhook event didn't carry them. */
export function renderOrderConfirmationEmail(input: OrderConfirmationInput): { subject: string; html: string; text: string } {
  const greeting = input.traineeName ? `Hi ${input.traineeName},` : 'Hi,'
  const lines = [greeting, '', 'Your VibeCreations subscription is now active.', '']
  if (input.planId) lines.push(`Plan: ${input.planId}`)
  if (input.amount) lines.push(`Amount: ${input.amount.value} ${input.amount.currencyCode}`)
  if (input.nextBillingTime) lines.push(`Next billing date: ${input.nextBillingTime}`)
  lines.push('', `Questions? Contact us at ${input.supportEmail}.`, '', '— VibeCreations')

  const text = lines.join('\n')
  const html = `<p>${greeting}</p><p>Your VibeCreations subscription is now active.</p><ul>${[
    input.planId ? `<li>Plan: ${input.planId}</li>` : '',
    input.amount ? `<li>Amount: ${input.amount.value} ${input.amount.currencyCode}</li>` : '',
    input.nextBillingTime ? `<li>Next billing date: ${input.nextBillingTime}</li>` : '',
  ]
    .filter(Boolean)
    .join('')}</ul><p>Questions? Contact us at <a href="mailto:${input.supportEmail}">${input.supportEmail}</a>.</p><p>— VibeCreations</p>`

  return { subject: 'Your VibeCreations subscription is confirmed', html, text }
}
