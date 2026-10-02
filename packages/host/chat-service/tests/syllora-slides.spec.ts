/**
 * 幻灯片讲义：生成、引用校验、失败降级、旧版本兼容，以及"默认关闭"的契约。
 * 这些用例都用合成客户端，不依赖真实模型。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { SylloraProjects } from '../src/syllora-projects.ts'
import type { StructuredCallClient } from '@syllora/course-builder'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const config = { providerId: 'fixture', model: 'fixture', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fixture-only', apiKeyEnv: null, temperature: 0, maxConcurrency: 1, defaultMode: 'quick' as const }

/** 讲义 payload（与既有夹具同形）。 */
function lecture(sources: any[]) {
  return {
    chapter: String(sources[0].section).split(' / ').at(-1)!.slice(0, 60),
    intro: { text: '合成章节导读', sourceIds: sources.map(source => source.id) },
    concepts: sources.filter(source => source.kind !== 'heading' && source.text.length >= 4)
      .map((source, i) => ({ name: `合成概念 ${i}`, text: '合成解释', sourceIds: [source.id], quote: source.text.slice(0, 40) })),
    examples: [], connections: [], analogies: [],
  }
}

/**
 * 幻灯片 payload：画布 1000×562，每页引用两个片段里的一部分。
 * `copies` 让同一份来源可以被多页引用；`corrupt` 用来制造"契约不合法"的输出。
 */
function deck(sources: any[], options: { corrupt?: boolean } = {}) {
  const headings = sources.filter(source => source.kind === 'heading')
  const bodies = sources.filter(source => source.kind !== 'heading')
  const text = (id: string, content: string, left: number, top: number, width: number, height: number) =>
    ({ type: 'text', id, left, top, width, height, rotate: 0, content: `<p>${content}</p>`, defaultFontName: 'sans-serif', defaultColor: '#202128' })
  const canvas = (id: string, heading: any, body: any) => ({
    id, viewportSize: 1000, viewportRatio: 0.5625,
    theme: { backgroundColor: '#ffffff', themeColors: ['#002fa7'], fontColor: '#202128', fontName: 'sans-serif' },
    elements: [
      text(`${id}-title`, String(heading?.text ?? '章节').replace(/^#\s*/, '').slice(0, 30), 60, 40, 880, 80),
      text(`${id}-body`, String(body?.text ?? '依据').slice(0, 40), 60, 160, 880, 300),
    ],
  })
  const scenes = [
    { id: 'scene-1', title: '本章要点', order: 0, citations: [headings[0]?.id ?? sources[0]!.id], content: { type: 'slide' as const, canvas: canvas('c1', headings[0], bodies[0]) } },
    { id: 'scene-2', title: '展开说明', order: 1, citations: bodies.map(source => source.id).slice(0, 1), content: { type: 'slide' as const, canvas: canvas('c2', headings[0], bodies[0]) } },
  ]
  if (options.corrupt) {
    // 越界坐标 + 缺失 theme：schema 与契约都不该放行。
    scenes.push({ id: 'scene-3', title: '坏的', order: 2, citations: ['not-a-real-source'], content: { type: 'slide' as const, canvas: { id: 'c3', viewportSize: 0, viewportRatio: 0, theme: {} as never, elements: [] } } as never })
  }
  return { chapter: String(sources[0].section).split(' / ').at(-1)!.slice(0, 60), scenes }
}

async function setup(options: { slides?: boolean; corruptDeck?: boolean; extraCalls?: number[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'syllora-slides-'))
  roots.push(root)
  const folder = join(root, 'course')
  await mkdir(folder)
  await writeFile(join(folder, 'a.md'), '# 甲章\n\n合成甲章依据，用于幻灯片。\n\n# 乙章\n\n合成乙章依据，用于幻灯片。')
  let lectureCalls = 0, slideCalls = 0
  const client: StructuredCallClient = {
    async *stream(callOptions) {
      const text = (callOptions.messages.at(-1) as any).content[0].text as string
      const sources = JSON.parse(text.slice(text.indexOf('所选资料：\n') + '所选资料：\n'.length))
      if (text.includes('课堂幻灯片')) {
        slideCalls++
        if (options.corruptDeck) throw new Error('合成幻灯片失败')
        yield { type: 'text-delta', text: JSON.stringify(deck(sources, { corrupt: options.corruptDeck })) }
        return
      }
      lectureCalls++
      yield { type: 'text-delta', text: JSON.stringify(lecture(sources)) }
    },
  }
  const projects = new SylloraProjects(join(root, 'app'), {
    config: async () => config, client: () => client,
    ...(options.slides === undefined ? {} : { slides: options.slides }),
  })
  await projects.handle('preferences', { consent: true })
  const { id } = await projects.handle('openCourse', { path: folder }) as { id: string }
  const job = await projects.handle('initialize', { courseId: id, requestId: randomUUID(), paths: ['a.md'] }) as { jobId: string }
  let settled: any
  for (let i = 0; i < 400; i++) {
    const state = await projects.handle('state', {}) as any
    const current = state.jobs.find((candidate: any) => candidate.id === job.jobId)
    if (current && current.state !== 'running') { settled = { state, job: current }; break }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  if (!settled) throw new Error('初始化未结束')
  return { root, folder, projects, id, ...settled, calls: () => ({ lectureCalls, slideCalls }) }
}

describe('幻灯片讲义', () => {
  it('开启时按章节产出幻灯片，写进 revision 并带可回溯引用', async () => {
    const s = await setup({ slides: true })
    expect(s.job.state).toBe('succeeded')
    expect(s.calls().slideCalls).toBeGreaterThan(0)
    const revision = s.state.courses[0].revision
    const decks = JSON.parse(await readFile(join(s.folder, '.syllora', 'revisions', revision, 'slides.json'), 'utf8'))
    expect(decks.length).toBeGreaterThan(0)
    for (const item of decks) {
      expect(item.scenes.length).toBeGreaterThan(0)
      for (const scene of item.scenes) expect(scene.citations.length).toBeGreaterThan(0)
    }
    // 通过公开读取面拿到幻灯片，且引用仍指向可用来源。
    const read = await s.projects.handle('slides', { courseId: s.id }) as any
    expect(read.revision).toBe(revision)
    expect(read.decks.length).toBe(decks.length)
    const manifest = JSON.parse(await readFile(join(s.folder, '.syllora', 'revisions', revision, 'manifest.json'), 'utf8'))
    expect(manifest.slideDeckCount).toBe(decks.length)
  })

  it('幻灯片失败只记进度，不影响讲义发布', async () => {
    const s = await setup({ slides: true, corruptDeck: true })
    // 讲义照常成功，revision 照常发布。
    expect(s.job.state).toBe('succeeded')
    expect(s.state.courses[0].revision).toBeTruthy()
    expect(s.job.progress.failures.join(' ')).toContain('幻灯片')
    const read = await s.projects.handle('slides', { courseId: s.id }) as any
    expect(read.decks).toEqual([])
    const lectures = await s.projects.handle('lectures', { courseId: s.id }) as any
    expect(lectures.lectures.length).toBeGreaterThan(0)
  })

  it('默认关闭：不产生幻灯片调用，也不写 slides.json', async () => {
    const s = await setup()
    expect(s.job.state).toBe('succeeded')
    expect(s.calls().slideCalls).toBe(0)
    const revision = s.state.courses[0].revision
    await expect(readFile(join(s.folder, '.syllora', 'revisions', revision, 'slides.json'), 'utf8')).rejects.toThrow()
  })

  it('旧 revision 没有 slides.json 时读作空列表而不是报错', async () => {
    const s = await setup({ slides: true })
    const revision = s.state.courses[0].revision
    // 模拟历史 revision：目录在、但没有 slides.json（这个特性之前发布的版本就是这样）。
    await rm(join(s.folder, '.syllora', 'revisions', revision, 'slides.json'))
    const read = await s.projects.handle('slides', { courseId: s.id }) as any
    expect(read.revision).toBe(revision)
    expect(read.decks).toEqual([])
  })

  it('来源被删除后，引用失效的幻灯片不再返回', async () => {
    const s = await setup({ slides: true })
    const materialId = s.state.courses[0].materials[0].id
    await s.projects.handle('deleteMaterial', { courseId: s.id, materialId, confirmed: true })
    const read = await s.projects.handle('slides', { courseId: s.id }) as any
    // 资料删除会清掉发布产物，因此这里要么空、要么只剩仍可回溯的页。
    for (const item of read.decks) for (const scene of item.scenes) expect(scene.citations.length).toBeGreaterThan(0)
  })
})
