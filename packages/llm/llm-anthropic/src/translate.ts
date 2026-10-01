/**
 * Translate Anthropic SSE events into the harness `StreamChunk` protocol.
 *
 * Two deliberate parity choices with the DeepSeek translator, so downstream
 * consumers (the session tool client, the structured-call builder) need no
 * protocol awareness at all:
 *  - `block-end`, `usage` and `finish` are all deferred to `message_stop` rather
 *    than emitted as they arrive. Only deltas stream.
 *  - A completed response with no content is a degenerate provider completion
 *    and maps to an `EMPTY_RESPONSE` error finish, not a successful empty message.
 * @module @syllora/llm-anthropic/translate
 */

import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { MESSAGE_STOP } from './sse.ts'
import type {
  WireContentBlockDelta,
  WireContentBlockStart,
  WireErrorFrame,
  WireEvent,
  WireMessageDelta,
  WireMessageStart,
  WireUsage,
} from './types.ts'

/** One open block under assembly, keyed by the provider's own block index. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  /** tool-call only */
  callId: string
  name: string
}

/** Map Anthropic's `stop_reason` vocabulary onto the harness FinishReason. */
export function mapStopReason(reason: string | null | undefined): FinishReason {
  switch (reason ?? undefined) {
    case undefined:
    case 'end_turn':
    case 'stop_sequence':
      return { kind: 'stop' }
    case 'tool_use':
      return { kind: 'tool-calls' }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    default:
      // refusal, pause_turn, and future additions: surface loudly rather than
      // pretending the turn completed normally.
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: String(reason).toUpperCase() },
      }
  }
}

/** Map one Anthropic usage frame onto disjoint harness counts.
 *  Anthropic already reports `input_tokens` as the uncached portion, so unlike
 *  the DeepSeek mapping nothing is subtracted — the cache fields ride alongside
 *  and the three sum to the billed input. */
export function mapUsage(usage: WireUsage): TokenUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    ...usage.cache_read_input_tokens === undefined ? {} : { cacheReadTokens: usage.cache_read_input_tokens },
    ...usage.cache_creation_input_tokens === undefined ? {} : { cacheWriteTokens: usage.cache_creation_input_tokens },
  }
}

/**
 * Fold a later usage frame over an earlier one. Anthropic splits accounting:
 * `message_start` carries the input side, `message_delta` the cumulative output
 * side — so a field the later frame omitted (or reported as 0) keeps the value
 * the earlier frame established instead of being zeroed out.
 */
function mergeUsage(earlier: TokenUsage | undefined, later: TokenUsage): TokenUsage {
  const pick = <K extends keyof TokenUsage>(key: K): TokenUsage[K] | undefined => {
    const next = later[key]
    if (next !== undefined && next !== 0) return next
    return earlier?.[key]
  }
  const cacheReadTokens = pick('cacheReadTokens')
  const cacheWriteTokens = pick('cacheWriteTokens')
  const reasoningTokens = pick('reasoningTokens')
  return {
    inputTokens: pick('inputTokens') ?? 0,
    outputTokens: pick('outputTokens') ?? 0,
    ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
    ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
    ...reasoningTokens === undefined ? {} : { reasoningTokens },
  }
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: CallId(block.callId),
      name: block.name,
      arguments: block.text,
    }
  }
}

/** Parse one event's JSON body; a malformed frame aborts the stream. */
function parse<T>(event: WireEvent): T {
  try {
    return JSON.parse(event.data) as T
  } catch {
    throw new LlmError(`malformed SSE payload: ${event.data.slice(0, 120)}`, 'MALFORMED_RESPONSE')
  }
}

/**
 * Consume `parseAnthropicSse` events and yield StreamChunks.
 * @param events - named events from {@link parseAnthropicSse}, `message_stop`-terminated.
 */
export async function* translate(events: AsyncIterable<WireEvent>): AsyncGenerator<StreamChunk> {
  const blocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingUsage: TokenUsage | undefined
  let pendingFinish: FinishReason | undefined

  function open(index: number, kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index, kind, text: '', callId: '', name: '' }
    blocks.set(index, block)
    order.push(block)
    return block
  }

  for await (const event of events) {
    if (event.event === MESSAGE_STOP) {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' as const }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? {
            kind: 'error',
            failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
          }
          : reason,
      }
      return
    }

    switch (event.event) {
      case 'message_start': {
        const start = parse<WireMessageStart>(event)
        if (start.message.usage !== undefined) pendingUsage = mergeUsage(pendingUsage, mapUsage(start.message.usage))
        break
      }
      case 'content_block_start': {
        const start = parse<WireContentBlockStart>(event)
        const kind = start.content_block.type
        if (kind === 'text' || kind === 'thinking' || kind === 'tool_use') {
          const block = open(
            start.index,
            kind === 'tool_use' ? 'tool-call' : kind === 'thinking' ? 'reasoning' : 'text',
          )
          if (kind === 'tool_use') {
            const tool = start.content_block as { id?: string; name?: string }
            block.callId = tool.id ?? ''
            block.name = tool.name ?? ''
          }
          yield { type: 'block-start', index: block.index, blockType: block.kind }
        }
        // Unknown block kinds are ignored rather than mapped onto a vocabulary
        // they do not belong to.
        break
      }
      case 'content_block_delta': {
        const delta = parse<WireContentBlockDelta>(event)
        const block = blocks.get(delta.index)
        if (block === undefined) break
        const kind = delta.delta.type
        if (kind === 'text_delta') {
          const text = (delta.delta as { text?: string }).text ?? ''
          if (text !== '') {
            block.text += text
            yield { type: 'text-delta', index: block.index, text }
          }
        } else if (kind === 'thinking_delta') {
          const text = (delta.delta as { thinking?: string }).thinking ?? ''
          if (text !== '') {
            block.text += text
            yield { type: 'reasoning-delta', index: block.index, text }
          }
        } else if (kind === 'input_json_delta') {
          const fragment = (delta.delta as { partial_json?: string }).partial_json ?? ''
          block.text += fragment
          yield {
            type: 'tool-call-delta',
            index: block.index,
            id: CallId(block.callId),
            ...block.name !== '' ? { name: block.name } : {},
            argumentsDelta: fragment,
          }
        }
        break
      }
      case 'content_block_stop':
        // Closed here, but its `block-end` is deferred to message_stop (see module doc).
        break
      case 'message_delta': {
        const delta = parse<WireMessageDelta>(event)
        if (delta.delta?.stop_reason != null) pendingFinish = mapStopReason(delta.delta.stop_reason)
        if (delta.usage !== undefined) pendingUsage = mergeUsage(pendingUsage, mapUsage(delta.usage))
        break
      }
      case 'error': {
        const frame = parse<WireErrorFrame>(event)
        throw new LlmError(
          `Anthropic stream error: ${frame.error?.message ?? frame.error?.type ?? 'unknown'}`,
          'PROVIDER_ERROR',
        )
      }
      default:
        // `ping` and any future keep-alive frames carry no content.
        break
    }
  }

  // parseAnthropicSse guarantees message_stop (or throws); reaching here means
  // the event source violated that contract.
  throw new LlmError('Anthropic event stream ended without message_stop', 'STREAM_CLOSED')
}
