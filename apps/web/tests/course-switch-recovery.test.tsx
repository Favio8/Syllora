/**
 * B2 / B3：切课窗口期的状态保全与清理（本地实现口径）。
 *  - 切课要先 flushDraft（保存当前课程未提交的草稿）；保存失败就**留在原课程**
 *    并提示「未提交输入已保留」，草稿同时在 sessionStorage 留一份恢复副本；
 *    服务恢复后再次切课会补交草稿，切回原课程仍能看到输入。
 *  - 切课进入新课程时清空上一门课的练习面板、来源弹层等临时 UI 状态。
 *  - 通知胶囊「查看失败页」跨课程跳转同样必须先保存当前草稿，再切到目标课程
 *    的「资料」页。
 * 注：PR 原文的「离线强制切换（保留草稿并切换）」「切换中禁用输入框」两组用例
 * 对应 PR 版 Syllora/LearningChat 的专用实现，本地没有这两件 UI，未移植；
 * 原文「从学习页切走回到今日页」也不适用——本地 setTab 是独立状态，切课只清
 * 临时面板/弹层，不重置右栏页签（下方第 2 条按本地事实守护这一点）。
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Syllora from '../src/components/Syllora'
import { buildPlan, publicCourse, type Course } from '../../../packages/host/chat-service/src/syllora-domain'

vi.mock('../src/components/settings/ModelsSection', () => ({ default: () => null }))
beforeEach(() => { sessionStorage.clear(); Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear() })

function fixture(id: string): Course {
  return { id, name: `课程 ${id}`, timezone: 'Asia/Shanghai', archived: false, createdAt: Date.now(), materials: [{ id: 'm', name: 'fixture.txt', fingerprint: 'fixture', status: 'ready', accepted: true, pages: 0, sources: [{ id: 's', materialId: 'm', anchor: '段落 1', text: '合成来源' }] }], points: [{ id: 'p', name: '知识点', chapter: '章', sourceIds: ['s'] }], scope: ['p'], plan: null, draft: null, questions: [], attempts: [], messages: [], actions: [], drafts: { prompt: '', answers: [] }, changes: [], notice: null }
}

/** 与本地测试惯例一致：宿主 RPC 直接以 fetch 桩承接，返回 {result} 信封。 */
function stateOf(courses: Course[], jobs: unknown[] = []) {
  return { courses: courses.map(course => publicCourse(course, Date.now())), jobs, settings: { consent: false, calls: 0 } }
}

describe('B2 / B3 切课恢复', () => {
  it('切课保存失败时留在原课程、保留草稿并提示；服务恢复后再次切课补交草稿', async () => {
    const courses = [fixture('a'), fixture('b')]
    const saved: Array<Record<string, unknown>> = []
    let saveDown = true
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/saveDraft')) {
        if (saveDown) throw new TypeError('本地服务不可用')
        const payload = JSON.parse(String(init?.body)).payload
        saved.push(payload)
        courses.find(course => course.id === payload.courseId)!.drafts = { prompt: payload.prompt, answers: payload.answers, version: 1 }
        return { ok: true, json: async () => ({ result: { version: 1 } }) }
      }
      return { ok: true, json: async () => ({ result: stateOf(courses) }) }
    }))
    render(<Syllora />)
    await waitFor(() => expect(document.querySelectorAll('.rail-course')).toHaveLength(2))
    fireEvent.click(document.querySelectorAll('.rail-course')[0]!)
    const input = await screen.findByLabelText('向课程资料提问')
    fireEvent.change(input, { target: { value: '离线输入 a' } })
    // 未提交的输入在浏览器恢复缓存里也有一份。
    expect(sessionStorage.getItem('syllora.unsaved-drafts.v1')).toContain('离线输入 a')

    fireEvent.click(document.querySelectorAll('.rail-course')[1]!)
    // 保存失败：不切课程（仍停在课程 a），输入保留，并给出明确提示。
    await screen.findByText(/未提交输入已保留/)
    expect(screen.getByText('课程 a', { exact: true })).toBeInTheDocument()
    expect(screen.getByLabelText('向课程资料提问')).toHaveValue('离线输入 a')

    saveDown = false
    fireEvent.click(document.querySelectorAll('.rail-course')[1]!)
    await screen.findByText('课程 b', { exact: true })
    expect(saved.some(payload => payload.courseId === 'a' && payload.prompt === '离线输入 a')).toBe(true)
    // 新课程是空草稿，不会被上一门课的输入串入（等效果刷完再断言）。
    await waitFor(() => expect(screen.getByLabelText('向课程资料提问')).toHaveValue(''))

    // 回到课程 a：草稿仍在。
    fireEvent.click(document.querySelectorAll('.rail-course')[0]!)
    await screen.findByText('课程 a', { exact: true })
    await waitFor(() => expect(screen.getByLabelText('向课程资料提问')).toHaveValue('离线输入 a'))
  })

  it('切课清空上一门课的练习面板与来源弹层', async () => {
    const courseA = fixture('a')
    courseA.plan = buildPlan(courseA, { scope: ['p'], dailyMinutes: 40, days: 7, restDays: [] }, Date.now(), () => 'task')
    courseA.plan.tasks[0]!.status = 'in_progress'
    courseA.messages = [{ id: 'msg1', role: 'assistant', text: '合成回答', sourceIds: ['s'], at: Date.now() }]
    const courses = [courseA, fixture('b')]
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ result: stateOf(courses) }) })))
    render(<Syllora />)
    await waitFor(() => expect(document.querySelectorAll('.rail-course')).toHaveLength(2))
    fireEvent.click(document.querySelectorAll('.rail-course')[0]!)
    await screen.findByText('课程 a', { exact: true })

    // 打开练习面板（进行中的任务）与来源弹层。
    fireEvent.click(screen.getByRole('button', { name: '练习' }))
    await waitFor(() => expect(document.querySelector('.sy-task-study')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '来源 1' }))
    expect(await screen.findByRole('dialog', { name: '资料来源' })).toBeInTheDocument()

    fireEvent.click(document.querySelectorAll('.rail-course')[1]!)
    await screen.findByText('课程 b', { exact: true })
    // 上一门课的临时 UI 不跨课程残留（练习面板随 activeTask/practiceOpen 清空，
    // 来源弹层随 sourceId 清空）。
    await waitFor(() => expect(document.querySelector('.sy-task-study')).toBeNull())
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '资料来源' })).toBeNull())
  })

  it('通知胶囊「查看失败页」先保存当前草稿，再打开失败课程的资料页', async () => {
    const courses = [fixture('a'), fixture('b')]
    const saved: Array<Record<string, unknown>> = []
    const jobs = [{ id: 'failed-b', courseId: 'b', state: 'failed', message: '解析失败', model: 'fixture', calls: 1, inputTokens: null, outputTokens: null, createdAt: Date.now(), finishedAt: Date.now(), progress: { stage: 'parsing', done: 0, total: 1, failures: ['资料失败'] } }]
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/saveDraft')) {
        saved.push(JSON.parse(String(init?.body)).payload)
        return { ok: true, json: async () => ({ result: { version: 1 } }) }
      }
      return { ok: true, json: async () => ({ result: stateOf(courses, jobs) }) }
    }))
    render(<Syllora />)
    await waitFor(() => expect(document.querySelectorAll('.rail-course')).toHaveLength(2))
    fireEvent.click(document.querySelectorAll('.rail-course')[0]!)
    fireEvent.change(await screen.findByLabelText('向课程资料提问'), { target: { value: '先保存再看其他课程失败' } })
    fireEvent.click(document.querySelector('.notification-capsule')!)
    fireEvent.click(await screen.findByRole('button', { name: '查看失败页' }))
    // 切过去了：草稿已补交，右栏落在「资料」页，输入框换成新课程的空草稿。
    await waitFor(() => expect(screen.getByRole('tab', { name: '资料' })).toHaveAttribute('aria-selected', 'true'))
    expect(saved.some(payload => payload.courseId === 'a' && payload.prompt === '先保存再看其他课程失败')).toBe(true)
    await waitFor(() => expect(screen.getByLabelText('向课程资料提问')).toHaveValue(''))
  })
})
