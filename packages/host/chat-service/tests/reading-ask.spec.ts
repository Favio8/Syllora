/**
 * 需求六：辅助阅读「直接提问」的流式回答（streamReadingAsk）。
 *
 * 覆盖：未配置模型 → 单条 error；提示词原样进 LLM 调用、token 按序下发；
 * `<think>` 块（含跨 delta 的半截标签）永不下发到 token；上游异常 → error 帧
 * 且不留栈/密钥；取消（signal 已中止）不再补 done。
 *
 * LLM 接缝用 streamReadingAsk 的可注入客户端工厂替换，不打网络。
 */

import { describe, expect, it } from 'vitest'
import type { ResolvedChatConfig } from '../src/config.ts'
import { streamReadingAsk, type ReadingAskChunk, type ReadingAskInput } from '../src/reading-ask.ts'

const config: ResolvedChatConfig = {
  providerId: 'mock',
  model: 'mock-model',
  baseUrl: 'http://127.0.0.1:9/v1',
  protocol: 'openai',
  apiKeyEnv: 'MOCK_KEY',
  apiKey: 'test-key',
  temperature: 0.3,
  maxConcurrency: 1,
  defaultMode: 'quick',
}

interface Call {
  system: string
  messages: Array<Record<string, unknown>>
  tools: unknown
}

/** 假客户端：记录调用参数，按给定序列产流（字符串=文本增量，Error=抛错）。 */
function fakeClient(chunks: Array<string | Error>) {
  const calls: Call[] = []
  return {
    calls,
    factory: () => ({
      async *request(system: string, messages: Array<Record<string, unknown>>, tools: Array<Record<string, unknown>> | null) {
        calls.push({ system, messages, tools })
        for (const chunk of chunks) {
          if (chunk instanceof Error) throw chunk
          yield { kind: 'text' as const, delta: chunk }
        }
      },
    }),
  }
}

async function collect(input: ReadingAskInput, chunks: Array<string | Error>, signal?: AbortSignal) {
  const client = fakeClient(chunks)
  const frames: ReadingAskChunk[] = []
  for await (const frame of streamReadingAsk(config, input, signal, client.factory)) frames.push(frame)
  return { frames, calls: client.calls }
}

const tokensOf = (frames: ReadingAskChunk[]): string[] => frames.filter(frame => frame.kind === 'token').map(frame => frame.delta ?? '')

describe('streamReadingAsk（需求六）', () => {
  it('未配置模型时只下发一条 error 回包', async () => {
    const frames: ReadingAskChunk[] = []
    for await (const frame of streamReadingAsk(null, { prompt: '什么是多态？' })) frames.push(frame)
    expect(frames).toEqual([{ kind: 'error', message: '尚未配置模型，无法回答。请先在设置里配置模型供应商。' }])
  })

  it('无选区时提示词原样进调用，token 按序流出', async () => {
    const { frames, calls } = await collect({ prompt: '什么是多态？' }, ['多', '态', '是同一接口的不同实现。'])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.messages).toEqual([{ role: 'user', content: '什么是多态？' }])
    // 直答不是工具回合：不带 tools。
    expect(calls[0]!.tools).toBeNull()
    expect(tokensOf(frames)).toEqual(['多', '态', '是同一接口的不同实现。'])
    expect(frames.at(-1)).toEqual({ kind: 'done' })
  })

  it('有选区与资料标题时组装成上下文提示，选区超长截断', async () => {
    const { calls } = await collect({ prompt: '解释一下', selection: '虚函数表', documentTitle: '讲义.md' }, ['好'])
    expect(calls[0]!.messages).toEqual([{ role: 'user', content: '资料标题：讲义.md\n\n选中文字：虚函数表\n\n提示词：解释一下' }])
    const long = await collect({ prompt: '解释一下', selection: 'x'.repeat(5000) }, ['好'])
    const content = String((long.calls[0]!.messages[0] as { content: string }).content)
    expect(content).toContain(`选中文字：${'x'.repeat(4000)}`)
    expect(content).not.toContain('x'.repeat(4001))
  })

  it('<think> 块（含跨 delta 半截标签）不会出现在任何 token 里', async () => {
    const { frames } = await collect({ prompt: '提问' }, ['<think>', '内部推理', '</think>', '答', '案'])
    expect(tokensOf(frames)).toEqual(['答', '案'])
    const split = await collect({ prompt: '提问' }, ['<thi', 'nk>先推导</think>可见结论', '正文'])
    expect(tokensOf(split.frames)).toEqual(['可见结论', '正文'])
    for (const delta of tokensOf(split.frames)) expect(delta.toLowerCase()).not.toContain('<think')
  })

  it('上游异常 → error 帧（去掉栈行与密钥痕迹），不再补 done', async () => {
    const { frames } = await collect({ prompt: '提问' }, ['开头', new Error('上游拒绝：密钥 sk-live-abcdef123456 无效\n    at adapter.ts:42')])
    expect(tokensOf(frames)).toEqual(['开头'])
    const last = frames.at(-1)
    expect(last?.kind).toBe('error')
    expect(last?.message).toBe('上游拒绝：密钥 sk-*** 无效')
  })

  it('取消（signal 已中止）不补 done 帧', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const { frames } = await collect({ prompt: '提问' }, ['半截'], aborted.signal)
    expect(frames.some(frame => frame.kind === 'done')).toBe(false)
  })
})
