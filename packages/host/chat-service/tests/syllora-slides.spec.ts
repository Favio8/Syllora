/**
 * 幻灯片归一化与校验的单元测试。
 *
 * 生成已经移到云端（那部分的网络行为由 `syllora-cloud.spec.ts` 用真实 HTTP 服务器验证），
 * 所以这里只测本模块自己的职责：把云端场景归一化、校验产物、以及 Markdown 降级视图。
 *
 * 输入形态对着实测的云端响应写：场景形如 `{ id, title, order, content: { type, canvas } }`。
 */
import { describe, expect, it } from 'vitest'
import type { Source } from '../src/syllora-domain.ts'
import {
  normalizeCloudScenes,
  slideArtifactMarkdown,
  slideFailureMessage,
  validateSlideArtifact,
  type SlideArtifact,
} from '../src/syllora-slides.ts'

/** 一份最小可渲染的 canvas：渲染器只要求有 elements 数组与主题。 */
const canvas = (text: string) => ({
  id: 'c1',
  viewportSize: 1000,
  viewportRatio: 0.5625,
  theme: { backgroundColor: '#fff', themeColors: ['#002fa7'], fontColor: '#202128', fontName: 'sans-serif' },
  elements: [
    { type: 'text', id: 't1', left: 60, top: 40, width: 880, height: 120, content: `<p>${text}</p>` },
  ],
})

const scene = (id: string, title: string, order: number, text: string) => ({
  id,
  title,
  order,
  content: { type: 'slide', canvas: canvas(text) },
})

const source = (id: string, section = '第一章'): Source => ({
  id, materialId: 'm1', version: 1, anchor: 'a.md · 行 1', text: '资料原文', section, kind: 'paragraph',
} as Source)

describe('normalizeCloudScenes', () => {
  it('保留可渲染的场景并按 order 排序', () => {
    const scenes = normalizeCloudScenes([
      scene('s2', '第二页', 2, '内容二'),
      scene('s1', '第一页', 1, '内容一'),
    ])
    expect(scenes.map(item => item.id)).toEqual(['s1', 's2'])
    expect(scenes[0]!.content.canvas).toBeDefined()
    expect(scenes[0]!.content.type).toBe('slide')
  })

  it('丢弃没有 canvas 的场景，而不是把畸形数据交给渲染器', () => {
    const scenes = normalizeCloudScenes([
      { id: 'ok', title: '好', order: 0, content: { type: 'slide', canvas: canvas('x') } },
      { id: 'no-canvas', title: '缺 canvas', order: 1, content: { type: 'slide' } },
      { id: 'empty', title: '空', order: 2 },
    ] as never)
    expect(scenes.map(item => item.id)).toEqual(['ok'])
  })

  it('缺失 id/title/order 时用兜底值补齐，不因单个字段缺失丢弃整页', () => {
    const scenes = normalizeCloudScenes([
      { content: { type: 'slide', canvas: canvas('无 id') } },
    ] as never)
    expect(scenes).toHaveLength(1)
    expect(scenes[0]!.id).toBe('scene-1')
    expect(scenes[0]!.title).toBe('')
    expect(scenes[0]!.order).toBe(0)
  })

  it('云端返回空数组时得到空结果（由 validate 负责报错）', () => {
    expect(normalizeCloudScenes([])).toEqual([])
  })

  it('认得上游的两种画布形态（嵌套 canvas 与内联画布）', () => {
    // 形态一来自上游测试夹具 tests/import/server-backed-import.test.ts:
    //   scenes: [{ title: 'Slide', order: 0, content: { type: 'slide', canvas: slide } }]
    // 形态二见于 tests/generation/scene-api-retry-boundary.test.ts:
    //   content: { elements: [], remark: 'ok' }   —— 画布字段被内联
    const scenes = normalizeCloudScenes([
      { id: 'nested', title: '嵌套', order: 0, content: { type: 'slide', canvas: canvas('嵌套画布') } },
      { id: 'inline', title: '内联', order: 1, content: { elements: [{ type: 'text', content: '<p>内联画布</p>' }], remark: 'ok' } },
    ] as never)
    expect(scenes.map(item => item.id)).toEqual(['nested', 'inline'])
    expect(scenes[1]!.content.canvas).toMatchObject({ elements: expect.any(Array) })
  })
})

describe('validateSlideArtifact', () => {
  const artifact = (overrides: Partial<SlideArtifact> = {}): SlideArtifact => ({
    chapter: '第一章',
    classroomId: 'cls_1',
    sourceIds: ['s1'],
    scenes: normalizeCloudScenes([scene('s1', '一', 0, '内容')]),
    ...overrides,
  })

  it('正常产物通过校验', () => {
    expect(() => validateSlideArtifact(artifact(), [source('s1')])).not.toThrow()
  })

  it('没有可渲染页时报出明确原因', () => {
    expect(() => validateSlideArtifact(artifact({ scenes: [] }), [source('s1')]))
      .toThrowError('云端未返回任何可渲染的幻灯片页')
  })

  it('记录了不属于本批的来源时报错（防止跨批串味）', () => {
    expect(() => validateSlideArtifact(artifact({ sourceIds: ['other'] }), [source('s1')]))
      .toThrowError('幻灯片记录了未提供的来源')
  })
})

describe('slideArtifactMarkdown', () => {
  it('把画布文本提取为可读的 Markdown（无渲染器时的降级路径）', () => {
    const artifact: SlideArtifact = {
      chapter: '第一章',
      classroomId: 'cls_1',
      sourceIds: ['s1'],
      scenes: normalizeCloudScenes([
        scene('s1', '第一节', 0, '勾股定理'),
        scene('s2', '第二节', 1, '逆定理'),
      ]),
    }
    const markdown = slideArtifactMarkdown(artifact)
    expect(markdown).toContain('# 第一章')
    expect(markdown).toContain('## 第一节')
    expect(markdown).toContain('- 勾股定理')
    expect(markdown).toContain('## 第二节')
    // 不应残留 HTML 标签
    expect(markdown).not.toContain('<p>')
  })
})

describe('slideFailureMessage', () => {
  it('带上章节名与原因，便于在 failures 里定位', () => {
    expect(slideFailureMessage('第三章', new Error('云端返回 401：拒绝访问')))
      .toBe('第三章（幻灯片）：云端返回 401：拒绝访问')
  })

  it('非 Error 值也能转成可读信息', () => {
    expect(slideFailureMessage('第一章', '字符串错误')).toBe('第一章（幻灯片）：字符串错误')
  })
})
