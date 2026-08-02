// Postgres access for the assessment backend (PROJ-011/T-141) — a pooled
// WebSocket client (@neondatabase/serverless's `Pool`, not the fetch-only
// `neon()` tagged-template client) because entitlement.py's dance
// (set_config + SET LOCAL ROLE, both transaction-scoped) needs real
// session/transaction semantics, not one-shot queries.
import { Pool, type PoolClient } from '@neondatabase/serverless'

// PROJ-011/T-146: a module-level singleton `Pool` used to be cached here
// and reused across invocations. Cloudflare Pages Functions reuse a
// module's top-level scope across requests within the same isolate, but
// the driver's README is explicit that a `Pool`/`Client`'s WebSocket
// "can't outlive a single request" in serverless environments — it "must
// be connected, used and closed within a single request handler". The
// first request on a given isolate connected fine; every later request on
// that isolate reused the now-dead WebSocket and `.connect()` threw a raw,
// message-less exception (Cloudflare's generic 500, no CORS headers —
// exactly what was observed live). Fix: one `Pool` per call, torn down
// with the request.
export async function withClient<T>(
  databaseUrl: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString: databaseUrl })
  try {
    const client = await pool.connect()
    try {
      return await fn(client)
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}
