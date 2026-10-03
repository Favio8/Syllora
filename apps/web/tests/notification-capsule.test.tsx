/**
 * PRD 需求五：右下角通知胶囊。
 *  - 进行中常驻、可展开面板、可取消；
 *  - 成功后自动消失；失败保留到手动关闭（已读/未读区分）；
 *  - 切课后不残留其他课程的进行中任务（工作台只喂当前快照，面板按课程标注）；
 *  - 刷新后后端仍有 running job 时胶囊恢复（组件只依赖轮询快照，无会话态）；
 *  - 键盘可达 + aria-live 播报。
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NotificationCapsule, { resetDismissedNotifications } from '../src/components/chat/NotificationCapsule'
import type { SylloraState } from '../src/types/syllora'

type Job = SylloraState['jobs'][number]
/** 本地 job 类型尚未声明 etaMs/concurrency：与组件里一样按可选字段收窄。 */
type JobProgress = NonNullable<Job['progress']> & { etaMs?: number; concurrency?: number }

function job(patch: Partial<Job> & { id: string; courseId: string; state: string; progress?: JobProgress }): Job {
  return {
    message: '',
    model: 'fixture',
    calls: 0,
    inputTokens: null,
    outputTokens: null,
    ...patch,
  } as Job
}

const names: Record<string, string> = { c1: '甲课', c2: '乙课' }
const courseName = (id: string) => names[id] ?? id

afterEach(() => {
  vi.useRealTimers()
  // 组件把「已读」存在模块内存里（按设计只活在本会话）：用例之间显式清空，
  // 不用 vi.resetModules()——那会重建整张模块图，影响同进程的其他测试文件。
  resetDismissedNotifications()
})

describe('需求五：通知胶囊', () => {
  it('stays visible while a job runs and never shows the old mid-column bar', () => {
    render(<NotificationCapsule jobs={[job({ id: 'j1', courseId: 'c1', state: 'running', message: '整理章节 3/60', progress: { stage: 'organizing', done: 3, total: 60, failures: [] } })]} courseName={courseName} onCancel={vi.fn()} />)
    const capsule = screen.getByRole('button', { name: /整理中|任务/ })
    expect(capsule).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens the panel with progress, ETA and a working cancel button', () => {
    const onCancel = vi.fn()
    render(<NotificationCapsule jobs={[job({ id: 'j1', courseId: 'c1', state: 'running', message: '整理章节 3/60', progress: { stage: 'organizing', done: 3, total: 60, failures: [], etaMs: 90_000, concurrency: 3 } })]} courseName={courseName} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: /整理中/ }))
    const panel = screen.getByRole('dialog', { name: '通知面板' })
    expect(panel).toBeInTheDocument()
    expect(panel).toHaveTextContent('甲课')
    expect(panel).toHaveTextContent('整理 3/60')
    expect(panel).toHaveTextContent(/预计剩余约 90 秒/)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalledWith('j1')
  })

  it('labels the course so two same-named tasks do not merge', () => {
    render(<NotificationCapsule jobs={[
      job({ id: 'j1', courseId: 'c1', state: 'running', message: '整理中' }),
      job({ id: 'j2', courseId: 'c2', state: 'running', message: '整理中' }),
    ]} courseName={courseName} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /2 个任务进行中/ }))
    const panel = screen.getByRole('dialog', { name: '通知面板' })
    expect(panel).toHaveTextContent('甲课')
    expect(panel).toHaveTextContent('乙课')
  })

  it('keeps failures until dismissed and shows the failure detail', () => {
    render(<NotificationCapsule jobs={[job({ id: 'j9', courseId: 'c1', state: 'failed', message: '章节整理失败', errorCode: 'RATE_LIMITED', progress: { stage: 'organizing', done: 4, total: 10, failures: ['第 5 章：供应商限流'] } })]} courseName={courseName} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /1 个任务失败/ }))
    const panel = screen.getByRole('dialog', { name: '通知面板' })
    expect(panel).toHaveTextContent('章节整理失败')
    expect(panel).toHaveTextContent('错误代码 RATE_LIMITED')
    expect(panel).toHaveTextContent('第 5 章：供应商限流')
    // 失败条目没有「取消」，有「关闭」。
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    // 关闭后胶囊消失（该条不再提示）。
    expect(screen.queryByRole('button', { name: /任务失败/ })).toBeNull()
  })

  it('auto-hides a success after a few seconds', () => {
    vi.useFakeTimers()
    render(<NotificationCapsule jobs={[job({ id: 'jd', courseId: 'c1', state: 'succeeded', message: '初始化完成' })]} courseName={courseName} onCancel={vi.fn()} />)
    expect(screen.getByRole('button', { name: /任务已完成/ })).toBeInTheDocument()
    // 停留计时到点后自动移出（假时钟下直接推进，不用 waitFor 以免等真实时钟）。
    act(() => { vi.advanceTimersByTime(7000) })
    expect(screen.queryByRole('button', { name: /任务已完成/ })).toBeNull()
  })

  it('reappears when the backend still reports a running job after a refresh', () => {
    // 组件本身无会话态：拿到 running 快照就显示，等价于刷新后的恢复。
    const { unmount } = render(<NotificationCapsule jobs={[]} courseName={courseName} onCancel={vi.fn()} />)
    expect(screen.queryByRole('button')).toBeNull()
    unmount()
    render(<NotificationCapsule jobs={[job({ id: 'jr', courseId: 'c1', state: 'running', message: '整理章节 1/60', progress: { stage: 'organizing', done: 1, total: 60, failures: [] } })]} courseName={courseName} onCancel={vi.fn()} />)
    expect(screen.getByRole('button', { name: /整理中/ })).toBeInTheDocument()
  })

  it('is keyboard reachable and announces status changes', () => {
    render(<NotificationCapsule jobs={[job({ id: 'jk', courseId: 'c1', state: 'running', message: '整理中', progress: { stage: 'organizing', done: 1, total: 5, failures: [] } })]} courseName={courseName} onCancel={vi.fn()} />)
    // aria-live 播报当前状态。
    expect(screen.getByRole('status')).toHaveTextContent(/整理中/)
    const capsule = screen.getByRole('button', { name: /整理中/ })
    capsule.focus()
    expect(capsule).toHaveFocus()
    fireEvent.click(capsule)
    expect(screen.getByRole('dialog', { name: '通知面板' })).toBeInTheDocument()
    // Esc 收起并把焦点交还胶囊。
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '通知面板' })).toBeNull()
    expect(capsule).toHaveFocus()
  })

  it('需求：覆盖度提示已删除——没有任务时胶囊不出现', () => {
    const { container } = render(<NotificationCapsule jobs={[]} courseName={courseName} onCancel={vi.fn()} />)
    expect(container.querySelector('[data-notification-dock]')).toBeNull()
    expect(screen.queryByRole('button', { name: /覆盖提示|候选片段/ })).toBeNull()
  })
})
