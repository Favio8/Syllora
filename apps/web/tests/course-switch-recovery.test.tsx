import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Syllora from '../src/components/Syllora'
import { publicCourse, type Course } from '../../../packages/host/chat-service/src/syllora-domain'

vi.mock('../src/components/chat/AgentChat', () => ({ default: ({ draft, onDraft, children }: { draft: string; onDraft: (text: string) => void; children: ReactNode }) => <><textarea aria-label="课程草稿" value={draft} onChange={event => onDraft(event.target.value)} />{children}</> }))
vi.mock('../src/components/settings/ModelsSection', () => ({ default: () => null }))
beforeEach(() => { sessionStorage.clear(); Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear() })
function fixture(id: string): Course {
  return { id, name: `课程 ${id}`, timezone: 'Asia/Shanghai', archived: false, createdAt: Date.now(), materials: [], points: [], scope: [], plan: null, draft: null, questions: [], attempts: [], messages: [], actions: [], drafts: { prompt: '', answers: [], version: 0 }, changes: [], notice: null }
}

describe('B2 / B3 course switching', () => {
  it('offers forced switching offline, retains both drafts and retries background saving when service returns', async () => {
    const courses = [fixture('a'), fixture('b')]
    let offline = false, backgroundFailures = 1
    const saved: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (offline) throw new Error('本地服务不可用')
      if (url.endsWith('/saveDraft')) {
        const payload = JSON.parse(String(init?.body)).payload
        if (backgroundFailures-- > 0) throw new Error('临时保存失败')
        saved.push(payload)
        courses.find(course => course.id === payload.courseId)!.drafts = { prompt: payload.prompt, answers: payload.answers, version: 1 }
        return new Response(JSON.stringify({ result: { version: 1 } }))
      }
      return new Response(JSON.stringify({ result: { courses: courses.map(course => publicCourse(course, Date.now())), jobs: [], settings: { consent: false, calls: 0 } } }))
    }))
    render(<Syllora />)
    await waitFor(() => expect(document.querySelectorAll('.rail-course')).toHaveLength(2))
    fireEvent.click(document.querySelectorAll('.rail-course')[0]!)
    const input = await screen.findByLabelText('课程草稿')
    fireEvent.change(input, { target: { value: '离线输入 a' } })
    offline = true
    fireEvent.click(document.querySelectorAll('.rail-course')[1]!)
    const force = await screen.findByRole('button', { name: '保留草稿并切换' })
    expect(screen.getByRole('heading', { name: '课程 a' })).toBeInTheDocument()
    fireEvent.click(force)
    await screen.findByRole('heading', { name: '课程 b' })
    expect(screen.getByLabelText('课程草稿')).toHaveValue('')
    expect(sessionStorage.getItem('syllora.unsaved-drafts.v1')).toContain('离线输入 a')
    offline = false
    await waitFor(() => expect(saved.some(payload => payload.courseId === 'a' && payload.prompt === '离线输入 a')).toBe(true), { timeout: 6000 })
    fireEvent.click(document.querySelectorAll('.rail-course')[0]!)
    await screen.findByRole('heading', { name: '课程 a' })
    expect(screen.getByLabelText('课程草稿')).toHaveValue('离线输入 a')
  })

  it('returns to Today when switching away from another course study tab', async () => {
    const courses = [fixture('a'), fixture('b')]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: { courses: courses.map(course => publicCourse(course, Date.now())), jobs: [], settings: { consent: false, calls: 0 } } }))))
    render(<Syllora />)
    await waitFor(() => expect(document.querySelectorAll('.rail-course')).toHaveLength(2))
    fireEvent.click(document.querySelectorAll('.rail-course')[0]!)
    await screen.findByRole('heading', { name: '课程 a' })
    fireEvent.click(screen.getByRole('tab', { name: '学习' }))
    expect(screen.getByRole('tab', { name: '学习' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(document.querySelectorAll('.rail-course')[1]!)
    await screen.findByRole('heading', { name: '课程 b' })
    expect(screen.getByRole('tab', { name: '今日' })).toHaveAttribute('aria-selected', 'true')
  })

  it('opens another course failure in Materials only after saving the current draft', async () => {
    const courses = [fixture('a'), fixture('b')]
    const saved: Record<string, unknown>[] = []
    const jobs = [{ id: 'failed-b', courseId: 'b', kind: 'initialize', state: 'failed', message: '解析失败', createdAt: Date.now(), finishedAt: Date.now(), progress: { stage: 'parsing', done: 0, total: 1, failures: ['资料失败'] } }]
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/saveDraft')) {
        saved.push(JSON.parse(String(init?.body)).payload)
        return new Response(JSON.stringify({ result: { version: 1 } }))
      }
      return new Response(JSON.stringify({ result: { courses: courses.map(course => publicCourse(course, Date.now())), jobs, settings: { consent: false, calls: 0 } } }))
    }))
    render(<Syllora />)
    await waitFor(() => expect(document.querySelectorAll('.rail-course')).toHaveLength(2))
    fireEvent.click(document.querySelectorAll('.rail-course')[0]!)
    fireEvent.change(await screen.findByLabelText('课程草稿'), { target: { value: '先保存再看其他课程失败' } })
    fireEvent.click(document.querySelector('.notification-capsule')!)
    fireEvent.click(await screen.findByRole('button', { name: '查看失败页' }))
    await screen.findByRole('heading', { name: '课程 b' })
    expect(saved.some(payload => payload.courseId === 'a' && payload.prompt === '先保存再看其他课程失败')).toBe(true)
    await waitFor(() => expect(screen.getByRole('tab', { name: '资料' })).toHaveAttribute('aria-selected', 'true'))
  })
})
