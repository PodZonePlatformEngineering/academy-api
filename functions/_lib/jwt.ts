// JWT verification for the assessment backend (PROJ-011/T-141).
//
// Nothing in this codebase has verified a Neon Auth (Stack) JWT server-side
// before — everywhere else, the Neon Data API's own PostgREST layer does it
// and RLS is the gate. This is the first server-side verification: ES256
// against Stack's public per-project JWKS
// (https://api.stack-auth.com/api/v1/projects/{STACK_PROJECT_ID}/.well-known/jwks.json,
// confirmed reachable — STACK_PROJECT_ID is not sensitive, already public as
// academy-web's own VITE_STACK_PROJECT_ID build var). The verified `sub`
// claim becomes `trainee_sub` — never a client-supplied body field, per the
// brief.
import { createRemoteJWKSet, jwtVerify } from 'jose'

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null
let jwksProjectId: string | null = null

function getJwks(stackProjectId: string) {
  if (!jwks || jwksProjectId !== stackProjectId) {
    jwks = createRemoteJWKSet(
      new URL(`https://api.stack-auth.com/api/v1/projects/${stackProjectId}/.well-known/jwks.json`),
    )
    jwksProjectId = stackProjectId
  }
  return jwks
}

export class AuthError extends Error {}

/** The verified trainee_sub (JWT `sub` claim) from a `Bearer <token>` header, or throws AuthError. */
export async function verifyTraineeSub(
  authHeader: string | null,
  stackProjectId: string,
): Promise<string> {
  const token = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) throw new AuthError('missing Authorization: Bearer token')
  try {
    const { payload } = await jwtVerify(token, getJwks(stackProjectId))
    if (typeof payload.sub !== 'string' || !payload.sub) {
      throw new AuthError('token has no sub claim')
    }
    return payload.sub
  } catch (e) {
    if (e instanceof AuthError) throw e
    throw new AuthError(`token verification failed: ${(e as Error).message}`)
  }
}
