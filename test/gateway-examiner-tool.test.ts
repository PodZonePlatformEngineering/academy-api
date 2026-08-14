// Unit tests for recordExaminerVerdictToolOffer (PROJ-011/T-214) — the same
// two-round tool-interception loop gateway-tools.test.ts already proves for
// create_document, exercised here with the second tool the loop now offers.
// Focus: the tool_use block never reaches the client as visible content
// (design doc §3.2's core requirement), and malformed verdict shape degrades
// rather than crashing the turn, same posture as off-by-one #2.
import { describe, expect, it, vi, afterEach } from 'vitest'
import { proxyToGatewayWithTools, recordExaminerVerdictToolOffer } from '../functions/_lib/gateway'

function sseChunk(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseChunk(events)))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'cf-aig-log-id': 'log-1' } })
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

function verdictToolUseTurn(inputJsonChunks: string[]) {
  return [
    { type: 'message_start', message: { model: 'claude-sonnet-5', usage: { input_tokens: 120, output_tokens: 0 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_2', name: 'record_examiner_verdict', input: {} },
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
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Verdict recorded — you passed M3.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
  { type: 'message_stop' },
]

describe('recordExaminerVerdictToolOffer via proxyToGatewayWithTools', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('never forwards the tool_use block to the client — only the final plain-text closing message streams', async () => {
    const verdictInput = {
      module_id: 'M3',
      passed: true,
      criteria: [{ name: 'own_words_explanation', met: true, rationale: 'clear' }],
      overall_rationale: 'solid',
    }
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const parsedBody = JSON.parse(init.body as string)
      return parsedBody.tool_choice?.type === 'none'
        ? sseResponse(FINAL_TEXT_TURN)
        : sseResponse(verdictToolUseTurn([JSON.stringify(verdictInput)]))
    })
    vi.stubGlobal('fetch', fetchMock)
    const executeVerdict = vi.fn(async (input: { module_id: string; passed: boolean; criteria: unknown; overall_rationale?: string }) => {
      expect(input).toEqual(verdictInput)
      return { attestation_id: 7 }
    })

    const result = await proxyToGatewayWithTools(
      'acc',
      'token',
      { trainee_id: 1, subscription_id: 2 },
      { system: 'be the examiner', messages: [{ role: 'user', content: 'ready to be examined' }] },
      recordExaminerVerdictToolOffer(executeVerdict),
    )

    const text = await readAllText(result.response)
    expect(text).not.toContain('record_examiner_verdict')
    expect(text).not.toContain('"tool_use"')
    expect(text).toContain('Verdict recorded — you passed M3.')
    expect(executeVerdict).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('malformed verdict shape (missing criteria) degrades to an error tool_result instead of crashing the turn', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const parsedBody = JSON.parse(init.body as string)
      return parsedBody.tool_choice?.type === 'none'
        ? sseResponse(FINAL_TEXT_TURN)
        : sseResponse(verdictToolUseTurn(['{"module_id":"M3","passed":true}'])) // missing criteria
    })
    vi.stubGlobal('fetch', fetchMock)
    const executeVerdict = vi.fn()

    const result = await proxyToGatewayWithTools(
      'acc',
      'token',
      { trainee_id: 1, subscription_id: null },
      { system: 'be the examiner', messages: [{ role: 'user', content: 'ready to be examined' }] },
      recordExaminerVerdictToolOffer(executeVerdict),
    )

    const text = await readAllText(result.response)
    expect(text).toContain('Verdict recorded — you passed M3.')
    expect(executeVerdict).not.toHaveBeenCalled()
  })
})
