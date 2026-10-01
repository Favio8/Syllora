/**
 * FR-02 资料入库与来源 / FR-04 有依据的讲解问答 —— A 包四项补强的回归用例。
 * Adapted from PR #40 by Mr-Grimwig, commit f0bc21b9e1387e55293a204f9622a1c91204816d.
 *
 * 覆盖 PRD 原文：
 * - 6.2 partial 必须「列出失败范围」，不只是一个布尔值
 * - 6.3 每份资料保存 version，且原资料可预览
 * - 6.4 相同指纹复用已有版本；改变正文不静默替换
 * - 17.4 上下文超长时说明使用范围，不声称读完全文
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StructuredCallClient } from '@syllora/course-builder'
import type { ResolvedChatConfig } from '../src/config.ts'

const sourcesSeen: string[] = []

/**
 * `@syllora/course-builder` 的 barrel 会加载 extract.ts，后者静态 import pdf-parse。
 * 这里只需要 structuredCall 的语义，所以替换该包，让本套用例不依赖 PDF 解析库；
 * 真实解析路径由 syllora.spec.ts 与端到端脚本覆盖。
 */
vi.mock('@syllora/course-builder', () => ({
  structuredCall: async (client: StructuredCallClient, schema: { parse: (value: unknown) => unknown }, options: { messages: Array<{ content: unknown }> }) => {
    const text = textOf(options.messages.at(-1)?.content)
    sourcesSeen.push(text)
    const parts: string[] = []
    for await (const chunk of client.stream(options as never)) {
      const typed = chunk as { type?: string; text?: string }
      if (typed.type === 'text-delta' && typeof typed.text === 'string') parts.push(typed.text)
    }
    return schema.parse(JSON.parse(parts.join('').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim()))
  },
}))

const { SylloraService } = await import('../src/syllora.ts')

const roots: string[] = [],temp=resolve('..','tmp','pr40-material-tests')
afterEach(async () => { for(const root of roots.splice(0)){if(!root.startsWith(temp))throw new Error('unsafe cleanup');await rm(root,{recursive:true,force:true})} })

async function root(): Promise<string> {
  await mkdir(temp,{recursive:true})
  const dir = await mkdtemp(join(temp, 'syllora-materials-'))
  roots.push(dir)
  return dir
}

/** A 3-page PDF whose middle page has no text layer, matching a scanned insert. */
const threePagesOneBlank = async () => ({
  total: 3,
  pages: [
    { num: 1, text: '矩阵的秩等于其非零子式的最高阶数。' },
    { num: 2, text: '   ' },
    { num: 3, text: '初等行变换不改变矩阵的秩。' },
  ],
})

async function courseWith(svc: SylloraService, name = '线性代数'): Promise<string> {
  const courseId = randomUUID()
  await svc.handle('create', { name, requestId: courseId, timezone: 'Asia/Shanghai' })
  return courseId
}

/** Message content can be a string or a parts array; flatten either shape. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text ?? '') : '')).join('')
  return JSON.stringify(content ?? {})
}

/** Minimal model stub: cites a source that the context actually contains. */
function stubClient(): StructuredCallClient {
  return {
    async *stream(options) {
      const text = textOf(options.messages.at(-1)?.content)
      // Only the offered context is addressable, mirroring "只能引用本次提供的 source id".
      const context = text.slice(text.indexOf('所选资料（'))
      const ids = [...context.matchAll(/"id":"([0-9a-f-]+)"/g)].map(m => m[1]!)
      yield { type: 'text-delta', text: JSON.stringify({ points: [{ chapter: '矩阵', name: '矩阵的秩', sourceIds: [ids[0] ?? randomUUID()] }] }) } as never
    },
  }
}

function config(): ResolvedChatConfig {
  return { providerId: 'stub', model: 'stub-model', baseUrl: 'http://127.0.0.1:1', apiKey: 'stub', apiKeyEnv: undefined } as ResolvedChatConfig
}

/** The service publishes asynchronously; the suite polls like the existing spec does. */
async function waitJob(svc: SylloraService): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const state = await svc.handle('state') as any
    if (state.jobs.length && state.jobs.every((j: any) => j.state !== 'running')) return state
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('job did not settle')
}

describe('A1 原资料预览（PRD 6.3）', () => {
  it('保存原文件并可通过 materialFile 取回相同字节', async () => {
    const dir = await root()
    const svc = new SylloraService(dir, { pdf: threePagesOneBlank })
    const courseId = await courseWith(svc)
    const bytes = Buffer.from('%PDF-1.4 stub body')
    const imported = await svc.handle('import', { courseId, name: '讲义.pdf', base64: bytes.toString('base64') }) as any
    expect(imported.duplicate).toBe(false)
    expect(imported.previewAvailable).toBe(true)

    const fetched = await svc.readMaterialFile(courseId, imported.id)
    expect(fetched.data.equals(bytes)).toBe(true)
    expect(fetched.file.name).toBe('讲义.pdf')
    expect(fetched.file.ext).toBe('pdf')
    expect(fetched.file.bytes).toBe(bytes.length)
  })

  it('课程视图给出可用的 previewUrl，删除资料后不再提供原文件', async () => {
    const dir = await root()
    const svc = new SylloraService(dir, { pdf: threePagesOneBlank })
    const courseId = await courseWith(svc)
    const imported = await svc.handle('import', { courseId, name: '讲义.pdf', base64: Buffer.from('%PDF-1.4 x').toString('base64') }) as any

    const state = await svc.handle('state', {}) as any
    const material = state.courses[0].materials.find((m: any) => m.id === imported.id)
    expect(material.previewUrl).toContain('/api/syllora/material-file?courseId=')
    expect(material.previewUrl).toContain(imported.id)

    await svc.handle('deleteMaterial', { courseId, materialId: imported.id, confirmed: true })
    await expect(svc.readMaterialFile(courseId, imported.id)).rejects.toThrow()
  })

  it('未保存原文件的粘贴正文不产生 previewUrl，也不谎报可预览', async () => {
    const dir = await root()
    const svc = new SylloraService(dir)
    const courseId = await courseWith(svc)
    const imported = await svc.handle('import', { courseId, name: '粘贴资料.txt', text: '正文一段。' }) as any
    expect(imported.previewAvailable).toBe(false)
    const state = await svc.handle('state', {}) as any
    expect(state.courses[0].materials[0].previewUrl).toBeNull()
  })
})

describe('A2 失败页明细（PRD 6.2 / AC-16）', () => {
  it('partial 资料列出失败页码与原因，而不是只标记部分可用', async () => {
    const dir = await root()
    const svc = new SylloraService(dir, { pdf: threePagesOneBlank })
    const courseId = await courseWith(svc)
    const imported = await svc.handle('import', { courseId, name: '讲义.pdf', base64: Buffer.from('%PDF-1.4 y').toString('base64') }) as any
    expect(imported.partial).toBe(true)
    expect(imported.pageIssues).toEqual([{ num: 2, reason: 'blank-page' }])

    const state = await svc.handle('state', {}) as any
    const material = state.courses[0].materials[0]
    expect(material.status).toBe('partial')
    expect(material.accepted).toBe(false)
    expect(material.pageIssues).toEqual([{ num: 2, reason: 'blank-page' }])
    // 可用页仍然建索引，且锚点用真实物理页码（不伪造页码）
    const anchors = material.sources.map((s: any) => s.anchor as string)
    expect(anchors).toHaveLength(2)
    expect(anchors[0]).toContain('第 1 页')
    expect(anchors[1]).toContain('第 3 页')
    // 空白页不产生任何片段
    expect(anchors.some(a => a.startsWith('第 2 页'))).toBe(false)
  })

  it('解析器未返回的页码记为 unextracted-text', async () => {
    const dir = await root()
    const svc = new SylloraService(dir, {
      pdf: async () => ({ total: 4, pages: [{ num: 1, text: '第一页正文。' }, { num: 4, text: '第四页正文。' }] }),
    })
    const courseId = await courseWith(svc)
    const imported = await svc.handle('import', { courseId, name: '讲义.pdf', base64: Buffer.from('%PDF-1.4 z').toString('base64') }) as any
    expect(imported.pageIssues).toEqual([
      { num: 2, reason: 'unextracted-text' },
      { num: 3, reason: 'unextracted-text' },
    ])
  })

  it('全部空白页判为失败并说明原因，不产生 ready 资料', async () => {
    const dir = await root()
    const svc = new SylloraService(dir, { pdf: async () => ({ total: 2, pages: [{ num: 1, text: '' }, { num: 2, text: ' ' }] }) })
    const courseId = await courseWith(svc)
    await expect(svc.handle('import', { courseId, name: '扫描件.pdf', base64: Buffer.from('%PDF-1.4 s').toString('base64') }))
      .rejects.toThrow(/未提取到正文/)
    const state = await svc.handle('state', {}) as any
    expect(state.courses[0].materials).toHaveLength(0)
  })

  it('解析器抛错时给出具体原因，不暴露为笼统的格式错误', async () => {
    const dir = await root()
    const svc = new SylloraService(dir, { pdf: async () => { throw new Error('bad xref table') } })
    const courseId = await courseWith(svc)
    await expect(svc.handle('import', { courseId, name: '损坏.pdf', base64: Buffer.from('%PDF-broken').toString('base64') }))
      .rejects.toThrow(/PDF 解析失败：bad xref table/)
  })
})

describe('A3 资料版本（PRD 6.3 / 6.4 / AC-21）', () => {
  it('相同指纹复用已有版本，不重复拆解', async () => {
    const dir = await root()
    const svc = new SylloraService(dir)
    const courseId = await courseWith(svc)
    const first = await svc.handle('import', { courseId, name: '讲义.txt', text: '单位矩阵主对角线元素为一。' }) as any
    const again = await svc.handle('import', { courseId, name: '讲义副本.txt', text: '单位矩阵主对角线元素为一。' }) as any
    expect(again.duplicate).toBe(true)
    expect(again.id).toBe(first.id)
    expect(again.version).toBe(1)
    const state = await svc.handle('state', {}) as any
    expect(state.courses[0].materials).toHaveLength(1)
  })

  it('同名不同正文建立新的独立资料线，旧资料与其来源继续可用', async () => {
    const dir = await root()
    const svc = new SylloraService(dir)
    const courseId = await courseWith(svc)
    const v1 = await svc.handle('import', { courseId, name: '讲义.txt', text: '第一版：矩阵的秩。' }) as any
    const v2 = await svc.handle('import', { courseId, name: '讲义.txt', text: '第二版：矩阵的秩与行列式。' }) as any

    expect(v2.duplicate).toBe(false)
    expect(v2.version).toBe(2)
    expect(v2.replaced).toEqual([{ id: v1.id, version: 1 }])

    const state = await svc.handle('state', {}) as any
    const materials = state.courses[0].materials
    expect(materials).toHaveLength(2)
    // AC-21：不静默替换，旧资料的来源没有被清空
    expect(materials[0].status).toBe('ready')
    expect(materials[0].sources.length).toBeGreaterThan(0)
    expect(materials[0].version).toBe(1)
    expect(materials[1].version).toBe(2)
    expect(materials[1].versionOf).toBe(v1.id)
  })

  it('旧快照缺少版本字段时按 v1 读取，不因升级而崩溃', async () => {
    const dir = await root()
    const svc = new SylloraService(dir)
    const courseId = await courseWith(svc)
    await svc.handle('import', { courseId, name: '讲义.txt', text: '正文。' })
    const legacy = {
      version: 1, consent: false, callLimit: 0, calls: 0, jobs: [],
      courses: [{
        id: courseId, name: '线性代数', timezone: 'Asia/Shanghai', archived: false, createdAt: 0,
        materials: [{ id: 'legacy', name: '旧讲义.txt', fingerprint: 'h', status: 'ready', accepted: true, pages: 0, sources: [] }],
        points: [], scope: [], plan: null, draft: null, questions: [], attempts: [], messages: [],
      }],
    }
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'syllora.json'), JSON.stringify(legacy))
    const reloaded = new SylloraService(dir)
    const state = await reloaded.handle('state', {}) as any
    expect(state.courses[0].materials[0].version).toBe(1)
    expect(state.courses[0].materials[0].pageIssues).toEqual([])
    expect(state.courses[0].materials[0].file).toBeNull()
  })
})

describe('A4 上下文覆盖度（PRD 17.4）', () => {
  it('记录实际使用的片段范围，并列出未被覆盖的资料', async () => {
    const dir = await root()
    sourcesSeen.length = 0
    const svc = new SylloraService(dir, { config: async () => config(), client: () => stubClient() })
    const courseId = await courseWith(svc)
    // 12 段 × 2400 字符：远超 22,000 字符预算，必然有片段被省略
    for (let i = 0; i < 12; i++) {
      const body = `第${i + 1}段。` + '矩'.repeat(2390)
      await svc.handle('import', { courseId, name: `资料${i + 1}.txt`, text: body })
    }
    await svc.handle('preferences', { consent: true, callLimit: 5 })
    const { jobId } = await svc.handle('generate', { courseId, requestId: randomUUID(), kind: 'outline' }) as any
    const state = await waitJob(svc)

    const job = state.jobs.find((j: any) => j.id === jobId)
    expect(job.state,job.message).toBe('succeeded')
    expect(job.coverage).not.toBeNull()
    expect(job.coverage.sourcesTotal).toBe(12)
    expect(job.coverage.sourcesUsed).toBeLessThan(12)
    expect(job.coverage.charsUsed).toBeLessThanOrEqual(22000)
    // 按课程顺序列出未覆盖资料，不按随机 ID 排序
    expect(job.coverage.materialsWithOmitted).toEqual(Array.from({length:12-job.coverage.sourcesUsed},(_,i)=>`资料${job.coverage.sourcesUsed+i+1}.txt`))
    // 上下文里明确声明未选入片段不参与，避免模型声称读完全文
    expect(sourcesSeen[0]).toContain('不得声称已阅读全部资料')
    expect(sourcesSeen[0]).toContain(`本次候选 12 个片段，使用 ${job.coverage.sourcesUsed} 个`)
  })

  it('片段能全部放下时如实报告全覆盖，不虚报省略', async () => {
    const dir = await root()
    sourcesSeen.length = 0
    const svc = new SylloraService(dir, { config: async () => config(), client: () => stubClient() })
    const courseId = await courseWith(svc)
    await svc.handle('import', { courseId, name: '小资料.txt', text: '单位矩阵主对角线元素为一。' })
    await svc.handle('preferences', { consent: true, callLimit: 5 })
    const { jobId } = await svc.handle('generate', { courseId, requestId: randomUUID(), kind: 'outline' }) as any
    const state = await waitJob(svc)

    const job = state.jobs.find((j: any) => j.id === jobId)
    expect(job.state).toBe('succeeded')
    expect(job.coverage.sourcesUsed).toBe(job.coverage.sourcesTotal)
    expect(job.coverage.materialsWithOmitted).toEqual([])
  })
})
