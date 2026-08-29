// PayPal REST + webhook-signature mechanics for the subscription channel
// (PROJ-011/T-151, Phase 1 of academy-api-three-tier-design-refresh.md
// §7). Checked against PayPal's current, authoritative sources rather than
// assumed — same discipline T-150 applied to the subscription status enum:
//
//   - Signature verification shape (endpoint, request field names, response
//     shape) and the PAYPAL-* transmission header names: confirmed against
//     paypal/paypal-rest-api-specifications (GitHub, official PayPal repo),
//     openapi/notifications_webhooks_v1.json,
//     #/paths/~1v1~1notifications~1verify-webhook-signature and
//     #/components/schemas/verify_webhook_signature_response, fetched
//     2026-08-02. Confirms developer.paypal.com's documented shape exactly
//     (POST /v1/notifications/verify-webhook-signature with
//     transmission_id/transmission_time/cert_url/auth_algo/transmission_sig/
//     webhook_id/webhook_event, response {verification_status: "SUCCESS" |
//     "FAILURE"}).
//   - OAuth2 client-credentials token endpoint
//     (POST /v1/oauth2/token, Basic auth of client_id:client_secret,
//     grant_type=client_credentials): developer.paypal.com/api/rest/authentication/.
//   - BILLING.SUBSCRIPTION.* event-type names: developer.paypal.com/api/rest/webhooks/event-names/,
//     cross-checked against the same OpenAPI repo's notifications spec.
//   - subscription resource field names (id, plan_id, status, custom_id,
//     billing_info.next_billing_time, status_update_time): confirmed
//     against openapi/billing_subscriptions_v1.json,
//     #/components/schemas/subscription and #/components/schemas/subscription_billing_info.
//
// None of this has been exercised against a live PayPal call — there is no
// PayPal Developer sandbox app (Client ID/Secret/Webhook ID) in the secrets
// vault yet. See README.md's credential-boundary section.
export class PayPalVerificationError extends Error {}

// The subset of BILLING.SUBSCRIPTION.* events this repo acts on (brief
// §3/§4). PayPal also emits BILLING.SUBSCRIPTION.CREATED (fires before
// buyer approval, resource status APPROVAL_PENDING/APPROVED — not acted on
// here, since T-150's assert_feature_entitled only treats ACTIVE as
// entitled either way) and BILLING.SUBSCRIPTION.PAYMENT.FAILED (dunning
// signal, not a status transition by itself — SUSPENDED is what actually
// changes entitlement, per failed_payments_count crossing
// payment_failure_threshold). Both are real, documented event types; they
// are out of this brief's explicit scope (§4 names exactly the five below)
// and safely no-op through the "unhandled event" ack path in webhook.ts.
export const HANDLED_EVENT_TYPES = [
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.UPDATED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
] as const
export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number]

export function isHandledEventType(eventType: string): eventType is HandledEventType {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(eventType)
}

// PayPal's own Subscriptions API status enum, verbatim — matches T-150's
// decision doc exactly, re-confirmed here against
// openapi/billing_subscriptions_v1.json's subscription_status schema.
export const SUBSCRIPTION_STATUSES = [
  'APPROVAL_PENDING',
  'APPROVED',
  'ACTIVE',
  'SUSPENDED',
  'CANCELLED',
  'EXPIRED',
] as const

export interface WebhookEvent {
  id: string
  event_type: string
  resource_type: string
  create_time?: string
  summary?: string
  resource: {
    id: string
    plan_id?: string
    status?: string
    custom_id?: string
    status_update_time?: string
    create_time?: string
    // last_payment is additive to what extractSubscriptionFields (subscription.ts)
    // reads — only email.ts's order-confirmation content uses it (PROJ-011/
    // ACP-444). Confirmed against openapi/billing_subscriptions_v1.json's
    // subscription_billing_info -> last_payment_details -> money schemas,
    // fetched 2026-08-28: billing_info's own description ("If the
    // subscription was or is active, these fields are populated") means
    // this can legitimately be absent even on ACTIVATED if PayPal hasn't
    // captured a payment yet — code reading it must treat it as optional,
    // not assume presence.
    billing_info?: {
      next_billing_time?: string
      last_payment?: { amount?: { currency_code?: string; value?: string }; time?: string }
    }
    // PAYMENT.SALE.COMPLETED-only fields (ACP-441) — a "sale" resource, not
    // a "subscription" resource, so it carries neither `status` nor
    // `custom_id`: `state` (lowercase 'completed', not PayPal's usual
    // uppercase status enum) is the sale's own state, and
    // `billing_agreement_id` — not `id` — is the subscription this payment
    // belongs to; `id` here is the sale/capture id itself. Confirmed against
    // current developer.paypal.com webhook-event-name docs + community-
    // reported payload shape (no PAYMENT.SALE.COMPLETED example survives in
    // paypal/paypal-rest-api-specifications' notifications_webhooks_v1.json
    // — this event predates that spec repo), 2026-08-28.
    state?: string
    billing_agreement_id?: string
    // PROJ-011/ACP-448 — the sale's own charged amount, {total, currency}
    // (note the field names: NOT the subscription resource's
    // billing_info.last_payment.amount.{value, currency_code}). Confirmed
    // against developer.paypal.com's deprecated Payments v1 "sale" resource
    // (GET /v1/payments/sale/{sale_id}), 2026-08-28 — the same resource
    // shape a PAYMENT.SALE.COMPLETED webhook's `resource` carries. A third,
    // yet again different, shape: PAYMENT.CAPTURE.COMPLETED's "capture"
    // resource (ACP-449, Orders API v2) uses {value, currency_code} — see
    // the fields immediately below.
    amount?: { total?: string; currency?: string; value?: string; currency_code?: string }
    // PROJ-011/ACP-449 — PAYMENT.CAPTURE.COMPLETED-only field. A "capture"
    // resource (Orders API v2), confirmed against
    // openapi/payments_payment_v2.json's capture schema: reuses the same
    // top-level `custom_id` field declared above — this repo sets it on the
    // *order's* purchase_unit at creation time (createOrder, below), and
    // PayPal carries it straight through onto the resulting capture
    // resource, so no `billing_agreement_id`-style join back to a stored
    // row is needed to attribute the payment to a trainee.
    supplementary_data?: { related_ids?: { order_id?: string } }
  }
}

/** ACP-441 — the subscription-billing payment event, handled separately
 * from HANDLED_EVENT_TYPES/BILLING.SUBSCRIPTION.* above: its resource shape
 * is a "sale", not a "subscription" (see WebhookEvent's field comments),
 * so it can't run through extractSubscriptionFields/upsertSubscription. */
export const PAYMENT_SALE_COMPLETED = 'PAYMENT.SALE.COMPLETED'

/** PROJ-011/ACP-449 — the one-off Orders API purchase's confirm event.
 * Named identically in shape to PAYMENT_SALE_COMPLETED's handling (its own
 * separate resource shape, not a subscription), but a genuinely different
 * PayPal event: fired when an Orders v2 capture completes, not a
 * subscription-billing charge. Event name confirmed against
 * developer.paypal.com/api/rest/webhooks/event-names/, 2026-08-29.
 */
export const PAYMENT_CAPTURE_COMPLETED = 'PAYMENT.CAPTURE.COMPLETED'

interface OAuthTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
}

/**
 * Client-credentials OAuth token (PayPal REST auth). No caching across
 * requests — same one-per-invocation posture db.ts's `withClient` uses for
 * the Neon `Pool`, for the same reason: a Pages Functions isolate can't be
 * trusted to keep module-level state alive/valid across requests (T-146).
 * A short-lived token re-minted per webhook delivery is the safe default;
 * revisit only if PayPal's token endpoint turns out to be a real latency
 * problem once there's a live webhook to measure against.
 */
export async function getAccessToken(
  apiBase: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const resp = await fetch(`${apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })
  if (!resp.ok) {
    throw new PayPalVerificationError(`OAuth token request failed: ${resp.status} ${await resp.text()}`)
  }
  const data = (await resp.json()) as OAuthTokenResponse
  return data.access_token
}

export interface TransmissionHeaders {
  transmissionId: string | null
  transmissionTime: string | null
  certUrl: string | null
  authAlgo: string | null
  transmissionSig: string | null
}

/** The PAYPAL-* headers PayPal sends with every webhook delivery, read
 * straight off the incoming Request — confirmed header names against
 * openapi/notifications_webhooks_v1.json (PAYPAL-TRANSMISSION-ID,
 * PAYPAL-TRANSMISSION-TIME, PAYPAL-CERT-URL, PAYPAL-AUTH-ALGO,
 * PAYPAL-TRANSMISSION-SIG). */
export function readTransmissionHeaders(request: Request): TransmissionHeaders {
  return {
    transmissionId: request.headers.get('PAYPAL-TRANSMISSION-ID'),
    transmissionTime: request.headers.get('PAYPAL-TRANSMISSION-TIME'),
    certUrl: request.headers.get('PAYPAL-CERT-URL'),
    authAlgo: request.headers.get('PAYPAL-AUTH-ALGO'),
    transmissionSig: request.headers.get('PAYPAL-TRANSMISSION-SIG'),
  }
}

export function hasAllTransmissionHeaders(
  h: TransmissionHeaders,
): h is { [K in keyof TransmissionHeaders]: string } {
  return Boolean(h.transmissionId && h.transmissionTime && h.certUrl && h.authAlgo && h.transmissionSig)
}

export interface VerifySignatureInput extends Record<keyof TransmissionHeaders, string> {
  webhookId: string
  webhookEvent: unknown
}

/**
 * POST /v1/notifications/verify-webhook-signature — the only PayPal-
 * documented way to verify a webhook delivery actually came from PayPal.
 * There is no local HMAC/shared-secret scheme to check against; PayPal
 * signs each delivery with its own rotating cert and this endpoint is the
 * server-to-server check against it. `webhook_event` must be posted back
 * exactly as received (PayPal's own documented warning) — callers should
 * pass the parsed body object straight through, not a re-serialised or
 * reshaped copy.
 */
export async function verifyWebhookSignature(
  apiBase: string,
  accessToken: string,
  input: VerifySignatureInput,
): Promise<boolean> {
  const resp = await fetch(`${apiBase}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      transmission_id: input.transmissionId,
      transmission_time: input.transmissionTime,
      cert_url: input.certUrl,
      auth_algo: input.authAlgo,
      transmission_sig: input.transmissionSig,
      webhook_id: input.webhookId,
      webhook_event: input.webhookEvent,
    }),
  })
  if (!resp.ok) {
    throw new PayPalVerificationError(
      `verify-webhook-signature request failed: ${resp.status} ${await resp.text()}`,
    )
  }
  const data = (await resp.json()) as { verification_status: 'SUCCESS' | 'FAILURE' }
  return data.verification_status === 'SUCCESS'
}

export class PayPalApiError extends Error {}

export interface SubscriptionLink {
  href: string
  rel: string
  method: string
}

export interface CreatedSubscription {
  id: string
  status: string
  custom_id?: string
  links: SubscriptionLink[]
}

export interface CreateSubscriptionInput {
  planId: string
  customId: string
  /** Buyer redirect after approve/cancel on PayPal's hosted checkout — both
   * optional per openapi/billing_subscriptions_v1.json's
   * subscription_application_context_request schema (only `plan_id` is
   * actually required to create a subscription). Omitted entirely when the
   * caller (a future academy-frontend paywall page) doesn't supply one --
   * PayPal falls back to its own default return behaviour rather than this
   * repo guessing a URL for a frontend that doesn't exist yet (Phase 2).
   */
  returnUrl?: string
  cancelUrl?: string
}

/**
 * POST /v1/billing/subscriptions — creates a subscription in
 * `APPROVAL_PENDING` state and returns the PayPal-hosted approval link
 * (`links[].rel === 'approve'`) the caller redirects the buyer to. Request/
 * response shape confirmed against
 * openapi/billing_subscriptions_v1.json's `subscription_request_post` /
 * `subscription` schemas (PayPal's official spec repo), fetched 2026-08-02
 * — same discipline as the rest of this file. `custom_id` here is the
 * entire point of PROJ-011/T-152: setting it to the resolved `trainee_id`
 * at creation time is what makes T-151's webhook handler able to attribute
 * events to a trainee at all (see subscription.ts's UnattributedSubscriptionError).
 */
export async function createSubscription(
  apiBase: string,
  accessToken: string,
  input: CreateSubscriptionInput,
): Promise<CreatedSubscription> {
  const body: Record<string, unknown> = {
    plan_id: input.planId,
    custom_id: input.customId,
  }
  if (input.returnUrl && input.cancelUrl) {
    body.application_context = {
      user_action: 'SUBSCRIBE_NOW',
      return_url: input.returnUrl,
      cancel_url: input.cancelUrl,
    }
  }
  const resp = await fetch(`${apiBase}/v1/billing/subscriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      // PayPal's own documented idempotency header for this endpoint — a
      // fresh uuid per call (not derived from customId/time, which would
      // give a false sense of dedup without a real client-supplied
      // idempotency token) so a duplicate *network* retry of literally the
      // same fetch (Cloudflare-side, not caller-side) can't double-create.
      'PayPal-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    throw new PayPalApiError(`create subscription failed: ${resp.status} ${await resp.text()}`)
  }
  return (await resp.json()) as CreatedSubscription
}

/** GET /v1/billing/subscriptions/{id} — used by callers that need to
 * re-confirm a subscription's current state (e.g. live verification that
 * `custom_id` round-tripped correctly). Same `subscription` response
 * schema as createSubscription's response. */
export async function getSubscription(
  apiBase: string,
  accessToken: string,
  subscriptionId: string,
): Promise<CreatedSubscription> {
  const resp = await fetch(`${apiBase}/v1/billing/subscriptions/${subscriptionId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!resp.ok) {
    throw new PayPalApiError(`get subscription failed: ${resp.status} ${await resp.text()}`)
  }
  return (await resp.json()) as CreatedSubscription
}

export interface RefundResult {
  id: string
  status: string
}

/**
 * POST /v2/payments/captures/{capture_id}/refund — ACP-441. An empty
 * request body means a full refund of the capture's entire amount (PayPal's
 * own documented behaviour, confirmed against
 * openapi/payments_payment_v2.json's refund_request examples, fetched
 * 2026-08-28) — this repo only ever issues full refunds (brief §4's safe
 * default; no partial-refund amount is threaded through anywhere in this
 * codebase). Same idempotency-header posture as createSubscription: a fresh
 * uuid per call, guarding only against a duplicate *network* retry of the
 * same fetch, not against a caller submitting two separate refund requests
 * (that's admin_record_subscription_refund's `WHERE refunded_at IS NULL`
 * guard, academy-admin migration 077).
 */
export async function refundCapture(
  apiBase: string,
  accessToken: string,
  captureId: string,
): Promise<RefundResult> {
  const resp = await fetch(`${apiBase}/v2/payments/captures/${captureId}/refund`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': crypto.randomUUID(),
    },
    body: '{}',
  })
  if (!resp.ok) {
    throw new PayPalApiError(`refund capture failed: ${resp.status} ${await resp.text()}`)
  }
  return (await resp.json()) as RefundResult
}

/**
 * POST /v1/billing/subscriptions/{id}/cancel — PROJ-011/ACP-445. Request/
 * response shape confirmed against openapi/billing_subscriptions_v1.json's
 * cancel operation, fetched 2026-08-28: body is `{ reason: string }`
 * (PayPal's schema marks it optional, but this repo always sends one —
 * brief §1 calls out that PayPal's docs describe it as required in
 * practice), success is `204 No Content` with no response body — there is
 * nothing to parse or return.
 *
 * This only stops future billing/quota accrual on PayPal's side (brief
 * "Context": ACP-448 already made `is_feature_entitled` ignore
 * `subscription.status` for the quota-holding OR-path). It never touches
 * `trainee_quota_balance` directly, and callers must not add any
 * entitlement-revocation logic around this call — `subscription.status`
 * syncing to CANCELLED happens later via the existing
 * BILLING.SUBSCRIPTION.CANCELLED webhook path (webhook.ts), same as any
 * other PayPal-initiated status change.
 */
export async function cancelSubscription(
  apiBase: string,
  accessToken: string,
  subscriptionId: string,
  reason: string,
): Promise<void> {
  const resp = await fetch(`${apiBase}/v1/billing/subscriptions/${subscriptionId}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ reason }),
  })
  if (!resp.ok) {
    throw new PayPalApiError(`cancel subscription failed: ${resp.status} ${await resp.text()}`)
  }
}

// --- PROJ-011/ACP-449 — one-off top-up purchases (Orders API v2), a
// genuinely separate PayPal integration path from everything above: no
// PayPal "Plan" object, no billing agreement, no recurring charge. Request/
// response shapes confirmed against
// paypal/paypal-rest-api-specifications' openapi/checkout_orders_v2.json,
// fetched 2026-08-29:
//   - POST /v2/checkout/orders: `intent: "CAPTURE"`, one `purchase_units[]`
//     entry with `amount.currency_code`/`amount.value` and `custom_id` (the
//     Orders API's own per-purchase-unit field — NOT top-level like the
//     Subscriptions API's `custom_id`, brief §4's "check the Orders API's
//     own field, it may differ" is resolved: same field *name*, different
//     *location*). Buyer redirect URLs live under
//     `payment_source.paypal.experience_context.return_url`/`cancel_url` in
//     this API version, not `application_context` (that's Subscriptions-
//     API-only shape, see createSubscription above).
//   - POST /v2/checkout/orders/{id}/capture: no request body, response
//     carries the capture result nested under
//     `purchase_units[].payments.captures[]` — this repo only needs to know
//     the call succeeded (crediting quota happens off the
//     PAYMENT.CAPTURE.COMPLETED webhook, not this response), so
//     captureOrder returns just `{id, status}` off the top-level order
//     object.

export interface CreateOrderInput {
  /** Server-validated against `quota.ts`'s ONE_OFF_PRICES_GBP by the
   * caller (orders.ts) before this function is ever reached — this
   * function itself does not re-validate, same trust boundary
   * createSubscription draws around its own planId. */
  amountValue: string
  customId: string
  returnUrl?: string
  cancelUrl?: string
}

export interface CreatedOrder {
  id: string
  status: string
  links: SubscriptionLink[]
}

/** POST /v2/checkout/orders — creates an order in `CREATED` state and
 * returns the PayPal-hosted approval link (`links[].rel === 'approve'`) the
 * caller redirects the buyer to, same shape createSubscription's caller
 * already expects. */
export async function createOrder(
  apiBase: string,
  accessToken: string,
  input: CreateOrderInput,
): Promise<CreatedOrder> {
  const body: Record<string, unknown> = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        custom_id: input.customId,
        amount: { currency_code: 'GBP', value: input.amountValue },
      },
    ],
  }
  if (input.returnUrl && input.cancelUrl) {
    body.payment_source = {
      paypal: {
        experience_context: {
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
        },
      },
    }
  }
  const resp = await fetch(`${apiBase}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    throw new PayPalApiError(`create order failed: ${resp.status} ${await resp.text()}`)
  }
  return (await resp.json()) as CreatedOrder
}

/** POST /v2/checkout/orders/{id}/capture — finalises the payment for an
 * order the buyer has already approved on PayPal's hosted checkout
 * (`orders/capture.ts` calls this once the trainee returns to
 * academy-frontend). Crediting the trainee's quota balance happens off the
 * resulting PAYMENT.CAPTURE.COMPLETED webhook delivery (webhook.ts), not
 * off this response — mirrors the subscription channel's own division
 * (createSubscription doesn't credit anything either; ACTIVATED does), so
 * a trainee closing the tab after this call still gets credited once
 * PayPal's webhook lands. */
export async function captureOrder(
  apiBase: string,
  accessToken: string,
  orderId: string,
): Promise<{ id: string; status: string }> {
  const resp = await fetch(`${apiBase}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': crypto.randomUUID(),
    },
  })
  if (!resp.ok) {
    throw new PayPalApiError(`capture order failed: ${resp.status} ${await resp.text()}`)
  }
  const data = (await resp.json()) as { id: string; status: string }
  return { id: data.id, status: data.status }
}
