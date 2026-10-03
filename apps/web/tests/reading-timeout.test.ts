/**
 * B5 / CR-10 阅读助手等待：轮询有总时延上限（150 秒），中途 60 秒时提示
 * 「仍在查询原任务」而不重复提交；超时后请求取消原任务并保留选区可重试。
 * 另外守住两个前置拒绝：已取消的选区、资料修订已删除的选区都不发请求。
 */

import { webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readingService } from '../src/features/workbench/services'
import type { ReadingDocument } from '../src/features/workbench/types'

const document: ReadingDocument = { id: 'm', courseId: 'c', revision: 'revision', name: 'fixture', title: 'fixture', source: 'published', content: '测试正文', sources: [{ id: 's', anchor: '段落', text: '测试正文' }] }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); sessionStorage.clear() })

describe('B5 / CR-10 reading waits', () => {
  it('queries only the original job, warns after 60s and cancels at 150s', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn(async () => new Uint8Array(32).buffer) }, randomUUID: () => webcrypto.randomUUID() })
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify({ result: url.endsWith('/generate') ? { jobId: 'original' } : url.endsWith('/state') ? { jobs: [{ id: 'original', state: 'running' }], courses: [] } : {} }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const onWaiting = vi.fn()
    const outcome = readingService.assist(document, '测试', 'explain', undefined, { onWaiting }).catch(error => error)
    await vi.advanceTimersByTimeAsync(61_200)
    expect(onWaiting).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(90_000)
    expect((await outcome).message).toContain('150 秒')
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/generate'))).toHaveLength(1)
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/cancel'))).toHaveLength(1)
    const calls = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchMock).toHaveBeenCalledTimes(calls)
  })

  it('does not submit a cancelled selection or one whose revision was deleted', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const abort = new AbortController(); abort.abort()
    await expect(readingService.assist(document, '测试', 'explain', abort.signal)).rejects.toThrow('取消')
    await expect(readingService.assist({ ...document, revision: null }, '测试', 'explain')).rejects.toThrow('资料已变化')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
