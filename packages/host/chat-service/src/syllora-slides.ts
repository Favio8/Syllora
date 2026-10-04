/**
 * 幻灯片讲义：把云端 OpenMAIC 生成的场景归一化成 Syllora 的幻灯片结构。
 *
 * 职责边界（重做后）：
 * - **云端负责生成**：调用 OpenMAIC 的 `/api/generate-classroom`，它返回的是成品场景，
 *   其中的 canvas 已由 OpenMAIC 自己校验入库，Syllora 不重复校验 canvas 内部结构。
 * - **本模块负责校验与归一化**：只校验 Syllora 自己依赖的字段（id/title/order/canvas 存在性），
 *   产出渲染器可直接使用的结构，并记录「这一章用了哪些 Syllora 来源」。
 * - **渲染仍在本机**：canvas 交给 `@openmaic/renderer`。渲染很轻，没必要上云。
 *
 * 关于引用的重要变化：云端**不返回** Syllora 的 sourceIds，因此原先"每页引用可回溯到原文"
 * 无法逐页维持。改为**章节级溯源**：每份幻灯片记录本次生成上传了哪些 Syllora 来源，
 * 保证「这份幻灯片基于哪些资料生成」可追溯，但不声称逐页对应。
 */
import { z } from 'zod'
import type { Source } from './syllora-domain.ts'
import type { CloudScene } from './syllora-cloud.ts'

/** 一页幻灯片。canvas 是不透明数据，原样交给渲染器。 */
export const slideSceneSchema = z.object({
  id: z.string().trim().min(1).max(200),
  title: z.string().trim().max(200).default(''),
  order: z.number().int().min(0).default(0),
}).passthrough()

/** 一份章节幻灯片 = 云端一个课堂（Stage）的归一化结果。 */
export const slideDeckSchema = z.object({
  chapter: z.string().trim().min(1).max(120),
  scenes: z.array(slideSceneSchema).min(1),
}).passthrough()

export type SlideScene = z.infer<typeof slideSceneSchema>
export type SlideDeck = z.infer<typeof slideDeckSchema>

/** Syllora 侧持久化的幻灯片产物：除场景外还记录来源与云端标识，便于追溯与重取。 */
export interface SlideArtifact {
  /** 章节名，与讲义同粒度。 */
  chapter: string
  /** 云端课堂 id，可用于重新取回或排查。 */
  classroomId: string
  /** 本次生成上传的 Syllora 来源 id（章节级溯源）。 */
  sourceIds: string[]
  /** 归一化后的场景（只含可渲染的幻灯片页）。 */
  scenes: Array<SlideScene & { content: { type: string; canvas: unknown } }>
  /**
   * 云端课堂的场景总数，以及其中有多少不是幻灯片页。
   *
   * 实测：一次 8 页的课堂里有 2 页分别是 `interactive`（交互模拟）与 `quiz`（测验），
   * 它们没有 canvas，幻灯片渲染器无法呈现。丢弃是正确行为，但**静默丢弃**会让人以为
   * 生成漏了内容，因此把数量记下来，由界面如实说明。
   */
  cloudSceneCount?: number
  skippedNonSlideCount?: number
}

/**
 * 从场景里取出可渲染的画布。
 *
 * 上游存在两种形态（都在其自身代码里出现过）：
 * - `content: { type: 'slide', canvas: {...} }` —— DSL 的 `SlideContent`，主形态
 *   （见 packages/@openmaic/dsl/src/stage.ts 的 `canvas: Slide`）
 * - `content: { elements: [...], remark }` —— 画布字段被内联，没有 canvas 包一层
 *
 * 两种都要认，否则第二种会被整页丢掉。都取不到才返回 null。
 */
function readCanvas(content: unknown): unknown | null {
  if (!content || typeof content !== 'object') return null
  const record = content as Record<string, unknown>
  const nested = record.canvas
  if (nested && typeof nested === 'object') return nested
  // 内联形态：content 自身就是画布
  if (Array.isArray(record.elements)) return content
  return null
}

/**
 * 把云端场景归一化成一节的场景。
 *
 * 云端形态随版本演进，因此这里做保守映射：认不出画布的场景直接丢弃，
 * 而不是让一份畸形数据把整个渲染器打挂。**丢弃的数量会被报出来**——
 * 实测云端会把交互模拟与测验也放进同一个课堂，它们本来就无法用幻灯片呈现，
 * 静默少页会让人误以为生成失败。
 */
export function normalizeCloudScenes(scenes: CloudScene[]): {
  scenes: SlideArtifact['scenes']
  cloudSceneCount: number
  skippedNonSlideCount: number
} {
  const out: SlideArtifact['scenes'] = []
  scenes.forEach((scene, index) => {
    const canvas = readCanvas(scene.content)
    if (!canvas) return
    const id = typeof scene.id === 'string' && scene.id ? scene.id : `scene-${index + 1}`
    const title = typeof scene.title === 'string' ? scene.title : ''
    const order = typeof scene.order === 'number' && Number.isFinite(scene.order) ? scene.order : index
    const parsed = slideSceneSchema.safeParse({ id, title, order })
    if (!parsed.success) return
    out.push({
      id: parsed.data.id,
      title: parsed.data.title,
      order: parsed.data.order,
      content: { type: typeof scene.content?.type === 'string' ? scene.content.type : 'slide', canvas },
    })
  })
  out.sort((a, b) => a.order - b.order)
  return { scenes: out, cloudSceneCount: scenes.length, skippedNonSlideCount: scenes.length - out.length }
}

/**
 * 校验一份归一化产物是否可用。
 * 只断言 Syllora 自己依赖的东西：有章节名、有至少一页可渲染内容、来源合法。
 */
export function validateSlideArtifact(artifact: SlideArtifact, sources: Source[]) {
  if (artifact.scenes.length === 0) throw new Error('云端未返回任何可渲染的幻灯片页')
  const supported = new Set(sources.map(source => source.id))
  for (const id of artifact.sourceIds) if (!supported.has(id)) throw new Error('幻灯片记录了未提供的来源')
}

/** 纯文本阅读 / 无渲染器时的降级视图：从 canvas 元素里提取文字。 */
export function slideArtifactMarkdown(artifact: SlideArtifact) {
  return `# ${artifact.chapter}\n\n` + artifact.scenes.map(scene => {
    const elements = (scene.content.canvas as { elements?: unknown[] } | null)?.elements ?? []
    const lines = elements.map(element => {
      const content = (element as { content?: unknown }).content
      if (typeof content !== 'string') return null
      const plain = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
      return plain ? `- ${plain}` : null
    }).filter((line): line is string => line !== null)
    return `## ${scene.title || scene.id}\n\n${lines.join('\n')}`
  }).join('\n\n') + '\n'
}

/** 幻灯片是附加产物：失败只记录，不让整次整理失败。 */
export function slideFailureMessage(chapter: string, error: unknown) {
  return `${chapter}（幻灯片）：${error instanceof Error ? error.message : String(error)}`
}
