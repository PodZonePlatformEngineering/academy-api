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
): Promise<{ response: Response; usage: Promise<GatewayUsage> }> {
  const upstream = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      'cf-aig-metadata': JSON.stringify(metadata),
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
  })

  if (!upstream.ok || !upstream.body) {
    throw new GatewayError(upstream.status, await upstream.text())
  }

  const [clientBranch, usageBranch] = upstream.body.tee()
  return {
    response: new Response(clientBranch, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    }),
    usage: readGatewayUsage(usageBranch),
  }
}
