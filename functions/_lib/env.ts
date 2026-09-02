// Cloudflare Pages Functions env bindings for academy-api (PROJ-011/T-151).
// Set as encrypted Pages secrets on the academy-api project — never in a
// deployed bundle (this repo ships no static assets, but the discipline is
// copied from academy-web's functions/_lib/env.ts verbatim regardless).
export interface Env {
  /** Admin Postgres DSN (podzone-training project, red-sunset-16158933) —
   * same resource academy-web's functions/_lib/db.ts and
   * academy-admin's neon_dsn.resolve_dsn() use. */
  NEON_DATABASE_URL: string
  /** Neon Auth (Stack) project id — public-by-design, mirrors academy-web's
   * VITE_STACK_PROJECT_ID. Not used by the PayPal webhook route itself (no
   * trainee session on a server-to-server delivery) but wired here so any
   * future JWT-authenticated route (e.g. a subscription-status endpoint for
   * academy-frontend, Phase 2) can call verifyTraineeSub without a second
   * env shape. */
  STACK_PROJECT_ID: string
  /** PROJ-011/ACP-434 — 'better-auth' selects betterAuthJwt.ts's verifier
   * instead of jwt.ts's Stack one for the browser-facing PayPal routes
   * (mirrors academy-web's functions/_lib/env.ts AUTH_PRODUCT switch,
   * ACP-428). Unset means "verify as Stack", the existing behaviour,
   * unchanged by construction. */
  AUTH_PRODUCT?: string
  /** Neon Managed Better Auth base URL (get_neon_auth_config's `base_url`,
   * e.g. `.../neondb/auth`) — only required when AUTH_PRODUCT is
   * 'better-auth'. */
  NEON_AUTH_URL?: string
  /** PayPal REST app credentials (sandbox first) — does not exist yet, see
   * README's credential-boundary note. Client-credentials OAuth against
   * PAYPAL_API_BASE, per _lib/paypal.ts. */
  PAYPAL_CLIENT_ID: string
  PAYPAL_CLIENT_SECRET: string
  /** The webhook subscription's own id (minted by PayPal when a webhook URL
   * is registered against the app) — required by
   * verify-webhook-signature. Does not exist yet either; registering a
   * webhook is itself blocked on the sandbox app existing. */
  PAYPAL_WEBHOOK_ID: string
  /** https://api-m.sandbox.paypal.com (sandbox) or https://api-m.paypal.com
   * (live) — the environment switch, not a secret, but env-scoped so a
   * single codebase serves both without a code change. */
  PAYPAL_API_BASE: string
  /** The sandbox billing plan (PROJ-011/T-152) subscriptions.ts creates
   * subscriptions against — `P-6T4453632B555204CNJX4AAQ`, GBP 1.00/month,
   * an explicit PLACEHOLDER price (not a pricing decision, see README).
   * Env-scoped, not hardcoded, so swapping to a real priced plan post-pilot
   * is a config change, not a code change. */
  PAYPAL_PLAN_ID: string
  /** Cloudflare account id the `training-gateway` AI Gateway (T-150/T-157)
   * lives under — the `{account_id}` path segment in the Gateway's
   * `/ai/v1/messages` REST endpoint. Not a secret, but env-scoped like every
   * other account identifier here (T-158). */
  CLOUDFLARE_ACCOUNT_ID: string
  /** Cloudflare API token authorized against the AI Gateway (T-150 §2 —
   * `cloudflare-podzone-token`), sent as `Authorization: Bearer` (T-158's
   * resolved SDK-auth-header question: the Gateway's `/ai/v1/messages`
   * endpoint expects Bearer, not `X-Api-Key`). */
  CLOUDFLARE_API_TOKEN: string
  /** `training-token-admin` (T-150 §6 item 4, T-160) — a *different*
   * Cloudflare API token, scoped to the AI Gateway's logs/analytics
   * endpoint (`GET .../ai-gateway/gateways/{gw}/logs`), not the invoke
   * endpoint `CLOUDFLARE_API_TOKEN` covers. Used only to backfill
   * `ai_gateway_usage.cost`, which isn't present on the inference response
   * itself (Anthropic's schema has no dollar figure). */
  CLOUDFLARE_LOGS_TOKEN: string
  /** PROJ-011/ACP-252 — QA cost-control switch (proposal §2.5). Unset (or
   * any value other than 'mock') means "call the real Gateway", the
   * existing production behaviour, unchanged by construction. Only the
   * `academy-api-qa` Pages project sets this to 'mock', so
   * `functions/_lib/gateway.ts` returns a canned SSE response instead of
   * spending real Anthropic/Gateway tokens on QA traffic. */
  GATEWAY_MODE?: string
  /** PROJ-011/ACP-448 — QA-only override of quota.ts's
   * DEFAULT_QUOTA_GRANT_AMOUNT (production's real 50/payment). Unset means
   * "use the default", production's existing behaviour, unchanged by
   * construction. Supersedes ACP-409's MONTHLY_TURN_CAP (the old flat
   * monthly-cap mechanism this brief replaces) — same QA-reachability
   * purpose, now expressed as "how much a sandbox payment credits" rather
   * than "how high the count is allowed to go", since the gate itself is no
   * longer a count. Only `academy-api-qa`/`academy-api-vibe-qa` set this
   * (to a small number), so quota exhaustion is actually reachable in an
   * e2e run without waiting on 50 real chat turns. */
  QUOTA_GRANT_AMOUNT?: string
  /** PROJ-011 (2026-08-24) — QA cost-separation: overrides `TUTOR_GATEWAY_ID`
   * ('training-gateway') with a second, dedicated Cloudflare AI Gateway
   * (vibecreations-branded, e.g. 'vibecreations-qa-gateway') so QA's Gateway
   * logs/analytics — and, once ANTHROPIC_API_KEY_QA is also set, its actual
   * Anthropic spend — are never mixed into production's 'training-gateway'
   * numbers. Only `academy-api-qa` sets this; unset elsewhere falls back to
   * `TUTOR_GATEWAY_ID` unchanged. */
  GATEWAY_ID?: string
  /** PROJ-011 (2026-08-24) — a real Anthropic API key (BYOK), set only on
   * `academy-api-qa`, paired with GATEWAY_ID above. Production never sets
   * this and keeps using Cloudflare Unified Billing (CLOUDFLARE_API_TOKEN's
   * `cf-aig-authorization` alone, no `x-api-key`) — Anthropic bills this
   * key directly, so QA's Anthropic-side cost reporting reads separately
   * from production's Cloudflare-account Unified Billing spend. */
  ANTHROPIC_API_KEY_QA?: string
  /** PROJ-011/ACP-444 — Resend API key (`resend-api-token` vault
   * credential), used by `_lib/email.ts` to send the order-confirmation
   * email from the BILLING.SUBSCRIPTION.ACTIVATED webhook path. */
  RESEND_API_KEY: string
  /** PROJ-011/ACP-444 — the verified From address `_lib/email.ts` sends
   * with. Env-scoped, not hardcoded, because the domain has to be verified
   * in the Resend account before any real send will succeed — see
   * README's credential-boundary section for the current verification
   * status. */
  RESEND_FROM_ADDRESS: string
}

// T-145's CORS pattern (academy-web's functions/_lib/env.ts). The PayPal
// webhook route never needs this (PayPal's servers send no Origin header,
// and signature verification — not CORS — is the actual trust boundary for
// that route) — but POST /api/paypal/subscriptions (T-152) is browser-facing
// from academy-frontend, deployed at vibecreations.net (T-153) — both the
// apex and www hosts serve the site live (academy-frontend-vibe's Pages
// domains: vibecreations.net, www.vibecreations.net), so both must be
// listed or a bare-apex visitor's requests silently CORS-fail with no
// error detail beyond "Failed to fetch" (academy-frontend#64, 2026-08-16 —
// confirmed live via a captured OPTIONS preflight whose Origin was the bare
// apex, which this list didn't match). academy-frontend-vibe.pages.dev
// added too, matching academy-web's own ALLOWED_ORIGINS convention of also
// listing the raw .pages.dev project URL for direct testing.
export const ALLOWED_ORIGINS: string[] = [
  'https://vibecreations.net',
  'https://www.vibecreations.net',
  'https://academy-frontend-vibe.pages.dev',
  // PROJ-011/ACP-252 — the QA app instance's own origin (proposal §2.4:
  // "CORS scoped to exactly the QA app's origin"). Harmless to list
  // alongside production origins here since this array is already a strict
  // allowlist, not a wildcard.
  'https://academy-frontend-qa.pages.dev',
  // PROJ-011/ACP-434 — the VibeCreations-branded QA app instance's own
  // origin (ACP-426). Missing here was the actual root cause of ACP-434's
  // "Failed to fetch" bug: academy-frontend-vibe-qa's fetch to
  // POST /api/paypal/subscriptions never got a CORS-approved response, so
  // the browser surfaced a bare network-error TypeError with no status
  // code or body to show — exactly this module's own doc comment above
  // already predicted for any unlisted origin.
  'https://academy-frontend-vibe-qa.pages.dev',
  // PROJ-011/ACP-473 — the QA custom-domain host qa.vibecreations.net
  // actually serves academy-frontend-vibe-qa from (distinct from the raw
  // academy-frontend-vibe-qa.pages.dev project URL already listed above).
  // Missing here was the root cause of a live "Failed to fetch"/CORS
  // preflight failure from the real QA custom domain against
  // /api/tutor/chat and /api/examiner/chat.
  'https://qa.vibecreations.net',
  // PROJ-011/ACP-441 — academy-gui, the admin console POST /api/admin/refund
  // is served for (both CF Pages projects, admin.podzone.academy's and
  // admin.vibecreations.net's own custom domains plus their raw .pages.dev
  // URLs, same "list every serving origin" discipline as the frontend
  // entries above — deploy.yml deploys exactly these two projects, both
  // `--branch main`).
  'https://admin.podzone.academy',
  'https://academy-gui.pages.dev',
  'https://admin.vibecreations.net',
  'https://academy-gui-vibe.pages.dev',
  // PROJ-011/ACP-475 — the QA admin console instance, sibling gap to
  // ACP-473/474: academy-gui-vibe-qa's own .pages.dev URL plus its
  // adminqa.vibecreations.net custom domain (confirmed live via a
  // Cloudflare Pages API sweep of the academy-gui-vibe-qa project) were
  // both missing here, so a QA admin refund call would CORS-fail exactly
  // like ACP-473/474 did before their fixes.
  'https://academy-gui-vibe-qa.pages.dev',
  'https://adminqa.vibecreations.net',
]

export function corsHeaders(origin: string | null): Record<string, string> {
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
  }
  return {}
}

export function json(body: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  })
}

// Shared OPTIONS preflight handler, same shape as academy-web's — unused by
// the webhook route (no browser preflight for a server-to-server POST) but
// kept ready for the first browser-facing route.
export function handleOptions(request: Request): Response {
  const origin = request.headers.get('Origin')
  const headers = corsHeaders(origin)
  if (!headers['Access-Control-Allow-Origin']) return new Response(null, { status: 204 })
  return new Response(null, {
    status: 204,
    headers: {
      ...headers,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  })
}
