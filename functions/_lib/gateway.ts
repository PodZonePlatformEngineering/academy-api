// PROJ-011/T-158 — proxy to Cloudflare AI Gateway's Anthropic-SDK-compatible
// `/ai/v1/messages` endpoint (t157-inference-delivery-design.md §2).
//
// SDK-auth-header question (§2's flagged open item), resolved with evidence:
// installed @anthropic-ai/sdk@0.112.3 (the exact version academy-frontend
// pins) and read `core/streaming.mjs`/`client.mjs` directly. The `authToken`
// constructor option (as opposed to `apiKey`) drives `bearerAuth()`, which
// sends `Authorization: Bearer <token>` — exactly the header the Gateway's
// `/ai/v1/messages` endpoint documents. `apiKey` would have sent `X-Api-Key`
// instead, which the Gateway does not accept for this endpoint.
//
// Despite that, this module hand-rolls the HTTP call with `fetch()` rather
// than constructing an `Anthropic` SDK client, for a reason the design doc's
// own pseudocode glossed over: the SDK's higher-level streaming helper
// (`MessageStream`) has no method that re-emits the exact wire-format
// Anthropic SSE bytes it consumed — its own `toReadableStream()` (on the
// lower-level `Stream` class) re-serializes each parsed event as
// newline-delimited JSON, not `event:`/`data:` SSE framing. The design doc's
// recommended browser-side approach (§2, option (a)) requires this route to
// re-emit byte-identical Anthropic SSE so the browser's own Anthropic SDK
// stream parser keeps working unmodified — a hand-rolled passthrough
// (`response.body.tee()`, one branch returned untouched, the other parsed
// for usage) is what actually delivers that, not a smaller build than the
// SDK would have been.
// PROJ-011/T-163 — moved off the unified `api.cloudflare.com/.../ai/v1/messages`
// endpoint onto the provider-native `gateway.ai.cloudflare.com/v1/{account}/
// {gateway}/anthropic/v1/messages` endpoint. Root cause (live-caught 502,
// verified against current Cloudflare docs 2026-08-03, not assumed): the
// unified endpoint is a normalized/translated shim over multiple providers
// (hence needing the `{provider}/{model}` prefix below, T-162) — it rejects
// `system` as an array of content blocks (`Invalid input: expected string,
// received array`), which silently drops `academy-frontend`'s T-114/T-115
// 1-hour prompt-cache breakpoint (`cache_control` lives on those array
// blocks; a string `system` has nowhere to carry it). Cloudflare's docs for
// the unified endpoint never mention `cache_control` or Anthropic prompt
// caching at all — only Gateway-level HTTP response caching (`cf-aig-*`
// headers), a different feature. The provider-native endpoint's own docs
// (`developers.cloudflare.com/ai-gateway/usage/providers/anthropic/`) show
// it built by pointing the real `Anthropic` SDK's `baseURL` at the gateway —
// a true schema passthrough, not a shim — so it takes the bare model id (no
// provider prefix) and, live-tested against this account/gateway 2026-08-03
// with the exact production body (array `system` + `cache_control` +
// `thinking`/`output_config` + `stream: true`), returned real
// `cache_creation_input_tokens`/`cache_read_input_tokens` on write/read —
// caching genuinely works here. Auth differs too: Unified Billing on this
// endpoint is `cf-aig-authorization: Bearer <token>` (not `Authorization`),
// confirmed live with the same `CLOUDFLARE_API_TOKEN` already deployed — no
// new secret needed.
export const TUTOR_GATEWAY_ID = 'training-gateway'
export const TUTOR_MODEL = 'claude-sonnet-5'
export const TUTOR_MAX_TOKENS = 8192
export const TUTOR_THINKING_EFFORT = 'medium'

export class GatewayError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface GatewayUsage {
  model: string | null
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

/**
 * PROJ-011/T-160 — the `cf-aig-log-id` response header question, resolved
 * with evidence (t157-inference-delivery-design.md §3's flagged open item):
 * live-checked 2026-08-03 against this account/gateway, both non-streaming
 * and `stream: true` requests. The header is present on both. This means
 * `gateway_log_id` never needs a backfill at all — it's known the moment
 * the Gateway response headers arrive, before the body is even read.
 */
export function readGatewayLogId(headers: Headers): string | null {
  return headers.get('cf-aig-log-id')
}

/**
 * Read Anthropic-shaped SSE off a (possibly tee'd) stream and pull the usage
 * totals out of it. Anthropic's streaming protocol (unchanged by Gateway
 * routing, per §2's schema-compatibility finding): `message_start` carries
 * the message's initial `usage` (`input_tokens`,
 * `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`
 * starts at 0 there); one or more `message_delta` events carry the
 * cumulative `output_tokens` as generation proceeds, so the last one seen
 * before the stream ends is the final count.
 */
export async function readGatewayUsage(stream: ReadableStream<Uint8Array>): Promise<GatewayUsage> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const usage: GatewayUsage = { model: null, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }

  const consumeEvent = (rawEvent: string) => {
    const dataLine = rawEvent.split('\n').find((l) => l.startsWith('data:'))
    if (!dataLine) return
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(dataLine.slice(5).trim())
    } catch {
      return
    }
    if (parsed.type === 'message_start') {
      const message = parsed.message as Record<string, unknown> | undefined
      const msgUsage = message?.usage as Record<string, unknown> | undefined
      usage.model = (message?.model as string) ?? usage.model
      usage.inputTokens = (msgUsage?.input_tokens as number) ?? usage.inputTokens
      usage.cacheCreationTokens = (msgUsage?.cache_creation_input_tokens as number) ?? usage.cacheCreationTokens
      usage.cacheReadTokens = (msgUsage?.cache_read_input_tokens as number) ?? usage.cacheReadTokens
      usage.outputTokens = (msgUsage?.output_tokens as number) ?? usage.outputTokens
    } else if (parsed.type === 'message_delta') {
      const deltaUsage = parsed.usage as Record<string, unknown> | undefined
      if (typeof deltaUsage?.output_tokens === 'number') usage.outputTokens = deltaUsage.output_tokens as number
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      consumeEvent(buffer.slice(0, idx))
      buffer = buffer.slice(idx + 2)
    }
  }
  if (buffer.trim()) consumeEvent(buffer)
  return usage
}

export interface ChatRequestBody {
  system?: unknown
  messages: unknown[]
}

// PROJ-011/T-168 (T-164 §2) — tool use, wired without touching the existing
// tee-passthrough `proxyToGateway` above, which stays exactly as-is for any
// caller that never offers tools (T-158/T-160/T-163's proven byte-passthrough
// behaviour must not regress). See t164-personal-library-group-discussion-
// design.md §2 in full for the reasoning this implements: Anthropic only
// reveals `stop_reason: "tool_use"` near the END of a stream, well after any
// `tool_use` content block's `input_json_delta` events have already gone out
// — a naive tee would leak an unrenderable block to the browser and finish
// the client SDK's stream while the server still owes a real answer. The fix
// is a first-content-block-peek: read up to the first DECISIVE
// `content_block_start` (skipping past `thinking`/`redacted_thinking` blocks,
// which can legitimately precede the real one per T-163's `thinking` request
// param) and branch there instead of waiting for `stop_reason`.

export const CREATE_DOCUMENT_TOOL = {
  name: 'create_document',
  description:
    "Create a document in the trainee's personal library, visible only to " +
    'them unless they choose to share it.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      content: { type: 'string', description: 'Markdown.' },
    },
    required: ['title', 'content'],
  },
} as const

const CREATE_DOCUMENT_TOOL_CONVENTION =
  'You have a create_document tool that saves a document to the ' +
  "trainee's personal library. If you decide to call it, call it " +
  'immediately with no preceding commentary — explain what you did in ' +
  'your next reply, after the tool result comes back.'

// PROJ-011/T-214 — a second tool offered by the same interception loop
// (design doc §3.2: "reuse this exact mechanism... rather than inventing a
// second way to get a privileged write out of an LLM turn"). Offered only by
// the Examiner route (api/examiner/chat.ts), never api/tutor/chat.ts.
export const RECORD_EXAMINER_VERDICT_TOOL = {
  name: 'record_examiner_verdict',
  description: 'Record the final pass/fail verdict for this examination. Call exactly once, at the end of the exam.',
  input_schema: {
    type: 'object',
    properties: {
      module_id: { type: 'string' },
      passed: { type: 'boolean' },
      criteria: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            met: { type: 'boolean' },
            rationale: { type: 'string' },
          },
          required: ['name', 'met', 'rationale'],
        },
      },
      overall_rationale: { type: 'string' },
    },
    required: ['module_id', 'passed', 'criteria', 'overall_rationale'],
  },
} as const

const RECORD_EXAMINER_VERDICT_TOOL_CONVENTION =
  'You have a record_examiner_verdict tool. Work through this module’s ' +
  'rubric criteria across the conversation; when you are ready to render a ' +
  'final pass/fail verdict, call the tool exactly once with no preceding ' +
  'commentary — the tool call is the verdict of record, not any text you ' +
  'write. Do not announce a verdict in chat text before calling it.'

export type ToolName = typeof CREATE_DOCUMENT_TOOL.name | typeof RECORD_EXAMINER_VERDICT_TOOL.name

export interface ToolOffer {
  tool: { name: string; description: string; input_schema: Record<string, unknown> }
  convention: string
  execute: (input: unknown) => Promise<string>
}

/**
 * Append the tool-use convention as an extra system block, never mutate the
 * existing one(s). Appending AFTER whatever the client sent preserves
 * academy-frontend's T-114 cache breakpoint on its own block untouched — the
 * cached prefix is unchanged, this is new uncached content tacked onto the
 * end, not a rewrite of the cached content.
 */
function withToolConvention(system: unknown, convention: string): unknown {
  const appendix = { type: 'text', text: convention }
  if (Array.isArray(system)) return [...system, appendix]
  if (typeof system === 'string') return [{ type: 'text', text: system }, appendix]
  return [appendix]
}

function addUsage(a: GatewayUsage, b: GatewayUsage): GatewayUsage {
  return {
    model: b.model ?? a.model,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  }
}

async function fetchGatewayStream(
  accountId: string,
  apiToken: string,
  metadata: { trainee_id: number; subscription_id: number | null },
  requestBody: Record<string, unknown>,
): Promise<Response> {
  const upstream = await fetch(
    `https://gateway.ai.cloudflare.com/v1/${accountId}/${TUTOR_GATEWAY_ID}/anthropic/v1/messages`,
    {
      method: 'POST',
      headers: {
        'cf-aig-authorization': `Bearer ${apiToken}`,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'cf-aig-metadata': JSON.stringify(metadata),
        'User-Agent': 'academy-api/1.0 (+academy-api.pages.dev)',
      },
      body: JSON.stringify({
        model: TUTOR_MODEL,
        max_tokens: TUTOR_MAX_TOKENS,
        thinking: { type: 'adaptive' },
        output_config: { effort: TUTOR_THINKING_EFFORT },
        stream: true,
        ...requestBody,
      }),
    },
  )
  if (!upstream.ok || !upstream.body) {
    throw new GatewayError(upstream.status, await upstream.text())
  }
  return upstream
}

interface PeekCommon {
  reader: ReadableStreamDefaultReader<Uint8Array>
  decoder: TextDecoder
  leftoverBuffer: string
}

type PeekResult =
  | (PeekCommon & { kind: 'passthrough'; prefixText: string })
  | (PeekCommon & { kind: 'tool_use'; contentBlock: { id: string; name: string } })

/**
 * Read raw SSE off `stream` up to and including the first DECISIVE
 * `content_block_start` event — decisive meaning `type: 'tool_use'` (branch
 * to server-side interception) or anything else that isn't `thinking`/
 * `redacted_thinking` (branch to passthrough; checking `!== 'thinking' &&
 * !== 'redacted_thinking'` rather than `=== 'text'` per the design's flagged
 * off-by-one, so a future third content-block type doesn't get silently
 * misrouted into the interception path either).
 *
 * Honest limitation carried over from the design doc: this only works
 * because the system prompt makes "tool call first, no preceding text" the
 * only shape a tool-calling turn can take. If the model ever violates that
 * convention and emits text before a `tool_use` block, this function still
 * only branches on the FIRST content block — a leading `text` block would
 * make this passthrough (correct: nothing broke, the model just didn't call
 * the tool first this turn, no tool call happens). The failure mode the
 * design accepts as degraded-not-broken is the reverse (impossible for
 * `create_document`'s single-tool case since there's only one thing to lead
 * with) — flagging precisely rather than asserting a stronger guarantee than
 * the code actually provides.
 */
async function peekFirstContentBlock(stream: ReadableStream<Uint8Array>): Promise<PeekResult> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let prefixText = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) return { kind: 'passthrough', prefixText, reader, decoder, leftoverBuffer: buffer }
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx + 2)
      buffer = buffer.slice(idx + 2)
      prefixText += rawEvent
      const dataLine = rawEvent.split('\n').find((l) => l.startsWith('data:'))
      if (!dataLine) continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(dataLine.slice(5).trim())
      } catch {
        continue
      }
      if (parsed.type !== 'content_block_start') continue
      const contentBlock = parsed.content_block as Record<string, unknown> | undefined
      const blockType = contentBlock?.type
      if (blockType === 'thinking' || blockType === 'redacted_thinking') continue // not decisive, keep reading
      if (blockType === 'tool_use') {
        return {
          kind: 'tool_use',
          contentBlock: { id: contentBlock?.id as string, name: contentBlock?.name as string },
          reader,
          decoder,
          leftoverBuffer: buffer,
        }
      }
      return { kind: 'passthrough', prefixText, reader, decoder, leftoverBuffer: buffer }
    }
  }
}

/** Consume the rest of a tool-use round server-side (never forwarded to the
 * client — §2's "do NOT forward anything to the client yet"), accumulating
 * `input_json_delta` into the tool call's full JSON input, the same
 * event-parsing pattern `readGatewayUsage` already uses for a different
 * field. Returns once `message_stop` closes the round.
 */
async function consumeToolUseRound(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  initialBuffer: string,
): Promise<unknown> {
  let buffer = initialBuffer
  let inputJson = ''
  const finish = () => {
    reader.cancel().catch(() => {})
    if (!inputJson.trim()) return {}
    try {
      return JSON.parse(inputJson)
    } catch {
      return {}
    }
  }

  while (true) {
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx + 2)
      buffer = buffer.slice(idx + 2)
      const dataLine = rawEvent.split('\n').find((l) => l.startsWith('data:'))
      if (!dataLine) continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(dataLine.slice(5).trim())
      } catch {
        continue
      }
      if (parsed.type === 'content_block_delta') {
        const delta = parsed.delta as Record<string, unknown> | undefined
        if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          inputJson += delta.partial_json
        }
      } else if (parsed.type === 'message_stop') {
        return finish()
      }
    }
    const { done, value } = await reader.read()
    if (done) return finish()
    buffer += decoder.decode(value, { stream: true })
  }
}

function buildPassthroughStream(peek: Extract<PeekResult, { kind: 'passthrough' }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const { reader, prefixText, leftoverBuffer } = peek
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (prefixText || leftoverBuffer) controller.enqueue(encoder.encode(prefixText + leftoverBuffer))
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        controller.enqueue(value)
      }
      controller.close()
    },
    cancel() {
      reader.cancel().catch(() => {})
    },
  })
}

const ZERO_USAGE: GatewayUsage = { model: null, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }

/**
 * Tool-offering counterpart to `proxyToGateway` — §2's bounded (2-round)
 * loop. Round 1 offers `tools: [CREATE_DOCUMENT_TOOL]` with `tool_choice:
 * auto`; if that round is tool-first, the tool executes server-side and a
 * second, FINAL round is issued with `tool_choice: { type: 'none' }` —
 * Anthropic's documented mechanism to guarantee a tool-free (and therefore
 * tee-safe) reply, closing the loop deterministically. Any ordinary
 * (non-tool) turn resolves on round 1 with only a first-content-block-peek
 * of added latency, then splices into true passthrough exactly like
 * `proxyToGateway` — the common case pays no meaningful cost.
 */
export async function proxyToGatewayWithTools(
  accountId: string,
  apiToken: string,
  metadata: { trainee_id: number; subscription_id: number | null },
  body: ChatRequestBody,
  offer: ToolOffer,
): Promise<{ response: Response; usage: Promise<GatewayUsage>; gatewayLogId: string | null }> {
  const system = withToolConvention(body.system, offer.convention)
  let messages = body.messages
  let gatewayLogId: string | null = null
  const roundUsages: Promise<GatewayUsage>[] = []

  for (let round = 0; round < 2; round++) {
    const finalRound = round === 1
    const upstream = await fetchGatewayStream(accountId, apiToken, metadata, {
      system,
      messages,
      ...(finalRound ? { tool_choice: { type: 'none' } } : { tools: [offer.tool], tool_choice: { type: 'auto' } }),
    })
    if (gatewayLogId === null) gatewayLogId = readGatewayLogId(upstream.headers)

    const [decisionBranch, usageBranch] = upstream.body!.tee()
    roundUsages.push(readGatewayUsage(usageBranch))
    const peek = await peekFirstContentBlock(decisionBranch)

    if (peek.kind === 'passthrough') {
      const usage = Promise.all(roundUsages).then((all) => all.reduce(addUsage, ZERO_USAGE))
      return {
        response: new Response(buildPassthroughStream(peek), {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        }),
        usage,
        gatewayLogId,
      }
    }

    if (finalRound) {
      // Should be unreachable — this round was requested with `tool_choice:
      // { type: 'none' }`, Anthropic's own documented guarantee against a
      // tool_use reply. Treat a violation as a hard Gateway error rather
      // than loop forever or silently drop the tool call.
      throw new GatewayError(502, 'Gateway returned tool_use despite tool_choice: none')
    }

    const input = await consumeToolUseRound(peek.reader, peek.decoder, peek.leftoverBuffer)
    let toolResultContent: string
    try {
      toolResultContent = await offer.execute(input)
    } catch (e) {
      console.error(`${offer.tool.name} tool execution failed`, e)
      toolResultContent = `Could not complete ${offer.tool.name} due to an internal error.`
    }

    messages = [
      ...messages,
      { role: 'assistant', content: [{ type: 'tool_use', id: peek.contentBlock.id, name: peek.contentBlock.name, input }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: peek.contentBlock.id, content: toolResultContent }],
      },
    ]
  }

  // Unreachable (the loop above always returns or throws), but keeps the
  // function's return type honest for TypeScript's control-flow analysis.
  throw new GatewayError(502, 'tool-use round cap exhausted without a final answer')
}

/** `ToolOffer` for T-168's create_document tool — the reference implementation
 * this loop was built for. `executeCreateDocument` already validates/throws
 * on bad input, same contract `execute` needs. */
export function createDocumentToolOffer(
  executeCreateDocument: (input: { title: string; content: string }) => Promise<{ document_id: number }>,
): ToolOffer {
  return {
    tool: CREATE_DOCUMENT_TOOL,
    convention: CREATE_DOCUMENT_TOOL_CONVENTION,
    execute: async (input) => {
      const titleContent = input as { title?: unknown; content?: unknown }
      if (typeof titleContent.title !== 'string' || typeof titleContent.content !== 'string') {
        throw new Error('create_document tool input missing title/content')
      }
      const created = await executeCreateDocument({ title: titleContent.title, content: titleContent.content })
      return `Document created with id=${created.document_id}.`
    },
  }
}

// PROJ-011/T-214 — `ToolOffer` for record_examiner_verdict (design doc §3.2:
// "do not forward the tool_use block to the client as visible content";
// step 4, "tool_result back to the model, tool_choice: none for the final
// round, so the trainee sees a closing message as plain streamed text, not
// raw tool JSON" — that closing-message shape is exactly what this ToolOffer,
// plugged into the same two-round loop createDocumentToolOffer uses, gives
// for free).
export function recordExaminerVerdictToolOffer(
  executeVerdict: (input: {
    module_id: string
    passed: boolean
    criteria: unknown
    overall_rationale?: string
  }) => Promise<{ attestation_id: number }>,
): ToolOffer {
  return {
    tool: RECORD_EXAMINER_VERDICT_TOOL,
    convention: RECORD_EXAMINER_VERDICT_TOOL_CONVENTION,
    execute: async (input) => {
      const verdict = input as {
        module_id?: unknown
        passed?: unknown
        criteria?: unknown
        overall_rationale?: unknown
      }
      if (
        typeof verdict.module_id !== 'string' ||
        typeof verdict.passed !== 'boolean' ||
        !Array.isArray(verdict.criteria)
      ) {
        throw new Error('record_examiner_verdict tool input missing module_id/passed/criteria')
      }
      const result = await executeVerdict({
        module_id: verdict.module_id,
        passed: verdict.passed,
        criteria: verdict.criteria,
        overall_rationale: typeof verdict.overall_rationale === 'string' ? verdict.overall_rationale : undefined,
      })
      return `Verdict recorded (attestation id=${result.attestation_id}): ${verdict.passed ? 'passed' : 'not passed'}.`
    },
  }
}

/**
 * Proxy one chat turn to the Gateway. Returns the client-facing
 * `Response` (raw SSE passthrough — untouched, so a browser Anthropic SDK
 * pointed at this route's `baseURL` keeps working unmodified) and a promise
 * for the usage totals, resolved once the tee'd server-side branch finishes
 * reading (the caller awaits this only in the background, via
 * `context.waitUntil`, so returning the streaming Response is not delayed by
 * it).
 */
export async function proxyToGateway(
  accountId: string,
  apiToken: string,
  metadata: { trainee_id: number; subscription_id: number | null },
  body: ChatRequestBody,
): Promise<{ response: Response; usage: Promise<GatewayUsage>; gatewayLogId: string | null }> {
  const upstream = await fetch(
    `https://gateway.ai.cloudflare.com/v1/${accountId}/${TUTOR_GATEWAY_ID}/anthropic/v1/messages`,
    {
      method: 'POST',
      headers: {
        'cf-aig-authorization': `Bearer ${apiToken}`,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'cf-aig-metadata': JSON.stringify(metadata),
        // Cloudflare's edge WAF (error 1010) blocks requests with no/generic
        // User-Agent on this endpoint — live-caught during T-163 verification.
        'User-Agent': 'academy-api/1.0 (+academy-api.pages.dev)',
      },
      body: JSON.stringify({
        model: TUTOR_MODEL,
        max_tokens: TUTOR_MAX_TOKENS,
        thinking: { type: 'adaptive' },
        output_config: { effort: TUTOR_THINKING_EFFORT },
        system: body.system,
        messages: body.messages,
        stream: true,
      }),
    },
  )

  if (!upstream.ok || !upstream.body) {
    throw new GatewayError(upstream.status, await upstream.text())
  }

  const [clientBranch, usageBranch] = upstream.body.tee()
  return {
    response: new Response(clientBranch, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    }),
    usage: readGatewayUsage(usageBranch),
    gatewayLogId: readGatewayLogId(upstream.headers),
  }
}

/**
 * The async half: `cost` isn't on the inference response (Anthropic's
 * schema has no dollar figure), only on the Gateway's own logs/analytics
 * endpoint. Live-checked 2026-08-03: querying this endpoint by the exact
 * `gateway_log_id` captured above, immediately after the inference call
 * completes, returns the log entry already indexed — no polling window
 * needed, a single direct lookup by id. Called from the caller's
 * `context.waitUntil`, so this doesn't delay the streamed response.
 */
export async function fetchGatewayLogCost(
  accountId: string,
  logsToken: string,
  logId: string,
): Promise<number | null> {
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways/${TUTOR_GATEWAY_ID}/logs/${logId}`,
    { headers: { Authorization: `Bearer ${logsToken}` } },
  )
  if (!resp.ok) return null
  const body = (await resp.json()) as { success: boolean; result?: { cost?: number } }
  if (!body.success || typeof body.result?.cost !== 'number') return null
  return body.result.cost
}
