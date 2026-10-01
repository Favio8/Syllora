/**
 * Decode an Anthropic SSE byte stream into named events.
 *
 * Two things differ from the OpenAI-compatible stream `llm-deepseek` consumes,
 * and both are load-bearing:
 *  1. Anthropic names every event (`event: content_block_delta`), so the name —
 *     not a field inside the payload — selects the shape to parse.
 *  2. There is **no `[DONE]` sentinel**. The stream is over when `message_stop`
 *     arrives; a stream that ends before it is truncated and must not be
 *     treated as a complete response.
 *
 * Framing (chunk reassembly, UTF-8/CRLF/BOM handling, comment and non-data field
 * skipping, multi-`data:` joining) is `eventsource-parser`'s, same as the
 * DeepSeek side.
 * @module @syllora/llm-anthropic/sse
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { WireEvent } from './types.ts'

/** The terminal event name; its absence at EOF means truncation. */
export const MESSAGE_STOP = 'message_stop'

/**
 * Parse an SSE byte stream into named events.
 * Yields each event in arrival order and returns after `message_stop`; throws
 * `LlmError('STREAM_CLOSED')` when the stream ends without it.
 * @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
 * @param onComment - optional transport-activity callback; comments never enter the yielded stream.
 */
export async function* parseAnthropicSse(
  stream: ReadableStream<BufferSource>,
  onComment?: (comment: string) => void,
): AsyncGenerator<WireEvent> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment }))
  for await (const message of events) {
    // A data-only frame without an `event:` line is not part of the documented
    // vocabulary; `ping` carries `{}` and is harmless to surface.
    yield { event: message.event ?? '', data: message.data }
    if (message.event === MESSAGE_STOP) return
  }
  throw new LlmError('Anthropic SSE stream ended without message_stop', 'STREAM_CLOSED')
}
