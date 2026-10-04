/**
 * 电子书精炼（+3；决策：默认只跑免费规则清洗，
 * 公式修复为模型增强/开关默认关，章节精修留到拟序链路）。
 *
 * 输入：DocMind 本地化后的 markdown（含 images/ 相对引用）。
 * 输出：规则清洗后的 markdown + 各项修正计数（写 refined.md + refined-fixes.json）。
 * 所有规则必须可逆、保守——宁可少改，不改坏正文/公式/表格。
 */

export interface EbookRefineFix {
  /** 规则名（稳定小写短横线，供前端/调试聚合）。 */
  rule: string
  /** 命中处数。 */
  count: number
}

export interface EbookRefineResult {
  markdown: string
  fixes: EbookRefineFix[]
}

/** 逐行处理类规则：返回 {text, hits}。 */
function applyLineRule(
  text: string,
  predicate: (line: string) => string | null,
): { text: string; hits: number } {
  let hits = 0
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const fixed = predicate(lines[i]!)
    if (fixed !== null) {
      lines[i] = fixed
      hits++
    }
  }
  return { text: lines.join('\n'), hits }
}

export function refineMarkdown(
  markdown: string,
  options: { formula?: boolean } = {},
): EbookRefineResult {
  const fixes: EbookRefineFix[] = []
  let text = markdown

  // 1) 编码/换行归一：CRLF→LF、BOM、行尾空白（DocMind 产物常见 \r\n 与行尾空格）。
  text = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
  const trailing = applyLineRule(text, line => (/[ \t]+$/.test(line) ? line.replace(/[ \t]+$/, '') : null))
  text = trailing.text
  if (trailing.hits > 0) fixes.push({ rule: 'strip-trailing-ws', count: trailing.hits })

  // 2) 空行收敛：markdown 渲染只认单空行分段，压缩 3+ 连空行为 1 空行。
  const blankBefore = (text.match(/\n{3,}/g) ?? []).length
  if (blankBefore > 0) {
    text = text.replace(/\n{3,}/g, '\n\n')
    fixes.push({ rule: 'collapse-blank-lines', count: blankBefore })
  }

  // 3) 引用块缺空格：`>正文` → `> 正文`（DocMind 偶发吞掉引用符后的空格）。
  const quote = applyLineRule(text, line => (/^>(?=[^\s>])/.test(line) ? line.replace(/^>/, '> ') : null))
  text = quote.text
  if (quote.hits > 0) fixes.push({ rule: 'blockquote-space', count: quote.hits })

  // 4) 列表符号后补空格：`-项`/`*项`/`1.项`（DocMind 偶发，只改无空格粘连）。
  // 保守策略：星号行内另有 `*`（强调/粗体/分隔线）时不当作列表符；
  // 数字标号后直接跟数字（如行首小数 `1.5倍`）时不补空格。
  const list = applyLineRule(text, line => {
    const matched = /^(\s*)([-*+]|\d{1,3}[.)])(?=\S)/.exec(line)
    if (matched === null) return null
    const marker = matched[2]!
    const rest = line.slice(matched[1]!.length + marker.length)
    if (marker === '*' && (rest.includes('*') || /^\*/.test(rest))) return null
    if (/^\d+\./.test(marker) && /^\d/.test(rest)) return null
    return line.slice(0, matched[1]!.length + marker.length) + ' ' + rest
  })
  text = list.text
  if (list.hits > 0) fixes.push({ rule: 'list-marker-space', count: list.hits })

  // 5) DocMind 逐字斜杠乱码：标题被渲染成「高/等/学/校」——连续 ≥3 段的
  // 「汉字/汉字」粘连是渲染乱码，合并回原文；单向「和/或」不受影响。
  {
    const slashBefore = (text.match(/\p{Script=Han}(?:\/\p{Script=Han}){2,}/gu) ?? []).length
    if (slashBefore > 0) {
      let slashHits = 0
      text = text.replace(/\p{Script=Han}(?:\/\p{Script=Han}){2,}/gu, (run) => {
        const parts = run.split('/')
        if (parts.length < 3) return run
        slashHits += parts.length - 1
        return parts.join('')
      })
      if (slashHits > 0) fixes.push({ rule: 'cjk-slash-corruption', count: slashHits })
    }
  }

  // 6) 数学公式修复（决策  默认关；开关打开时只做无损的空白/换行收敛，
  // 不重排语义——重排属于模型增强阶段）。
  if (options.formula === true) {
    const inlineBefore = (text.match(/\$\s+\$/g) ?? []).length
    if (inlineBefore > 0) {
      text = text.replace(/\$\s+\$/g, '$$')
      fixes.push({ rule: 'formula-whitespace', count: inlineBefore })
    }
    // $$ 块内首尾多余换行（渲染时会产生空行）。
    let blockHits = 0
    text = text.replace(/\$\$\n{2,}([^$]*?)\n{2,}\$\$/gs, (_match, body: string) => {
      blockHits++
      return `$$\n${body}\n$$`
    })
    if (blockHits > 0) fixes.push({ rule: 'formula-block-blank', count: blockHits })
  }

  return { markdown: text, fixes }
}