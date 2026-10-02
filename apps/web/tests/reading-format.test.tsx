/**
 * B11：辅助阅读正文按 kind 分支渲染（用户实测：旧实现所有非 heading 源都走
 * ReactMarkdown 且无 remark-breaks，代码/表格/列表/多行段落被折叠成一堵墙）。
 * 同时守住 XSS 口径（skipHtml、不引 rehype-raw）。
 */

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReadingWorkspace from '../src/features/workbench/components/ReadingWorkspace'
import { remarkSoftBreaks, splitFence } from '../src/features/workbench/reading-format'
import type { Course, ReadingDocument } from '../src/features/workbench/types'

const course = { id: 'c1', name: '数据结构', revision: 'r1', materials: [{ id: 'm1', name: '讲义.md' }], points: [], tasks: [], messages: [] } as unknown as Course

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const result = url.endsWith('/readingDocument') ? current : {}
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

let current: Record<string, unknown> = {}

function withDocument(document: Omit<ReadingDocument, 'courseId'>) {
  current = document as unknown as Record<string, unknown>
}

const base = { id: 'm1', name: '讲义.md', title: '讲义.md', revision: 'r1', status: 'ready', accepted: true, source: 'published' as const, previewUrl: null, pageIssues: [], content: 'x' }

function props() {
  return { course, onUpload: () => {}, assistantOpen: false, onToggleAssistant: () => {}, onExpandAssistant: () => {}, onActivity: () => {}, onSource: () => {} }
}

describe('B11：正文按 kind 渲染', () => {
  it('keeps code newlines and indentation inside pre/code', async () => {
    withDocument({ ...base, sources: [{ id: 's1', kind: 'code', anchor: '代码', text: '```js\nfunction add(a, b) {\n  return a + b;\n}\n```' }] } as unknown as Omit<ReadingDocument, 'courseId'>)
    render(<ReadingWorkspace {...props()} />)
    const code = await screen.findByText(/function add/)
    expect(code.tagName).toBe('CODE')
    expect(code.closest('pre')).not.toBeNull()
    // 换行与两格缩进都要在文本里保留（不是被折成空格）。
    expect(code.textContent).toBe('function add(a, b) {\n  return a + b;\n}')
  })

  it('renders a table as rows rather than one flattened line', async () => {
    withDocument({ ...base, sources: [{ id: 's2', kind: 'table', anchor: '表', text: '| 名称 | 复杂度 |\n| --- | --- |\n| 二分 | O(log n) |' }] } as unknown as Omit<ReadingDocument, 'courseId'>)
    const { container } = render(<ReadingWorkspace {...props()} />)
    const table = await screen.findByRole('table')
    expect(table).toBeInTheDocument()
    expect(container.querySelectorAll('th')).toHaveLength(2)
    expect(container.querySelectorAll('td')).toHaveLength(2)
  })

  it('preserves soft line breaks in list and paragraph blocks', async () => {
    withDocument({ ...base, sources: [{ id: 's3', kind: 'paragraph', anchor: '段', text: '第一行\n第二行\n第三行' }] } as unknown as Omit<ReadingDocument, 'courseId'>)
    const { container } = render(<ReadingWorkspace {...props()} />)
    await screen.findByText(/第一行/)
    // remarkSoftBreaks 把软换行提升为 <br>，否则三行会被折成一行。
    expect(container.querySelectorAll('br').length).toBeGreaterThanOrEqual(2)
  })

  it('does not render raw html from a source', async () => {
    withDocument({ ...base, sources: [{ id: 's4', kind: 'paragraph', anchor: '段', text: '普通正文\n<img src=x onerror="alert(1)">' }] } as unknown as Omit<ReadingDocument, 'courseId'>)
    const { container } = render(<ReadingWorkspace {...props()} />)
    await screen.findByText(/普通正文/)
    expect(container.querySelector('img')).toBeNull()
    expect(container.innerHTML).not.toContain('onerror')
  })

  it('still renders headings as h2', async () => {
    withDocument({ ...base, sources: [{ id: 's5', kind: 'heading', anchor: '节', text: '## 第二章 线性表' }] } as unknown as Omit<ReadingDocument, 'courseId'>)
    render(<ReadingWorkspace {...props()} />)
    expect(await screen.findByRole('heading', { name: '第二章 线性表' })).toBeInTheDocument()
  })
})

describe('B11：渲染辅助', () => {
  it('splits a fence into language and body', () => {
    expect(splitFence('```ts\nconst a = 1;\n```')).toEqual({ language: 'ts', code: 'const a = 1;' })
    expect(splitFence('const a = 1;')).toEqual({ language: '', code: 'const a = 1;' })
    // 未闭合的围栏也要给出正文（不能把围栏行当代码）。
    expect(splitFence('```js\nlet x = 1;')).toEqual({ language: 'js', code: 'let x = 1;' })
  })

  it('keeps code text nodes intact when applying soft breaks', () => {
    const tree = { type: 'root', children: [{ type: 'code', value: 'a\nb', children: [] }] }
    remarkSoftBreaks()(tree)
    expect(tree.children[0]).toEqual({ type: 'code', value: 'a\nb', children: [] })
  })
})
