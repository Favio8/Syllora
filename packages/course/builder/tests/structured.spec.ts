/**
 * extractJsonObject 回归（第四轮对抗性审查 RV-9）：括号深度扫描必须感知
 * 字符串字面量——题目内容含引号内花括号/引号转义时，裸计数会提前判闭合，
 * 切片 JSON.parse 恒败，structuredCall 重试耗尽后整卡构建失败。
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { extractJsonObject, extractXmlToolCall, salvageStructuredFields, tryStructuredCall } from '../src/structured.ts'

describe('extractJsonObject', () => {
  it('RV-9：字符串内的花括号不破坏深度计数', () => {
    const raw = '{"question":"求证 f(x)={x} 的定义域","answer_index":2}'
    expect(extractJsonObject(raw)).toEqual({ question: '求证 f(x)={x} 的定义域', answer_index: 2 })
  })

  it('RV-9：字符串内的引号转义与嵌套对象', () => {
    const raw = '{"a":"她说：\\"中间}有花括号\\"","b":{"c":"}"}}'
    expect(extractJsonObject(raw)).toEqual({ a: '她说："中间}有花括号"', b: { c: '}' } })
  })

  it('围栏 JSON 与前后散文共存时正常提取', () => {
    const text = '好的，以下是结果：\n```json\n{"tasks":[{"question":"含 } 的题目"}]}\n```\n以上就是输出。'
    const parsed = extractJsonObject(text) as { tasks: Array<{ question: string }> }
    expect(parsed.tasks[0]!.question).toBe('含 } 的题目')
  })

  it('围栏片段损坏时回落全文扫描（RV-9 兜底候选）', () => {
    const text = '```json\n{"broken": tru\n```\n{"ok": true}'
    expect(extractJsonObject(text)).toEqual({ ok: true })
  })

  it('无 JSON 时抛错', () => {
    expect(() => extractJsonObject('抱歉，我无法输出。')).toThrow('未找到合法 JSON')
  })
})

/**
 * 降级放行（用户口径）：结构化输出失败也发布。这里覆盖两条：
 *  - extractJsonObject 认得 XML 工具调用方言（实测小米 MiMo 会这么回）；
 *  - salvageStructuredFields 能从残缺原文里抢救正文与来源 id。
 */
describe('extractXmlToolCall / salvageStructuredFields', () => {
  const xml = ['<tool_call>', '<function=_emit_structured>', '<parameter=text>电流表示电荷定向移动的快慢。\n第二行。</parameter>', '<parameter=sourceIds>["aaaa1111bbbb2222cccc3333dddd4444","eeee5555ffff6666aaaa7777bbbb8888"]</parameter>', '<parameter=insufficient>false</parameter>', '</function>', '</tool_call>'].join('\n')

  it('XML 工具调用方言能被 extractJsonObject 解析（原文里的 JSON 不再被判"没有合法 JSON"）', () => {
    const parsed = extractJsonObject(xml) as { text: string; sourceIds: string[]; insufficient: boolean }
    expect(parsed.text).toContain('电流表示电荷定向移动的快慢')
    expect(parsed.sourceIds).toEqual(['aaaa1111bbbb2222cccc3333dddd4444', 'eeee5555ffff6666aaaa7777bbbb8888'])
    expect(parsed.insufficient).toBe(false)
  })

  it('`<parameter name="x">` 写法同样认', () => {
    expect(extractXmlToolCall('<parameter name="insufficient">true</parameter>')).toEqual({ insufficient: true })
  })

  it('模型只回散文时：剥掉脚手架当正文发布，来源为空', () => {
    const prose = ['<tool_call>', '<function=_emit_structured>', '先讲本质：电流是电荷的定向移动。', '</function>', '</tool_call>'].join('\n')
    const salvaged = salvageStructuredFields(prose)
    expect(salvaged.recovered).toBe('text')
    expect(salvaged.text).toContain('电流是电荷的定向移动')
    expect(salvaged.text).not.toContain('tool_call')
    expect(salvaged.sourceIds).toEqual([])
  })

  it('字段残缺（缺 insufficient）时仍能抢救正文与来源 id', () => {
    const partial = '<parameter=text>只写了正文。</parameter><parameter=sourceIds>["aaaa1111bbbb2222cccc3333dddd4444"]</parameter>'
    const salvaged = salvageStructuredFields(partial)
    expect(salvaged.recovered).toBe('xml')
    expect(salvaged.text).toBe('只写了正文。')
    expect(salvaged.sourceIds).toEqual(['aaaa1111bbbb2222cccc3333dddd4444'])
  })

  it('降级发布绝不含模型的自我推演（reasoning 不参与正文）', async () => {
    const client = {
      async *stream() {
        yield { type: 'reasoning-delta', text: '用户问的是电流，我得先想想怎么组织语言。' }
        yield { type: 'text-delta', text: '电流是电荷的定向移动，电压是推动电荷的势差。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const attempt = await tryStructuredCall(client as never, z.object({ text: z.string() }), { provider: 'fixture', model: 'fixture', messages: [] } as never, 1)
    expect(attempt.ok).toBe(false)
    expect(attempt.raw).toContain('电流是电荷的定向移动')
    expect(attempt.raw).not.toContain('我得先想想')
  })

  it('正文里内联的 <think> 块在降级发布前剥掉', async () => {
    const client = {
      async *stream() {
        yield { type: 'text-delta', text: '<think>先算一下…</think>电流是电荷的定向移动。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const attempt = await tryStructuredCall(client as never, z.object({ text: z.string() }), { provider: 'fixture', model: 'fixture', messages: [] } as never, 1)
    expect(attempt.raw).toBe('电流是电荷的定向移动。')
  })

  it('源码围栏里的散文只保留正文', () => {
    const salvaged = salvageStructuredFields(['说明如下：', '```json', '{"text":"围栏里的正文"}', '```', '以上。'].join('\n'))
    expect(salvaged.text).toBe('围栏里的正文')
    expect(salvaged.recovered).toBe('json')
  })
})

describe('tryStructuredCall 的形状失败与供应商错误分界', () => {
  it('形状失败返回 ok:false 并带上原始输出（供降级发布）', async () => {
    const client = { async *stream() { yield { type: 'text-delta', text: '没有 JSON 的散文' } } }
    const attempt = await tryStructuredCall(client as never, z.object({ ok: z.boolean() }), { provider: 'fixture', model: 'fixture', messages: [] } as never, 1)
    expect(attempt.ok).toBe(false)
    expect(attempt.raw).toContain('没有 JSON 的散文')
    expect(attempt.reason).toContain('未找到合法 JSON')
  })

  it('schema 不符也算形状失败（不是供应商错误）', async () => {
    const client = { async *stream() { yield { type: 'text-delta', text: '{"ok":"不是布尔"}' } } }
    const attempt = await tryStructuredCall(client as never, z.object({ ok: z.boolean() }), { provider: 'fixture', model: 'fixture', messages: [] } as never, 1)
    expect(attempt.ok).toBe(false)
    expect(attempt.raw).toContain('不是布尔')
  })

  it('供应商级错误（截断）直接抛出，不做降级', async () => {
    const client = { async *stream() { yield { type: 'finish', reason: { kind: 'max-tokens' } } } }
    await expect(tryStructuredCall(client as never, z.object({ ok: z.boolean() }), { provider: 'fixture', model: 'fixture', messages: [] } as never, 1)).rejects.toThrow('已截断')
  })

  it('XML 方言经结构化调用直接成功（不再触发降级）', async () => {
    const fixture = ['<tool_call>', '<function=_emit_structured>', '<parameter=text>电流表示电荷定向移动的快慢。\n第二行。</parameter>', '<parameter=sourceIds>["aaaa1111bbbb2222cccc3333dddd4444","eeee5555ffff6666aaaa7777bbbb8888"]</parameter>', '<parameter=insufficient>false</parameter>', '</function>', '</tool_call>'].join('\n')
    const client = { async *stream() { yield { type: 'text-delta', text: fixture } } }
    const attempt = await tryStructuredCall(client as never, z.object({ text: z.string(), sourceIds: z.array(z.string()), insufficient: z.boolean() }), { provider: 'fixture', model: 'fixture', messages: [] } as never, 1)
    expect(attempt.ok).toBe(true)
    expect(attempt.value?.sourceIds).toHaveLength(2)
  })
})
