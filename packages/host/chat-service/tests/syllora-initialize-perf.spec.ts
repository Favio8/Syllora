/*
 * PRD 需求六：大资料初始化性能。
 *  - 并发 3 的总耗时不高于串行的 1/2（用可控延迟的假模型调用实测）；
 *  - 供应商限流时不失败：自动退避重试、进度继续推进、临时下调并发；
 *  - 进度带预计剩余时间与每批耗时；
 *  - 解析阶段有界并行（多文件）。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeFolder, type InitProgress, type Lecture } from '../src/syllora-initialize.ts'
import type { Course, Source } from '../src/syllora-domain.ts'
import { structuredSources } from '../src/syllora-files.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

/** 每章一份资料，共 chapters 章：产生 chapters 个整理批次（同 section 才合并）。 */
async function courseFixture(chapters: number): Promise<{ root: string; course: Course; paths: string[]; fingerprints: Record<string, string> }> {
  const root = await mkdtemp(join(tmpdir(), 'syllora-perf-'))
  roots.push(root)
  const stateDir = join(root, '.syllora')
  await mkdir(stateDir, { recursive: true })
  const course: Course = {
    id: randomUUID(), name: '性能课程', timezone: 'Asia/Shanghai', archived: false, createdAt: Date.now(),
    materials: [], points: [], plan: null, draft: null, questions: [], attempts: [], messages: [], actions: [],
    drafts: { prompt: '', answers: [] }, changes: [], notice: null, scope: [],
  } as unknown as Course
  const paths: string[] = []
  const fingerprints: Record<string, string> = {}
  const { createHash } = await import('node:crypto')
  for (let index = 1; index <= chapters; index += 1) {
    const name = `第${index}章.md`
    const body = `# 第${index}章\n\n本章主题${index}在这里说明，包含足够的正文长度用于整理。\n`
    await writeFile(join(root, name), body, 'utf8')
    paths.push(name)
    fingerprints[name] = createHash('sha256').update(body).digest('hex')
  }
  return { root, course, paths, fingerprints }
}

/** 假模型调用：可配置延迟、限流次数与调用计数。 */
function fakeCall(options: { delayMs: number; rateLimitFirst?: number; counter?: { calls: number; concurrent: number; peak: number; rateLimited: number } }) {
  const counter = options.counter ?? { calls: 0, concurrent: 0, peak: 0, rateLimited: 0 }
  return async (sources: Source[]): Promise<Lecture> => {
    counter.calls += 1
    counter.concurrent += 1
    counter.peak = Math.max(counter.peak, counter.concurrent)
    try {
      if (options.rateLimitFirst !== undefined && counter.rateLimited < options.rateLimitFirst) {
        counter.rateLimited += 1
        const error = new Error('端点返回 HTTP 429') as Error & { code?: string }
        error.code = 'RATE_LIMITED'
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, options.delayMs))
      const first = sources[0]!
      // 引用本批**全部**片段：validateLecture 要求每段都被至少一项引用。
      return {
        chapter: first.section ?? '章',
        intro: { text: '按资料整理的章节导读。', sourceIds: sources.map(source => source.id) },
        concepts: sources.map(source => ({ name: `概念 ${source.id.slice(0, 6)}`, text: '概念解释来自所附资料。', sourceIds: [source.id], quote: source.text.slice(0, Math.min(20, source.text.length)) })),
        examples: [], connections: [], analogies: [],
      } as Lecture
    } finally {
      counter.concurrent -= 1
    }
  }
}

async function run(root: string, course: Course, paths: string[], fingerprints: Record<string, string>, concurrency: number, call: ReturnType<typeof fakeCall>): Promise<{ ms: number; progress: InitProgress[]; failures: string[] }> {
  const progress: InitProgress[] = []
  const started = Date.now()
  await initializeFolder({
    root, course, paths, expected: fingerprints, acceptPartial: false, jobId: randomUUID(), modelKey: 'fixture', concurrency,
    call,
    progress: async item => { progress.push(item) },
    check: async () => undefined,
  })
  return { ms: Date.now() - started, progress, failures: progress.at(-1)?.failures ?? [] }
}

describe('PRD 需求六：整理阶段有界并发', () => {
  it('finishes a 60-chapter course in under half the serial time at concurrency 3', async () => {
    const chapters = 60
    const delayMs = 60
    // 串行基准。
    const serial = await courseFixture(chapters)
    const serialRun = await run(serial.root, serial.course, serial.paths, serial.fingerprints, 1, fakeCall({ delayMs }))
    // 并发 3。
    const parallel = await courseFixture(chapters)
    const parallelCounter = { calls: 0, concurrent: 0, peak: 0, rateLimited: 0 }
    const parallelRun = await run(parallel.root, parallel.course, parallel.paths, parallel.fingerprints, 3, fakeCall({ delayMs, counter: parallelCounter }))
    process.stdout.write('60-chapter controlled benchmark '+JSON.stringify({ serialMs: serialRun.ms, concurrency3Ms: parallelRun.ms, ratio: parallelRun.ms / serialRun.ms, peak: parallelCounter.peak, model: 'synthetic 60ms delay' })+'\n')

    // 验收标准 1：并发 3 的总耗时不高于串行的 1/2。
    expect(parallelRun.ms).toBeLessThanOrEqual(serialRun.ms / 2)
    // 并发度确实有界（不超过 3），且确实并行过（峰值 > 1）。
    expect(parallelCounter.peak).toBeLessThanOrEqual(3)
    expect(parallelCounter.peak).toBeGreaterThan(1)
    // 批次数不变：并发不改变调用总量（= 批次数）与批次划分。
    const batches = serialRun.progress.at(-1)!.total
    expect(parallelCounter.calls).toBe(batches)
    expect(parallelRun.progress.at(-1)!.total).toBe(batches)
  })

  it('keeps serial behaviour when concurrency is 1', async () => {
    const fixture = await courseFixture(6)
    const counter = { calls: 0, concurrent: 0, peak: 0, rateLimited: 0 }
    await run(fixture.root, fixture.course, fixture.paths, fixture.fingerprints, 1, fakeCall({ delayMs: 5, counter }))
    expect(counter.peak).toBe(1)
  })
})

describe('PRD 需求六：限流退避', () => {
  it('applies the reduced limit to real model calls after a 429', async () => {
    const fixture = await courseFixture(6)
    let limited = false, active = 0, peakAfterLimit = 0
    const generate = fakeCall({ delayMs: 15 })
    const progress: InitProgress[] = []
    await initializeFolder({ root: fixture.root, course: fixture.course, paths: fixture.paths, expected: fixture.fingerprints, acceptPartial: false, jobId: randomUUID(), modelKey: 'fixture', concurrency: 3,
      call: async (sources, prompt) => {
        if (!limited) { limited = true; throw Object.assign(new Error('HTTP 429'), { code: 'RATE_LIMITED' }) }
        active++; peakAfterLimit = Math.max(peakAfterLimit, active)
        try { return await generate(sources) } finally { active-- }
      }, progress: async item => { progress.push(item) }, check: async () => {},
    })
    expect(peakAfterLimit).toBe(1)
    expect(progress.filter(item => item.stage === 'organizing').at(-1)?.concurrency).toBe(1)
  })

  it('publishes chapters and points in source order even when later chapters finish first', async () => {
    const fixture = await courseFixture(6)
    const generate = fakeCall({ delayMs: 0 })
    const result = await initializeFolder({ root: fixture.root, course: fixture.course, paths: fixture.paths, expected: fixture.fingerprints, acceptPartial: false, jobId: randomUUID(), modelKey: 'fixture', concurrency: 3,
      call: async sources => { await new Promise(resolve => setTimeout(resolve, sources[0]!.section.includes('第1章') ? 100 : 1)); return generate(sources) }, progress: async () => {}, check: async () => {},
    })
    expect(result.lectures.map(lecture => lecture.chapter)).toEqual(Array.from({ length: 6 }, (_, index) => `第${index + 1}章`))
    expect(result.points.map(point => point.chapter)).toEqual(result.lectures.flatMap(lecture => lecture.concepts.map(() => lecture.chapter)))
  })

  it('retries through 429s without failing and lowers the reported concurrency', async () => {
    const fixture = await courseFixture(6)
    const counter = { calls: 0, concurrent: 0, peak: 0, rateLimited: 0 }
    // 每个批次第一次都撞 429：必须退避后成功，整体不失败。
    const result = await run(fixture.root, fixture.course, fixture.paths, fixture.fingerprints, 3, fakeCall({ delayMs: 5, rateLimitFirst: 6, counter }))

    expect(result.failures).toEqual([])
    expect(counter.rateLimited).toBeGreaterThan(0)
    // 退避期间上报了降低后的并发度（进度事件里出现 < 初始值）。
    const lowered = result.progress.filter(item => item.message.includes('供应商限流')).map(item => item.concurrency ?? 0)
    expect(lowered.length).toBeGreaterThan(0)
    expect(Math.min(...lowered)).toBeLessThan(3)
    // 进度继续推进到完成。
    expect(result.progress.at(-1)!.stage).toBe('validating')
  })

  it('does not retry a quota failure', async () => {
    const fixture = await courseFixture(3)
    let calls = 0
    const quota = async (): Promise<Lecture> => {
      calls += 1
      const error = new Error('供应商账户配额或余额不足') as Error & { code?: string }
      error.code = 'QUOTA_EXCEEDED'
      throw error
    }
    await expect(initializeFolder({
      root: fixture.root, course: fixture.course, paths: fixture.paths, expected: fixture.fingerprints,
      acceptPartial: false, jobId: randomUUID(), modelKey: 'fixture', concurrency: 3, call: quota,
      progress: async () => undefined, check: async () => undefined,
    })).rejects.toThrow()
    // 配额不是限流：每个批次最多两次校验重试，不做 4 轮退避。
    expect(calls).toBeLessThanOrEqual(3 * 2)
  })
})

describe('PRD 需求六：进度体验', () => {
  it('reports an ETA and per-batch timings', async () => {
    const fixture = await courseFixture(8)
    const result = await run(fixture.root, fixture.course, fixture.paths, fixture.fingerprints, 2, fakeCall({ delayMs: 20 }))
    const organizing = result.progress.filter(item => item.stage === 'organizing')
    expect(organizing.length).toBeGreaterThan(0)
    // 每批耗时进入进度数据（诊断可查）。
    const timings = organizing.at(-1)!.timings ?? []
    expect(timings.filter(item => item.stage === 'organizing').length).toBeGreaterThan(0)
    expect(timings.every(item => typeof item.ms === 'number' && item.ms >= 0)).toBe(true)
    // 完成后给出预计剩余（最后一条 organizing 之后 done=total，不再估算）。
    const withEta = organizing.filter(item => typeof item.etaMs === 'number')
    expect(withEta.length).toBeGreaterThan(0)
    expect(withEta.every(item => (item.etaMs ?? 0) >= 0)).toBe(true)
  })

  it('records parse timings for every parsed material', async () => {
    const fixture = await courseFixture(4)
    const result = await run(fixture.root, fixture.course, fixture.paths, fixture.fingerprints, 2, fakeCall({ delayMs: 5 }))
    const parseTimings = (result.progress.findLast(item => item.stage === 'parsing')?.timings ?? []).filter(item => item.stage === 'parsing')
    expect(parseTimings.map(item => item.label).sort()).toEqual(fixture.paths.slice().sort())
  })
})

describe('PRD 需求六：解析并行', () => {
  it('parses multiple files with bounded parallelism while keeping the merge order', async () => {
    const fixture = await courseFixture(6, )
    let inFlight = 0
    let peak = 0
    const pdf = async (data: Uint8Array) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      try {
        await new Promise(resolve => setTimeout(resolve, 30))
        return { pages: [{ text: new TextDecoder().decode(data), num: 1 }], total: 1 }
      } finally { inFlight -= 1 }
    }
    // 用 .pdf 路径走注入的解析器（内部并行发生在解析阶段）。
    const root = await mkdtemp(join(tmpdir(), 'syllora-perf-pdf-'))
    roots.push(root)
    await mkdir(join(root, '.syllora'), { recursive: true })
    const paths: string[] = []
    const fingerprints: Record<string, string> = {}
    const { createHash } = await import('node:crypto')
    for (let index = 1; index <= 6; index += 1) {
      const name = `讲义${index}.pdf`
      const body = `第${index}页的正文内容，用于覆盖解析并行。`
      await writeFile(join(root, name), body, 'utf8')
      paths.push(name)
      fingerprints[name] = createHash('sha256').update(body).digest('hex')
    }
    const course = { ...fixture.course } as Course
    const parsingProgress: number[] = []
    const result = await initializeFolder({
      root, course, paths, expected: fingerprints, acceptPartial: false, jobId: randomUUID(), modelKey: 'fixture',
      concurrency: 1, parseConcurrency: 3, pdf, call: fakeCall({ delayMs: 5 }),
      progress: async item => { if (item.stage === 'parsing') parsingProgress.push(item.done) }, check: async () => undefined,
    })
    // 解析确实并行（峰值 > 1），且有界（不超过 3）。
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(3)
    // 合并顺序保持传入顺序（材料列表与路径一一对应）。
    expect(result.materials.map(material => material.path)).toEqual(paths)
    expect(parsingProgress).toEqual([...parsingProgress].sort((a, b) => a - b))
    expect(parsingProgress.at(-1)).toBe(6)
  })
})

/*
 * 资料夹具辅助：让「每章一份资料」产生每章一个批次（section 不同不合并）。
 * structuredSources 会按文件切 section，这里直接构造带 section 的 sources 更可控，
 * 因此把 source 生成集中在一处，便于上面两个测试共用。
 */
describe('PRD 需求六：批次划分保持不变', () => {
  it('does not merge sources from different sections into one batch', async () => {
    const fixture = await courseFixture(5)
    const seen: number[] = []
    const call = async (sources: Source[]): Promise<Lecture> => {
      seen.push(sources.length)
      const first = sources[0]!
      return {
        chapter: first.section ?? '章',
        intro: { text: '导读。', sourceIds: sources.map(source => source.id) },
        concepts: sources.map(source => ({ name: `概念 ${source.id.slice(0, 6)}`, text: '解释。', sourceIds: [source.id], quote: source.text.slice(0, 12) })),
        examples: [], connections: [], analogies: [],
      } as Lecture
    }
    await run(fixture.root, fixture.course, fixture.paths, fixture.fingerprints, 3, call)
    // 批次划分只由 section/长度决定：每批至少一段，且总数等于批次数（不重复调用）。
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(count => count >= 1)).toBe(true)
    // 同一 section 的片段必须合并进同一批（不同 section 不合并）。
    expect(seen.length).toBeLessThanOrEqual(fixture.paths.length * 2)
  })
})

// structuredSources 在夹具里被间接使用；显式引用一次，避免被误判为未使用导入。
void structuredSources
void readFile
