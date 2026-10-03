/**
 * 导出资料（PPT/PDF 转 Markdown）里残留的行内 HTML 会原样显示在讲义、引用与资料正文中，
 * 例如 `u = d<em><strong>w</strong></em>/d<em><strong>q</strong></em>` 变成一串裸标签。
 *
 * 这里在**渲染前**把行内标签剥掉、只留其中的文字（块级标签如表格保持原样，交给 Markdown 渲染器）：
 * 刻意不还原成 Markdown 强调——原文的强调标记层层嵌套，转出来是 `*****i***` 这种噪声，更不可读。
 *
 * 只做显示层剥离，不改动已入库的数据与来源定位；数据层的清洗在解析侧另有一道（parse-v6）。
 */
const BLOCK_TAG = /^(?:table|thead|tbody|tfoot|tr|td|th|caption|div|p|ul|ol|li|section|article|blockquote|br|hr|h[1-6]|pre|figure|figcaption|details|summary)$/i
export function normalizeInlineMarkup(text: string): string {
  if (!text || !text.includes('<')) return text
  return text
    .replace(/<\/?(?:span|font|small|big|mark|u|s|del|ins|sub|sup|code|abbr|cite|q|time|var|kbd|samp|strong|b|em|i)\b[^>]*>/gi, '')
    .replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (match, tag: string) => (BLOCK_TAG.test(tag) ? match : ''))
}
