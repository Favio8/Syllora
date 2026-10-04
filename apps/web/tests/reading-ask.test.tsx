/**
 * 需求六：辅助阅读「直接提问」——
 * 选中文字后可以在工具栏输入自定义提示词，回答以流式增量渲染在右侧助手面板，
 * 标注「不引用课程资料」、不给任何来源按钮；失败保留提示词与选区可重试。
 *
 * 这里 mock 掉 services（宿主真实 SSE 帧由 packages/host/chat-service 的
 * reading-ask.spec.ts 与 apps/web 的 sse-parser 用例覆盖），只验证界面行为。
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Course, ReadingDocument } from '../src/features/workbench/types'

const mocked = vi.hoisted(() => ({
  ask: vi.fn(),
  assist: vi.fn(),
  document: {
    id: 'm1',
    courseId: 'c1',
    revision: 'r1',
    name: '讲义.md',
    title: '讲义.md',
    source: 'published' as const,
    content: '文章正文',
    sources: [{ id: 's1', anchor: '段落', text: '测试正文' }],
  },
}))

vi.mock('@/src/features/workbench/services', () => ({
  readingService: {
    document: async () => mocked.document,
    assist: mocked.assist,
    ask: mocked.ask,
  },
}))

import ReadingWorkspace from '../src/features/workbench/components/ReadingWorkspace'

const course = { id: 'c1', name: '数据结构', revision: 'r1', materials: [{ id: 'm1', name: '讲义.md' }], points: [], tasks: [], messages: [] } as unknown as Course

function props() {
  return { course, onUpload: () => {}, assistantOpen: true, onToggleAssistant: () => {}, onExpandAssistant: () => {}, onActivity: () => {}, onSource: () => {} }
}

const SELECTED = '被选中的文字'

/** 伪造页面选区：容器必须在正文 article 内，且 Range 的 rect 在 jsdom 里要自行补；
 *  工具栏的来源标注依赖 `range.intersectsNode(节点)`，纯对象也得带上这个方法。 */
function selectArticleText() {
  const article = document.querySelector('.reading-paper')
  const range = {
    startContainer: article,
    endContainer: article,
    getBoundingClientRect: () => ({ left: 120, top: 240, width: 80, height: 18, bottom: 258, right: 200, x: 120, y: 240 }),
    intersectsNode: () => true,
  }
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
    toString: () => SELECTED,
    removeAllRanges: () => {},
  } as unknown as Selection)
  act(() => { document.dispatchEvent(new Event('selectionchange')) })
}

async function openToolbar() {
  render(<ReadingWorkspace {...props()} />)
  await screen.findByText('测试正文')
  selectArticleText()
  // selectionchange 有 100ms 防抖。
  return screen.findByLabelText('自定义提示词')
}

describe('辅助阅读「直接提问」（需求六）', () => {
  beforeEach(() => {
    mocked.ask.mockReset()
    mocked.assist.mockReset()
    mocked.assist.mockRejectedValue(new Error('不应走知识库路径'))
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('输入提示词发送后，右侧面板增量渲染流式回答并标注不引用课程资料', async () => {
    let release: () => void = () => {}
    mocked.ask.mockImplementation(async (_document: ReadingDocument, _selection: string, _prompt: string, _signal: AbortSignal, options?: { onDelta?: (delta: string) => void }) => {
      options?.onDelta?.('第一段。')
      await new Promise<void>(resolve => { release = resolve })
      options?.onDelta?.('第二段。')
      return { text: '第一段。第二段。' }
    })
    const input = await openToolbar()
    fireEvent.change(input, { target: { value: '用生活中的例子解释这段话' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // 增量：第一段先到，第二段在流继续前还不该出现。
    expect(await screen.findByText(/第一段/)).toBeInTheDocument()
    expect(screen.getByText('不引用课程资料')).toBeInTheDocument()
    expect(screen.getByText('AI 直答')).toBeInTheDocument()
    expect(screen.getByText(SELECTED)).toBeInTheDocument()
    expect(screen.getByText(/正在生成/)).toBeInTheDocument()
    expect(screen.queryByText(/第二段/)).toBeNull()
    expect(mocked.ask.mock.calls[0]?.[1]).toBe(SELECTED)
    expect(mocked.ask.mock.calls[0]?.[2]).toBe('用生活中的例子解释这段话')

    await act(async () => { release() })
    await waitFor(() => expect(screen.getByText(/第一段。第二段。/)).toBeInTheDocument())
    expect(screen.queryByText(/正在生成/)).toBeNull()
    // 直答路径不得出现任何来源入口，也不得走知识库检索。
    expect(screen.queryByText(/来源/)).toBeNull()
    expect(screen.queryByText('查看资料来源')).toBeNull()
    expect(mocked.assist).not.toHaveBeenCalled()
  })

  it('发送失败保留选区与提示词，重试走通', async () => {
    mocked.ask.mockImplementationOnce(async (_document: ReadingDocument, _selection: string, _prompt: string, _signal: AbortSignal, options?: { onDelta?: (delta: string) => void }) => {
      options?.onDelta?.('半截回答')
      throw new Error('模型调用失败，请稍后重试。')
    })
    mocked.ask.mockImplementationOnce(async () => ({ text: '重试后的完整回答。' }))
    const input = await openToolbar()
    fireEvent.change(input, { target: { value: '换个说法解释' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(await screen.findByText('模型调用失败，请稍后重试。')).toBeInTheDocument()
    // 失败后选区仍在面板里，提示词可在重试时复用。
    expect(screen.getByText(SELECTED)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试直答' }))
    await waitFor(() => expect(screen.getByText(/重试后的完整回答/)).toBeInTheDocument())
    expect(mocked.ask.mock.calls[1]?.[2]).toBe('换个说法解释')
  })
})
