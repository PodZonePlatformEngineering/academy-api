# academy-api

PROJ-011/T-151 + T-152 — Phase 1 of `academy-api-three-tier-design-refresh.md`
§7: the subscription/billing backend for the new PayPal-billed channel
(`academy-frontend` + `academy-api`, deploying to vibecreations.net,
Phase 2). Cloudflare Pages Functions, no static assets. Schema is T-150's
(`academy-admin/migrations/039_subscription_feature_gate.sql`, live in
`red-sunset-16158933` — `subscription` + `ai_gateway_usage` tables,
`academy.is_feature_entitled`/`assert_feature_entitled`).

**Live**: `https://academy-api.pages.dev`. T-151 built the webhook-receiving
half of this channel; T-152 (this update) builds the other half —
subscription creation, the thing that actually sets PayPal's `custom_id` so
T-151's webhook handler has anything to attribute events to.

## Pages Functions vs. a plain Cloudflare Worker — decision

**Pages Functions**, per the brief's default recommendation. Reasoning:

- The entire debugging/deploy discipline this codebase already has —
  `wrangler pages deployment tail --format json` (the technique that broke
  through "no way to test an authenticated path headlessly" across
  T-141→T-147), the encrypted-Pages-secrets model, the CORS-allowlist
  pattern (`_lib/env.ts`) — is Pages-specific tooling. A bare Worker would
  need its own equivalents rediscovered from scratch for no benefit this
  brief actually needs.
- The one concrete argument *for* a bare Worker — "no static assets to
  serve" — doesn't cost anything under Pages either: this repo ships an
  empty `public/` directory as its build-output dir (Cloudflare Pages
  requires *a* directory, not a non-empty one) and Functions still work
  identically. There's no meaningful overhead from the unused static-asset
  path.
- `academy-web` (T-141) is the proven reference recipe end-to-end —
  reusing it verbatim for a second repo is strictly cheaper than
  reconsidering the shape.

No concrete reason surfaced during this build that a pure-API repo needs a
bare Worker instead — Pages Functions it is.

## `_lib` — reused and extended

| File | Status | Notes |
|---|---|---|
| `_lib/jwt.ts` | copied verbatim (T-141) | ES256 Neon Auth (Stack) JWT verification against the per-project JWKS. Not called by the webhook route (no trainee JWT on a server-to-server delivery) — wired in for the first JWT-authenticated route this repo grows (e.g. a subscription-status read for academy-frontend, Phase 2). |
| `_lib/db.ts` | copied verbatim (T-141/T-146) | One `Pool` per Pages Function invocation, never a module-level singleton — T-146 found the hard way that a cached `Pool`'s WebSocket doesn't survive past the request that created it. |
| `_lib/env.ts` | ported + trimmed | Same `Env`/`json`/`handleOptions` shape as academy-web's. `ALLOWED_ORIGINS` is empty here — no browser-facing route exists yet in this repo (see `_lib/env.ts`'s comment for when to populate it). |
| `_lib/entitlement.ts` | ported + extended (T-151, T-152, T-158) | Curriculum/track `isEntitled`/`assertEntitled` copied verbatim, **plus** `isFeatureEntitled`/`assertFeatureEntitled` (T-151, TS port of T-150's `academy.is_feature_entitled`/`assert_feature_entitled`), `resolveTraineeId` (T-152) — resolves a verified JWT `sub` to the numeric `trainee_id` `subscription.trainee_id`/PayPal's `custom_id` are keyed on, same GUC-dance shape throughout — **plus new** `resolveActiveSubscriptionId`/`insertUsageRow` (T-158). |
| `_lib/paypal.ts` | new (T-151) + extended (T-152, ACP-445) | OAuth2 client-credentials token fetch, webhook-signature verification, event-type gating, **plus** `createSubscription`/`getSubscription` (T-152), **plus** `cancelSubscription` (ACP-445). See "PayPal research" below. |
| `_lib/subscription.ts` | new + extended (ACP-445) | Pure field extraction + idempotent `subscription` upsert, **plus** `findOwnedSubscription` (ACP-445) — the self-service cancel endpoint's ownership check. |
| `_lib/turnCap.ts` | new (T-158) | `MONTHLY_TURN_CAP = 50` + `countMonthlyTurns`, the operator's T-161 rate-limit decision (a flat 50 turns/calendar month/subscription) folded into this brief. Counted off `ai_gateway_usage` — no new table. |
| `_lib/gateway.ts` | new (T-158) | Hand-rolled `fetch()` + `response.body.tee()` proxy to Cloudflare AI Gateway's `/ai/v1/messages`, plus `readGatewayUsage` (pure SSE-parsing, unit-tested). See "Inference route" below for why this isn't the `@anthropic-ai/sdk` client despite resolving the SDK's auth-header question first. |
| `_lib/email.ts` | new (ACP-444) | Resend `POST /emails` wrapper (`sendEmail`) + pure content builder (`renderOrderConfirmationEmail`), used by the webhook's `BILLING.SUBSCRIPTION.ACTIVATED` path. See "Order-confirmation email" below — **blocked on Resend domain verification**, not deployed live. |

## PayPal research — checked against current sources, not assumed

Same discipline T-150 applied to the subscription status enum: every claim
below is checked against PayPal's own current documentation/spec, not
carried over from general knowledge or the brief's illustrative text.

- **Signature verification** — `POST /v1/notifications/verify-webhook-signature`
  confirmed still current, request field names (`transmission_id`,
  `transmission_time`, `cert_url`, `auth_algo`, `transmission_sig`,
  `webhook_id`, `webhook_event`) and response shape
  (`{"verification_status": "SUCCESS" | "FAILURE"}`) confirmed against
  PayPal's own OpenAPI spec
  (`github.com/paypal/paypal-rest-api-specifications`,
  `openapi/notifications_webhooks_v1.json`), not just the docs prose —
  fetched directly 2026-08-02. `PAYPAL-TRANSMISSION-ID` /
  `PAYPAL-TRANSMISSION-TIME` / `PAYPAL-CERT-URL` / `PAYPAL-AUTH-ALGO` /
  `PAYPAL-TRANSMISSION-SIG` header names confirmed the same way.
- **OAuth2 token endpoint** — `POST /v1/oauth2/token`, `Authorization: Basic
  base64(client_id:client_secret)`, `grant_type=client_credentials` body,
  confirmed against `developer.paypal.com/api/rest/authentication/`.
- **`BILLING.SUBSCRIPTION.*` event-type names** — confirmed against
  `developer.paypal.com/api/rest/webhooks/event-names/`. The five the brief
  names (`ACTIVATED`/`UPDATED`/`CANCELLED`/`EXPIRED`/`SUSPENDED`) are all
  real, current event types. Two more real event types exist and are
  **deliberately not handled** here, matching the brief's exact scope:
  `BILLING.SUBSCRIPTION.CREATED` (fires pre-approval,
  `APPROVAL_PENDING`/`APPROVED` — doesn't change what
  `is_feature_entitled` treats as entitled) and
  `.PAYMENT.FAILED` (a dunning signal, not a status transition by itself —
  `SUSPENDED` is what actually flips once `failed_payments_count` crosses
  `payment_failure_threshold`). Both ack cleanly through the "unhandled
  event" 200 path in `webhook.ts` rather than erroring.
- **`subscription` resource field names** — confirmed against the same spec
  repo's `openapi/billing_subscriptions_v1.json`
  (`#/components/schemas/subscription`,
  `#/components/schemas/subscription_billing_info`,
  `#/components/schemas/subscription_status`). This is also where T-150's
  status enum gets an independent re-confirmation: the live schema's
  `subscription_status.status` enum is exactly
  `APPROVAL_PENDING | APPROVED | ACTIVE | SUSPENDED | CANCELLED | EXPIRED`,
  matching the decision doc.

## Webhook handler (`functions/api/paypal/webhook.ts`)

1. Read the raw body, parse as JSON.
2. Read the five `PAYPAL-*` transmission headers; 400 if any are missing.
3. Get an OAuth token, call `verify-webhook-signature`; 400 if it reports
   `FAILURE`, 502 if the call itself fails (network/PayPal-side error, not
   a bad signature).
4. If `event_type` isn't one of the five handled types, ack 200 without
   writing anything.
5. Otherwise: `extractSubscriptionFields` (pure) → `upsertSubscription`
   (idempotent — PayPal delivers at-least-once, so a duplicate delivery
   must produce the same end state, not a duplicate row or a crash).
6. `BILLING.SUBSCRIPTION.ACTIVATED` only, additionally: resolve the trainee
   row (`fields.customId` → `trainee.id`, same attribution `upsertSubscription`
   already trusts) and, if it has an email, send an order-confirmation email
   via `_lib/email.ts`. See "Order-confirmation email" below.

### Order-confirmation email (`_lib/email.ts`, PROJ-011/ACP-444)

Added as a pure side-effect of step 6 above — deliberately outside the
`withClient`/`upsertSubscription` try/catch, so a Resend failure can never
turn a successful subscription-upsert into a failed webhook ack (PayPal
would just retry an identical delivery, which fixes nothing for a
Resend-side config problem). A failure is `console.error`'d and swallowed;
the response is still `{received: true, handled: true}`.

Content (`renderOrderConfirmationEmail`) states only what the webhook
payload actually carries — no invented legal/billing language (brief §4):
plan is PayPal's own `plan_id` (no human-readable plan/pricing table exists
in academy-admin yet), amount comes from `billing_info.last_payment.amount`
(confirmed against `openapi/billing_subscriptions_v1.json`'s
`subscription_billing_info` → `last_payment_details` → `money` schemas,
2026-08-28) and is omitted, not guessed, when the event doesn't carry it
(billing_info's own doc: "If the subscription was or is active, these
fields are populated" — not a hard guarantee on every ACTIVATED delivery),
same for `next_billing_time`. Support contact is a fixed
`podzone.cloud@gmail.com` per brief §4.

**Blocked: `RESEND_FROM_ADDRESS` — domain not verified, not deployed live.**
Brief §5 named this as an explicit stop condition rather than something to
guess around. Checked live (not assumed) against the real Resend account
using the `resend-api-token` vault credential (a send-scoped key — it can't
call `GET /domains`, so this was checked by attempting a real send, the
most direct proof available):

```
POST /emails {from: "noreply@vibecreations.net", to: "podzone.cloud@gmail.com", ...}
→ 403 {"message":"The vibecreations.net domain is not verified. Please, add
   and verify your domain on https://resend.com/domains"}
```

`onboarding@resend.dev` (Resend's own shared sandbox sender, no
verification required) **does** send successfully — proven live the same
way — but using it as the production From-address for real trainee emails
is a policy call outside this brief's scope (shared/unbranded sender, not
what "noreply@vibecreations.net or similar" in brief §5 asked for), so it
wasn't substituted in. `_lib/email.ts`/webhook.ts are fully wired and unit
tested (`test/email.test.ts`) and will work the moment an operator verifies
`vibecreations.net` (or another domain) in the Resend account's
[resend.com/domains](https://resend.com/domains) and `RESEND_FROM_ADDRESS`
is set to a From-address on that domain — no code change needed.
`RESEND_API_KEY`/`RESEND_FROM_ADDRESS` are consequently **not** yet set as
Pages secrets (see Deploy runbook) — setting them now would make the
webhook silently start throwing `ResendApiError` on every ACTIVATED event
until the domain step above is done, which is exactly the "unverified
domain that will silently fail to send" brief §5 said to avoid.

### Retry-vs-drop on `UnattributedSubscriptionError` — resolved (T-152 §4)

`upsertSubscription` acks the webhook delivery with `200` (not a retryable
404/5xx) when an event carries no `custom_id` and matches no existing row —
**reconfirmed, not just carried over, now that subscription-creation
exists.** Every subscription this repo creates (`subscriptions.ts`, below)
always sets `custom_id` at `POST /v1/billing/subscriptions` time, so a real
subscription's very first *handled* webhook event already carries it (the
`INSERT ... ON CONFLICT` path). The only realistic way to still hit the
UPDATE-only/no-match branch is (a) a PayPal Webhook Simulator canned test
delivery — a fake resource id that will never correspond to a real row no
matter how many times it's retried, since the Simulator replays the same
static payload rather than re-checking PayPal's own subscription API — or
(b) a genuine data anomaly that needs a human, not an automated retry, to
fix. Neither benefits from PayPal's retry-on-non-2xx behaviour, so
ack-and-log stays the safer default; switching to a retryable status would
only risk a multi-hour retry storm against Simulator test traffic for no
upside. Full reasoning in `subscription.ts`'s `upsertSubscription` docstring.

## Subscription-creation endpoint (`functions/api/paypal/subscriptions.ts`, T-152)

`POST /api/paypal/subscriptions` — the other half of this channel T-151's
own README flagged as the missing piece ("nothing in this repo sets
`custom_id` yet"):

1. Verifies the caller's Neon Auth JWT (`_lib/jwt.ts`) — 401 if missing/invalid.
2. Resolves the real numeric `trainee_id` from the verified `sub` via
   `_lib/entitlement.ts`'s new `resolveTraineeId` (same
   `academy.current_trainee_id()` GUC dance `isFeatureEntitled` already
   uses) — never a client-supplied id. 404 if the sub has no `trainee` row.
3. Calls PayPal's `POST /v1/billing/subscriptions` with `plan_id =
   env.PAYPAL_PLAN_ID` and **`custom_id` set to that resolved `trainee_id`**
   — the entire point of this brief. Optional `returnUrl`/`cancelUrl` in the
   request body become PayPal's `application_context` (omitted entirely
   otherwise — no academy-frontend paywall page exists yet to default to,
   Phase 2).
4. Returns `{ subscriptionId, status, approvalUrl }` — `approvalUrl` is the
   `links[].rel === "approve"` HATEOAS link, PayPal's own hosted checkout
   UI, confirmed against `openapi/billing_subscriptions_v1.json`'s response
   schema/example (fetched 2026-08-02, same discipline as the rest of this
   file) rather than assumed from general knowledge.

Request/response shapes for `POST /v1/catalogs/products`, `POST
/v1/billing/plans`, and `POST`/`GET /v1/billing/subscriptions` were all
pulled directly from PayPal's own OpenAPI spec repo
(`github.com/paypal/paypal-rest-api-specifications`,
`openapi/catalogs_products_v1.json` + `openapi/billing_subscriptions_v1.json`
— there is no separate `billing_plans_v1.json`; plans live in the
subscriptions spec), not carried over from the brief's illustrative text or
general knowledge.

## Self-service cancel endpoint (`functions/api/paypal/subscription/cancel.ts`, ACP-445)

`POST /api/paypal/subscription/cancel` — the trainee-facing counterpart to
`subscriptions.ts`, same auth-dispatch/`resolveTraineeId` shape:

1. Verifies the caller's JWT (Stack or Better Auth per `env.AUTH_PRODUCT`) —
   401 if missing/invalid.
2. Resolves the caller's `trainee_id` via `resolveTraineeId` — never a
   client-supplied id.
3. Takes `paypalSubscriptionId` (required) + optional `reason` from the
   request body, then confirms that subscription actually belongs to the
   resolved `trainee_id` (`_lib/subscription.ts`'s new
   `findOwnedSubscription`, a plain `trainee_id = $2` predicate against this
   repo's own `subscription` mirror) before ever calling PayPal — 404 on no
   match, identical to "no such subscription" for both "wrong trainee" and
   "doesn't exist" so neither leaks which case it was.
4. Already-`CANCELLED`/`EXPIRED` is a 200 no-op (PayPal's own cancel
   endpoint 4xxs on an already-terminal subscription; the trainee's intent
   is already satisfied).
5. Otherwise calls PayPal's `POST /v1/billing/subscriptions/{id}/cancel`
   (`_lib/paypal.ts`'s new `cancelSubscription` — request/response shape
   confirmed against `openapi/billing_subscriptions_v1.json`'s cancel
   operation, fetched 2026-08-28: `{ reason: string }` body, `204 No
   Content` success, nothing to parse).

**This only stops future PayPal billing/quota accrual.** Per the brief's
operator decision (ACP-448, already live): `subscription.status` syncing to
`CANCELLED` happens later, asynchronously, via the existing
`BILLING.SUBSCRIPTION.CANCELLED` webhook handler (`webhook.ts`) — this
endpoint never writes `subscription.status` or `trainee_quota_balance`
itself, and `academy.is_feature_entitled` already ignores
`subscription.status` for the quota-holding OR-path (`inference`/
`examination`), so a cancelled-but-quota-holding trainee keeps access until
their accrued quota runs out, same as before this brief.

### Live verification (2026-08-28)

- **Ownership check** — proved directly against `vibecreations-training`
  (`curly-voice-88063025`) on a disposable branch (created, queried,
  deleted): inserted one `subscription` row owned by `trainee_id=2`, then
  ran `findOwnedSubscription`'s exact query as both the owning trainee
  (`trainee_id=2`, returns the row) and a different trainee
  (`trainee_id=3`, returns zero rows — the 404 path, never reaching
  PayPal). Confirms a trainee genuinely cannot address someone else's
  subscription id.
- **PayPal cancel contract** — called the VibeCreations sandbox app's real
  `POST /v1/billing/subscriptions/{id}/cancel` live (same OAuth/plan this
  repo uses, `P-3PY25649RR320045LNKFYPDI`) against a disposable test
  subscription. It 404s (`RESOURCE_NOT_FOUND`) on a subscription still in
  `APPROVAL_PENDING` — PayPal has nothing to cancel until a buyer actually
  approves it, confirmed as expected PayPal behaviour, not a bug in this
  endpoint (a trainee only ever sees the cancel UI once their subscription
  is already `ACTIVE`, i.e. already approved).
- **Not yet live-verified**: a cancel call against a genuinely `ACTIVE`
  subscription end-to-end (create → real sandbox buyer approves via hosted
  checkout → cancel → confirm PayPal's sandbox reflects `CANCELLED` → wait
  for/trigger the webhook → confirm `subscription.status` syncs and
  `is_feature_entitled('inference')` still returns true throughout). This
  needs a real PayPal sandbox buyer login completing hosted checkout
  (`e2e/subscribe.spec.ts`'s existing `PAYPAL_QA_USERNAME`/`PASSWORD`-gated
  pattern) — the vibecreations-frontend e2e spec now includes this flow
  (see `academy-frontend/e2e/subscribe.spec.ts`), but running it needs
  credentials for a sandbox buyer account scoped to the VibeCreations app
  specifically, which this session couldn't confirm exist correctly-paired
  in the secrets vault (`paypal_vibecreations-sandbox_password` has no
  obvious matching buyer *username* secret, only the app's own
  client id/secret). Flagged for the Team Lead / operator to either point
  at the right buyer credential or run `e2e/subscribe.spec.ts` once one
  exists.

### Sandbox product + plan (T-152 §1) — ids, record them here since a
sandbox plan isn't reconstructable by guessing

- **Product**: `PROD-5MD18068LS244714V` — `type: SERVICE`, `category:
  EDUCATIONAL_AND_TEXTBOOKS`.
- **Plan**: `P-6T4453632B555204CNJX4AAQ` — status `ACTIVE`, one regular
  monthly billing cycle, **GBP 1.00/month, an explicit PLACEHOLDER price**
  (sandbox region is GB per the operator's app). Not a pricing decision —
  pricing itself is parked until after the production pilot
  (`academy-api-three-tier-design-refresh.md` §3); pilot/test cohorts are
  free. This plan exists purely to unblock building/testing the
  subscription-creation flow. `env.PAYPAL_PLAN_ID` points at it (set as a
  Cloudflare Pages env var, not hardcoded, so swapping to a real priced plan
  post-pilot is a config change).

### App split: "Default" (QA) vs. "VibeCreations" (production) — ACP-411, 2026-08-24

Until 2026-08-24, `academy-api` (production) and `academy-api-qa` shared the
same PayPal sandbox app ("Default", the one above) — same
`PAYPAL_CLIENT_ID`/`SECRET`/`PLAN_ID`, only the webhook subscription
differed. ACP-410's audit flagged this as a real gap: if ACP-409's
production live-cutover ever swapped `academy-api`'s credentials without
QA getting its own app first, QA would lose its PayPal sandbox entirely.

Fixed by splitting onto the operator's two existing PayPal Developer apps:
**"Default" stays QA-only**, **"VibeCreations" becomes production's app.**
Both are still sandbox — this is an app-identity split, not the live
cutover itself (that's ACP-409, still open, tracked in the production
release plan).

New resources provisioned under the VibeCreations app (2026-08-24, same
"record here since it isn't reconstructable by guessing" reasoning as
above):

- **Product**: `PROD-9DE034977F394463W` — same `SERVICE`/
  `EDUCATIONAL_AND_TEXTBOOKS` shape as the Default app's product.
- **Plan**: `P-3PY25649RR320045LNKFYPDI` — status `ACTIVE`, identical shape
  to the Default app's plan (GBP 1.00/month placeholder, one regular
  monthly cycle). `academy-api`'s `PAYPAL_PLAN_ID` now points here;
  `academy-api-qa`'s is unchanged (still the Default app's
  `P-6T4453632B555204CNJX4AAQ`).
- **Webhook**: `4TK142903U503644J` → `academy-api.pages.dev/api/paypal/webhook`,
  registered under the VibeCreations app (a webhook belongs to one app, not
  one URL — the Default app's old production webhook,
  `7S5206055D247271W`, is now orphaned: still registered, still pointed at
  `academy-api.pages.dev`, but nothing looks it up anymore since production
  no longer authenticates as the Default app. Left in place rather than
  deleted — harmless, and trivially reproducible if ever needed).

Live-verified end to end: `POST /v1/billing/subscriptions` against the new
plan under the VibeCreations app's own OAuth token returned a real
`APPROVAL_PENDING` subscription with a working sandbox approval link.

**Still open (ACP-409, add to the production release plan)**: the operator
has a real PayPal Business account to switch production to for the actual
sandbox → live cutover. That's a distinct, much bigger step (real money,
`PAYPAL_API_BASE` → `https://api-m.paypal.com`, a real priced plan
replacing the GBP 1.00 placeholder) — this session only split the sandbox
app identity so QA doesn't share whatever happens to production next.

## Inference route (`functions/api/tutor/chat.ts`, T-158)

Phase 3 build 1 of `t157-inference-delivery-design.md` — platform-paid tutor
inference for ACTIVE subscribers, routed through `academy-api` and
Cloudflare AI Gateway instead of the trainee's own BYOK Anthropic key
(`academy-frontend`'s existing free channel, untouched by this route).

**Order**: `verifyTraineeSub` (401) -> `resolveTraineeId` (404 if unknown) ->
`assertFeatureEntitled('inference')` (403 if no ACTIVE subscription) ->
50-turn monthly cap check, the operator's T-161 rate-limit decision folded
into this brief (429, checked *before* any Gateway call — never burn a
Gateway call to reject a request) -> resolve the active `subscription.id` ->
proxy to the Gateway's `/ai/v1/messages`, `stream: true` -> stream the
response straight back -> write the synchronous half of `ai_gateway_usage`
in the background (`context.waitUntil`, doesn't delay the streamed
response).

**Request body**: `{ system?: Anthropic.TextBlockParam[] | string, messages:
Anthropic.MessageParam[] }` — the caller (task 2, `academy-frontend`'s
`tutor.ts`, not this brief) is expected to compose these exactly as it
already does for the direct-to-Anthropic BYOK path
(`composeSystemBlocks`/`composeMessages`). `model`/`max_tokens`/`thinking`/
`output_config` are **not** client-controlled — this route hardcodes them
(`_lib/gateway.ts`'s `TUTOR_MODEL`/`TUTOR_MAX_TOKENS`/
`TUTOR_THINKING_EFFORT`, mirroring `academy-frontend`'s `tutorConfig.ts`
defaults) so the turn cap's cost assumption can't be bypassed by a client
picking a pricier model or a larger token budget.

**SDK-auth-header question, resolved with evidence, not assumed** (the one
open item the design doc flagged, §2): installed
`@anthropic-ai/sdk@0.112.3` — the exact version `academy-frontend` pins —
and read `client.mjs`/`core/streaming.mjs` directly rather than trusting the
docs. Finding: the SDK's `authToken` constructor option (as opposed to
`apiKey`) drives `bearerAuth()`, which sends `Authorization: Bearer <token>`
— exactly what the Gateway's `/ai/v1/messages` endpoint expects. `apiKey`
would have sent `X-Api-Key` instead, which the Gateway does not accept here.

**Why the actual proxy call is a hand-rolled `fetch()`, not the SDK client,
despite that finding**: the SDK's higher-level streaming helper
(`MessageStream`, what `client.messages.stream()` returns) has no method
that re-emits the exact wire-format Anthropic SSE bytes it consumed — its
`toReadableStream()` (on the lower-level `Stream` class) re-serializes each
parsed event as newline-delimited JSON, not real `event:`/`data:` SSE
framing. The design doc's own recommended browser-side approach (§2, option
(a) — keep using the Anthropic SDK client-side, pointed at this route's
`baseURL`, so `tutor.ts`'s stream-parsing code barely changes) depends on
this route re-emitting byte-identical Anthropic SSE. `_lib/gateway.ts`
instead does `fetch()` + `response.body.tee()`: one branch returned
untouched as the client-facing `Response` body (true passthrough, zero
protocol-mismatch risk), the other parsed by `readGatewayUsage` (pure,
unit-tested against a hand-built fixture stream shaped like Anthropic's
documented `message_start`/`message_delta` protocol) for the token counts
`ai_gateway_usage` needs.

**`ai_gateway_usage` write** (§3's synchronous half): `model`, `tokens_in`,
`tokens_out`, `cached_tokens_in` populated from the Gateway response's own
`usage` object; `cost`/`gateway_log_id` left `NULL` — Anthropic's API (and
therefore the Gateway's Anthropic-schema-compatible response) doesn't return
dollar cost at all, only token counts. Backfilling those two fields from
`training-token-admin`'s logs endpoint is T-158's task-3 follow-on
(t157-inference-delivery-design.md §5), out of scope here.

## Live verification (T-152 §3) — what's proven, what's gated

**Deployed and live** at `https://academy-api.pages.dev` (Cloudflare Pages
project already existed with `NEON_DATABASE_URL`/`PAYPAL_CLIENT_ID`/
`PAYPAL_CLIENT_SECRET`/`PAYPAL_WEBHOOK_ID`/`PAYPAL_API_BASE`/
`STACK_PROJECT_ID` set; this session added `PAYPAL_PLAN_ID` via GET+merge+
PATCH on `deployment_configs.production.env_vars`, per T-141/T-145's
GET-merge-PATCH discipline — this PATCH shape confirmed to merge rather
than replace, unlike the whole-map-replace gotcha T-145 hit, but still
worth the GET/PATCH-then-verify pattern), then triggered a fresh deployment
(`POST .../deployments`, empty body) so the new commit + env var were
captured at deployment-creation time (T-145's snapshot-timing gotcha).
Confirmed live via curl:

- `POST /api/paypal/subscriptions` with no `Authorization` header →
  `401 {"error":"missing Authorization: Bearer token"}`.
- Same route with `Authorization: Bearer garbage.token.here` →
  `401 {"error":"token verification failed: ..."}` — genuinely verifying
  the token, not just checking for the header's presence.

**The actual proof this brief exists to deliver — `custom_id` round-trips
correctly** — verified directly against PayPal's live sandbox API (not
through the HTTP endpoint above; see the gap below) using a real
`trainee_id` (`5`, Martin Colley's own row in `red-sunset-16158933`):

```
POST /v1/billing/subscriptions {"plan_id": "P-6T4453632B555204CNJX4AAQ", "custom_id": "5"}
  -> 201 {"id": "I-N6DLWVT52HK9", "status": "APPROVAL_PENDING",
          "links": [{"rel": "approve", "href": "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-4SD863980L014440K", ...}, ...]}

GET /v1/billing/subscriptions/I-N6DLWVT52HK9
  -> 200 {"id": "I-N6DLWVT52HK9", "custom_id": "5", "plan_id": "P-6T4453632B555204CNJX4AAQ", "status": "APPROVAL_PENDING", ...}
```

`custom_id: "5"` is present on the GET-back, confirming PayPal round-trips
it exactly as set — the mechanism T-151's whole webhook-attribution path
depends on actually works, live, against PayPal's real sandbox. The
`approve` link is a genuine `sandbox.paypal.com` hosted-checkout URL, not
fabricated.

### Gap raised, not worked around: no headless Stack JWT to drive the HTTP endpoint itself

The above proves the exact PayPal mechanic (`custom_id` set at creation ->
round-trips on GET) that this brief exists to deliver, using the identical
fields/endpoint `subscriptions.ts` calls — but it was done with a direct
PayPal API call, not by POSTing a real Bearer JWT to
`https://academy-api.pages.dev/api/paypal/subscriptions` itself, because
**no way exists to mint a live Neon Auth (Stack) JWT headlessly**:
`get_neon_auth_config` (`red-sunset-16158933`) shows
`auth_methods.email_password.enabled: false` — only GitHub/Google/Microsoft
OAuth are configured, all requiring a real browser click-through. This is
the exact same gate T-141, T-145, T-078, and T-084 each independently hit
and raised — not a new problem, and not something a fake/self-signed token
can respectably stand in for (the brief is explicit: raise the gap rather
than work around it with one). `verifyTraineeSub`/`resolveTraineeId`
themselves are the same GUC-dance code already proven correct by
`isFeatureEntitled`'s own live testing (T-136/T-150) — the only genuinely
untested link is the JWT-verification step itself against a real
browser-issued token, which needs a human OAuth round-trip to produce.
**Not blocking**: everything up to that human-only step is proven live —
the endpoint correctly demands and verifies a JWT (curl proof above), and
the PayPal mechanic it drives is independently proven live (above).

### T-158 (`POST /api/tutor/chat`) hits the identical gate

Same JWT-minting gap, checked again rather than assumed stale:
`get_neon_auth_config` still shows `email_password.enabled: false`,
OAuth-only. Verified live against `https://academy-api.pages.dev/api/tutor/chat`
without a real trainee JWT, up to the point that gap allows:

- No `Authorization` header -> `401 {"error":"missing Authorization: Bearer token"}`.
- A garbage Bearer token -> `401 {"error":"token verification failed: Invalid Compact JWS"}`.
- `OPTIONS` preflight from `https://www.vibecreations.net` -> `204` with the
  same CORS headers `/api/paypal/subscriptions` returns.

The one piece that genuinely can't be proven live without a real JWT
(`assertFeatureEntitled`'s `403`, and the Gateway proxy/streaming/usage-write
happy path) is exactly the same human-OAuth-only gap above — not
independently re-derived, not worked around.

**The 50-turn cap's actual mechanism was proven live anyway**, independent of
the JWT gap, because `countMonthlyTurns`'s query only needs a `trainee_id`,
not a live request: seeded 49 then 50 `ai_gateway_usage` rows for a real
ACTIVE-subscription trainee (`trainee_id = 5`) on a disposable Neon branch
(`br-raspy-wind-abin1ibj`, created and deleted within this session — no
production data touched), and ran the exact query `_lib/turnCap.ts` issues
against each state: 49 rows -> `count = 49` (not blocked, correctly allows a
50th turn); 50 rows -> `count = 50`, `count >= MONTHLY_TURN_CAP` -> `true`
(blocks the 51st turn). This is the cap's actual gating logic, proven
against real Postgres, not just present in the code.

## T-162 — Gateway model-id fix, live-caught then live-verified

The JWT-minting gap above (`email_password.enabled: false`, OAuth-only) is
a headless limitation, not an absolute one — with a real trainee doing the
OAuth click-through and extracting the resulting Stack Auth Bearer token
from the browser's Network tab (same operator-assisted pattern as
`t157-inference-delivery-design.md`'s own account, established across
T-141/T-145/T-152/T-153), a real request reached `/api/tutor/chat` all the
way through JWT verify -> entitlement -> the 50-turn cap and hit the
Gateway proxy itself, which 502'd: `"No such model: claude-sonnet-5"`.

**Root cause, verified against current docs, not assumed**: Cloudflare's
REST API docs (`developers.cloudflare.com/ai-gateway/usage/rest-api/`)
confirm the unified `api.cloudflare.com/.../ai/v1/messages` endpoint —
despite being labelled "Anthropic-SDK-compatible" — requires the
`{provider}/{model}` prefixed form for `model`, the same convention as
`/ai/run`. This is *not* the same as the older
`gateway.ai.cloudflare.com/.../anthropic/v1/messages` endpoint, which does
accept a bare id — the two endpoints' conventions genuinely differ, so the
brief's instruction not to assume one carries over to the other was
correct to insist on. Fix: `_lib/gateway.ts`'s `TUTOR_MODEL` changed from
`'claude-sonnet-5'` to `'anthropic/claude-sonnet-5'` (commit `09cb579`,
PR #3). Deployed to production the same way T-145 established (fresh
`POST .../deployments` after merge, since Pages snapshots env/build state
at deployment-creation time, not on every request) — confirmed via the
Cloudflare API that deployment `2763e617` (commit `09cb579`) is the live
production deployment.

**Live-verified end-to-end** with a second operator-provided Bearer token
(same extraction loop, ~5 minutes): `POST /api/tutor/chat` with
`{"messages":[{"role":"user","content":"Say the single word: pong"}]}` ->
`200`, real Anthropic SSE framing (`message_start` -> `content_block_delta`
x2 -> `message_stop`), and the actual assistant text came back
(`"p"` + `"ong"` deltas) — not just "no error this time." The fix is
confirmed correct against a real Gateway call, not just against docs.

### §4 — does the failed 502'd call's usage write need correcting?

**No correction needed, confirmed by direct evidence, not just by reading
the code**: queried `ai_gateway_usage` for every row in the table before
running the live-verification request above — zero rows existed. The
502'd request that caught this bug never wrote a usage row at all, despite
the brief's working assumption that it had.

The reason is structural, not incidental: `chat.ts` only registers the
`context.waitUntil` background write (`insertUsageRow`) *after*
`proxyToGateway` returns successfully (`chat.ts` lines ~82-100).
`proxyToGateway` (`_lib/gateway.ts`) throws `GatewayError` as soon as it
sees `!upstream.ok`, before it ever tees the body or constructs the
`usage` promise — so a Gateway-side failure unwinds straight to `chat.ts`'s
`catch` block and a `502` response, never reaching the write path. The
50-turn cap is therefore also correctly unaffected by a failed call: a
turn that never produced a real answer doesn't consume any of the
trainee's 50, because nothing gets written to count.

Running the live-verification request above and re-querying confirmed the
other half of this: a *successful* call does write exactly one row
(`trainee_id: 5, subscription_id: 1, model: "claude-sonnet-5", tokens_in:
14, tokens_out: 4`) — the write path works correctly when it's supposed to
fire, and correctly doesn't when it isn't.

## ACP-437 — `academy-api-vibe-qa`'s AiGatewayError 2009 Unauthorized, fixed

Found by ACP-436 (2026-08-27) once its Better Auth JWT fix let tutor/
examiner requests reach the Gateway call on `academy-api-vibe-qa` (ACP-434's
dedicated backend for the vibe-qa frontend): the call itself 401'd,
`AiGatewayError` code 2009. No application code change was needed — the
fix is entirely CF Pages config, made in the `academy-admin` repo's
`scripts/ensure_cf_pages_vars.py` MANIFEST (PR academy-admin#112), which
this section records the live-verification of since this repo owns the
routes that were actually exercised.

**Root cause, in two layers, each confirmed live rather than assumed:**

1. `academy-api-vibe-qa` was missing `CLOUDFLARE_ACCOUNT_ID`/
   `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_LOGS_TOKEN`/`GATEWAY_ID` entirely —
   `proxyToGateway`'s `cf-aig-authorization` header was literally
   `Bearer undefined`. Confirmed by diffing this project's live CF Pages
   env vars against `academy-api-qa`'s (has all four) via the Cloudflare
   API. Fixed by adding a new `academy-api-vibe-qa` MANIFEST entry, reusing
   `academy-api-qa`'s account/`vibecreations-qa-gateway`.
2. **A second, distinct 502 surfaced immediately after fixing (1)**, caught
   only because this session insisted on a real tutor/examiner round-trip
   rather than stopping at "the 2009 is gone": Anthropic itself replied
   `authentication_error: x-api-key header is required`.
   `vibecreations-qa-gateway`'s account has no Anthropic provider key on
   file for Cloudflare Unified Billing, so a request carrying only
   `cf-aig-authorization` (no `x-api-key`) passes Gateway auth but is then
   rejected by Anthropic. Fixed by also setting `ANTHROPIC_API_KEY_QA`
   (BYOK) on `academy-api-vibe-qa`, reusing the same vault credential
   `academy-api-qa`'s own `ANTHROPIC_API_KEY_QA` was set from — that
   project never surfaced this gap itself because its `GATEWAY_MODE=mock`
   short-circuits before any real Anthropic call is made.

**A third gotcha, same class as T-162's above**: after each `--apply` of
the MANIFEST, the fix did NOT take effect until a fresh
`POST .../pages/projects/academy-api-vibe-qa/deployments` was issued —
confirmed live by GETting the *canonical* (currently-serving) deployment
directly and finding it still snapshotted the pre-fix env var set from
11:58 UTC, an hour before the `--apply` ran. Cloudflare Pages bakes env
vars into a deployment snapshot at deploy-creation time, not read live —
the same trap T-145 hit for a different project. PATCHing
`deployment_configs.production.env_vars` converges the *project config*
only; the live deployment needs a new build to pick it up.

**Live-verified end-to-end**, real signup + redemption via
`academy-frontend-vibe-qa` (same self-serve pattern ACP-436 used, redeeming
through `/#/scoreboard` — a curriculum-agnostic entitlement gate, since
vibe-qa's VibeCoding catalogue has no `academy-ai`-shaped paywall entry
point to redeem through, per ACP-435's finding):

- **Tutor** (`POST /api/tutor/chat` via the real Tutor UI): real streamed
  Anthropic reply, `· N passages retrieved` rendered — no `AiGatewayError`,
  no `x-api-key` error. (First 1-2 attempts right after signup 404'd with
  `no trainee row for sub ...` — an unrelated, transient trainee-provisioning
  race after fresh signup, not a regression of anything this fix touches;
  retrying a few seconds later succeeds.)
- **Examiner** (`POST /api/examiner/chat`, no frontend UI exists for this
  route yet — called directly with the Better Auth JWT captured off the
  Tutor request's own `Authorization` header, same token, well inside its
  15-minute TTL): `200`, real Anthropic SSE (`message_start` with real
  `usage`/`model` fields).
- **Generic Stack-Auth QA target unaffected**: `academy-api-qa`'s live CF
  Pages env vars were re-read after this fix and are byte-identical to
  before (`GATEWAY_MODE=mock` still set, no new vars) — this fix only ever
  added a new MANIFEST key for `academy-api-vibe-qa`, never touched the
  existing `academy-api-qa` entry. `e2e/sign-in.spec.ts` (2/2) and
  `e2e/home.spec.ts` re-run clean against the default
  (`academy-frontend-qa`) target.
- **Production untouched, by construction**: production's `academy-api`
  project already has its own complete Gateway vars (T-158) and was never
  in this MANIFEST change at all — read to confirm during the diagnosis,
  never modified.

## Testing — what's covered, what's genuinely blocked

Per the brief's §5 (T-151) and this update (T-152): parsing and the
`subscription` upsert are tested against fixtures built from PayPal's
confirmed schema fields (`test/fixtures/`, provenance documented in
`test/fixtures/README.md` — PayPal doesn't publish full example webhook
JSON per event type, so these are schema-accurate constructions, not
copy-pasted doc examples); `createSubscription`/`getSubscription` are
tested against a stubbed `fetch` for request-shape (`custom_id` in
particular) and response parsing. `npm test` — 21 tests, all passing:

- `test/subscription.test.ts` — field extraction across all five handled
  event types, the INSERT-vs-UPDATE branch, the `cancelled_at` CASE logic,
  and the `UnattributedSubscriptionError` path.
- `test/paypal.test.ts` — event-type gating, transmission-header parsing.
- `test/paypal-subscriptions.test.ts` — `custom_id`/`plan_id` sent
  correctly, `application_context` only included when both URLs are given,
  the `approve` link parsed out of the response, `PayPalApiError` on a
  non-2xx.

**Not unit-testable, but live-verified above instead**: `getAccessToken`,
`createSubscription`, `getSubscription` against a real PayPal call — these
were exercised directly against the live sandbox (see "Live verification"
above), which is strictly stronger proof than a mock would give.
`verifyWebhookSignature`/the webhook route's end-to-end behaviour against a
real PayPal delivery remain untested pending a live webhook delivery (T-151's
original gap — this update doesn't change that; `custom_id` attribution
itself, this update's actual scope, is proven live above).

## Deploy runbook

Live at `https://academy-api.pages.dev` (Cloudflare Pages project
`de5b7e61-677d-4dda-85fe-17de6eed2075`, same account as `academy-web`,
`c0c43e22b184f415d48ed9387c12c0aa`), GitHub-connected (`main`, auto-deploy
on push). Encrypted Pages secrets already set: `NEON_DATABASE_URL`,
`STACK_PROJECT_ID`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
`PAYPAL_WEBHOOK_ID`, `PAYPAL_API_BASE`, `PAYPAL_PLAN_ID`, and (T-158)
`CLOUDFLARE_ACCOUNT_ID` (plain-text env var, not a secret — the account id
isn't sensitive) + `CLOUDFLARE_API_TOKEN` (encrypted, the
`cloudflare-podzone-token` vault credential, scoped for the `training-gateway`
AI Gateway per T-150 §2). Not yet done (an
operator action, needs the live URL below to exist first, which it now
does):

**Not set (ACP-444, blocked):** `RESEND_API_KEY`/`RESEND_FROM_ADDRESS` — the
`resend-api-token` vault credential exists, but setting these on the `qa`
Pages project now would just make the webhook throw `ResendApiError` on
every real ACTIVATED delivery until an operator verifies a From-address
domain in the Resend account. See "Order-confirmation email" above for the
live-checked proof and exactly what unblocks this.

1. Register the webhook URL (`https://academy-api.pages.dev/api/paypal/webhook`)
   against the sandbox app in the PayPal Developer dashboard, if
   `PAYPAL_WEBHOOK_ID` doesn't already correspond to this exact URL — worth
   double-checking, not assuming, since T-151 minted it before this repo
   had a live URL to register against.
2. `wrangler pages deployment tail --format json` — same live-debugging
   technique banked across T-141→T-147, especially relevant here since
   PayPal webhooks are exactly the class of request that's hard to
   trigger/observe headlessly otherwise.

## Credential boundary — resolved

A PayPal Developer sandbox app now exists: `paypal-sandbox-client`
(Client ID) and `paypal-sandbox-key1` (Client Secret, PayPal's own
dashboard label for it) in the secrets vault, both wired into the Pages
project's `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET` env vars.
`paypal_sandbox_webhook_id` also exists (`PAYPAL_WEBHOOK_ID`) — see the
deploy runbook's item 1 for the one thing still worth confirming (that it's
registered against this repo's actual live URL). `paypal_sandbox_password`
also exists in the vault (likely a sandbox buyer/personal account login,
not an API credential — not needed for anything this update did, since
proving `custom_id` round-trips doesn't require completing the
buyer-approval flow). The only remaining gap is the JWT-minting one above,
which is an infrastructure/product gap (no password-auth method enabled on
this Neon Auth project), not a missing-credential one.
