/**
 * Anthropic Messages adapter for the harness LLM seam.
 *
 * Unlike `@deepseek-ai/dsh-llm-deepseek` this package ships no cordis plugin
 * and no settings section: Syllora constructs the adapter directly
 * (`packages/host/chat-service/src/adapter.ts`) and owns provider configuration
 * itself, so only the transport surface is needed here.
 * @module @syllora/llm-anthropic
 */

export {
  AnthropicAdapter,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  httpErrorCode,
  anthropicEndpoint,
} from './adapter.ts'
export type {
  AnthropicAdapterOptions,
  AnthropicCatalogModel,
  AnthropicConnectionOptions,
} from './adapter.ts'
export { serializeRequest } from './serialize.ts'
export type { RequestDefaults } from './serialize.ts'
export { MESSAGE_STOP, parseAnthropicSse } from './sse.ts'
export { mapStopReason, mapUsage, translate } from './translate.ts'
export { ANTHROPIC_VERSION } from './types.ts'
export type * from './types.ts'
