// Unit test for _lib/gateway.ts's readGatewayUsage — the pure SSE-parsing
// half of the Gateway proxy (PROJ-011/T-158). No network: exercises the
// parser against a hand-built stream shaped exactly like Anthropic's
// documented streaming protocol (message_start's initial usage +
// message_delta's cumulative output_tokens), the same shape the Gateway's
// `/ai/v1/messages` endpoint is confirmed to re-emit unmodified (§2 of
// t157-inference-delivery-design.md — "strictly Anthropic's API schema").
import { describe, expect, it } from 'vitest'
import { readGatewayUsage } from '../functions/_lib/gateway'

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
