# academy-api

PROJ-011/T-151 — Phase 1 of `academy-api-three-tier-design-refresh.md` §7:
the subscription/billing backend for the new PayPal-billed channel
(`academy-frontend` + `academy-api`, deploying to vibecreations.net,
Phase 2). Cloudflare Pages Functions, no static assets. Schema is T-150's
(`academy-admin/migrations/040_subscription_feature_gate.sql`, live in
`red-sunset-16158933` — `subscription` + `ai_gateway_usage` tables,
`academy.is_feature_entitled`/`assert_feature_entitled`).

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
| `_lib/entitlement.ts` | ported + extended | Curriculum/track `isEntitled`/`assertEntitled` copied verbatim, **plus new** `isFeatureEntitled`/`assertFeatureEntitled` — the TS port of T-150's `academy.is_feature_entitled`/`assert_feature_entitled`, same GUC-dance shape. |
| `_lib/paypal.ts` | new | OAuth2 client-credentials token fetch, webhook-signature verification, event-type gating. See "PayPal research" below. |
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

### Known gap — not this brief's scope, flagged for whoever builds Phase 2

`upsertSubscription` attributes a **new** subscription to a trainee via
PayPal's own `custom_id` field on the subscription resource (present on
every webhook for that subscription once set, not just the creation
event). Nothing in this repo *sets* `custom_id` yet — that happens when a
subscription is created (`POST /v1/billing/subscriptions`, with
`custom_id` set to the trainee's id), which is naturally academy-frontend's
"subscribe" action (Phase 2, a different repo/phase per the design doc's
own staging) calling a not-yet-built academy-api endpoint. This brief's
scope is explicitly "webhook handler → subscription writes" (§4), not the
create-subscription flow — building it now would be scope creep ahead of
Phase 2's actual UI existing to call it. Flagging it here so it isn't
mistaken for an oversight: until that endpoint exists, a fresh
`ACTIVATED` webhook with no matching row and no `custom_id` acks 200 but
logs an `UnattributedSubscriptionError` — visible in `wrangler pages
deployment tail`, not silently dropped.

## Testing — what's covered, what's genuinely blocked

Per the brief's §5: parsing and the `subscription` upsert are tested
against fixtures built from PayPal's confirmed schema fields
(`test/fixtures/`, provenance documented in
`test/fixtures/README.md` — PayPal doesn't publish full example webhook
JSON per event type, so these are schema-accurate constructions, not
copy-pasted doc examples). `npm test` — 17 tests, all passing:

- `test/subscription.test.ts` — field extraction across all five handled
  event types, the INSERT-vs-UPDATE branch, the `cancelled_at` CASE logic,
  and the `UnattributedSubscriptionError` path.
- `test/paypal.test.ts` — event-type gating, transmission-header parsing.

**Not testable without a live PayPal sandbox app** (no Client ID/Secret/
Webhook ID exists — see below): `getAccessToken`, `verifyWebhookSignature`,
and therefore the webhook route's end-to-end behaviour against a real
PayPal delivery. `npx tsc --noEmit` passes (the code compiles and
typechecks against `@cloudflare/workers-types`), but it has never made a
live call to PayPal's API.

## Deploy runbook (for whoever stands this up once credentials exist)

Not yet deployed — this brief's acceptance criteria are code-completeness,
not a live Cloudflare Pages project (unlike T-141, which explicitly
required one; nothing here can be meaningfully end-to-end tested without
live PayPal credentials regardless of whether the CF project exists).

1. `wrangler pages project create academy-api` (or via the Cloudflare
   dashboard) under the same account academy-web runs on
   (`c0c43e22b184f415d48ed9387c12c0aa`).
2. Connect this GitHub repo, build command `npm run build` (typecheck
   only — no bundle step needed, Pages compiles `functions/` itself),
   build output directory `public`.
3. Set encrypted Pages secrets: `NEON_DATABASE_URL`, `STACK_PROJECT_ID`
   (same values academy-web's Pages project already has),
   `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`,
   `PAYPAL_API_BASE` (`https://api-m.sandbox.paypal.com` first).
4. Register the webhook URL (`https://<project>.pages.dev/api/paypal/webhook`)
   against the sandbox app in the PayPal Developer dashboard — this is what
   mints `PAYPAL_WEBHOOK_ID`, so it can only happen after step 3's app
   exists.
5. `wrangler pages deployment tail --format json` — same live-debugging
   technique banked across T-141→T-147, especially relevant here since
   PayPal webhooks are exactly the class of request that's hard to
   trigger/observe headlessly otherwise.

## Credential boundary — what's needed from here

**No PayPal credential of any kind exists in the secrets vault.** Building
a real, testable integration needs a PayPal Developer sandbox app:

- **Client ID** and **Secret** (create the app in the PayPal Developer
  dashboard — this step is an operator action, not something automatable
  from here).
- **Webhook ID** — minted when the sandbox app's webhook subscription is
  registered against a reachable URL (step 4 above), so it can't exist
  before the app does and the Pages project is deployed.

Suggested secretctl naming, following the existing
`training-token-*`/`cloudflare-podzone-*` convention:
`paypal-sandbox-client-id`, `paypal-sandbox-client-secret`,
`paypal-sandbox-webhook-id`. Everything in this repo up to that boundary —
repo, `_lib` reuse/extension, signature-verification code (research-backed,
not guessed), webhook handler, fixture-based tests — is complete.
