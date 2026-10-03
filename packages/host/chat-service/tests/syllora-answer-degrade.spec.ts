/**
 * 降级放行（用户口径）：资料问答/讲解的结构化输出失败也要发布。
 * - 模型回 XML 工具调用方言 → XML 兜底解析直接成功，来源照常标注（不是降级）；
 * - 模型只回散文 → 降级发布：正文照发、不标来源，并在正文末尾注明未通过结构校验；
 * - 供应商级错误（截断）→ 仍然失败（没有可发布内容），错误码保持 OUTPUT_TRUNCATED；
 * - 大纲/题目等有证据含义的生成不降级（保持严格失败）。
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { StructuredCallClient } from '@syllora/course-builder'
import { SylloraProjects } from '../src/syllora-projects.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const config = { providerId: 'fixture', model: 'fixture', baseUrl: 'http://fixture.invalid/v1', apiKey: 'fixture', protocol: 'openai' as const, temperature: 0.3, maxConcurrency: 1, defaultMode: 'quick' as const }

/** 造一门有资料的课程，返回工程句柄与课程 id。 */
async function seed(client: StructuredCallClient) {
  const root = await mkdtemp(join(tmpdir(), 'syllora-answer-degrade-'))
  roots.push(root)
  const folder = join(root, 'course')
  await mkdir(folder)
  await writeFile(join(folder, 'a.md'), '# 电路\n\n电流是电荷的定向移动。电压是电场力做功。\n\n## 第二章\n\n欧姆定律：U=IR。基尔霍夫定律描述节点与回路约束。\n')
  const projects = new SylloraProjects(join(root, 'app'), { config: async () => config, client: () => client })
  await projects.handle('preferences', { consent: true })
  const opened = await projects.handle('openCourse', { path: folder, icon: 'physics' }) as { id: string }
  // 初始化讲义：这一步用同一个 client，测试里让它走标准 JSON 路径。
  const init = await projects.handle('initialize', { courseId: opened.id, requestId: randomUUID(), paths: ['a.md'], acceptPartial: true }) as { jobId: string }
  await settle(projects, init.jobId)
  return { projects, courseId: opened.id, folder, appDir: join(root, 'app') }
}

async function settle(projects: SylloraProjects, jobId: string) {
  for (let i = 0; i < 200; i += 1) {
    const state = await projects.handle('state', {}) as { courses: Array<Record<string, unknown>>; jobs: Array<{ id: string; state: string; message: string; errorCode?: string | null }> }
    const job = state.jobs.find(item => item.id === jobId)
    if (job && job.state !== 'running') return { job, state }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('job did not settle')
}

const lecture = (sources: Array<{ id: string; text: string }>) => ({
  chapter: '电路基础',
  intro: { text: '本章讲电路的基本量与定律。', sourceIds: sources.map(source => source.id) },
  concepts: [{ name: '电流', text: '电流是电荷的定向移动。', sourceIds: [sources[0]!.id], quote: sources[0]!.text.slice(0, 12) }],
  examples: [], connections: [], analogies: [],
})

function idFor(index: number): string { return `${'0123456789abcdef'[index % 16] ?? 'a'}${'abcdef0123456789'[index % 16] ?? 'b'}`.repeat(16) }

/** 一个按提示词分派的假模型：讲义走标准 JSON，答案走调用方指定的花招。 */
function fakeClient(answerBehavior: (sources: Array<{ id: string; text: string }>) => StreamChunk[]) {
  return {
    async *stream(options: { messages: Array<{ content: unknown }> }) {
      const text = String((options.messages.at(-1) as { content: Array<{ text?: string }> }).content[0]?.text ?? '')
      if (text.includes('初始化整理课程讲义')) {
        const sources = JSON.parse(text.slice(text.indexOf('所选资料：\n') + '所选资料：\n'.length)) as Array<{ id: string; text: string }>
        yield { type: 'text-delta', text: JSON.stringify(lecture(sources)) } as StreamChunk
        return
      }
      const marker = '所选资料（'
      const start = text.indexOf(marker)
      const sources = JSON.parse(text.slice(text.indexOf('\n', start) + 1)) as Array<{ id: string; text: string }>
      for (const chunk of answerBehavior(sources)) yield chunk
    },
  } as StructuredCallClient
}

describe('资料问答/讲解：结构校验失败降级放行', () => {
  it('模型回散文 → 照常发布、不标来源、正文注明未通过结构校验', async () => {
    const client = fakeClient(sources => [
      { type: 'text-delta', text: `先讲本质：电流是电荷的定向移动，电压是推动电荷的势差。\n（依据：${sources[0]!.id}）` } as StreamChunk,
      { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
    ])
    const { projects, courseId } = await seed(client)
    const created = await projects.handle('generate', { courseId, requestId: randomUUID(), kind: 'answer', prompt: '讲讲电流与电压' }) as { jobId: string }
    const { job, state } = await settle(projects, created.jobId)
    expect(job.state).toBe('succeeded')
    expect(job.errorCode ?? null).toBeNull()
    expect(job.message).toContain('降级发布')
    const course = state.courses.find(item => (item as { id: string }).id === courseId) as { messages: Array<{ role: string; text: string; sourceIds: string[] }> }
    const answer = course.messages.filter(message => message.role === 'assistant').at(-1)!
    expect(answer.text).toContain('电流是电荷的定向移动')
    expect(answer.text).toContain('本次回答未通过结构校验')
    expect(answer.text).toContain('未附来源')
    expect(answer.sourceIds).toEqual([])
  })

  it('模型回 XML 工具调用方言 → XML 兜底解析成功，来源照常标注（不算降级）', async () => {
    const client = fakeClient(sources => [
      { type: 'text-delta', text: ['<tool_call>', '<function=_emit_structured>', `<parameter=text>电流是电荷的定向移动（见资料 ${sources[0]!.id.slice(0, 8)}）。</parameter>`, `<parameter=sourceIds>["${sources[0]!.id}"]</parameter>`, '<parameter=insufficient>false</parameter>', '</function>', '</tool_call>'].join('\n') } as StreamChunk,
      { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
    ])
    const { projects, courseId } = await seed(client)
    const created = await projects.handle('generate', { courseId, requestId: randomUUID(), kind: 'answer', prompt: '讲讲电流' }) as { jobId: string }
    const { job, state } = await settle(projects, created.jobId)
    expect(job.state).toBe('succeeded')
    const course = state.courses.find(item => (item as { id: string }).id === courseId) as { messages: Array<{ role: string; text: string; sourceIds: string[] }> }
    const answer = course.messages.filter(message => message.role === 'assistant').at(-1)!
    expect(answer.sourceIds).toHaveLength(1)
    expect(answer.text).not.toContain('未通过结构校验')
    // 「本次使用 N 个资料片段」统计的是喂给模型的片段数（不是引用数）。
    expect(answer.text).toContain('本次使用 4 个资料片段')
  })

  it('模型引用了未提供的来源 → 忽略越界 id 并发布，正文注明', async () => {
    const client = fakeClient(sources => [
      { type: 'text-delta', text: JSON.stringify({ text: '电流是电荷的定向移动。', sourceIds: [sources[0]!.id, idFor(3)], insufficient: false }) } as StreamChunk,
      { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
    ])
    const { projects, courseId } = await seed(client)
    const created = await projects.handle('generate', { courseId, requestId: randomUUID(), kind: 'answer', prompt: '讲讲电流' }) as { jobId: string }
    const { job, state } = await settle(projects, created.jobId)
    expect(job.state).toBe('succeeded')
    const course = state.courses.find(item => (item as { id: string }).id === courseId) as { messages: Array<{ role: string; text: string; sourceIds: string[] }> }
    const answer = course.messages.filter(message => message.role === 'assistant').at(-1)!
    expect(answer.sourceIds).toHaveLength(1)
    expect(answer.text).toContain('来源已按核验结果处理')
    expect(answer.text).toContain('已忽略 1 个未提供的来源')
  })

  it('模型输出被截断 → 仍然失败（错误码 OUTPUT_TRUNCATED，不降级）', async () => {
    const client = fakeClient(() => [
      { type: 'text-delta', text: '{"text":"写到一半' } as StreamChunk,
      { type: 'finish', reason: { kind: 'max-tokens' } } as StreamChunk,
    ])
    const { projects, courseId } = await seed(client)
    const created = await projects.handle('generate', { courseId, requestId: randomUUID(), kind: 'answer', prompt: '讲讲电流' }) as { jobId: string }
    const { job } = await settle(projects, created.jobId)
    expect(job.state).toBe('failed')
    expect(job.errorCode).toBe('OUTPUT_TRUNCATED')
  })

  it('讲义/大纲生成不降级：模型只回散文时既不发布讲义也不产生知识点', async () => {
    const { projects, courseId, folder, appDir } = await seed(fakeClient(sources => [{ type: 'text-delta', text: JSON.stringify({ text: 'ok', sourceIds: [sources[0]!.id], insufficient: false }) } as StreamChunk]))
    // 换一个"只会回散文"的模型重开这门课（讲义调用拿不到合法 JSON）。
    const proseClient = {
      async *stream() { yield { type: 'text-delta', text: '我觉得可以先学电流再看电压。' } as StreamChunk; yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk },
    } as StructuredCallClient
    const reopened = new SylloraProjects(appDir, { config: async () => config, client: () => proseClient })
    await reopened.handle('preferences', { consent: true })
    await reopened.handle('openCourse', { path: folder })
    await writeFile(join(folder, 'a.md'), ['# 电路', '', '电流是电荷的定向移动。', '', '## 第三章', '', '叠加定理与戴维南等效。'].join('\n'))
    const before = await projects.handle('state', {}) as { courses: Array<{ id: string; points: unknown[] }> }
    const created = await reopened.handle('generate', { courseId, requestId: randomUUID(), kind: 'outline' }) as { jobId: string }
    const { job, state } = await settle(reopened, created.jobId)
    const course = state.courses.find(item => (item as { id: string }).id === courseId) as { points: unknown[] }
    // 讲义没整理出来（没有合法 JSON 就没有可发布内容），知识点数量不变。
    expect(course.points).toHaveLength(before.courses.find(item => item.id === courseId)!.points.length)
    expect(job.state).not.toBe('succeeded')
  })
})
