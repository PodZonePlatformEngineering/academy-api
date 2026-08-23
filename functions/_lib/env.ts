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
  /** PROJ-011/ACP-409 follow-up — QA-only override of turnCap.ts's
   * DEFAULT_MONTHLY_TURN_CAP (production's real 50/month). Unset means
   * "use the default", production's existing behaviour, unchanged by
   * construction. Only `academy-api-qa` sets this (to 5), so quota
   * exhaustion is actually reachable in an e2e run. */
  MONTHLY_TURN_CAP?: string
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
