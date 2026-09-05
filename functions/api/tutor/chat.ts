// POST /api/tutor/chat — PROJ-011/T-158, Phase 3 build 1
// (t157-inference-delivery-design.md). Platform-paid tutor inference for
// ACTIVE subscribers, routed through Cloudflare AI Gateway instead of the
// trainee's own BYOK Anthropic key (academy-frontend's existing free
// channel, untouched — this route is new and additive).
//
// Order, per the design doc §1 + the operator's T-161 rate-limit decision
// folded in 2026-08-03, superseded by ACP-448's 2026-08-28 quota-balance
// redesign: JWT verify -> resolve trainee_id -> assertFeatureEntitled
// ('inference') -> quota-balance check (persistent, non-expiring — see
// _lib/quota.ts; a token-holder's fixed lifetime budget is unchanged) ->
// resolve the active subscription.id -> proxy to the Gateway, stream back
// -> write the synchronous half of ai_gateway_usage + decrement the spent
// turn off the balance.
//
// No academy-frontend changes here (task 2 of the 3-brief breakdown,
// t157-inference-delivery-design.md §5) — this route is deliberately
// testable standalone against a real trainee JWT.
import type { Env } from '../../_lib/env'
import { corsHeaders, handleOptions, json } from '../../_lib/env'
import { withClient } from '../../_lib/db'
import { verifyTraineeSub, AuthError } from '../../_lib/jwt'
import { verifyBetterAuthTraineeSub } from '../../_lib/betterAuthJwt'
import {
  resolveTraineeId,
  assertFeatureEntitled,
  isFeatureEntitled,
  resolveActiveSubscriptionId,
  resolveActiveAccessToken,
  insertUsageRow,
  backfillCost,
  executeCreateDocument,
  UnknownTraineeError,
  NotEntitled,
} from '../../_lib/entitlement'
import { countTokenTurns } from '../../_lib/turnCap'
import { getQuotaBalance, decrementQuota } from '../../_lib/quota'
import {
  proxyToGateway,
  proxyToGatewayWithTools,
  createDocumentToolOffer,
  fetchGatewayLogCost,
  GatewayError,
  type ChatRequestBody,
} from '../../_lib/gateway'

export const onRequestOptions: PagesFunction<Env> = async (context) => handleOptions(context.request)

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context
  const origin = request.headers.get('Origin')

  let traineeSub: string
  try {
    traineeSub =
      env.AUTH_PRODUCT === 'better-auth'
        ? await verifyBetterAuthTraineeSub(request.headers.get('Authorization'), env.NEON_AUTH_URL!)
        : await verifyTraineeSub(request.headers.get('Authorization'), env.STACK_PROJECT_ID)
  } catch (e) {
    if (e instanceof AuthError) return json({ error: e.message }, 401, origin)
    throw e
  }

  let body: ChatRequestBody
  try {
    const parsed = JSON.parse(await request.text()) as Partial<ChatRequestBody>
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
      return json({ error: 'messages required' }, 400, origin)
    }
    body = { system: parsed.system, messages: parsed.messages }
  } catch {
    return json({ error: 'invalid JSON body' }, 400, origin)
  }

  let traineeId: number
  let subscriptionId: number | null
  let accessTokenId: number | null
  let hasLibraryAccess: boolean
  try {
    const gate = await withClient(env.NEON_DATABASE_URL, async (client) => {
      const resolvedTraineeId = await resolveTraineeId(client, traineeSub)
      await assertFeatureEntitled(client, traineeSub, 'inference')
      // Second, cheap check in the same withClient block already resolving
      // the inference gate above — no extra round trip (PROJ-011/T-168,
      // T-164 §2). Only if true does the Gateway request include `tools` at
      // all, so a non-entitled trainee's request is structurally tool-free.
      const resolvedLibraryAccess = await isFeatureEntitled(client, traineeSub, 'personal_library')
      const resolvedSubscriptionId = await resolveActiveSubscriptionId(client, resolvedTraineeId)
      // PROJ-011/ACP-222 — a token, not a subscription, may be what granted
      // the assertFeatureEntitled check above. A token doesn't stack with
      // the flat subscription cap: its own turn_quota replaces
      // MONTHLY_TURN_CAP entirely for a token-holder (design note in
      // academy-admin migration 064).
      const resolvedAccessToken = await resolveActiveAccessToken(client, resolvedTraineeId)
      // PROJ-011/ACP-448 — a token-holder's fixed lifetime budget stays
      // exactly as it was (turnCap.ts's countTokenTurns/turnQuota,
      // unaffected by this brief, brief §5); everyone else now gates on
      // the persistent, non-expiring quota balance (_lib/quota.ts)
      // instead of a calendar-month turn count.
      const tokenTurnCount = resolvedAccessToken ? await countTokenTurns(client, resolvedAccessToken.id) : null
      const quotaBalance = resolvedAccessToken ? null : await getQuotaBalance(client, resolvedTraineeId)
      return {
        traineeId: resolvedTraineeId,
        subscriptionId: resolvedSubscriptionId,
        accessTokenId: resolvedAccessToken?.id ?? null,
        hasLibraryAccess: resolvedLibraryAccess,
        tokenTurnCount,
        tokenTurnCap: resolvedAccessToken?.turnQuota ?? null,
        quotaBalance,
      }
    })
    if (gate.accessTokenId) {
      // Don't burn a Gateway call to reject a request (brief, T-161 fold-in).
      if (gate.tokenTurnCount! >= gate.tokenTurnCap!) {
        return json({ error: `token turn cap reached (${gate.tokenTurnCap} turns)` }, 429, origin)
      }
    } else if (gate.quotaBalance! <= 0) {
      return json(
        { error: 'quota balance exhausted — subscribe or wait for your next payment to accrue more', code: 'quota_exhausted' },
        429,
        origin,
      )
    }
    traineeId = gate.traineeId
    subscriptionId = gate.subscriptionId
    accessTokenId = gate.accessTokenId
    hasLibraryAccess = gate.hasLibraryAccess
  } catch (e) {
    if (e instanceof UnknownTraineeError) return json({ error: e.message }, 404, origin)
    if (e instanceof NotEntitled) return json({ error: e.message }, 403, origin)
    throw e
  }

  let gatewayResult: Awaited<ReturnType<typeof proxyToGateway>>
  try {
    const metadata = { trainee_id: traineeId, subscription_id: subscriptionId }
    // PROJ-011/ACP-252 — 'mock' only when the deployment's own GATEWAY_MODE
    // env var says so (the QA project); unset/anything else is 'real',
    // identical to today's production behaviour.
    const gatewayMode = env.GATEWAY_MODE === 'mock' ? 'mock' : 'real'
    gatewayResult = hasLibraryAccess
      ? await proxyToGatewayWithTools(
          env.CLOUDFLARE_ACCOUNT_ID,
          env.CLOUDFLARE_API_TOKEN,
          metadata,
          body,
          createDocumentToolOffer((input) =>
            withClient(env.NEON_DATABASE_URL, (client) => executeCreateDocument(client, traineeId, traineeSub, input)),
          ),
          gatewayMode,
          env.GATEWAY_ID,
          env.ANTHROPIC_API_KEY_QA,
        )
      : await proxyToGateway(
          env.CLOUDFLARE_ACCOUNT_ID,
          env.CLOUDFLARE_API_TOKEN,
          metadata,
          body,
          gatewayMode,
          env.GATEWAY_ID,
          env.ANTHROPIC_API_KEY_QA,
        )
  } catch (e) {
    if (e instanceof GatewayError) return json({ error: e.message }, 502, origin)
    throw e
  }

  context.waitUntil(
    (async () => {
      const usage = await gatewayResult.usage
      const gatewayLogId = gatewayResult.gatewayLogId
      const rowId = await withClient(env.NEON_DATABASE_URL, async (client) => {
        const id = await insertUsageRow(client, traineeId, subscriptionId, usage, gatewayLogId, accessTokenId)
        // PROJ-011/ACP-448 — spend the turn off the persistent quota
        // balance, not the token's fixed pool (accessTokenId holders never
        // touch trainee_quota_balance at all, brief §5). Same async-after-
        // the-fact timing insertUsageRow itself already has: the turn was
        // already served by the pre-flight balance check above, this just
        // records the spend.
        if (!accessTokenId) await decrementQuota(client, traineeId)
        return id
      })
      // Async half (T-160): cost isn't on the inference response, only on
      // the Gateway's logs endpoint, and that endpoint's indexing lags the
      // inference response by a beat under real conditions (unlike this
      // brief's own live check against a quiet gateway) — a few short
      // retries absorbs that without a separate cron/Worker.
      if (gatewayLogId) {
        for (const delayMs of [0, 1500, 3000]) {
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
          const cost = await fetchGatewayLogCost(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_LOGS_TOKEN, gatewayLogId, env.GATEWAY_ID)
          if (cost !== null) {
            await withClient(env.NEON_DATABASE_URL, (client) => backfillCost(client, rowId, cost))
            break
          }
        }
      }
    })().catch((e) => console.error('ai_gateway_usage write failed', e)),
  )

  const headers = new Headers(gatewayResult.response.headers)
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v)
  return new Response(gatewayResult.response.body, { status: gatewayResult.response.status, headers })
}
