/**
 * PRD 需求三的验收锁定（适配本地「外壳 + 本地内容」的设计）：
 *  1. 面板外壳（PanelCard / PanelEmpty）渲染卡片与空状态的约定类名；
 *  2. 三个分组只是布局包裹：原样渲染 children，不拥有任何本地逻辑；
 *  3. 面板样式在 syllora.css 里到场（卡片化、分段标签、暗色分层），
 *     且面板内的正文字号下限为 11px（静态扫描，防止把字号改回去）。
 *
 * 面板的具体内容由 `Syllora.tsx` 注入，因此这里只测外壳与样式契约，
 * 不再断言各分组内部的本地内容（那由工作台自己的用例覆盖）。
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MaterialsSection, PanelCard, PanelEmpty, StudySection, TodaySection } from '../src/components/panel/StudyPanel'

describe('需求三：面板外壳', () => {
  it('renders a card with its head, hint and extra class', () => {
    const { container } = render(<PanelCard title="进度" hint="活动完成 · 有效评估覆盖" className="panel-card-quiet">卡片正文</PanelCard>)
    const card = container.querySelector('.panel-card')
    expect(card).not.toBeNull()
    expect(card).toHaveClass('panel-card-quiet')
    expect(container.querySelector('.panel-card-head h3')).toHaveTextContent('进度')
    expect(container.querySelector('.panel-card-head > span')).toHaveTextContent('活动完成 · 有效评估覆盖')
    expect(screen.getByText('卡片正文')).toBeInTheDocument()
  })

  it('omits the head when there is no title', () => {
    const { container } = render(<PanelCard>只有正文</PanelCard>)
    expect(container.querySelector('.panel-card-head')).toBeNull()
    expect(screen.getByText('只有正文')).toBeInTheDocument()
  })

  it('renders the empty state with icon, title, description and action', () => {
    const { container } = render(<PanelEmpty icon={<span data-testid="empty-icon" />} title="还没有已确认的计划" description="导入资料、生成大纲后，确认你的第一份计划。" action={<button>开始准备</button>} />)
    const empty = container.querySelector('.panel-empty-state')
    expect(empty).not.toBeNull()
    expect(screen.getByTestId('empty-icon')).toBeInTheDocument()
    expect(screen.getByText('还没有已确认的计划')).toBeInTheDocument()
    expect(screen.getByText('导入资料、生成大纲后，确认你的第一份计划。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始准备' })).toBeInTheDocument()
  })

  it('keeps the three groups as thin layout wrappers around the passed children', () => {
    const { container } = render(<>
      <TodaySection><p>今日内容</p></TodaySection>
      <StudySection><p>学习内容</p></StudySection>
      <MaterialsSection><p>资料内容</p></MaterialsSection>
    </>)
    expect(container.querySelectorAll('.panel-body-section')).toHaveLength(3)
    expect(screen.getByText('今日内容').parentElement).toHaveClass('panel-body-section')
    expect(screen.getByText('学习内容').parentElement).toHaveClass('panel-body-section')
    expect(screen.getByText('资料内容').parentElement).toHaveClass('panel-body-section')
  })
})

describe('需求三：视觉规范（静态扫描，限面板块）', () => {
  /** 定位面板样式文件：从仓库根或 apps/web 运行都成立（不依赖单一 cwd）。 */
  function sylloraCssPath(): string {
    let dir = process.cwd()
    for (let depth = 0; depth < 4; depth++) {
      for (const candidate of [join(dir, 'apps', 'web', 'src', 'components', 'syllora.css'), join(dir, 'src', 'components', 'syllora.css')]) {
        if (existsSync(candidate)) return candidate
      }
      dir = resolve(dir, '..')
    }
    throw new Error('找不到 syllora.css')
  }

  async function panelCss(): Promise<string> {
    const css = await readFile(sylloraCssPath(), 'utf8')
    const marker = '需求三：学习面板视觉统一'
    const at = css.indexOf(marker)
    expect(at).toBeGreaterThanOrEqual(0)
    return css.slice(at)
  }

  it('declares the panel shell, segment tabs and dark-theme rules', async () => {
    const css = await panelCss()
    for (const selector of ['.study-panel{', '.panel-card{', '.panel-card-head{', '.panel-card-quiet{', '.panel-inline-action{', '.panel-fold{', '.panel-fold>summary{', '.panel-subsection{', '.panel-empty-state{', '.panel-plan-list{', '.panel-tabs.segment{', '.panel-tabs.segment button.active{']) {
      expect(css).toContain(selector)
    }
    // 卡片化与暗色分层的落地声明必须在场。
    expect(css).toContain('border-radius:10px')
    expect(css).toContain(':root[data-theme=dark] .study-panel .panel-card')
    expect(css).toContain('color:#15233c')
  })

  it('declares no font size below 11px inside the panel block', async () => {
    const css = await panelCss()
    const offenders = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].filter(match => Number(match[1]) < 11).map(match => match[0])
    expect(offenders).toEqual([])
  })
})
