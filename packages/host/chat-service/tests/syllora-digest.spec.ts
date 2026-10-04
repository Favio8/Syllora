/**
 * 提炼管线（`ui.digest`，默认开）：材料先提炼成结构化知识文档，再按节建来源整理讲义。
 *
 * 全部用注入的假解析器与假模型客户端（不打网络），守住这些契约：
 *  - 提炼单元：分页材料按页范围、Markdown 按标题/行范围，锚点机械继承（绝不编页码）；
 *  - 只有标题没有正文的块不单独成块（章节标题随下文一起成块）；
 *  - 提炼结果按节建来源，章节型材料一个批次即可整理（调用次数骤减）；
 *  - 引文双基：引文允许在提炼文本或该节对应的原材料原文中逐字命中，两处都没有才算编造；
 *  - parse-v7 缓存绑定模型：同模型重跑不发提炼调用，换模型重新提炼；
 *  - 单个单元提炼失败降级为原文继续（warning 如实记录），不阻断整次初始化；
 *  - `digest:false` 维持旧口径（对原始切片按批整理），两条链路的缓存互不干扰。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { StructuredCallClient } from '@syllora/course-builder'
import { SylloraProjects } from '../src/syllora-projects.ts'
import { digestUnits, repairLecture, sourcesFromDigest, validateLecture } from '../src/syllora-initialize.ts'
import type { ExtractInput, ExtractResult } from '../src/syllora-extract.ts'
import type { ResolvedChatConfig } from '../src/config.ts'

const temp = resolve('..', 'tmp', 'digest-pipeline-tests'), roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) { if (!root.startsWith(temp)) throw new Error('unsafe test cleanup'); await rm(root, { recursive: true, force: true }) } })

const MARKDOWN = [
  '# 第一章 电路基础',
  '',
  '## 1.1 电路模型',
  '',
  '电路由电源、负载和导线三个基本部分组成，电流的通路称为电路。',
  '',
  '## 1.2 欧姆定律',
  '',
  '欧姆定律描述电压、电流与电阻的关系：U = I × R，电压单位是伏特。',
  '',
  '# 第二章 电阻元件',
  '',
  '## 2.1 线性电阻',
  '',
  '线性电阻的阻值不随电压和电流变化，始终满足欧姆定律。',
].join('\n')

function lecture(sources: any[]) {
  return {
    chapter: '第一章 电路基础',
    intro: { text: '按提炼文档整理的章节导读。', sourceIds: sources.map(source => source.id) },
    concepts: sources.filter(source => source.text.trim().length >= 4).map((source, index) => ({
      name: `概念 ${index + 1}`, text: '概念解释来自提炼文档。', sourceIds: [source.id],
      quote: source.text.trim().slice(0, Math.min(40, source.text.trim().length)),
    })),
    examples: [], connections: [], analogies: [],
  }
}

/** 假提炼：把一段材料按行拆成两个小节（正文来自输入、去掉原始标题行，保证引文能落回且贴近真实产物）。 */
function fakeDigest(text: string): string {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '' && !/^#{1,6}\s/.test(line))
  const mid = Math.max(1, Math.ceil(lines.length / 2))
  const first = lines.slice(0, mid).join(' ')
  const second = lines.slice(mid).join(' ') || first
  return `## 提炼小节一\n\n${first}\n\n## 提炼小节二\n\n${second}`
}

interface FakeModel { digestCalls: number; lectureCalls: number; model: string; digestImpl?: (text: string) => string; lectureImpl?: (sources: any[]) => unknown }

function fakeClient(state: FakeModel): StructuredCallClient {
  return {
    async *stream(options) {
      const message = (options.messages.at(-1) as { content: Array<{ text: string }> }).content[0]!.text
      if (message.startsWith('材料：')) {
        state.digestCalls += 1
        const body = message.slice(message.indexOf('\n\n') + 2)
        const digest = state.digestImpl ? state.digestImpl(body) : fakeDigest(body)
        if (digest === '') throw new Error('提炼桩失败')
        yield { type: 'text-delta', text: digest }
        return
      }
      state.lectureCalls += 1
      const sources = JSON.parse(message.slice(message.indexOf('所选资料：\n') + '所选资料：\n'.length))
      yield { type: 'text-delta', text: JSON.stringify(state.lectureImpl ? state.lectureImpl(sources) : lecture(sources)) }
    },
  }
}

async function setup(options: { digest?: boolean; digestImpl?: (text: string) => string; lectureImpl?: (sources: any[]) => unknown; extract?: (input: ExtractInput) => Promise<ExtractResult> } = {}) {
  await mkdir(temp, { recursive: true })
  const root = await mkdtemp(join(temp, 'case-')); roots.push(root)
  const folder = join(root, 'course'); await mkdir(folder)
  const state: FakeModel = { digestCalls: 0, lectureCalls: 0, model: 'fixture', ...(options.digestImpl ? { digestImpl: options.digestImpl } : {}), ...(options.lectureImpl ? { lectureImpl: options.lectureImpl } : {}) }
  const config = (): ResolvedChatConfig => ({ providerId: 'fixture', model: state.model, baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fixture-only', apiKeyEnv: null, temperature: 0, maxConcurrency: 2, ...(options.digest === false ? { digest: false } : { digest: true }) })
  const extract = options.extract ?? (async () => ({ engine: 'local' as const, markdown: MARKDOWN, total: 1 }))
  const app = join(root, 'app'), projects = new SylloraProjects(app, { config: async () => config(), client: () => fakeClient(state), extract })
  await projects.handle('preferences', { consent: true })
  const course = await projects.handle('openCourse', { path: folder }) as { id: string }
  return { root, folder, app, projects, id: course.id, state }
}

async function initialize(s: Awaited<ReturnType<typeof setup>>) {
  const scan = await s.projects.handle('scan', { courseId: s.id }) as { files: Array<{ path: string; status: string; fingerprint: string }> }
  const files = scan.files.filter(file => file.status === 'ready')
  const job = await s.projects.handle('initialize', { courseId: s.id, requestId: randomUUID(), paths: files.map(file => file.path), fingerprints: Object.fromEntries(files.map(file => [file.path, file.fingerprint])), acceptPartial: false }) as { jobId: string }
  for (let i = 0; i < 1500; i++) {
    const state = await s.projects.handle('state', {}) as { jobs: Array<{ id: string; state: string; errorCode?: string | null; message?: string }> }
    const jobState = state.jobs.find((candidate) => candidate.id === job.jobId)
    if (jobState && jobState.state !== 'running') return { state, job: jobState }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('initialization did not settle')
}

describe('提炼单元：锚点机械继承', () => {
  it('分页材料按页范围成块，Markdown 只在最外层标题切块（深子标题留在块内）', () => {
    const paged = digestUnits([
      { text: '第一页正文内容足够长。', anchor: '第 1 页', name: '第一章' },
      { text: '第二页正文内容同样够长。', anchor: '第 2 页', name: '第一章' },
      { text: '第三页正文。', anchor: '第 3 页', name: '第一章' },
    ], 'fallback')
    expect(paged).toHaveLength(1)
    expect(paged[0]!.anchor).toBe('第 1–3 页')
    expect(paged[0]!.title).toBe('第一章')

    const markdown = digestUnits([{ text: MARKDOWN, anchor: 'demo.md' }], 'demo.md')
    // 只在 `#`（最外层）切块：两章两块；`##` 小节不单独成块，也不产生「只有标题」的空块。
    expect(markdown).toHaveLength(2)
    expect(markdown[0]!.title).toBe('第一章 电路基础')
    expect(markdown[0]!.anchor).toBe('行 1–10')
    expect(markdown[1]!.title).toBe('第二章 电阻元件')
    expect(markdown[1]!.anchor).toBe('行 11–15')

    const plain = digestUnits([{ text: '没有标题的一段正文。', anchor: 'demo.txt' }], 'demo.txt')
    expect(plain).toHaveLength(1)
    expect(plain[0]!.title).toBe('demo.txt')
    expect(plain[0]!.anchor).toBe('行 1–1')
  })

  it('提炼结果按节建来源并保留核对底本', () => {
    const unit = { title: '第一章', anchor: '行 1–6', text: '原材料正文：U = I × R。' }
    const built = sourcesFromDigest('m1', 'v1', [{ unit, markdown: '## 小节甲\n\n电压等于电流乘电阻。\n\n## 小节乙\n\n电路是电流的通路。' }])
    expect(built.sources.map(source => source.anchor)).toEqual(['行 1–6 · 小节甲', '行 1–6 · 小节乙'])
    expect(built.sources.map(source => source.section)).toEqual(['小节甲', '小节乙'])
    expect(built.sources[0]!.nextId).toBe(built.sources[1]!.id)
    for (const source of built.sources) expect(built.bases.get(source.id)).toBe(unit.text)
  })
})

describe('引文双基：提炼文本或原材料任一处命中即算原文依据', () => {
  const sources = [{ id: 's1', materialId: 'm1', version: 'v1', anchor: '行 1–2 · 欧姆定律', text: '电压等于电流乘以电阻。', section: '欧姆定律', context: '第一章', kind: 'paragraph', start: 0, end: 12 }] as never[]
  const original = new Map([['s1', '原文：欧姆定律 U = I × R 描述三者关系。']])
  const value = (quote: string) => ({ chapter: '第一章', intro: { text: '导读', sourceIds: ['s1'] }, concepts: [{ name: '欧姆定律', text: '解释', sourceIds: ['s1'], quote }], examples: [], connections: [], analogies: [] })

  it('提炼改写后引用原材料仍通过；两处都没有则视为编造', () => {
    expect(() => validateLecture(value('U = I × R') as never, sources, original)).not.toThrow()
    expect(() => validateLecture(value('U = I × R') as never, sources)).toThrow('讲义依据不是资料原文')
    expect(() => validateLecture(value('与资料无关的一句话') as never, sources, original)).toThrow('讲义依据不是资料原文')
  })

  it('修复引文时同样按双基匹配', () => {
    const repaired = repairLecture(value('U = I × R') as never, sources, original)
    expect(repaired.concepts[0]!.sourceIds).toEqual(['s1'])
  })
})

describe('提炼管线：调用次数、缓存与降级', () => {
  it('章节型材料：提炼 2 次 + 讲义 1 次；重跑命中缓存不再发调用；换模型重新提炼', async () => {
    const s = await setup()
    await writeFile(join(s.folder, 'chapter1.md'), MARKDOWN)
    const { state } = await initialize(s)
    const course = (state as { courses: Array<{ materials: Array<{ sources: Array<{ anchor: string }>; warnings: string[] }> }> }).courses[0]!
    const material = course.materials[0]!
    // 两个单元 × 两节 = 4 个来源；章节型材料一个批次完成。
    expect(material.sources).toHaveLength(4)
    expect(material.sources.every(source => source.anchor.startsWith('行 '))).toBe(true)
    expect(material.warnings.join('')).toContain('提炼')
    expect(s.state.digestCalls).toBe(2)
    expect(s.state.lectureCalls).toBe(1)
    // 提炼文档落盘。
    const digestFile = join(s.folder, '.syllora', 'parsed', (state as { courses: Array<{ materials: Array<{ id: string }> }> }).courses[0]!.materials[0]!.id, 'digest.md')
    expect(await readFile(digestFile, 'utf8')).toContain('提炼小节一')

    await initialize(s)
    expect(s.state.digestCalls).toBe(2)
    expect(s.state.lectureCalls).toBe(1)

    s.state.model = 'other-model'
    await initialize(s)
    expect(s.state.digestCalls).toBe(4)
    expect(s.state.lectureCalls).toBe(2)
  })

  it('单个单元提炼失败降级为原文继续，warning 如实记录', async () => {
    const s = await setup({ digestImpl: (text) => (text.includes('1.1 电路模型') ? '' : fakeDigest(text)) })
    await writeFile(join(s.folder, 'chapter1.md'), MARKDOWN)
    const { state, job } = await initialize(s)
    expect(job.state).toBe('succeeded')
    const material = (state as { courses: Array<{ materials: Array<{ sources: Array<{ anchor: string }>; warnings: string[] }> }> }).courses[0]!.materials[0]!
    expect(material.warnings.join('')).toContain('提炼失败')
    // 失败单元按原文成来源（锚点仍是该单元的行范围），成功单元按节成来源。
    expect(material.sources.some(source => source.anchor.startsWith('行 1–10'))).toBe(true)
    expect(material.sources.some(source => source.anchor.startsWith('行 11–15'))).toBe(true)
  })

  it('digest:false 维持旧口径：不发提炼调用，来源仍是原始切片', async () => {
    const s = await setup({ digest: false })
    await writeFile(join(s.folder, 'chapter1.md'), MARKDOWN)
    const { state } = await initialize(s)
    const material = (state as { courses: Array<{ materials: Array<{ sources: Array<{ anchor: string }>; warnings: string[] }> }> }).courses[0]!.materials[0]!
    expect(s.state.digestCalls).toBe(0)
    expect(material.warnings.join('')).not.toContain('提炼')
    expect(material.sources.length).toBeGreaterThan(4)
    expect(material.sources.some(source => source.anchor.includes('字符'))).toBe(true)
  })

  it('引文取自原材料（提炼改写后不在提炼文本里）也能通过：双基在管线内生效', async () => {
    const digestImpl = () => '## 欧姆定律\n\n电压等于电流乘以电阻。'
    const lectureImpl = (sources: any[]) => ({
      chapter: '第一章',
      intro: { text: '导读', sourceIds: sources.map(source => source.id) },
      concepts: [{ name: '欧姆定律', text: '解释', sourceIds: [sources[0]!.id], quote: 'U = I × R' }],
      examples: [], connections: [], analogies: [],
    })
    const s = await setup({ digestImpl, lectureImpl })
    await writeFile(join(s.folder, 'chapter1.md'), MARKDOWN)
    const { job } = await initialize(s)
    expect(job.state).toBe('succeeded')
  })
})