#!/usr/bin/env node
// PROJ-011/T-160 — one-time (and re-runnable) reconciliation sweep for
// `ai_gateway_usage` rows that predate this task's synchronous
// `gateway_log_id` capture (functions/_lib/gateway.ts::readGatewayLogId,
// functions/api/tutor/chat.ts), or whose async cost lookup failed to land
// (the route's own `context.waitUntil` retries a few times, then gives up
// silently — this script is the safety net for that failure mode, not the
// steady-state mechanism).
//
// Every row this route writes going forward already carries `gateway_log_id`
// at insert time (the Gateway's `cf-aig-log-id` response header, live-
// confirmed present on every inference response, 2026-08-03) and gets `cost`
// filled in within seconds via a direct `GET .../logs/{id}` lookup — no
// polling, no Cron Trigger. This script exists only for rows that predate
// that fix or that fell through the retry window, matched by the design
// doc's fallback: a narrow (trainee_id, created_at) window against the
// Gateway's logs list, cross-checked on token counts so a busy window can't
// double-match two different rows to the same log entry (brief §3).
//
// Usage: NEON_DATABASE_URL=... CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_LOGS_TOKEN=... node scripts/backfill-ai-gateway-usage.mjs [--apply]
// Without --apply, prints matches without writing (dry run).

import { Pool } from '@neondatabase/serverless'

const GATEWAY_ID = 'training-gateway'
const WINDOW_MS = 10_000 // narrow (trainee_id, created_at) match window, per t157 §3's fallback design

const apply = process.argv.includes('--apply')
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
const logsToken = process.env.CLOUDFLARE_LOGS_TOKEN
const databaseUrl = process.env.NEON_DATABASE_URL

if (!accountId || !logsToken || !databaseUrl) {
  console.error('Missing NEON_DATABASE_URL / CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_LOGS_TOKEN')
  process.exit(1)
}

async function listRecentLogs() {
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways/${GATEWAY_ID}/logs?per_page=100&order_by=created_at&order_by_direction=desc`,
    { headers: { Authorization: `Bearer ${logsToken}` } },
  )
  const body = await resp.json()
  if (!body.success) throw new Error(`logs list failed: ${JSON.stringify(body)}`)
  return body.result
}

async function main() {
  const pool = new Pool({ connectionString: databaseUrl })
  const client = await pool.connect()
  try {
    const { rows } = await client.query(
      `SELECT id, trainee_id, tokens_in, tokens_out, created_at
       FROM ai_gateway_usage
       WHERE gateway_log_id IS NULL OR cost IS NULL
       ORDER BY created_at`,
    )
    if (rows.length === 0) {
      console.log('nothing to backfill')
      return
    }

    const logs = await listRecentLogs()
    const usedLogIds = new Set()

    for (const row of rows) {
      const rowCreatedMs = new Date(row.created_at).getTime()
      const candidates = logs.filter((log) => {
        if (usedLogIds.has(log.id)) return false
        const meta = log.metadata
        if (!meta || Number(meta.trainee_id) !== Number(row.trainee_id)) return false
        if (log.tokens_in !== row.tokens_in || log.tokens_out !== row.tokens_out) return false
        return Math.abs(new Date(log.created_at).getTime() - rowCreatedMs) <= WINDOW_MS
      })

      if (candidates.length !== 1) {
        console.log(
          `row ${row.id} (trainee ${row.trainee_id}, ${row.created_at}): ${candidates.length} candidate log(s) — skipping`,
        )
        continue
      }

      const log = candidates[0]
      usedLogIds.add(log.id)
      console.log(`row ${row.id} -> log ${log.id} (cost ${log.cost})`)

      if (apply) {
        const result = await client.query(
          `UPDATE ai_gateway_usage
           SET gateway_log_id = COALESCE(gateway_log_id, $1),
               cost = COALESCE(cost, $2)
           WHERE id = $3 AND (gateway_log_id IS NULL OR cost IS NULL)
           RETURNING id, gateway_log_id, cost`,
          [log.id, log.cost, row.id],
        )
        console.log('  applied:', result.rows[0])
      }
    }
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
