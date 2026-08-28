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
    // shape a PAYMENT.SALE.COMPLETED webhook's `resource` carries.
    amount?: { total?: string; currency?: string }
  }
}

/** ACP-441 — the subscription-billing payment event, handled separately
 * from HANDLED_EVENT_TYPES/BILLING.SUBSCRIPTION.* above: its resource shape
 * is a "sale", not a "subscription" (see WebhookEvent's field comments),
 * so it can't run through extractSubscriptionFields/upsertSubscription. */
export const PAYMENT_SALE_COMPLETED = 'PAYMENT.SALE.COMPLETED'

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
