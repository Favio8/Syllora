/**
 * 电子书目录骨架（��盖章决策④：目录骨架 = 文档自带结构）。
 *
 * 从精炼后 markdown 的标题层级（# ~ ######）离线提取目录，作为：
 *  - 阅读模块的章节下拉（��
 *  - 大纲模块的红/绿/黄学习状态挂点（��
 *  - 多文件拟序（��与图谱章节-节点联动（��的输入。
 * AI 只做「校验/纠序」，不重造结构（含同级序号缺失检测，供 AI 纠序参考）。
 */

export interface EbookOutlineNode {
  level: number
  title: string
  /** GitHub 风格锚点（去标点、空格→-、小写）；重复标题自动加 -1/-2 后缀。 */
  anchor: string
  /** 在 markdown 中的行号（1 起，用于阅读定位）。 */
  line: number
}

export interface EbookOutline {
  nodes: EbookOutlineNode[]
  /** 序号断裂（如 1 → 3 跳号、同级重复号）：供 AI 纠序阶段提示。 */
  anomalies: Array<{ line: number; title: string; hint: string }>
}

/** 只当作标题的最长行；# 号后必须跟空格（避免把 `#tag` 当标题）。 */
const HEADING = /^(#{1,6})\s+(.+?)\s*$/

/**
 * OCR 垃圾标题判定（��：纯数字串（DocMind 页脚/书眉如「111111」「12」）、
 * 纯符号装饰（「!!!!」「———」）、纯空白标题。垃圾标题不进目录、记入 anomalies。
 */
export function isGarbageTitle(title: string): boolean {
  const trimmed = title.trim()
  if (trimmed === '') return true
  if (/^\d{3,}$/.test(trimmed)) return true
  if (/^[^\p{L}\p{N}]$/u.test(trimmed) && trimmed.length >= 3) return true
  return false
}

function slugify(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'section'
}

/** 行内序号探测：「1.2」「3.14」「2.1.1」（标题序号杂贴中文时不需要尾分隔符）；
 *  只截取 1~3 段数字用于同深度比较，标题文本保持完整，探测语义宽容。 */
function ordinalDigits(title: string): number[] | null {
  const m = /^(\d{1,3})(?:\.(\d{1,3}))?(?:\.(\d{1,3}))?/.exec(title)
  if (m === null || /^\d{4,}/.test(title)) return null
  const digits = [Number(m[1])]
  if (m[2] !== undefined) digits.push(Number(m[2]))
  if (m[3] !== undefined) digits.push(Number(m[3]))
  return digits
}

export function extractOutline(markdown: string): EbookOutline {
  const nodes: EbookOutlineNode[] = []
  const anchors = new Map<string, number>()
  const anomalies: EbookOutline['anomalies'] = []

  const lines = markdown.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const match = HEADING.exec(lines[i]!)
    if (match === null) continue
    const level = match[1]!.length
    const title = match[2]!.trim()
    if (title === '') continue
    if (isGarbageTitle(title)) {
      anomalies.push({ line: i + 1, title, hint: '疑似 OCR 垃圾标题（页脚/书眉/装饰），已从目录剔除' })
      continue
    }

    let anchor = slugify(title)
    const seen = anchors.get(anchor) ?? 0
    anchors.set(anchor, seen + 1)
    if (seen > 0) anchor = `${anchor}-${seen}`
    nodes.push({ level, title, anchor, line: i + 1 })
  }

  // 同级序号断裂探测：DocMind 常把全文档标题拍平成同一 markdown 层级，故按
// 「同深度 + 同父前缀 + 末段跳号 >1」判异常（1.1 → 1.1.1 是正常进入小节）。
// 标题层级发生变化（h2→h3）时重置，避免跨层级误报。
  let previous: number[] | null = null
  let prevLevel = 0
  for (const node of nodes) {
    const digits = ordinalDigits(node.title)
    if (digits === null || prevLevel !== node.level) {
      previous = digits
      prevLevel = node.level
      continue
    }
    if (
      previous !== null &&
      digits.length === previous.length &&
      digits.length > 1 &&
      digits[0] === previous[0] &&
      digits.slice(0, -1).join('.') === previous.slice(0, -1).join('.') &&
      digits[digits.length - 1]! !== previous[previous.length - 1]! + 1
    ) {
      anomalies.push({ line: node.line, title: node.title, hint: `同级序号从 ${previous.join('.')} 跳到 ${digits.join('.')}` })
    }
    previous = digits
  }

  return { nodes, anomalies }
}