/**
 * Anthropic Messages API wire vocabulary. Only the fields this adapter reads
 * or writes are modelled; unknown response fields are ignored by construction.
 * @module @syllora/llm-anthropic/types
 */

/** Anthropic requires this header; it pins the response event vocabulary. */
export const ANTHROPIC_VERSION = '2023-06-01'

/** One text content block, on both the request and response side. */
export interface WireTextBlock {
  readonly type: 'text'
  readonly text: string
}

/** One tool invocation produced by the model. */
export interface WireToolUseBlock {
  readonly type: 'tool_use'
  readonly id: string
  readonly name: string
  /** Already-decoded arguments (the wire carries a JSON object, not a string). */
  readonly input: unknown
}

/** One tool result sent back to the model. */
export interface WireToolResultBlock {
  readonly type: 'tool_result'
  readonly tool_use_id: string
  readonly content: string
  readonly is_error?: boolean
}

/** Request-side content block union. */
export type WireRequestBlock = WireTextBlock | WireToolUseBlock | WireToolResultBlock

/** Request-side message; Anthropic has no `system` role inside `messages`. */
export interface WireMessage {
  readonly role: 'user' | 'assistant'
  readonly content: WireRequestBlock[]
}

/** Tool declaration; Anthropic names the JSON Schema field `input_schema`. */
export interface WireTool {
  readonly name: string
  readonly description: string
  readonly input_schema: Record<string, unknown>
}

/** Streaming request body. `max_tokens` is mandatory for Anthropic. */
export interface WireRequest {
  readonly model: string
  readonly max_tokens: number
  readonly messages: WireMessage[]
  readonly stream: true
  readonly system?: string
  readonly tools?: WireTool[]
  readonly temperature?: number
  readonly stop_sequences?: string[]
}

/** Usage frame. `message_start` reports the input side, `message_delta` the
 *  cumulative output side; all counts are optional per frame. */
export interface WireUsage {
  readonly input_tokens?: number
  readonly output_tokens?: number
  readonly cache_read_input_tokens?: number
  readonly cache_creation_input_tokens?: number
}

/** SSE `message_start` payload. */
export interface WireMessageStart {
  readonly message: {
    readonly usage?: WireUsage
  }
}

/** SSE `content_block_start` payload; `content_block` varies by kind. */
export interface WireContentBlockStart {
  readonly index: number
  readonly content_block:
    | { readonly type: 'text'; readonly text?: string }
    | { readonly type: 'thinking'; readonly thinking?: string }
    | { readonly type: 'tool_use'; readonly id?: string; readonly name?: string }
    | { readonly type: string }
}

/** SSE `content_block_delta` payload. */
export interface WireContentBlockDelta {
  readonly index: number
  readonly delta:
    | { readonly type: 'text_delta'; readonly text?: string }
    | { readonly type: 'thinking_delta'; readonly thinking?: string }
    | { readonly type: 'input_json_delta'; readonly partial_json?: string }
    | { readonly type: string }
}

/** SSE `message_delta` payload: stop reason plus the cumulative output count. */
export interface WireMessageDelta {
  readonly delta?: { readonly stop_reason?: string | null }
  readonly usage?: WireUsage
}

/** SSE `error` payload. */
export interface WireErrorFrame {
  readonly error?: { readonly type?: string; readonly message?: string }
}

/** Envelope carrying the SSE event name alongside its parsed data. */
export interface WireEvent {
  readonly event: string
  readonly data: string
}
