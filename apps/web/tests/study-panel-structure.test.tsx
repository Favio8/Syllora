/**
 * PRD 需求三的验收锁定：
 *  1. 右栏只有 3 个标签；「计划/大纲/复习/资料」四部分内容在新结构里逐一可达。
 *  2. 全页面无 9–10px 正文字号、无 Helvetica 字体继承（静态扫描样式文件）。
 *  4. 讲义阅读入口在「今日」卡可见且行为与现在一致（打开中栏讲义）。
 *
 * 静态扫描比逐个组件断言更能防回归：样式是新加规则时最容易把字号改回去。
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Syllora from '../src/components/Syllora'
import { publicCourse, type Course } from '../../../packages/host/chat-service/src/syllora-domain'

vi.mock('../src/components/settings/ModelsSection', () => ({ default: () => null }))
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { sessionStorage.clear(); vi.unstubAllGlobals() })

function fixture(): Course {
  return { id: 'c', name: '合成 UI 课程', timezone: 'Asia/Shanghai', archived: false, createdAt: Date.now(),
    materials: [{ id: 'm', name: 'fixture.txt', fingerprint: 'fixture', status: 'ready', accepted: true, pages: 0, sources: [{ id: 's', materialId: 'm', anchor: '段落 1', text: '合成来源' }] }],
    points: [{ id: 'p', name: '旧知识点', chapter: '章', sourceIds: ['s'] }], scope: ['p'], plan: null, draft: null, questions: [], attempts: [], messages: [], actions: [], drafts: { prompt: '', answers: [] }, changes: [], notice: null }
}
function state(course: Course) { return { courses: [publicCourse(course, Date.now())], jobs: [], settings: { consent: false, calls: 0 } } }

async function openCourse() {
  const course = fixture()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ result: state(course) }) }))
  render(<Syllora />)
  fireEvent.click(await screen.findByRole('button', { name: /合成 UI 课程.*个知识点/ }))
  await screen.findByRole('heading', { name: '合成 UI 课程' })
  return course
}

describe('需求三：面板结构精简', () => {
  it('exposes exactly three panel tabs', async () => {
    await openCourse()
    const tabs = screen.getAllByRole('tab').map(tab => tab.textContent)
    expect(tabs).toEqual(['今日', '学习', '资料'])
    // 需求二：左栏入口删除后，顶栏的旧「学习工作台」标签一并调整。
    expect(screen.queryByText('学习工作台')).toBeNull()
    expect(screen.getByText('课程学习')).toBeInTheDocument()
  })

  it('keeps every section reachable through the three tabs', async () => {
    await openCourse()
    // 今日：进度 + 证据分布 + 已确认计划（空态）。
    expect(screen.getByText('有效评估覆盖')).toBeInTheDocument()
    expect(screen.getByLabelText('证据状态分布')).toBeInTheDocument()
    expect(screen.getByText(/已确认计划/)).toBeInTheDocument()
    // 学习：大纲（知识点勾选/重命名/排序/估时）+ 计划参数 + 复习 + 折叠诊断。
    fireEvent.click(screen.getByRole('tab', { name: '学习' }))
    expect(screen.getByLabelText('旧知识点 重命名')).toBeInTheDocument()
    expect(screen.getByLabelText('旧知识点 上移')).toBeInTheDocument()
    expect(screen.getByLabelText('旧知识点 下移')).toBeInTheDocument()
    expect(screen.getByLabelText('旧知识点 任务估时（分钟）')).toBeInTheDocument()
    expect(screen.getByLabelText('每天可用分钟')).toBeInTheDocument()
    expect(screen.getByLabelText('未来天数（无目标日期时生效）')).toBeInTheDocument()
    expect(screen.getByLabelText('目标日期（可选，含当天）')).toBeInTheDocument()
    expect(screen.getByText('复习间隔设置与学习诊断')).toBeInTheDocument()
    // 复习分组：已确认范围的知识点与复习状态（证据状态分布本身在「今日」卡内）。
    expect(screen.getByText('复习')).toBeInTheDocument()
    // 资料：初始化 + 上传/粘贴 + 资料列表 + 来源锚点。
    fireEvent.click(screen.getByRole('tab', { name: '资料' }))
    expect(screen.getByText('课程资料')).toBeInTheDocument()
    expect(screen.getByText('选择资料文件')).toBeInTheDocument()
    expect(screen.getByText(/或粘贴正文/)).toBeInTheDocument()
    expect(screen.getByLabelText('删除资料 fixture.txt')).toBeInTheDocument()
    expect(screen.getByText('段落 1')).toBeInTheDocument()
  })

  it('offers the lecture reading entry on the today card and opens the center-column reader', async () => {
    await openCourse()
    const entry = screen.getByRole('button', { name: /阅读讲义/ })
    expect(entry).toBeInTheDocument()
    fireEvent.click(entry)
    // 中栏讲义阅读器挂载（面板里的讲义标签已移除）。
    await waitFor(() => expect(screen.getByLabelText('课程讲义')).toBeInTheDocument())
  })
})

describe('需求三：视觉规范（静态扫描）', () => {
  const styleRoots = ['src', 'app']

  async function collectCss(root: string): Promise<string[]> {
    const base = join(process.cwd(), 'apps', 'web', root)
    const found: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (entry.name === 'node_modules') continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) await walk(path)
        else if (entry.name.endsWith('.css')) found.push(path)
      }
    }
    await walk(base)
    return found
  }

  it('declares no font size below 11px anywhere in the web stylesheet', async () => {
    const offenders: string[] = []
    for (const root of styleRoots) {
      for (const file of await collectCss(root)) {
        const css = await readFile(file, 'utf8')
        for (const match of css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) {
          if (Number(match[1]) < 11) offenders.push(`${file}: font-size:${match[1]}px`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('does not inherit a Helvetica/Arial font stack anywhere in the web stylesheet', async () => {
    const offenders: string[] = []
    for (const root of styleRoots) {
      for (const file of await collectCss(root)) {
        const css = await readFile(file, 'utf8')
        // globals.css 的系统字体回退链（含 Helvetica Neue）是唯一允许项。
        if (file.endsWith('globals.css')) continue
        for (const match of css.matchAll(/font-family:[^;}]*/g)) {
          if (/Helvetica/i.test(match[0])) offenders.push(`${file}: ${match[0].trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps the v2 look on the new panel surface tokens', async () => {
    const css = await readFile(join(process.cwd(), 'apps', 'web', 'src', 'components', 'syllora.css'), 'utf8')
    // 卡片化与暗色分层的落地声明必须在场。
    expect(css).toContain('.panel-card{')
    expect(css).toContain('border-radius:10px')
    expect(css).toContain(':root[data-theme=dark] .study-panel .panel-card')
    expect(css).toContain('color:#15233c')
  })
})
