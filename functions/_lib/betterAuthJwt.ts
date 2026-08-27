// Better Auth JWT verification (PROJ-011/ACP-434) — the 'better-auth'
// counterpart to jwt.ts's verifyTraineeSub, ported verbatim from
// academy-web's functions/_lib/betterAuthJwt.ts (ACP-428). Same `Bearer
// <token>` header contract and `sub`-claim result, different JWKS: Neon
// Managed Better Auth serves JWKS at `{base_url}/.well-known/jwks.json`
// (base_url = get_neon_auth_config's `base_url`, e.g. `.../neondb/auth` —
// NOT bare Better Auth jwt-plugin default `{base_url}/jwks`), signed EdDSA
// (Ed25519), 15-minute TTL.
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { AuthError } from './jwt'

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null
let jwksAuthUrl: string | null = null

function getJwks(authUrl: string) {
  if (!jwks || jwksAuthUrl !== authUrl) {
    jwks = createRemoteJWKSet(new URL(`${authUrl}/.well-known/jwks.json`))
    jwksAuthUrl = authUrl
  }
  return jwks
}

/** The verified trainee_sub (JWT `sub` claim) from a `Bearer <token>` header, or throws AuthError. */
export async function verifyBetterAuthTraineeSub(
  authHeader: string | null,
  authUrl: string,
): Promise<string> {
  const token = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) throw new AuthError('missing Authorization: Bearer token')
  try {
    const { payload } = await jwtVerify(token, getJwks(authUrl), {
      issuer: new URL(authUrl).origin,
    })
    if (typeof payload.sub !== 'string' || !payload.sub) {
      throw new AuthError('token has no sub claim')
    }
    return payload.sub
  } catch (e) {
    if (e instanceof AuthError) throw e
    throw new AuthError(`token verification failed: ${(e as Error).message}`)
  }
}
