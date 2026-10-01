/**
 * Serialize harness messages into an Anthropic Messages request.
 *
 * The shape differs from OpenAI-compatible chat completions in three ways that
 * this module exists to absorb:
 *  1. `system` is a top-level field, never a message role.
 *  2. Messages must alternate `user`/`assistant` — consecutive same-role
 *     messages are merged here rather than rejected by the endpoint.
 *  3. Tool results travel as `tool_result` blocks inside a `user` message,
 *     and tool calls as `tool_use` blocks inside an `assistant` message.
 *
 * Text-only by construction: image content is rejected loudly instead of being
 * silently dropped, matching the DeepSeek adapter's text-only path.
 * @module @syllora/llm-anthropic/serialize
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { WireMessage, WireRequest, WireRequestBlock, WireTool } from './types.ts'

/** Adapter-level request defaults resolved once per connection. */
export interface RequestDefaults {
  /** Default output cap used when the request omits `maxTokens`. */
  maxTokens: number
}

/** Reject image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError(
      'The Anthropic Messages adapter does not support image content.',
      'UNSUPPORTED_CONTENT',
    )
  }
}

/** Reject a stray image block wherever it appears, including inside a tool result. */
function assertNoImages(messages: readonly Message[]): void {
  for (const message of messages) {
    assertTextOnly(message.content)
    for (const block of message.content) {
      if (block.type === 'tool-result') assertTextOnly(block.content)
    }
  }
}

/** Join the text blocks of a block list (tool-result bodies are text-only here). */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Decode a tool-call argument string into the JSON object Anthropic expects.
 * A model that emits malformed JSON still gets its call delivered: the raw text
 * is wrapped instead of dropped, mirroring the session client's fallback.
 */
function decodeArguments(raw: string): unknown {
  if (raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : { _raw: raw }
  } catch {
    return { _raw: raw }
  }
}

/** Map one dsh message onto its request blocks. Reasoning blocks are dropped:
 *  Anthropic requires a signature to echo thinking back, which we never hold. */
function toBlocks(message: Message): WireRequestBlock[] {
  const blocks: WireRequestBlock[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        if (block.text !== '') blocks.push({ type: 'text', text: block.text })
        break
      case 'tool-call':
        blocks.push({
          type: 'tool_use',
          id: String(block.id),
          name: block.name,
          input: decodeArguments(block.arguments),
        })
        break
      case 'tool-result':
        blocks.push({
          type: 'tool_result',
          tool_use_id: String(block.toolCallId),
          content: flattenText(block.content),
          ...block.isError === true ? { is_error: true } : {},
        })
        break
      case 'reasoning':
      case 'image':
        // reasoning: see above. image: assertNoImages already rejected it.
        break
    }
  }
  return blocks
}

/** Anthropic rejects consecutive same-role turns; merge instead of failing. */
function pushMerged(target: WireMessage[], role: 'user' | 'assistant', blocks: WireRequestBlock[]): void {
  if (blocks.length === 0) return
  const last = target[target.length - 1]
  if (last !== undefined && last.role === role) {
    target[target.length - 1] = { role, content: [...last.content, ...blocks] }
    return
  }
  target.push({ role, content: blocks })
}

/** Build the wire request for one call. */
export function serializeRequest(options: GenerateOptions, defaults: RequestDefaults): WireRequest {
  assertNoImages(options.messages)

  // `system` is top-level; a system-role message in the history folds into it.
  const systemParts: string[] = []
  if (options.system !== undefined && options.system !== '') systemParts.push(options.system)

  const messages: WireMessage[] = []
  for (const message of options.messages) {
    const blocks = toBlocks(message)
    if (message.role === 'system') {
      const text = flattenText(message.content)
      if (text !== '') systemParts.push(text)
      continue
    }
    pushMerged(messages, message.role, blocks)
  }

  const tools: WireTool[] = (options.tools ?? []).map((tool: ToolSchema) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))

  return {
    model: options.model,
    // Mandatory on every Anthropic request; options win over the connection default.
    max_tokens: options.maxTokens ?? defaults.maxTokens,
    messages,
    stream: true,
    ...systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {},
    ...tools.length > 0 ? { tools } : {},
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.stop !== undefined && options.stop.length > 0 ? { stop_sequences: options.stop } : {},
  }
}
