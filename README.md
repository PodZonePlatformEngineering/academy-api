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
| `_lib/entitlement.ts` | ported + extended (T-151, T-152) | Curriculum/track `isEntitled`/`assertEntitled` copied verbatim, **plus** `isFeatureEntitled`/`assertFeatureEntitled` (T-151, TS port of T-150's `academy.is_feature_entitled`/`assert_feature_entitled`) **plus new** `resolveTraineeId` (T-152) — resolves a verified JWT `sub` to the numeric `trainee_id` `subscription.trainee_id`/PayPal's `custom_id` are keyed on, same GUC-dance shape throughout. |
| `_lib/paypal.ts` | new (T-151) + extended (T-152) | OAuth2 client-credentials token fetch, webhook-signature verification, event-type gating, **plus** `createSubscription`/`getSubscription` (T-152). See "PayPal research" below. |
| `_lib/subscription.ts` | new | Pure field extraction + idempotent `subscription` upsert. |

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
`PAYPAL_WEBHOOK_ID`, `PAYPAL_API_BASE`, `PAYPAL_PLAN_ID`. Not yet done (an
operator action, needs the live URL below to exist first, which it now
does):

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
