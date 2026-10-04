/**
 * B11：辅助阅读正文的分段渲染。
 *
 * 后端 `structuredSources` 为每段正文带 `kind`（heading / code / table / list /
 * paragraph，见 `syllora-files.ts` 的 `blocks()`）。旧实现把所有非 heading 源
 * 统一丢给 `ReactMarkdown`，Markdown 默认把段内软换行折叠成空格，于是代码块、
 * 表格、列表、多行段落全部连成「一堵墙」——注释与代码 run-on、换行全丢（用户
 * 实测发现）。这里按 kind 分支：
 *   - heading：交给调用方渲染 `<h2>`（现状保留）；
 *   - code：原样 `<pre><code>`，保留换行与缩进，并去掉围栏行；
 *   - table：`ReactMarkdown + remarkGfm`（表格按行解析，不受软换行折叠影响）；
 *   - list / paragraph：`ReactMarkdown + remarkSoftBreaks`（软换行提升为硬换行）。
 *
 * 软换行插件不引新依赖：remark-breaks 的行为用一段 mdast 遍历即可等价实现
 * （react-markdown 10 与 React 19 均无兼容问题，但少一个包少一份维护面）。
 */

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/

/** PDF text extraction may discard Markdown fences; recognize strong code signatures only. */
export function looksLikeExtractedCode(text: string): boolean {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return false
  if (/^curl\s+(?:--|https?:)/.test(lines[0]!)) return true
  const start = /^\s*(?:\/\/|(?:export\s+)?(?:async\s+)?function\b|(?:const|let|var|import|class)\s+|return\s+\w+[.(])/.test(lines[0]!)
  const signals = lines.filter(line => /^\s*(?:\/\/|(?:const|let|var|return|await|async|function|if|for)\b|[{}][,;]?\s*$)/.test(line)).length
  return start && signals >= 3
}

/** 拆掉代码围栏行，返回语言与正文。围栏缺失时原样返回（防御性）。 */
export function splitFence(text: string): { language: string; code: string } {
  const lines = text.split(/\r?\n/)
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const match = FENCE_RE.exec(lines[0] ?? '')
  if (!match) {
    // Long code blocks are split into source chunks; a continuation may contain only the closing fence.
    if (/^\s*(?:`{3,}|~{3,})\s*$/.test(lines.at(-1) ?? '')) lines.pop()
    return { language: '', code: lines.join('\n') }
  }
  const character = match[1]![0]!
  const length = match[1]!.length
  let body = lines.slice(1)
  const closing = body[body.length - 1]
  if (closing !== undefined && closing.trim() !== '' && closing.trim().startsWith(character.repeat(length))) body = body.slice(0, -1)
  return { language: (match[2] ?? '').trim(), code: body.join('\n') }
}

type MdastNode = { type?: string; value?: string; children?: MdastNode[] }

/** 等价于 remark-breaks：把文本节点里的软换行提升为 `break` 节点。
 *  代码（块级 `code` 与行内 `inlineCode`）自行处理换行，跳过。 */
export function remarkSoftBreaks() {
  return (tree: unknown) => {
    const visit = (node: MdastNode | undefined) => {
      if (node === undefined || !Array.isArray(node.children)) return
      if (node.type === 'code' || node.type === 'inlineCode') return
      const next: MdastNode[] = []
      for (const child of node.children) {
        if (child.type === 'text' && typeof child.value === 'string' && child.value.includes('\n')) {
          child.value.split('\n').forEach((part, index) => {
            if (index > 0) next.push({ type: 'break' })
            if (part !== '') next.push({ type: 'text', value: part })
          })
          continue
        }
        next.push(child)
      }
      node.children = next
      for (const child of next) visit(child)
    }
    visit(tree as MdastNode)
  }
}
