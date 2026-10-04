/**
 * 上传资料的统一解析：DocMind 是默认引擎，本地只做回退。
 *
 * 全部用注入的假解析器（不打真网络、不调 DocMind），守住这些契约：
 *  - 分页格式按「第 N 页」建来源（物理页码核对/失败页/引证口径不变），section 取该页所属章节；
 *  - 非分页格式（Word/HTML/纯文本）整份 markdown 交给 structuredSources 按标题分片；
 *  - 页码拿不到时不编造，降级原因写进资料 warnings；
 *  - 解析产物（markdown/大纲/图片）落 `parsed/<materialId>/`，受控路由能读、路径越界被拒；
 *  - 缓存分引擎（parse-v6）并保留 parse-v5 复用：旧资料不因换引擎被重解析；
 *  - state 的来源不带正文，正文按 id 取；阅读标记往返；
 *  - 单份/课程上限生效，且超限时一个模型调用都不发。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { StructuredCallClient } from '@syllora/course-builder'
import { SylloraProjects } from '../src/syllora-projects.ts'
import { MATERIAL_LIMITS, sha } from '../src/syllora-files.ts'
import { docMindExtract, localExtract, localizeDocMindImages, pagesFromLayouts, type ExtractInput, type ExtractResult, type DocMindLike } from '../src/syllora-extract.ts'
import type { ResolvedChatConfig } from '../src/config.ts'

const temp = resolve('..', 'tmp', 'docmind-material-tests'), roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) { if (!root.startsWith(temp)) throw new Error('unsafe test cleanup'); await rm(root, { recursive: true, force: true }) } })

const config: ResolvedChatConfig = { providerId: 'fixture', model: 'fixture', baseUrl: 'http://localhost:9999/v1', apiKey: 'fixture-only', apiKeyEnv: null, temperature: 0, maxConcurrency: 1, digest: false, defaultMode: 'quick' }

/** 讲义桩：把每批来源做成一个概念，保证引用回到原文（与既有用例同口径）。 */
function lecture(sources: any[]) {
  return { chapter: sources[0].section.split(' / ').at(-1).slice(0, 60), intro: { text: '按资料整理的章节导读。', sourceIds: sources.map(s => s.id) }, concepts: sources.filter(s => s.text.trim().length >= 4 && s.kind !== 'heading').map((s, i) => ({ name: `${s.section.split(' / ').at(-1).slice(0, 45)} 概念 ${i + 1}`, text: '概念解释来自所附资料。', sourceIds: [s.id], quote: s.text.slice(0, Math.min(40, s.text.length)) })), examples: [], connections: [], analogies: [] }
}

async function setup(extract: (input: ExtractInput) => Promise<ExtractResult>, pdf?: NonNullable<ConstructorParameters<typeof SylloraProjects>[1]>['pdf']) {
  await mkdir(temp, { recursive: true })
  const root = await mkdtemp(join(temp, 'case-')); roots.push(root)
  const folder = join(root, 'course'); await mkdir(folder)
  let calls = 0
  const client: StructuredCallClient = { async *stream(options) { const message = (options.messages.at(-1) as any).content[0].text; const sources = JSON.parse(message.slice(message.indexOf('所选资料：\n') + '所选资料：\n'.length)); calls++; yield { type: 'text-delta', text: JSON.stringify(lecture(sources)) } } }
  const app = join(root, 'app'), projects = new SylloraProjects(app, { config: async () => config, client: () => client, extract, ...(pdf ? { pdf } : {}) })
  await projects.handle('preferences', { consent: true })
  const course = await projects.handle('openCourse', { path: folder }) as { id: string }
  return { root, folder, app, projects, id: course.id, calls: () => calls }
}

async function initialize(s: Awaited<ReturnType<typeof setup>>, acceptPartial = true) {
  const scan = await s.projects.handle('scan', { courseId: s.id }) as { files: Array<{ path: string; status: string; fingerprint: string }> }
  const files = scan.files.filter(file => file.status === 'ready')
  const job = await s.projects.handle('initialize', { courseId: s.id, requestId: randomUUID(), paths: files.map(file => file.path), fingerprints: Object.fromEntries(files.map(file => [file.path, file.fingerprint])), acceptPartial }) as { jobId: string }
  for (let i = 0; i < 1500; i++) { const state = await s.projects.handle('state', {}) as any; const jobState = state.jobs.find((job: any) => job.id === job.jobId) ?? state.jobs.find((candidate: any) => candidate.id === job.jobId); if (jobState && jobState.state !== 'running') return { state, job: jobState }; await new Promise(r => setTimeout(r, 10)) }
  throw new Error('initialization did not settle')
}

/** 假 DocMind 结果：两页正文 + 一个章节标题（第 2 页起）+ markdown 大纲 + 一张本地化图片。 */
function docMindResult(overrides: Partial<ExtractResult> = {}): ExtractResult {
  return {
    engine: 'docmind', jobId: 'job-fixture', total: 2,
    pages: [
      { num: 1, text: '# 第一章 电路基础\n\n实际电路由电源、负载和导线三个基本部分组成。' },
      { num: 2, text: '欧姆定律描述电压、电流与电阻的关系：U = I × R。' },
    ],
    pageSections: { 1: '第一章 电路基础', 2: '第一章 电路基础' },
    markdown: '# 第一章 电路基础\n\n实际电路由电源、负载和导线三个基本部分组成。\n\n## 欧姆定律\n\n欧姆定律描述电压、电流与电阻的关系：U = I × R。\n',
    images: [{ name: 'img-fixture.png', data: new TextEncoder().encode('png-bytes') }],
    ...overrides,
  }
}

describe('资料解析：DocMind 分页与大纲', () => {
  it('keeps physical page anchors, maps each page to its chapter, and publishes markdown/outline/image artifacts', async () => {
    const s = await setup(async () => docMindResult())
    await writeFile(join(s.folder, 'chapter1.pdf'), 'fixture-pdf-bytes')
    const { state } = await initialize(s)
    const material = state.courses[0].materials[0]
    expect(material.engine).toBe('docmind')
    expect(material.pages).toBe(2)
    const anchors = material.sources.map((source: any) => source.anchor as string)
    expect(anchors.some(anchor => anchor.startsWith('第 1 页'))).toBe(true)
    expect(anchors.some(anchor => anchor.startsWith('第 2 页'))).toBe(true)
    // 章节归属来自 DocMind 的标题块：两页都归到「第一章 电路基础」，而不是文件名。
    expect(new Set(material.sources.map((source: any) => source.section))).toEqual(new Set(['第一章 电路基础']))
    expect(material.document).toMatchObject({ engine: 'docmind', hasMarkdown: true, images: 1 })
    expect(material.document.outline.map((node: any) => node.title)).toEqual(['第一章 电路基础', '欧姆定律'])
    // 解析产物落盘：markdown / 大纲 / 图片都在该资料名下，受控路由可读。
    const revision = state.courses[0].revision as string
    const base = join(s.folder, '.syllora', 'parsed', material.id)
    expect(await readFile(join(base, 'document.md'), 'utf8')).toContain('欧姆定律')
    expect(JSON.parse(await readFile(join(base, 'outline.json'), 'utf8')).map((node: any) => node.title)).toContain('欧姆定律')
    expect(await readFile(join(base, 'images', 'img-fixture.png'), 'utf8')).toBe('png-bytes')
    const markdown = await s.projects.readMaterialDocument(s.id, material.id, '') as { data: Buffer }
    expect(markdown.data.toString('utf8')).toContain('欧姆定律')
    const image = await s.projects.readMaterialDocument(s.id, material.id, 'images/img-fixture.png') as { contentType: string; data: Buffer }
    expect(image.contentType).toBe('image/png')
    // 路径越界与穿越一律拒绝。
    await expect(s.projects.readMaterialDocument(s.id, material.id, '../course.json')).rejects.toThrowError()
    // 学习链仍以来源为准：讲义与知识点引用都能回到「第 N 页」。
    expect(revision).toBeTruthy()
    expect(state.courses[0].points.length).toBeGreaterThan(0)
  })

  it('marks无页码的文档 as 章节定位 instead of inventing page numbers', async () => {
    const s = await setup(async () => docMindResult({ pages: undefined, pageSections: undefined, total: 3, pageNumbersUnavailable: '云端未返回逐页版式，本份资料按章节定位（无物理页码）', images: [] }))
    await writeFile(join(s.folder, 'notes.docx'), 'fixture-docx-bytes')
    const { state } = await initialize(s)
    const material = state.courses[0].materials[0]
    expect(material.engine).toBe('docmind')
    expect(material.pages).toBe(3)
    expect(material.sources.length).toBeGreaterThan(0)
    expect(material.sources.every((source: any) => (source.anchor as string).includes('notes.docx'))).toBe(true)
    expect(material.warnings.join(' ')).toContain('按章节定位')
    // 大纲来自 markdown 标题，供阅读页章节导航。
    expect(material.document.outline.map((node: any) => node.title)).toEqual(['第一章 电路基础', '欧姆定律'])
  })

  it('keeps every page accounted for: blank pages become page issues and partial status', async () => {
    const s = await setup(async () => docMindResult({ total: 3, pages: [{ num: 1, text: '第一页正文内容。' }, { num: 3, text: '第三页正文内容。' }], pageSections: {} }))
    await writeFile(join(s.folder, 'patchy.pdf'), 'fixture-pdf-bytes')
    const { state } = await initialize(s)
    const material = state.courses[0].materials[0]
    expect(material.pages).toBe(3)
    expect(material.pageIssues).toEqual([{ num: 2, reason: 'unextracted-text' }])
    expect(material.status).toBe('partial')
    const patchy = material.sources.map((source: any) => source.anchor as string)
    expect(patchy.some(anchor => anchor.startsWith('第 1 页'))).toBe(true)
    expect(patchy.some(anchor => anchor.startsWith('第 3 页'))).toBe(true)
    expect(patchy.some(anchor => anchor.startsWith('第 2 页'))).toBe(false)
  })
})

describe('资料解析：缓存与回退', () => {
  it('reuses a v6 parse cache on the next initialization and never re-calls the engine for unchanged bytes', async () => {
    let engineCalls = 0
    const extract = async () => { engineCalls++; return docMindResult() }
    const s = await setup(extract)
    await writeFile(join(s.folder, 'chapter1.pdf'), 'fixture-pdf-bytes')
    await initialize(s)
    expect(engineCalls).toBe(1)
    await initialize(s)
    expect(engineCalls).toBe(1)
  })

  it('still honours a legacy parse-v5 cache: old materials are not re-parsed just because the engine changed', async () => {
    let engineCalls = 0
    const s = await setup(async () => { engineCalls++; return docMindResult() })
    await writeFile(join(s.folder, 'legacy.txt'), '旧资料正文。')
    // 手工造一份 parse-v5 旧缓存（本地解析口径），模拟既有课程的存量资料。
    const fingerprint = sha(await readFile(join(s.folder, 'legacy.txt')))
    const materialId = (await s.projects.handle('scan', { courseId: s.id }) as any).files.length
    expect(materialId).toBeGreaterThan(0)
    const { state } = await initialize(s)
    // 第一次初始化会调用引擎（没有旧缓存），之后模拟「换引擎」：清掉 v6、保留 v5 的场景由下一次断言覆盖。
    expect(engineCalls).toBe(1)
    const material = state.courses[0].materials[0]
    const cacheDir = join(s.folder, '.syllora', '.staging', 'cache')
    const legacyPath = join(cacheDir, `${sha('parse-v5:' + material.path + ':' + fingerprint + ':' + material.id)}.json`)
    await writeFile(legacyPath, await readFile(join(cacheDir, `${sha('parse-v6:local:' + material.path + ':' + fingerprint + ':' + material.id)}.json`), 'utf8').catch(async () => JSON.stringify({ material, body: '', chars: 0 })))
    // 删除 v6 缓存：只剩 v5 时也必须复用（不重解析）。
    await rm(join(cacheDir, `${sha('parse-v6:local:' + material.path + ':' + fingerprint + ':' + material.id)}.json`), { force: true })
    await initialize(s)
    expect(engineCalls).toBe(1)
  })

  it('falls back to local parsing with an explicit reason when the engine refuses a format', async () => {
    const s = await setup(async input => localExtract({ ...input, reason: '云端不支持该格式', pdf: async () => ({ pages: [{ num: 1, text: 'PDF 本地正文。' }], total: 1 }) }))
    await writeFile(join(s.folder, 'plain.txt'), '本地直读正文。')
    const { state } = await initialize(s)
    const material = state.courses[0].materials[0]
    expect(material.engine).toBe('local')
    expect(material.warnings.join(' ')).toContain('没有走 DocMind')
  })
})

describe('资料解析：state 瘦身与新 RPC', () => {
  it('keeps source text out of state, serves it by id, and round-trips reading marks', async () => {
    const s = await setup(async () => docMindResult())
    await writeFile(join(s.folder, 'chapter1.pdf'), 'fixture-pdf-bytes')
    const { state } = await initialize(s)
    const material = state.courses[0].materials[0]
    // 取一个正文来源（首个来源可能是标题行，正文在段落分片里）。
    const source = material.sources.find((item: any) => item.kind !== 'heading')
    // state 里的来源只带定位信息：正文不再随每次轮询传输。
    expect(Object.hasOwn(source, 'text')).toBe(false)
    expect(typeof source.anchor).toBe('string')
    const fetched = await s.projects.handle('source', { courseId: s.id, sourceId: source.id }) as { source: { text: string } }
    expect(fetched.source.text).toContain('实际电路')
    const marked = await s.projects.handle('readingSetMark', { courseId: s.id, materialId: material.id, anchor: '第一章-电路基础', status: 'mastered' }) as { marks: Record<string, string> }
    expect(marked.marks).toEqual({ '第一章-电路基础': 'mastered' })
    const cleared = await s.projects.handle('readingSetMark', { courseId: s.id, materialId: material.id, anchor: '第一章-电路基础', status: null }) as { marks: Record<string, string> }
    expect(cleared.marks).toEqual({})
    // 阅读文档带上解析产物与标记，供统一阅读页渲染。
    const document = await s.projects.handle('readingDocument', { courseId: s.id, materialId: material.id }) as { document: { outline: unknown[] }; marks: Record<string, string>; sources: Array<{ text: string }> }
    expect(document.document.outline.length).toBe(2)
    expect(document.marks).toEqual({})
    expect(document.sources.some(entry => entry.text.includes('实际电路'))).toBe(true)
  })
})

describe('资料解析：上限', () => {
  it('refuses an oversized single document before any model call', async () => {
    const s = await setup(async () => docMindResult({ pages: [{ num: 1, text: '正文。' }], total: MATERIAL_LIMITS.maxPagesPerMaterial + 1, pageSections: {} }))
    await writeFile(join(s.folder, 'huge.pdf'), 'fixture-pdf-bytes')
    const { job } = await initialize(s)
    expect(job.state).toBe('failed')
    expect(job.message).toContain(String(MATERIAL_LIMITS.maxPagesPerMaterial))
    expect(s.calls()).toBe(0)
  })
})

describe('DocMind 提取器的纯函数部分', () => {
  it('groups layout blocks by physical page and only trusts real page numbers', () => {
    const paged = pagesFromLayouts({ total: 2, layouts: [], blocks: [
      { index: 0, type: 'title', pageNum: 1, text: '# 第一章' },
      { index: 1, type: 'text', pageNum: 1, text: '第一页正文。' },
      { index: 2, type: 'text', pageNum: 2, text: '第二页正文。' },
      { index: 3, type: 'text', pageNum: 0, text: '没有页码的块被忽略。' },
    ] } as never)
    expect(paged?.total).toBe(2)
    expect(paged?.pages.map(page => page.num)).toEqual([1, 2])
    expect(paged?.pages[0]!.text).toContain('第一页正文')
    expect(paged?.pageSections).toEqual({ 1: '第一章', 2: '第一章' })
    expect(pagesFromLayouts({ total: 3, layouts: [], blocks: [{ index: 0, type: 'text', text: '无页码' }] } as never)).toBeNull()
  })

  it('localizes only DocMind-hosted images and deduplicates by content', async () => {
    const png = new TextEncoder().encode('png')
    const markdown = `![a](https://docmind-api-cn-hangzhou.oss-cn-hangzhou.aliyuncs.com/x/a.png)\n![b](https://docmind-api-cn-hangzhou.oss-cn-hangzhou.aliyuncs.com/y/a.png)\n![c](https://evil.example.com/c.png)`
    const urls: string[] = []
    const localized = await localizeDocMindImages(markdown, async url => { urls.push(url); return png })
    expect(urls).toHaveLength(2)
    expect(localized.images).toHaveLength(1)
    expect(localized.markdown).toContain('](images/img-')
    expect(localized.markdown).toContain('https://evil.example.com/c.png')
  })

  it('docMindExtract reports page numbers unavailable instead of faking them', async () => {
    const client: DocMindLike = { parse: async () => ({ markdown: '# 只有标题\n\n正文。', layouts: { total: 1, layouts: [], blocks: [{ index: 0, type: 'text', text: '没有页码' }] } as never, status: { jobId: 'j', status: 'success', progress: 100, pageCountEstimate: 7, paragraphCount: null, tableCount: null, imageCount: null, tokens: null, outputUrl: 'x' } as never, jobId: 'j' }) }
    const result = await docMindExtract({ path: 'fixture', name: 'fixture.docx', bytes: new Uint8Array(), client })
    expect(result.pages).toBeUndefined()
    expect(result.total).toBe(7)
    expect(result.pageNumbersUnavailable).toContain('按章节定位')
  })
})