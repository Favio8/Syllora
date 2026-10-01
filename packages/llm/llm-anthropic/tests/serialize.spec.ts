import { describe, expect, it } from 'vitest'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { serializeRequest } from '../src/serialize.ts'
import { ANTHROPIC_VERSION } from '../src/types.ts'

const DEFAULTS = { maxTokens: 4096 }

function user(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function assistant(content: ContentBlock[]) {
  return createAssistantMessage({ content, source: { provider: 'p', model: 'm' } }) as unknown as Message
}

function toolResult(callId: string, text: string) {
  return createToolResultMessage({
    callId: CallId(callId),
    content: [{ type: 'text', text }],
    isError: false,
  }) as unknown as Message
}

function options(partial: Partial<GenerateOptions>): GenerateOptions {
  return { provider: 'p', model: 'claude-x', messages: [], ...partial } as GenerateOptions
}

describe('serializeRequest: shape', () => {
  it('always sends the mandatory max_tokens and stream flag', () => {
    const body = serializeRequest(options({}), DEFAULTS)
    expect(body.max_tokens).toBe(4096)
    expect(body.stream).toBe(true)
    expect(body.model).toBe('claude-x')
    // Explicit per-request cap wins over the connection default.
    expect(serializeRequest(options({ maxTokens: 512 }), DEFAULTS).max_tokens).toBe(512)
  })

  it('puts system at the top level, never as a message role', () => {
    const body = serializeRequest(options({ system: 'be terse', messages: [user('hi')] }), DEFAULTS)
    expect(body.system).toBe('be terse')
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
    expect(body.messages.some((m) => (m.role as string) === 'system')).toBe(false)
  })

  it('maps stop to stop_sequences and passes temperature through', () => {
    const body = serializeRequest(options({ stop: ['STOP'], temperature: 0.2 }), DEFAULTS)
    expect(body.stop_sequences).toEqual(['STOP'])
    expect(body.temperature).toBe(0.2)
    // Absent fields stay absent rather than being sent as undefined.
    expect('temperature' in serializeRequest(options({}), DEFAULTS)).toBe(false)
    expect('stop_sequences' in serializeRequest(options({}), DEFAULTS)).toBe(false)
  })

  it('declares tools with input_schema, the Anthropic field name', () => {
    const body = serializeRequest(options({
      tools: [{ name: 'lookup', description: 'd', parameters: { type: 'object', properties: {} } }],
    }), DEFAULTS)
    expect(body.tools).toEqual([{ name: 'lookup', description: 'd', input_schema: { type: 'object', properties: {} } }])
  })
})

describe('serializeRequest: messages', () => {
  it('carries a tool call as tool_use and its result as a user-side tool_result', () => {
    const body = serializeRequest(options({
      messages: [
        user('do it'),
        assistant([{ type: 'tool-call', id: CallId('call_1'), name: 'lookup', arguments: '{"q":"hi"}' }]),
        toolResult('call_1', 'found'),
      ],
    }), DEFAULTS)
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'hi' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'found' }] },
    ])
  })

  it('merges consecutive same-role turns, which the API rejects unmerged', () => {
    const body = serializeRequest(options({ messages: [user('a'), user('b')] }), DEFAULTS)
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }])
  })

  it('folds a system-role history message into the top-level system field', () => {
    const systemMessage = { ...user('late instruction'), role: 'system' } as unknown as Message
    const body = serializeRequest(options({ messages: [systemMessage, user('hi')] }), DEFAULTS)
    expect(body.system).toBe('late instruction')
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  })

  it('drops reasoning blocks: echoing them back needs a signature we never hold', () => {
    const body = serializeRequest(options({
      messages: [assistant([{ type: 'reasoning', text: 'internal' }, { type: 'text', text: 'out' }])],
    }), DEFAULTS)
    expect(body.messages).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'out' }] }])
  })

  it('wraps malformed tool arguments instead of dropping the call', () => {
    const body = serializeRequest(options({
      messages: [assistant([{ type: 'tool-call', id: CallId('c'), name: 'n', arguments: '{oops' }])],
    }), DEFAULTS)
    expect(body.messages).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'n', input: { _raw: '{oops' } }] },
    ])
  })
})

describe('serializeRequest: image rejection', () => {
  it('rejects image content loudly rather than silently erasing it', () => {
    const withImage = assistant([
      { type: 'text', text: 'see' },
      { type: 'image', attachment: { id: 'a', mediaType: 'image/png', bytes: 1 } as never },
    ])
    expect(() => serializeRequest(options({ messages: [withImage] }), DEFAULTS)).toThrowError(LlmError)
  })
})

describe('ANTHROPIC_VERSION', () => {
  it('pins the version the adapter sends on every request', () => {
    expect(ANTHROPIC_VERSION).toBe('2023-06-01')
  })
})
