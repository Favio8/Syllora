import { describe, expect, it } from 'vitest'
import { EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { mapStopReason, mapUsage, translate } from '../src/translate.ts'
import type { WireEvent } from '../src/types.ts'

/** Feed named events the way parseAnthropicSse would, `message_stop` last. */
async function* feed(...events: (WireEvent | [string, object])[]): AsyncGenerator<WireEvent> {
  for (const event of events) {
    if (Array.isArray(event)) yield { event: event[0], data: JSON.stringify(event[1]) }
    else yield event
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

/** The live opening frames: an empty text block then its first delta. */
const messageStart = (usage?: object): [string, object] => ['message_start', { type: 'message_start', message: { usage } }]

describe('translate: text', () => {
  it('retains initial content and rejects a completed empty text block', async () => {
    const chunks = await collect(translate(feed(['content_block_start', { index: 0, content_block: { type: 'text', text: 'initial' } }], ['message_stop', {}])))
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'initial' })
    const empty = await collect(translate(feed(['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }], ['message_stop', {}])))
    expect(empty.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: EMPTY_RESPONSE_CODE } } })
  })
  it('streams a text block and defers block-end/usage/finish to message_stop', async () => {
    const chunks = await collect(translate(feed(
      messageStart({ input_tokens: 5, output_tokens: 0 }),
      ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hel' } }],
      ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'lo' } }],
      ['content_block_stop', { index: 0 }],
      ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }],
      ['message_stop', {}],
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      // input side came from message_start, output side from message_delta.
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('ignores ping and unknown event names', async () => {
    const chunks = await collect(translate(feed(
      ['ping', {}],
      ['content_block_start', { index: 0, content_block: { type: 'text' } }],
      ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'x' } }],
      ['some_future_event', { index: 0 }],
      ['message_stop', {}],
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'x' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'x' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('a completed response with no content is an EMPTY_RESPONSE error, not success', async () => {
    const chunks = await collect(translate(feed(messageStart(), ['message_stop', {}])))
    expect(chunks).toEqual([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } } },
    ])
  })
})

describe('translate: thinking', () => {
  it('maps thinking_delta onto the reasoning channel so it never renders as prose', async () => {
    const chunks = await collect(translate(feed(
      ['content_block_start', { index: 0, content_block: { type: 'thinking' } }],
      ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'why' } }],
      ['content_block_stop', { index: 0 }],
      ['content_block_start', { index: 1, content_block: { type: 'text' } }],
      ['content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'answer' } }],
      ['message_delta', { delta: { stop_reason: 'end_turn' } }],
      ['message_stop', {}],
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'why' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'answer' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'why' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })
})

describe('translate: tool use', () => {
  it('assembles a tool_use block from input_json_delta fragments', async () => {
    const chunks = await collect(translate(feed(
      ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup' } }],
      ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } }],
      ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '"hi"}' } }],
      ['content_block_stop', { index: 0 }],
      ['message_delta', { delta: { stop_reason: 'tool_use' } }],
      ['message_stop', {}],
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'toolu_1', name: 'lookup', argumentsDelta: '{"q":' },
      { type: 'tool-call-delta', index: 0, id: 'toolu_1', name: 'lookup', argumentsDelta: '"hi"}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'toolu_1', name: 'lookup', arguments: '{"q":"hi"}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })
})

describe('translate: failures', () => {
  it('turns a stream error frame into a provider error', async () => {
    await expect(collect(translate(feed(
      ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
    )))).rejects.toThrowError(LlmError)
  })

  it('rejects a malformed payload instead of silently dropping it', async () => {
    await expect(collect(translate(feed({ event: 'content_block_delta', data: '{not json' }))))
      .rejects.toThrowError(/malformed SSE payload/)
  })

  it('a stream that ends without message_stop is truncation, not completion', async () => {
    await expect(collect(translate(feed(
      ['content_block_start', { index: 0, content_block: { type: 'text' } }],
      ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'half' } }],
    )))).rejects.toThrowError(/message_stop/)
  })
})

describe('mapStopReason', () => {
  it('maps the documented vocabulary and fails loudly on anything else', () => {
    expect(mapStopReason('end_turn')).toEqual({ kind: 'stop' })
    expect(mapStopReason('stop_sequence')).toEqual({ kind: 'stop' })
    expect(mapStopReason(null)).toEqual({ kind: 'stop' })
    expect(mapStopReason('tool_use')).toEqual({ kind: 'tool-calls' })
    expect(mapStopReason('max_tokens')).toEqual({ kind: 'max-tokens' })
    expect(mapStopReason('refusal')).toEqual({
      kind: 'error',
      failure: { message: 'model stopped: refusal', code: 'REFUSAL' },
    })
  })
})

describe('mapUsage', () => {
  it('keeps the counts disjoint, as the harness convention requires', () => {
    // Anthropic already reports input_tokens as the uncached portion, so unlike
    // the DeepSeek mapping there is nothing to subtract.
    expect(mapUsage({ input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 }))
      .toEqual({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 7, cacheWriteTokens: 2 })
    expect(mapUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 })
  })
})
