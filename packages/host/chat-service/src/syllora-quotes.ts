import type { Source } from './syllora-domain.ts'

/**
 * 引文相关的共用工具：初始化整理与「精加工」都用这一份。
 *
 * 背景：模型写「原文依据」时会自己改写、张冠李戴（把受控源的原文挂在独立电源下面），
 * 或者干脆编一句。所以**引文不交给模型写**——由这里从资料里挑出逐字命中的原句。
 */

/** 引用比对归一化：导出文本常带 HTML 标签与 Markdown 强调残留，模型引用时按纯文本摘录。 */
export function normalizeQuoteText(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 在本批资料里找与给定文本最贴近的原文句子（用于把转述接地成原文逐字句）。 */
export function groundQuote(quote: string, sources: Source[]): { id: string; text: string } | null {
  const wanted = normalizeQuoteText(quote), grams = new Set<string>()
  if (wanted.length < 6) return null
  for (let i = 0; i + 1 < wanted.length && grams.size < 240; i++) grams.add(wanted.slice(i, i + 2))
  let best: { id: string; text: string; score: number } | null = null
  for (const source of sources) {
    const text = source.text.slice(0, 4000)
    if (!text.trim()) continue
    const haystack = normalizeQuoteText(text)
    let hits = 0
    for (const gram of grams) if (haystack.includes(gram)) hits++
    const score = hits / grams.size
    if (score >= 0.5 && score > (best?.score ?? 0)) best = { id: source.id, text, score }
  }
  if (best === null) return null
  const sentences = best.text.split(/(?<=[。！？；])|\n+/).map(s => s.trim()).filter(s => s.length >= 8)
  let pick: { text: string; hits: number } | null = null
  for (const sentence of sentences) {
    const hay = normalizeQuoteText(sentence)
    let hits = 0
    for (const gram of grams) if (hay.includes(gram)) hits++
    if (hits > (pick?.hits ?? 0)) pick = { text: sentence, hits }
  }
  return pick === null ? null : { id: best.id, text: pick.text.slice(0, 200) }
}

/** 概念的"关键片段"：取概念名里长度 ≥2 的汉字/字母数字片段，用于判断引文是否在讲这个概念。 */
function conceptKeys(name: string): string[] {
  const cleaned = normalizeQuoteText(name).replace(/[（(].*?[)）]/g, '')
  const keys: string[] = cleaned.match(/[\p{Script=Han}]{2,}|[A-Za-z]{2,}/gu) ?? []
  const fallback = cleaned.replace(/[^\p{L}\p{N}]/gu, '')
  if (keys.length === 0 && fallback.length >= 2) keys.push(fallback)
  return keys.slice(0, 4)
}

/** 标题行不足以当依据：`### **独立电源**`、`**三、受控源**` 虽然逐字出自资料，却没有任何定义内容。
 *  依据必须是实义句——规范化后至少 15 字，且不是纯标题/纯加粗的短行。 */
function substantiveQuote(text: string): boolean {
  const trimmed = text.trim()
  const flat = normalizeQuoteText(trimmed)
  if (flat.length < 15) return false
  if (/^#+\s/.test(trimmed)) return false
  if (/^\*\*[^*]{0,24}\*\*$/.test(trimmed)) return false
  return true
}

/**
 * 为一条概念挑**逐字出自资料**的依据：
 * 1) 优先在含概念名、且是实义句的原文里挑（概念与句子必须真的相关）；
 * 2) 找不到含名的实义句时，退回与解释文本最贴近的原文句（groundQuote）；
 * 3) 都找不到则返回 null —— 调用方应当**明确写"资料中未找到可逐字引用的句子"**，而不是编一条。
 */
export function supportingQuote(
  name: string,
  definition: string,
  sources: Source[],
): { id: string; text: string; anchor: string; matchedBy: 'name' | 'overlap' } | null {
  const keys = conceptKeys(name)
  // 只要求"句子里出现概念名"太弱：`如：制作一个电阻器…产生磁场` 也含"电流"，却不是在讲电流。
  // 因此打分 = 概念名命中（权重 2） + 与「概念名。定义」的二元组重合度（权重 10）。
  const wanted = normalizeQuoteText(`${name}。${definition}`)
  const grams = new Set<string>()
  for (let i = 0; i + 1 < wanted.length && grams.size < 240; i++) grams.add(wanted.slice(i, i + 2))
  const overlap = (text: string) => {
    if (grams.size === 0) return 0
    const hay = normalizeQuoteText(text)
    let hits = 0
    for (const gram of grams) if (hay.includes(gram)) hits++
    return hits / grams.size
  }
  const best = (candidates: Array<{ id: string; text: string; anchor: string }>, by: 'name' | 'overlap') => {
    let pick: { id: string; text: string; anchor: string; score: number } | null = null
    for (const candidate of candidates) {
      const hay = normalizeQuoteText(candidate.text)
      let nameHits = 0
      for (const key of keys) if (hay.includes(key)) nameHits += key.length
      const score = nameHits * 2 + overlap(candidate.text) * 10
      if (score > (pick?.score ?? 0)) pick = { ...candidate, score }
    }
    return pick === null ? null : { id: pick.id, text: pick.text, anchor: pick.anchor, matchedBy: by }
  }
  if (keys.length > 0) {
    const named: Array<{ id: string; text: string; anchor: string }> = []
    for (const source of sources) {
      if (!keys.some(key => normalizeQuoteText(source.text).includes(key))) continue
      for (const sentence of source.text.split(/(?<=[。！？；])|\n+/).map(s => s.trim())) {
        if (!substantiveQuote(sentence)) continue
        if (keys.some(key => normalizeQuoteText(sentence).includes(key))) {
          named.push({ id: source.id, text: sentence.slice(0, 200), anchor: source.anchor })
        }
        if (named.length >= 200) break
      }
      if (named.length >= 200) break
    }
    const byName = best(named, 'name')
    if (byName !== null) return byName
  }
  const grounded = groundQuote(`${name}。${definition}`, sources)
  if (grounded === null || !substantiveQuote(grounded.text)) return null
  const source = sources.find(item => item.id === grounded.id)
  return { id: grounded.id, text: grounded.text, anchor: source?.anchor ?? '', matchedBy: 'overlap' }
}

/** 审计：逐条检查「概念 → 依据」是否真的出自资料、且与概念相关。 */
export function auditQuotes(
  items: Array<{ name: string; quote: string }>,
  sources: Source[],
): Array<{ name: string; ok: boolean; reason: string; fixed?: string }> {
  return items.map(item => {
    const quote = item.quote.trim()
    if (quote === '') return { name: item.name, ok: false, reason: '空引文' }
    const verbatim = sources.some(source => source.text.includes(quote))
    const normalized = !verbatim && sources.some(source => normalizeQuoteText(source.text).includes(normalizeQuoteText(quote)))
    if (!verbatim && !normalized) {
      const grounded = groundQuote(quote, sources)
      return grounded === null
        ? { name: item.name, ok: false, reason: '资料里找不到这句（疑似编造）' }
        : { name: item.name, ok: false, reason: '不是原文逐字', fixed: grounded.text }
    }
    const keys = conceptKeys(item.name)
    if (keys.length > 0 && !keys.some(key => normalizeQuoteText(quote).includes(key))) {
      const better = supportingQuote(item.name, quote, sources)
      return better === null
        ? { name: item.name, ok: false, reason: '引文与概念不相关' }
        : { name: item.name, ok: false, reason: '引文与概念不相关（张冠李戴）', fixed: better.text }
    }
    return { name: item.name, ok: true, reason: '逐字命中且与概念相关' }
  })
}
