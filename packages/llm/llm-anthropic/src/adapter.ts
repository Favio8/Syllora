/**
 * `AnthropicAdapter`: fetch + named-SSE against an Anthropic Messages endpoint
 * (`POST {baseURL}/v1/messages`), emitting the same harness `StreamChunk`
 * protocol as the DeepSeek chat-completions adapter.
 *
 * Keeping the chunk protocol identical is the whole point: consumers of the LLM
 * seam (the session tool client, the structured-call builder) select a provider
 * by protocol without any change to their own code.
 *
 * Like the DeepSeek adapter this class is transport-only. Connection facts
 * arrive through a thunk resolved once per operation and the key through a
 * per-request resolver, so an endpoint and the secret sent to it can never come
 * from different configuration generations.
 * @module @syllora/llm-anthropic/adapter
 */

import {
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { serializeRequest } from './serialize.ts'
import type { RequestDefaults } from './serialize.ts'
import { parseAnthropicSse } from './sse.ts'
import { translate } from './translate.ts'
import { ANTHROPIC_VERSION } from './types.ts'
import type { WireErrorFrame } from './types.ts'

/** Default maximum idle interval while one adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 200_000
/** Default per-request output cap. Anthropic requires `max_tokens` on every call. */
export const DEFAULT_MAX_TOKENS = 8_192

/** Accept either an API root or a versioned base, including gateway prefixes. */
export function anthropicEndpoint(baseURL: string, resource: 'messages' | 'models'): string {
  const base = baseURL.replace(/\/+$/, '')
  return `${base}${base.endsWith('/v1') ? '' : '/v1'}/${resource}`
}

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/** One optional model entry advertised by the adapter. */
export interface AnthropicCatalogModel {
  /** Wire model id accepted by the configured endpoint. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Known combined request/response context capacity. */
  contextWindow?: number
  /** Per-request output cap for this model. */
  maxTokens?: number
  /** Accepted request modalities; omission is text-only. */
  inputModalities?: ModelModality[]
}

/** Validated connection facts for one operation. */
export interface AnthropicConnectionOptions {
  /** Endpoint base; `/v1/messages` is appended. */
  baseURL: string
  /** Default per-request output cap; explicit request values win. */
  maxTokens: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Advisory models exposed to discovery consumers. */
  models: readonly AnthropicCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
}

/** Constructor options: the operation-local resolution hooks the caller owns. */
export interface AnthropicAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => AnthropicConnectionOptions
  /** Resolve the API key for the connection facts of one request. */
  resolveApiKey: (connection: AnthropicConnectionOptions) => Promise<string>
  /** Resolve the anonymous id shared with telemetry. */
  resolveUserId: () => AnonymousUserId
}

/** Map an Anthropic HTTP failure onto a harness error code. */
export function httpErrorCode(status: number, error?: WireErrorFrame['error']): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 413) return 'INVALID_REQUEST'
  // Anthropic names the failure at the top level (`error.type`); the detail
  // joins every field so the quota/context probes see whichever one is present.
  const detail = [error?.type, error?.message].filter(Boolean).join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

function modelInfo(provider: string, model: AnthropicCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    inputModalities: model.inputModalities === undefined ? ['text' as const] : [...model.inputModalities],
  }
}

/**
 * Anthropic Messages adapter. One instance serves every model name it is
 * registered under; the harness model name IS the wire model name.
 */
export class AnthropicAdapter extends LlmAdapter {
  constructor(private readonly config: AnthropicAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Anthropic' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const configured = connection.models.find(entry => entry.id === model)
    return Promise.resolve({
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, configured),
      context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // One resolution per stream call: connection facts and the credential freeze
    // here and hold for this whole request, so an in-flight stream never
    // observes a configuration change and the next call re-resolves.
    const connection = this.config.options()
    const apiKey = await this.config.resolveApiKey(connection)
    const userId = this.config.resolveUserId()
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(options, watchdog.signal, connection, apiKey, userId, () => { watchdog.pulse() })[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `Anthropic stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('Anthropic request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`Anthropic API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('Anthropic stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination.
        }
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: AnthropicConnectionOptions,
    apiKey: string,
    userId: AnonymousUserId,
    onComment: () => void,
  ): AsyncIterable<StreamChunk> {
    const defaults: RequestDefaults = { maxTokens: connection.maxTokens }
    // Prepared outside the try so the TRANSPORT label below covers exactly the
    // transport boundary, never a serialization failure.
    const payload = JSON.stringify(serializeRequest(options, defaults))
    const headers = {
      // The Anthropic convention. MiMo's Anthropic-compatible endpoint also
      // advertises `api-key`; `x-api-key` is the form every compatible gateway
      // understands, so it is the one sent.
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
      'x-deepseek-harness-user-id': String(userId),
      ...options.sessionId !== undefined
        ? { 'x-deepseek-harness-session-id': String(options.sessionId) }
        : {},
    }

    let response: Response
    try {
      response = await fetch(anthropicEndpoint(connection.baseURL, 'messages'), {
        method: 'POST',
        headers,
        body: payload,
        signal,
        redirect: 'error',
      })
    } catch (error: unknown) {
      // The outer stream distinguishes caller cancellation and watchdog expiry.
      if (signal.aborted) throw error
      // A transport error cannot prove the POST never reached the provider.
      // Retry policy belongs to the caller so physical calls remain visible.
      throw new LlmError('Anthropic API request failed', 'TRANSPORT', { cause: error })
    }

    if (!response.ok) {
      let message = `Anthropic API error (HTTP ${response.status})`
      let providerError: WireErrorFrame['error']
      try {
        const parsed = await response.json() as WireErrorFrame
        providerError = parsed.error
        if (providerError?.message) message = providerError.message
      } catch {
        // Only swallow error-body parsing: the HTTP status still identifies the
        // failure, so malformed gateway JSON must not mask it.
      }
      const retryAfter = response.headers.get('retry-after')
      const delay = retryAfter === null ? undefined : Number(retryAfter) * 1000
      const requestId = response.headers.get('request-id')
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...delay === undefined || !Number.isFinite(delay) || delay <= 0 ? {} : { providerRetryAfterMs: delay },
        ...requestId === null || requestId === '' ? {} : { requestId: ProviderRequestId(requestId) },
      })
    }
    if (!response.body) {
      throw new LlmError('Anthropic API returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translate(parseAnthropicSse(response.body, onComment))
  }
}
