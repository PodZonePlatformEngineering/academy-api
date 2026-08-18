// Unit test for _lib/gateway.ts's readGatewayUsage — the pure SSE-parsing
// half of the Gateway proxy (PROJ-011/T-158). No network: exercises the
// parser against a hand-built stream shaped exactly like Anthropic's
// documented streaming protocol (message_start's initial usage +
// message_delta's cumulative output_tokens), the same shape the Gateway's
// `/ai/v1/messages` endpoint is confirmed to re-emit unmodified (§2 of
// t157-inference-delivery-design.md — "strictly Anthropic's API schema").
import { describe, expect, it, vi, afterEach } from 'vitest'
import { readGatewayUsage, readGatewayLogId, fetchGatewayLogCost, proxyToGateway } from '../functions/_lib/gateway'

function sseStream(events: Array<{ type: string; data: Record<string, unknown> }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const chunks = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`)
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

describe('readGatewayUsage', () => {
  it('reads input/cache tokens off message_start and the final output_tokens off the last message_delta', async () => {
    const stream = sseStream([
      {
        type: 'message_start',
        data: {
          type: 'message_start',
          message: {
            model: 'claude-sonnet-5',
            usage: { input_tokens: 1517, cache_creation_input_tokens: 736, cache_read_input_tokens: 1214, output_tokens: 0 },
          },
        },
      },
      { type: 'content_block_delta', data: { type: 'content_block_delta', delta: { text: 'hi' } } },
      { type: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 300 } } },
      { type: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 591 } } },
      { type: 'message_stop', data: { type: 'message_stop' } },
    ])

    const usage = await readGatewayUsage(stream)

    expect(usage).toEqual({
      model: 'claude-sonnet-5',
      inputTokens: 1517,
      outputTokens: 591,
      cacheCreationTokens: 736,
      cacheReadTokens: 1214,
    })
  })

  it('defaults to zero counts on an empty stream', async () => {
    const usage = await readGatewayUsage(sseStream([]))
    expect(usage).toEqual({ model: null, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 })
  })
})

// PROJ-011/T-160 — the `cf-aig-log-id` response header, live-confirmed
// present on both streaming and non-streaming Gateway responses against
// this account/gateway 2026-08-03 (both branches tested against
// `gateway.ai.cloudflare.com/v1/{account}/training-gateway/anthropic/v1/messages`).
describe('readGatewayLogId', () => {
  it('reads cf-aig-log-id off the response headers', () => {
    const headers = new Headers({ 'cf-aig-log-id': '01KZ3ZT8J5E1Y24SHKA2JTDA5B' })
    expect(readGatewayLogId(headers)).toBe('01KZ3ZT8J5E1Y24SHKA2JTDA5B')
  })

  it('returns null when the header is absent', () => {
    expect(readGatewayLogId(new Headers())).toBeNull()
  })
})

describe('fetchGatewayLogCost', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns the cost field from a successful logs-endpoint lookup', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toBe(
          'https://api.cloudflare.com/client/v4/accounts/acc123/ai-gateway/gateways/training-gateway/logs/log123',
        )
        return new Response(JSON.stringify({ success: true, result: { cost: 0.017658 } }), { status: 200 })
      }),
    )
    const cost = await fetchGatewayLogCost('acc123', 'logs-token', 'log123')
    expect(cost).toBe(0.017658)
  })

  it('returns null when the log entry is not yet indexed (404)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))
    const cost = await fetchGatewayLogCost('acc123', 'logs-token', 'log123')
    expect(cost).toBeNull()
  })

  it('returns null when the response has no numeric cost', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: true, result: {} }), { status: 200 })),
    )
    const cost = await fetchGatewayLogCost('acc123', 'logs-token', 'log123')
    expect(cost).toBeNull()
  })
})

// PROJ-011/ACP-252 — the QA cost-control switch. `mode: 'mock'` must never
// call `fetch` at all (that's the whole point — no real Gateway spend), and
// must still produce a usage/gatewayLogId shape the caller's existing
// accounting code (chat.ts/examiner/chat.ts) already handles unmodified.
describe('proxyToGateway mock mode', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('never calls fetch and returns a well-formed SSE passthrough + usage', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await proxyToGateway(
      'acc123',
      'token',
      { trainee_id: 1, subscription_id: null },
      { system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
      'mock',
    )

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.gatewayLogId).toBeNull()
    const usage = await result.usage
    expect(usage.model).toBe('claude-sonnet-5')
    expect(usage.outputTokens).toBeGreaterThan(0)
    const text = await result.response.text()
    expect(text).toContain('event: message_start')
    expect(text).toContain('event: message_stop')
  })

  it('defaults to real mode (calls fetch) when mode is omitted', async () => {
    const fetchSpy = vi.fn(async () => new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(
      proxyToGateway('acc123', 'token', { trainee_id: 1, subscription_id: null }, { system: 'sys', messages: [] }),
    ).rejects.toThrow()
    expect(fetchSpy).toHaveBeenCalled()
  })
})
