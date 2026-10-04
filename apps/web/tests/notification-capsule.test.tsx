/**
 * PRD 需求五（UI 重构后）：通知入口改为左栏常驻图标，点击进入整页「任务」视图。
 *  - 入口常驻；状态文字通过 aria-label / 悬停气泡给出（整理中 x/y、N 个任务失败、任务）；
 *  - 刷新后后端仍有 running job 时状态恢复（组件只依赖轮询快照，无会话态）；
 *  - 键盘可达 + aria-live 播报；
 *  - 任务页：进行中置顶、按课程标注、可取消、失败明细与「查看失败页」，已完成不自动消失。
 */

import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import NotificationCapsule from '../src/components/chat/NotificationCapsule'
import TasksPage from '../src/components/chat/TasksPage'
import type { SylloraState } from '../src/types/syllora'

type Job = SylloraState['jobs'][number]
/** 本地 job 类型尚未声明 etaMs：与组件里一样按可选字段收窄。 */
type JobProgress = NonNullable<Job['progress']> & { etaMs?: number }

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
const running = (id = 'j1', courseId = 'c1') => job({
  id, courseId, state: 'running', createdAt: 2,
  progress: { stage: 'organizing', done: 2, total: 5, failures: [], etaMs: 30_000 } as JobProgress,
})

describe('需求五：左栏任务入口', () => {
  it('stays visible with no jobs and labels itself as the task entry', () => {
    render(<NotificationCapsule jobs={[]} onOpen={() => {}} />)
    expect(screen.getByRole('button', { name: '任务' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('summarises running progress and announces it', () => {
    render(<NotificationCapsule jobs={[running()]} onOpen={() => {}} />)
    const button = screen.getByRole('button', { name: '整理中 2/5' })
    expect(button.className).toContain('is-running')
    expect(screen.getByRole('status').textContent).toBe('整理中 2/5')
  })

  it('counts several running jobs and failures', () => {
    const { rerender } = render(<NotificationCapsule jobs={[running('a'), running('b', 'c2')]} onOpen={() => {}} />)
    expect(screen.getByRole('button', { name: '2 个任务进行中 2/5' })).toBeTruthy()
    rerender(<NotificationCapsule jobs={[job({ id: 'f', courseId: 'c1', state: 'failed' })]} onOpen={() => {}} />)
    expect(screen.getByRole('button', { name: '1 个任务失败' }).className).toContain('is-failed')
  })

  it('shows the tooltip on focus and opens the task page on click', () => {
    const onOpen = vi.fn()
    render(<NotificationCapsule jobs={[running()]} active onOpen={onOpen} />)
    const button = screen.getByRole('button', { name: '整理中 2/5' })
    expect(button.getAttribute('aria-current')).toBe('page')
    fireEvent.focus(button)
    expect(within(document.body).getByRole('tooltip').textContent).toBe('整理中 2/5')
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledOnce()
    expect(within(document.body).queryByRole('tooltip')).toBeNull()
  })

  it('reappears as running after a refresh when the backend still reports the job', () => {
    const { unmount } = render(<NotificationCapsule jobs={[running()]} onOpen={() => {}} />)
    unmount()
    render(<NotificationCapsule jobs={[running()]} onOpen={() => {}} />)
    expect(screen.getByRole('button', { name: '整理中 2/5' })).toBeTruthy()
  })
})

describe('需求五：任务页', () => {
  it('lists running jobs first, labelled by course, with progress, ETA and a working cancel button', () => {
    const onCancel = vi.fn()
    render(<TasksPage
      jobs={[job({ id: 'done', courseId: 'c2', state: 'succeeded', createdAt: 9, elapsedMs: 4_000 }), running()]}
      courseName={courseName}
      onCancel={onCancel}
    />)
    const cards = document.querySelectorAll('.task-card')
    expect(cards).toHaveLength(2)
    expect(within(cards[0] as HTMLElement).getByText('甲课')).toBeTruthy()
    expect(cards[0].textContent).toContain('整理 2/5')
    expect(cards[0].textContent).toContain('预计剩余约 30 秒')
    expect(within(cards[1] as HTMLElement).getByText('乙课')).toBeTruthy()
    expect(cards[1].textContent).toContain('已完成')
    expect(cards[1].textContent).toContain('耗时 4 秒')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalledWith('j1')
  })

  it('keeps failures with their detail, error code and failure-page entry', () => {
    const onOpenFailures = vi.fn()
    render(<TasksPage
      jobs={[job({
        id: 'f', courseId: 'c1', state: 'failed', errorCode: 'MODEL_QUOTA',
        progress: { stage: 'organizing', done: 1, total: 3, failures: ['第 3 页：无法识别文字'] } as JobProgress,
      })]}
      courseName={courseName}
      onCancel={() => {}}
      onOpenFailures={onOpenFailures}
    />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('1 个任务需要处理')
    expect(screen.getByText('第 3 页：无法识别文字')).toBeTruthy()
    expect(document.querySelector('.task-meta')?.textContent).toContain('错误代码 MODEL_QUOTA')
    fireEvent.click(screen.getByRole('button', { name: '查看失败页' }))
    expect(onOpenFailures).toHaveBeenCalledWith('c1')
  })

  it('shows an empty state without jobs', () => {
    render(<TasksPage jobs={[]} courseName={courseName} onCancel={() => {}} />)
    expect(screen.getByText('没有任务')).toBeTruthy()
  })
})