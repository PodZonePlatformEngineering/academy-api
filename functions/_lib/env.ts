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
}

// T-145's CORS pattern (academy-web's functions/_lib/env.ts) — kept here
// for the same shape, but empty for now. The PayPal webhook route never
// needs it (PayPal's servers send no Origin header, and signature
// verification — not CORS — is the actual trust boundary for that route).
// Populate this the day a browser-facing route exists in this repo (e.g. a
// subscription-status read for academy-frontend/vibecreations.net, Phase 2
// of academy-api-three-tier-design-refresh.md §7) — don't guess the origin
// now, since that Cloudflare Pages project doesn't exist yet either.
export const ALLOWED_ORIGINS: string[] = []

function corsHeaders(origin: string | null): Record<string, string> {
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
