/**
 * 幻灯片讲义：在 Markdown 讲义之外，按章节产出结构化幻灯片。
 *
 * 结构遵循 `@openmaic/dsl` 的 `Stage` / `Scene` 契约（`Scene.type==='slide'` 时 payload 是
 * `{ type:'slide', canvas: Slide }`），因此既可以用 `@openmaic/renderer` 的 `SlideCanvas`
 * 渲染，也能通过 DSL 的 `validateScene` 与 PPTX 导出链路复用。
 *
 * 本模块只做三件事：约束模型输出（zod）、校验引用与覆盖（与讲义同一套规则）、以及
 * 把幻灯片降级成 Markdown（导出与无渲染器时的兜底）。
 */
import { z } from 'zod'
import type { Source } from './syllora-domain.ts'

/** 画布里允许的元素类型：只收渲染器确实支持的子集，避免模型产出无法渲染的东西。 */
const ELEMENT_TYPES = ['text', 'image', 'shape', 'line', 'chart', 'table', 'video', 'audio', 'latex'] as const

const baseElement = {
  id: z.string().trim().min(1).max(80),
  left: z.number().finite(),
  top: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  rotate: z.number().finite().default(0),
}

/**
 * 元素用 `catchall` 放行未知字段：DSL 的元素类型很多，而这里只需要保证"能被渲染器接受的
 * 骨架"。宽松放行的代价由 `validateScene` 兜底——它是契约自己的校验器，比我们手写的更准。
 */
const slideElement = z.object({ type: z.enum(ELEMENT_TYPES), ...baseElement }).catchall(z.unknown())

/** 与 DSL 的 `Slide` 对齐的最小画布；`viewportSize`/`viewportRatio` 决定渲染比例。 */
const slideCanvas = z.object({
  id: z.string().trim().min(1).max(80),
  viewportSize: z.number().finite().positive(),
  viewportRatio: z.number().finite().positive(),
  theme: z.object({
    backgroundColor: z.string().trim().min(1),
    themeColors: z.array(z.string().trim().min(1)).min(1),
    fontColor: z.string().trim().min(1),
    fontName: z.string().trim().min(1),
  }),
  elements: z.array(slideElement),
})

/**
 * 一页幻灯片。`citations` 是本项目加的字段（DSL 用 `catchall`/额外属性放行）：每页必须声明
 * 它依据哪些来源片段，这样幻灯片与讲义共享同一套"引用可回溯"的保证。
 */
export const slideSceneSchema = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(80),
  order: z.number().int().min(0),
  citations: z.array(z.string().trim().min(1)).min(1),
  content: z.object({ type: z.literal('slide'), canvas: slideCanvas }),
})

export const slideDeckSchema = z.object({
  chapter: z.string().trim().min(1).max(60),
  scenes: z.array(slideSceneSchema).min(1).max(12),
})

export type SlideScene = z.infer<typeof slideSceneSchema>
export type SlideDeck = z.infer<typeof slideDeckSchema>

/**
 * 与 `validateLecture` 同一套规则：
 * - 引用的来源必须属于本批（防止跨批或编造 id）；
 * - 本批每个来源至少被一页引用（保证覆盖，不挑好写的讲）。
 * 单页 citation 为空、order 重复等结构问题由 schema 挡住。
 */
export function validateSlideDeck(deck: SlideDeck, sources: Source[]) {
  const supported = new Set(sources.map(source => source.id)), used = new Set<string>()
  for (const scene of deck.scenes) for (const id of scene.citations) {
    if (!supported.has(id)) throw new Error('幻灯片引用了未提供的来源')
    used.add(id)
  }
  if (sources.some(source => !used.has(source.id))) throw new Error('本批资料没有完整关联到幻灯片，请重试')
}

/** 无渲染器 / 导出 / 纯文本阅读时使用：把幻灯片降级成 Markdown。 */
export function slideDeckMarkdown(deck: SlideDeck) {
  const cite = (ids: string[]) => `\n\n来源：${ids.join('、')}`
  return `# ${deck.chapter}\n\n` + [...deck.scenes]
    .sort((a, b) => a.order - b.order)
    .map(scene => {
      const lines = scene.content.canvas.elements.map(element => {
        const text = (element as { content?: unknown }).content
        if (typeof text !== 'string') return null
        // 画布里的正文是 HTML 片段；Markdown 视图去掉标签，保留可读文本。
        const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
        return plain ? `- ${plain}` : null
      }).filter((line): line is string => line !== null)
      return `## ${scene.title}\n\n${lines.join('\n')}${cite(scene.citations)}`
    })
    .join('\n\n') + '\n'
}

/** 幻灯片相对讲义是"锦上添花"：它失败时只记录失败，不能让整次整理失败。 */
export function slideFailureMessage(chapter: string, error: unknown) {
  return `${chapter}（幻灯片）：${error instanceof Error ? error.message : String(error)}`
}
