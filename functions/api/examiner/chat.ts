// POST /api/examiner/chat — PROJ-011/T-214 Wave A §3.2/§7.3. Server-verified,
// LLM-judged understanding check ("Examiner"), distinct from the Teacher
// (`api/tutor/chat.ts`). A new route, not a body flag on the existing one —
// design doc §7.3's own reasoning: `chat.ts` has no tool-use offering for the
// base call at all (only the library-document path uses
// proxyToGatewayWithTools), and stacking a second, independent tool-offering
// condition onto that handler is exactly the implicit-branching complexity a
// second, small, dedicated route avoids.
//
// Order mirrors chat.ts: JWT verify -> resolve trainee_id -> assertFeature-
// Entitled('examination') -> shared quota-balance check (brief decision 2:
// exam turns are NOT independently capped — they share ai_gateway_usage
// with the Teacher, and PROJ-011/ACP-448's persistent quota balance is
// likewise shared, decremented by either route without any extra wiring)
// -> resolve the active subscription.id -> proxy to the Gateway with
// RECORD_EXAMINER_VERDICT_TOOL offered -> stream back -> write the
// synchronous half of ai_gateway_usage (same table, same cap accounting).
//
// PROJ-011/ACP-448 note: unlike tutor/chat.ts, this route has never
// special-cased an access-token holder (no resolveActiveAccessToken call
// here pre-dates this brief) — that stays a pre-existing gap, out of this
// brief's scope, not something introduced here.
//
// tutor_session_id/enrolment_id/module_id are supplied by the client
// (academy-frontend opens tutor_session with mode='examine' itself — same
// client-writable INSERT the Teacher path already uses, 008's
// tutor_session_self policy) — this route re-validates enrolment ownership
// server-side immediately before the privileged write
// (executeRecordExaminerVerdict), the same "never trust a stale client-side
// check" posture executeCreateDocument already takes for personal_library.
import type { Env } from '../../_lib/env'
import { corsHeaders, handleOptions, json } from '../../_lib/env'
import { withClient } from '../../_lib/db'
import { verifyTraineeSub, AuthError } from '../../_lib/jwt'
import { verifyBetterAuthTraineeSub } from '../../_lib/betterAuthJwt'
import {
  resolveTraineeId,
  assertFeatureEntitled,
  resolveActiveSubscriptionId,
  insertUsageRow,
  backfillCost,
  executeRecordExaminerVerdict,
  ForbiddenEnrolmentError,
  UnknownTraineeError,
  NotEntitled,
} from '../../_lib/entitlement'
import { getQuotaBalance, decrementQuota } from '../../_lib/quota'
import {
  proxyToGatewayWithTools,
  recordExaminerVerdictToolOffer,
  fetchGatewayLogCost,
  GatewayError,
  type ChatRequestBody,
} from '../../_lib/gateway'

interface ExaminerChatRequestBody extends ChatRequestBody {
  enrolment_id: number
  tutor_session_id: number
}

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

  let body: ExaminerChatRequestBody
  try {
    const parsed = JSON.parse(await request.text()) as Partial<ExaminerChatRequestBody>
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
      return json({ error: 'messages required' }, 400, origin)
    }
    if (typeof parsed.enrolment_id !== 'number' || typeof parsed.tutor_session_id !== 'number') {
      return json({ error: 'enrolment_id and tutor_session_id (numbers) required' }, 400, origin)
    }
    body = {
      system: parsed.system,
      messages: parsed.messages,
      enrolment_id: parsed.enrolment_id,
      tutor_session_id: parsed.tutor_session_id,
    }
  } catch {
    return json({ error: 'invalid JSON body' }, 400, origin)
  }

  let traineeId: number
  let subscriptionId: number | null
  try {
    const gate = await withClient(env.NEON_DATABASE_URL, async (client) => {
      const resolvedTraineeId = await resolveTraineeId(client, traineeSub)
      await assertFeatureEntitled(client, traineeSub, 'examination')
      const resolvedSubscriptionId = await resolveActiveSubscriptionId(client, resolvedTraineeId)
      const quotaBalance = await getQuotaBalance(client, resolvedTraineeId)
      return { traineeId: resolvedTraineeId, subscriptionId: resolvedSubscriptionId, quotaBalance }
    })
    if (gate.quotaBalance <= 0) {
      // Shared with the Teacher (brief decision 2) — the persistent quota
      // balance is decremented by either route, no separate exam quota.
      return json(
        { error: 'quota balance exhausted — subscribe or wait for your next payment to accrue more', code: 'quota_exhausted' },
        429,
        origin,
      )
    }
    traineeId = gate.traineeId
    subscriptionId = gate.subscriptionId
  } catch (e) {
    if (e instanceof UnknownTraineeError) return json({ error: e.message }, 404, origin)
    if (e instanceof NotEntitled) return json({ error: e.message }, 403, origin)
    throw e
  }

  let gatewayResult: Awaited<ReturnType<typeof proxyToGatewayWithTools>>
  try {
    const metadata = { trainee_id: traineeId, subscription_id: subscriptionId }
    // PROJ-011/ACP-252 — see the matching comment in api/tutor/chat.ts.
    const gatewayMode = env.GATEWAY_MODE === 'mock' ? 'mock' : 'real'
    gatewayResult = await proxyToGatewayWithTools(
      env.CLOUDFLARE_ACCOUNT_ID,
      env.CLOUDFLARE_API_TOKEN,
      metadata,
      body,
      recordExaminerVerdictToolOffer((input) =>
        withClient(env.NEON_DATABASE_URL, (client) =>
          executeRecordExaminerVerdict(client, traineeId, body.enrolment_id, input, body.tutor_session_id),
        ),
      ),
      gatewayMode,
      env.GATEWAY_ID,
      env.ANTHROPIC_API_KEY_QA,
    )
  } catch (e) {
    if (e instanceof ForbiddenEnrolmentError) return json({ error: e.message }, 403, origin)
    if (e instanceof GatewayError) return json({ error: e.message }, 502, origin)
    throw e
  }

  context.waitUntil(
    (async () => {
      const usage = await gatewayResult.usage
      const gatewayLogId = gatewayResult.gatewayLogId
      const rowId = await withClient(env.NEON_DATABASE_URL, async (client) => {
        const id = await insertUsageRow(client, traineeId, subscriptionId, usage, gatewayLogId)
        // PROJ-011/ACP-448 — spend the turn off the shared persistent quota
        // balance, same as tutor/chat.ts.
        await decrementQuota(client, traineeId)
        return id
      })
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
    })().catch((e) => console.error('ai_gateway_usage write failed (examiner)', e)),
  )

  const headers = new Headers(gatewayResult.response.headers)
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v)
  return new Response(gatewayResult.response.body, { status: gatewayResult.response.status, headers })
}
