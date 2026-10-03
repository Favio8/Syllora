/**
 * PRD 需求一：左栏课程列表溢出折叠 + 排序（浮层上移/下移与拖拽同一结果）。
 * 溢出探测依赖元素高度，jsdom 里 clientHeight 恒为 0，所以用 getter 覆盖造出
 * 「放得下 N 个」的场景，直接驱动容量判定。
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Sidebar from '../src/features/workbench/components/Sidebar'
import type { Course } from '../src/features/workbench/types'

vi.mock('../src/features/workbench/components/CourseIcon', () => ({
  default: ({ course }: { course: Course }) => <span data-testid={`icon-${course.id}`} />,
}))

// jsdom 没有顶层 dialog 实现（本地其余打开弹窗的用例同样自行补齐）：只补 open 状态。
if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
}

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { vi.restoreAllMocks() })

function course(id: string, name: string): Course {
  return { id, name, subtitle: '', symbol: '', color: 'blue', chapter: '第一章', tasks: [], points: [], materials: [], messages: [] }
}

/** 造出「课程列可用高度只放得下 capacity 个槽位」的测量结果。 */
function stubRailHeight(slots: number): void {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('rail-courses') ? slots * 53 : 800
  })
}

function renderRail(courses: Course[], onReorder?: (ids: string[]) => void) {
  const props = { courses, selected: courses[0]?.id ?? '', view: 'workspace' as const, mobileOpen: false, onClose: vi.fn(), onView: vi.fn(), onCourse: vi.fn(), onCreate: vi.fn(), onUserAction: vi.fn() }
  return render(onReorder ? <Sidebar {...props} onReorder={onReorder} /> : <Sidebar {...props} />)
}

describe('需求一：左栏课程列表溢出折叠', () => {
  it('hides the "…" button while every course fits', async () => {
    stubRailHeight(8)
    renderRail([course('a', '甲'), course('b', '乙')])
    await waitFor(() => expect(document.querySelector('.rail-courses')).not.toBeNull())
    expect(document.querySelector('.rail-courses-more')).toBeNull()
  })

  it('collapses the tail into "…" once courses exceed the rail height', async () => {
    stubRailHeight(3)
    const courses = [course('a', '甲'), course('b', '乙'), course('c', '丙'), course('d', '丁'), course('e', '戊')]
    renderRail(courses)
    const more = await waitFor(() => {
      const found = document.querySelector('.rail-courses-more')
      if (found === null) throw new Error('overflow button not rendered yet')
      return found as HTMLButtonElement
    })
    // 容量 3：留一个槽位给「…」，只显示前 2 门。
    expect(document.querySelectorAll('.rail-course')).toHaveLength(2)
    expect(more).toHaveTextContent('…')
  })

  it('lists every course in the picker and switches on choose', async () => {
    stubRailHeight(3)
    const courses = [course('a', '甲'), course('b', '乙'), course('c', '丙'), course('d', '丁')]
    const props = { courses, selected: 'a', view: 'workspace' as const, mobileOpen: false, onClose: vi.fn(), onView: vi.fn(), onCourse: vi.fn(), onCreate: vi.fn(), onUserAction: vi.fn(), onReorder: vi.fn() }
    render(<Sidebar {...props} />)
    fireEvent.click(await waitFor(() => document.querySelector('.rail-courses-more') as HTMLButtonElement))
    // 浮层列出全部课程（含被折叠的两门）。
    const dialog = await screen.findByRole('dialog')
    for (const name of ['甲', '乙', '丙', '丁']) expect(within(dialog).getByLabelText(`切换到 ${name}`)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByLabelText('切换到 丁'))
    expect(props.onCourse).toHaveBeenCalledWith('d')
  })
})

describe('需求一：排序（浮层上移/下移）', () => {
  it('moves a course up and down and reports the full order', async () => {
    stubRailHeight(2)
    const courses = [course('a', '甲'), course('b', '乙'), course('c', '丙')]
    const onReorder = vi.fn()
    const props = { courses, selected: 'a', view: 'workspace' as const, mobileOpen: false, onClose: vi.fn(), onView: vi.fn(), onCourse: vi.fn(), onCreate: vi.fn(), onUserAction: vi.fn(), onReorder }
    render(<Sidebar {...props} />)
    fireEvent.click(await waitFor(() => document.querySelector('.rail-courses-more') as HTMLButtonElement))
    const dialog = await screen.findByRole('dialog')

    fireEvent.click(within(dialog).getByLabelText('乙 上移'))
    expect(onReorder).toHaveBeenLastCalledWith(['b', 'a', 'c'])
    fireEvent.click(within(dialog).getByLabelText('丙 下移'))
    expect(onReorder).toHaveBeenLastCalledWith(['b', 'a', 'c'])
  })

  it('disables the first up and last down buttons (keyboard-reachable bounds)', async () => {
    stubRailHeight(2)
    const courses = [course('a', '甲'), course('b', '乙'), course('c', '丙')]
    renderRail(courses, vi.fn())
    fireEvent.click(await waitFor(() => document.querySelector('.rail-courses-more') as HTMLButtonElement))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('甲 上移')).toBeDisabled()
    expect(within(dialog).getByLabelText('丙 下移')).toBeDisabled()
    expect(within(dialog).getByLabelText('甲 下移')).not.toBeDisabled()
  })

  it('reorders on drop without switching the active course', async () => {
    stubRailHeight(10)
    const courses = [course('a', '甲'), course('b', '乙'), course('c', '丙')]
    const onReorder = vi.fn()
    const props = { courses, selected: 'a', view: 'workspace' as const, mobileOpen: false, onClose: vi.fn(), onView: vi.fn(), onCourse: vi.fn(), onCreate: vi.fn(), onUserAction: vi.fn(), onReorder }
    render(<Sidebar {...props} />)
    const buttons = await waitFor(() => {
      const found = document.querySelectorAll('.rail-course')
      if (found.length !== 3) throw new Error('courses not rendered yet')
      return found
    })
    const store = new Map<string, string>()
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: (k: string, v: string) => store.set(k, v), getData: (k: string) => store.get(k) ?? '' }
    fireEvent.dragStart(buttons[2]!, { dataTransfer })
    fireEvent.dragOver(buttons[0]!, { dataTransfer })
    fireEvent.drop(buttons[0]!, { dataTransfer })
    // 落位后才生效；拖拽过程不触发课程切换。
    expect(onReorder).toHaveBeenCalledWith(['c', 'a', 'b'])
    expect(props.onCourse).not.toHaveBeenCalled()
  })
})
