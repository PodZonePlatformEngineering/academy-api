// Unit tests for _lib/gateway.ts's proxyToGatewayWithTools — the
// first-content-block-peek tool-use loop (PROJ-011/T-168, T-164 §2). No
// network: each round is a hand-built SSE stream shaped exactly like
// Anthropic's documented streaming protocol, stubbed behind global `fetch`.
// Exercises the three off-by-ones the brief flagged explicitly: (1) a
// leading `thinking` block must not get misrouted into the tool-interception
// path, (2) a malformed/incomplete tool call must degrade, not crash, and
// (3) the entitlement re-check inside `executeCreateDocument` is the thing
// that actually blocks a write, not just present in the code.
import { describe, expect, it, vi, afterEach } from 'vitest'
import { proxyToGatewayWithTools } from '../functions/_lib/gateway'

function sseChunk(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
}

function sseResponse(events: Array<Record<string, unknown>>, headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseChunk(events)))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'cf-aig-log-id': 'log-1', ...headers } })
}

async function readAllText(response: Response): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out
}

const TEXT_TURN = [
  { type: 'message_start', message: { model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello!' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
]

const THINKING_THEN_TEXT_TURN = [
  { type: 'message_start', message: { model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering...' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Thought about it: 42.' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
  { type: 'message_stop' },
]

function toolUseTurn(inputJsonChunks: string[]) {
  return [
    { type: 'message_start', message: { model: 'claude-sonnet-5', usage: { input_tokens: 120, output_tokens: 0 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'create_document', input: {} },
    },
    ...inputJsonChunks.map((partial_json) => ({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json },
    })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
    { type: 'message_stop' },
  ]
}

const FINAL_TEXT_TURN = [
  { type: 'message_start', message: { model: 'claude-sonnet-5', usage: { input_tokens: 140, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Saved it for you!' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
  { type: 'message_stop' },
]

describe('proxyToGatewayWithTools', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('splices into real passthrough on an ordinary text-first turn — no tool call, executeCreateDocument never invoked', async () => {
    const fetchMock = vi.fn(async () => sseResponse(TEXT_TURN))
    vi.stubGlobal('fetch', fetchMock)
    const executeCreateDocument = vi.fn()

    const result = await proxyToGatewayWithTools(
      'acc',
      'token',
      { trainee_id: 1, subscription_id: 2 },
      { system: 'be helpful', messages: [{ role: 'user', content: 'hi' }] },
      executeCreateDocument,
    )

    const text = await readAllText(result.response)
    expect(text).toContain('"text":"Hello!"')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(executeCreateDocument).not.toHaveBeenCalled()

    const usage = await result.usage
    expect(usage.inputTokens).toBe(100)
    expect(usage.outputTokens).toBe(5)
    expect(result.gatewayLogId).toBe('log-1')
  })

  it('off-by-one #1: a leading thinking block does not get misrouted into the tool-interception path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(THINKING_THEN_TEXT_TURN)))
    const executeCreateDocument = vi.fn()

    const result = await proxyToGatewayWithTools(
      'acc',
      'token',
      { trainee_id: 1, subscription_id: null },
      { system: 'be helpful', messages: [{ role: 'user', content: 'what is the answer?' }] },
      executeCreateDocument,
    )

    const text = await readAllText(result.response)
    expect(text).toContain('thinking_delta')
    expect(text).toContain('Thought about it: 42.')
    expect(executeCreateDocument).not.toHaveBeenCalled()
  })

  it('tool-first turn: executes create_document, forces tool_choice:none on the final round, streams a coherent reply', async () => {
    const calls: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const parsedBody = JSON.parse(init.body as string)
      calls.push(parsedBody)
      return calls.length === 1
        ? sseResponse(toolUseTurn(['{"title":"Note', '","content":"hello world"}']))
        : sseResponse(FINAL_TEXT_TURN)
    })
    vi.stubGlobal('fetch', fetchMock)
    const executeCreateDocument = vi.fn(async (input: { title: string; content: string }) => {
      expect(input).toEqual({ title: 'Note', content: 'hello world' })
      return { document_id: 42 }
    })

    const result = await proxyToGatewayWithTools(
      'acc',
      'token',
      { trainee_id: 1, subscription_id: 2 },
      { system: 'be helpful', messages: [{ role: 'user', content: 'save a note' }] },
      executeCreateDocument,
    )

    const text = await readAllText(result.response)
    expect(text).toContain('Saved it for you!')
    expect(executeCreateDocument).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Round 1 offers the tool with tool_choice: auto.
    expect(calls[0].tools).toBeTruthy()
    expect(calls[0].tool_choice).toEqual({ type: 'auto' })
    // Round 2 is forced tool-free — the mechanism that guarantees the final
    // round is tee-safe rather than erroring out on a repeat tool call.
    expect(calls[1].tools).toBeUndefined()
    expect(calls[1].tool_choice).toEqual({ type: 'none' })
    // The tool_use + tool_result round-trip was appended to messages for round 2.
    const round2Messages = calls[1].messages as Array<Record<string, unknown>>
    expect(round2Messages.at(-2)).toMatchObject({ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1' }] })
    expect(round2Messages.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Document created with id=42.' }],
    })

    // Usage accumulates across both rounds.
    const usage = await result.usage
    expect(usage.inputTokens).toBe(120 + 140)
    expect(usage.outputTokens).toBe(12 + 6)
  })

  it('off-by-one #2: malformed tool input degrades to an error tool_result instead of crashing the turn', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const parsedBody = JSON.parse(init.body as string)
      return parsedBody.tool_choice?.type === 'none'
        ? sseResponse(FINAL_TEXT_TURN)
        : sseResponse(toolUseTurn(['{"title":"Note"}'])) // missing required `content`
    })
    vi.stubGlobal('fetch', fetchMock)
    const executeCreateDocument = vi.fn()

    const result = await proxyToGatewayWithTools(
      'acc',
      'token',
      { trainee_id: 1, subscription_id: null },
      { system: 'be helpful', messages: [{ role: 'user', content: 'save a note' }] },
      executeCreateDocument,
    )

    const text = await readAllText(result.response)
    expect(text).toContain('Saved it for you!') // turn still finishes coherently
    expect(executeCreateDocument).not.toHaveBeenCalled() // never called with invalid input
  })

  it('off-by-one #3: a load-bearing entitlement rejection inside executeCreateDocument degrades the turn, does not crash it', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const parsedBody = JSON.parse(init.body as string)
      return parsedBody.tool_choice?.type === 'none'
        ? sseResponse(FINAL_TEXT_TURN)
        : sseResponse(toolUseTurn(['{"title":"Note","content":"hi"}']))
    })
    vi.stubGlobal('fetch', fetchMock)
    const executeCreateDocument = vi.fn(async () => {
      throw new Error('trainee is not entitled to feature personal_library')
    })

    const result = await proxyToGatewayWithTools(
      'acc',
      'token',
      { trainee_id: 1, subscription_id: null },
      { system: 'be helpful', messages: [{ role: 'user', content: 'save a note' }] },
      executeCreateDocument,
    )

    const text = await readAllText(result.response)
    expect(text).toContain('Saved it for you!')
    expect(executeCreateDocument).toHaveBeenCalledTimes(1)
  })

  it('appends the tool-use convention as a new system block without mutating the client-supplied one', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const parsedBody = JSON.parse(init.body as string)
      expect(parsedBody.system).toEqual([
        { type: 'text', text: 'client system prompt', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: expect.stringContaining('create_document tool') },
      ])
      return sseResponse(TEXT_TURN)
    })
    vi.stubGlobal('fetch', fetchMock)

    await proxyToGatewayWithTools(
      'acc',
      'token',
      { trainee_id: 1, subscription_id: null },
      {
        system: [{ type: 'text', text: 'client system prompt', cache_control: { type: 'ephemeral', ttl: '1h' } }],
        messages: [{ role: 'user', content: 'hi' }],
      },
      vi.fn(),
    )
  })
})
