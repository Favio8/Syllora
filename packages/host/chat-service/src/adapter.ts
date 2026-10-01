/**
 * ToolLlmClient adapter over the dsh DeepSeekAdapter (fetch+SSE OpenAI-
 * compatible). Translates the session loop's plain OpenAI-shaped messages
 * into the dsh Message vocabulary, streams chunks as text deltas, and
 * emits the final tool-call batch. Native reasoning deltas feed the same
 * text stream (the splitter separates `<think>`).
 * @module @syllora/chat-service/src/adapter
 */

import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage, ReasoningEffortId, type ContentBlock, type GenerateOptions, type LlmReasoningEffortInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { DeepSeekAdapter, type DeepSeekConnectionOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { AnthropicAdapter, type AnthropicConnectionOptions } from '@syllora/llm-anthropic'
import type { ToolCall, ToolLlmClient } from '@syllora/session'
import type { StructuredCallClient } from '@syllora/course-builder'
import type { ResolvedChatConfig } from './config.ts'

/** Static anonymous id (dsh adapters only use it for telemetry binding). */
const ANONYMOUS_USER = 'anonymous'

/**
 * The one surface the tool client needs from an adapter. Both protocol
 * adapters satisfy it, and keeping this structural is what lets the client
 * stay protocol-agnostic.
 */
export interface StreamingAdapter {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * Build the tool-loop LLM client for one resolved config. The adapter is
 * constructed directly (no cordis plugin graph); options are re-read per
 * operation so a config change reaches the next request.
 *
 * The name is historical: this factory now dispatches on `config.protocol`, so
 * it returns an Anthropic-backed client for an `anthropic` provider. It was
 * left under the old name deliberately — renaming it would have touched three
 * call-site files for no behavioural gain.
 */
export function createDeepSeekToolClient(config: ResolvedChatConfig): ToolLlmClient & StructuredCallClient {
  const adapter = createAdapter(config)
  return new ProtocolToolClient(adapter, config)
}

/** Return the adapter-owned effort choices for one provider/model route. */
export async function reasoningEffortsForConfig(config: ResolvedChatConfig, model = config.model): Promise<Array<{ id: string; name: string; description?: string }>> {
  const adapter = createAdapter(config)
  const resolved = await adapter.resolveModel(config.providerId || 'syllora', model)
  return (resolved.reasoning?.efforts ?? []).map((effort: LlmReasoningEffortInfo) => ({
    id: String(effort.id),
    name: effort.name,
    ...(effort.description === undefined ? {} : { description: effort.description }),
  }))
}

/**
 * Pick the adapter for this provider's wire protocol. Both speak the same
 * `StreamChunk` protocol up the seam, so nothing above this line branches.
 */
function createAdapter(config: ResolvedChatConfig): DeepSeekAdapter | AnthropicAdapter {
  return config.protocol === 'anthropic' ? createAnthropicAdapter(config) : createDeepSeekAdapter(config)
}

function createAnthropicAdapter(config: ResolvedChatConfig): AnthropicAdapter {
  const connection = (): AnthropicConnectionOptions => ({
    baseURL: config.baseUrl,
    maxTokens: config.maxTokens ?? 16_384,
    defaultContextWindow: 200_000,
    models: [],
    streamIdleTimeoutMs: 300_000,
  })
  return new AnthropicAdapter({
    options: connection,
    resolveApiKey: async (facts) => {
      const key = config.apiKey ?? process.env[config.apiKeyEnv ?? ''] ?? null
      if (key === null || key === '') {
        // Same wording as the DeepSeek path: the user must be told where to go.
        throw new Error(`缺少 API Key：请在 设置 → 模型配置 中为当前供应商填写密钥（供应商 ${facts.baseURL}）`)
      }
      return key
    },
    resolveUserId: () => ANONYMOUS_USER as never,
  })
}

function createDeepSeekAdapter(config: ResolvedChatConfig): DeepSeekAdapter {
  const connection = (): DeepSeekConnectionOptions => ({
    baseURL: config.baseUrl,
    apiKeyEnv: (config.apiKeyEnv ?? '') as CredentialRef,
    defaults: {
      ...(config.reasoningEffort === 'off' || config.reasoningEffort === 'low' || config.reasoningEffort === 'high' || config.reasoningEffort === 'max'
        ? { reasoningEffort: config.reasoningEffort }
        : {}),
    },
    // 8192 会把推理型模型的思维链算进输出预算，正文常被截断、隐藏
    // [SYLLORA_SYNC] 块无法送达（聊天掌握度回写因此失效）。config.yaml
    // 的 provider.max_tokens 可按路由覆写；缺省给推理+回复留足余量。
    maxTokens: config.maxTokens ?? 16_384,
    defaultContextWindow: 128_000,
    models: [],
    streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    retryPolicy: {
      mode: 'normal',
      maxRetries: 0,
      retryableCodes: [],
      initialDelayMs: 250,
      maxDelayMs: 4_000,
      jitterRatio: 0.2,
    },
  })
  return new DeepSeekAdapter({
    options: connection,
    resolveApiKey: async (facts) => {
      const key = config.apiKey ?? process.env[facts.apiKeyEnv as string] ?? null
      if (key === null || key === '') {
        // FL-32：`configProblem`（course.ts:107-117）对 provider / Base URL / 默认模型
        // 缺失都给出了中文且可操作的诊断，唯独密钥缺失抛的是英文裸串，风格断裂且没
        // 告诉用户去哪补。这里统一到同一套措辞。
        throw new Error(`缺少 API Key：请在 设置 → 模型配置 中为当前供应商填写密钥（环境变量 ${String(facts.apiKeyEnv) || '未设置'} 或 credentials.json）`)
      }
      return key
    },
    resolveUserId: () => ANONYMOUS_USER as never,
  })
}

class ProtocolToolClient implements ToolLlmClient {
  constructor(
    private readonly adapter: StreamingAdapter,
    private readonly config: ResolvedChatConfig,
  ) {}

  /** StructuredCallClient seam: pass the raw dsh chunk stream through. */
  async *stream(options: import('@deepseek-ai/dsh-llm').GenerateOptions): AsyncGenerator<import('@deepseek-ai/dsh-llm').StreamChunk> {
    yield* this.adapter.stream(options)
  }

  async *request(
    system: string,
    messages: Array<Record<string, unknown>>,
    tools: Array<Record<string, unknown>> | null,
    signal?: AbortSignal,
  ): AsyncGenerator<{ kind: 'text'; delta: string } | { kind: 'toolCalls'; calls: ToolCall[] }> {
    const dshMessages = toDshMessages(messages)
    const toolSchemas = (tools ?? []).map(spec => {
      const fn = spec['function'] as { name: string; description: string; parameters: Record<string, unknown> }
      return { name: fn.name, description: fn.description, parameters: fn.parameters }
    })
    const callsByIndex = new Map<number, { id: string; name: string; argumentsDelta: string }>()

    for await (const chunk of this.adapter.stream({
      provider: this.config.providerId || 'syllora',
      model: this.config.model,
      system,
      messages: dshMessages,
      ...(toolSchemas.length > 0 ? { tools: toolSchemas } : {}),
      temperature: this.config.temperature,
      ...(this.config.reasoningEffort === undefined || this.config.reasoningEffort === null
        ? {}
        : { reasoningEffort: ReasoningEffortId(this.config.reasoningEffort) }),
      ...(signal === undefined ? {} : { signal }),
    })) {
      if (chunk.type === 'text-delta') {
        yield { kind: 'text', delta: chunk.text }
      } else if (chunk.type === 'reasoning-delta') {
        // 思维链必须以显式 <think> 包裹下发：下游 session.splitter 只认标签，
        // 裸转发会把推理当正文渲染给学生，且干扰隐藏同步块的提取。
        yield { kind: 'text', delta: `<think>${chunk.text}</think>` }
      } else if (chunk.type === 'tool-call-delta') {
        const existing = callsByIndex.get(chunk.index) ?? { id: '', name: '', argumentsDelta: '' }
        // 与 translate 层同一契约：线格式可能显式给 null（sglang 系），视为缺席。
        if (chunk.id != null) existing.id = String(chunk.id)
        if (chunk.name != null) existing.name = String(chunk.name)
        existing.argumentsDelta += chunk.argumentsDelta
        callsByIndex.set(chunk.index, existing)
      } else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
        throw new Error(`${chunk.reason.failure.code}: ${chunk.reason.failure.message}`)
      } else if (chunk.type === 'finish' && chunk.reason.kind === 'aborted') {
        return
      }
    }

    if (callsByIndex.size > 0) {
      const calls: ToolCall[] = [...callsByIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, call]) => ({
          id: call.id || `call_${Math.random().toString(36).slice(2)}`,
          name: call.name,
          arguments: safeParseArguments(call.argumentsDelta),
        }))
      yield { kind: 'toolCalls', calls }
    }
  }
}

function safeParseArguments(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return { _raw: raw }
  }
}

/** Translate OpenAI-shaped loop messages into the dsh Message vocabulary. */
function toDshMessages(messages: Array<Record<string, unknown>>): ReturnType<typeof createUserMessage>[] {
  return messages.map((message) => {
    const role = message['role']
    if (role === 'assistant') {
      const content: ContentBlock[] = []
      const text = message['content']
      if (typeof text === 'string' && text !== '') {
        content.push({ type: 'text', text })
      }
      const toolCalls = message['tool_calls']
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls as Array<{ id?: string; function?: { name?: string; arguments?: string } }>) {
          content.push({
            type: 'tool-call',
            id: CallId(call.id ?? ''),
            name: call.function?.name ?? '',
            arguments: call.function?.arguments ?? '{}',
          })
        }
      }
      return createAssistantMessage({
        content,
        source: { provider: 'syllora', model: 'syllora' },
      }) as unknown as ReturnType<typeof createUserMessage>
    }
    if (role === 'tool') {
      return createToolResultMessage({
        callId: CallId(String(message['tool_call_id'] ?? '')),
        content: [{ type: 'text', text: String(message['content'] ?? '') }],
        isError: false,
      }) as ReturnType<typeof createUserMessage>
    }
    return createUserMessage({
      content: [{ type: 'text', text: String(message['content'] ?? '') }],
      source: { kind: 'user' },
    }) as ReturnType<typeof createUserMessage>
  })
}
