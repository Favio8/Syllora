/**
 * 资料解析：上传的资料统一由 DocMind 解析（PDF/Word/PPT/Excel/HTML/纯文本），
 * 拿不到的才本地回退（离线可用、纯文本被云端拒绝时）。
 *
 * 输出刻意与「按页文本」老契约兼容：
 *   `pages: [{ num, text }]` —— PDF 走这条，`pdfPageIssues` 的物理页码核对与「第 N 页」锚点全部不变；
 *   `markdown`             —— 非分页格式（Word/PPT/Excel/HTML/纯文本）走这条，交给 structuredSources 按标题切片。
 *
 * 页码只信 DocMind 的 `layouts[].pageNum`：聚合不出真实页码时**不编造**，降级成整份 markdown
 * 并把原因写进 `pageNumbersUnavailable`，由资料提示如实展示。
 *
 * 解析产物里的图片会从 DocMind 的 OSS 预签名地址（24 小时过期）下载成本地字节，
 * 由调用方写进该资料的产物目录——markdown 里不留任何会失效的链接。
 */
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { type DocMindLayoutBlock, type DocMindLayouts, type DocMindParseStatus } from './docmind.ts'
import { extractOutline } from './syllora-outline.ts'
import { isPlainTextMaterial } from './syllora-files.ts'

const CRLF = /\r\n/g

export interface ExtractInput {
  /** 资料在磁盘上的路径（DocMind 客户端按文件流式提交）。 */
  path: string
  /** 展示用文件名（相对课程根，如 `sources/第一章.pdf`）。 */
  name: string
  /** 已读入的字节（本地回退与指纹校验用）。 */
  bytes: Uint8Array
  /** 解析阶段消息（提交 / 解析中 x% / 取回），写进作业进度。 */
  onPhase?: (message: string) => void | Promise<void>
}

export interface ExtractResult {
  /** 分页文本：PDF（以及任何 DocMind 给出真实页码的格式）。 */
  pages?: Array<{ text: string; num: number }>
  total?: number
  /** 整份 markdown：非分页格式的正文来源；分页格式也保留一份用于阅读页的版式视图。 */
  markdown?: string
  /** 给不出物理页码的原因（资料提示里如实说明，不静默降级）。 */
  pageNumbersUnavailable?: string | null
  /** 本地化的图片（文件名 → 字节，调用方写进产物目录）。 */
  images?: Array<{ name: string; data: Uint8Array }>
  /** 实际使用的引擎：docmind 或 local。 */
  engine: 'docmind' | 'local'
  /** DocMind 作业号（排障用，落进资料元信息）。 */
  jobId?: string
  /** DocMind 自报的页数估计（分页聚合失败时的参考值）。 */
  pageCountEstimate?: number
  /** 页码 → 该页所处章节标题（分页资料来源的 section 用它）。 */
  pageSections?: Record<number, string>
}

export interface DocMindLike {
  parse(options: { filePath: string; pageIndex?: string }, poll?: { onStatus?: (status: DocMindParseStatus) => void; signal?: AbortSignal; timeoutMs?: number }): Promise<{ markdown: string; layouts: DocMindLayouts | null; status: DocMindParseStatus; jobId: string }>
}

/** DocMind 返回的图片域名（预签名地址，24 小时过期，必须本地化）。 */
export const DOCMIND_IMAGE_HOST = 'docmind-api-cn-hangzhou.oss-cn-hangzhou.aliyuncs.com'

/** 单张图片上限：整本教材的插图逐个下载并按内容去重。 */
const IMAGE_MAX_BYTES = 32 * 1024 * 1024

/**
 * 把 DocMind 的版式块按物理页码聚合成「第 N 页」文本，并记下每页所属章节。
 * 只接受正整数页码；一页都没聚合出来时返回 null（由调用方降级，绝不编页码）。
 */
export function pagesFromLayouts(layouts: DocMindLayouts | null | undefined): { pages: Array<{ text: string; num: number }>; total: number; pageSections: Record<number, string> } | null {
  const blocks = [...(layouts?.blocks ?? []), ...(layouts && !layouts.blocks?.length ? layouts.layouts ?? [] : [])]
  const byPage = new Map<number, string[]>()
  const pageSections: Record<number, string> = {}
  let currentSection = ''
  for (const block of blocks as DocMindLayoutBlock[]) {
    const page = typeof block?.pageNum === 'number' && Number.isInteger(block.pageNum) && block.pageNum > 0 ? block.pageNum : null
    if (page === null) continue
    const raw = (typeof block.text === 'string' && block.text.trim() !== '' ? block.text : typeof block.markdownContent === 'string' ? block.markdownContent : '').replace(CRLF, '\n')
    const title = headingTitle(block, raw)
    if (title !== null) currentSection = title
    // 章节归属：该页先出现标题就用标题，否则沿用上一页的章节（正文页归属到所在章节）。
    if (pageSections[page] === undefined && (title !== null || currentSection !== '')) pageSections[page] = title ?? currentSection
    if (raw.trim() === '') continue
    const bucket = byPage.get(page)
    if (bucket) bucket.push(raw.trim())
    else byPage.set(page, [raw.trim()])
  }
  if (byPage.size === 0) return null
  const total = Math.max(...byPage.keys())
  const pages = [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([num, texts]) => ({ num, text: texts.join('\n\n') }))
  return { pages, total, pageSections }
}

/** 标题块识别：markdown 标题行或版式块类型；拿不准就算普通块（不硬编章节名）。 */
function headingTitle(block: DocMindLayoutBlock, raw: string): string | null {
  const markdownHeading = /^(#{1,6})\s+(.+?)\s*$/.exec(raw.trim())
  if (markdownHeading) return markdownHeading[2]!.slice(0, 80)
  const type = typeof block.type === 'string' ? block.type.toLowerCase() : ''
  if (['title', 'heading', 'section_title', 'heading1', 'heading2', 'heading3'].includes(type)) {
    const text = raw.trim().split('\n')[0]?.trim() ?? ''
    return text === '' ? null : text.slice(0, 80)
  }
  return null
}

/** 只抓 DocMind 自己域名下的图（预签名 URL 24 小时过期），按内容哈希去重命名。 */
export async function localizeDocMindImages(markdown: string, fetchImage: (url: string) => Promise<Uint8Array>): Promise<{ markdown: string; images: Array<{ name: string; data: Uint8Array }> }> {
  const pattern = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g
  const images: Array<{ name: string; data: Uint8Array }> = []
  const replacements: Array<{ from: string; to: string }> = []
  const seen = new Map<string, string>()
  for (const match of markdown.matchAll(pattern)) {
    const url = match[2]!
    let host = ''
    try { host = new URL(url).host } catch { continue }
    if (host !== DOCMIND_IMAGE_HOST) continue
    let local = seen.get(url)
    if (local === undefined) {
      try {
        const data = await fetchImage(url)
        const file = imageName(url, data)
        local = `images/${file}`
        seen.set(url, local)
        if (!images.some(image => image.name === file)) images.push({ name: file, data })
      } catch {
        // 单张图下载失败保留原链接（24 小时后失效），不能让整份资料解析失败。
        continue
      }
    }
    replacements.push({ from: `](${url})`, to: `](${local})` })
  }
  let localized = markdown
  for (const item of replacements) localized = localized.replace(item.from, item.to)
  return { markdown: localized, images }
}

function imageName(url: string, data: Uint8Array): string {
  const raw = extname(new URL(url).pathname).toLowerCase()
  const ext = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(raw) ? raw : '.png'
  return `img-${createHash('sha256').update(data).digest('hex').slice(0, 12)}${ext}`
}

export interface DocMindExtractOptions {
  client: DocMindLike
  pageIndex?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** 图片抓取（测试可注入）；默认走全局 fetch。 */
  fetchImage?: (url: string) => Promise<Uint8Array>
}

/** DocMind 解析一份资料：分页文本优先，markdown 与章节大纲始终尝试取回。 */
export async function docMindExtract(input: ExtractInput & DocMindExtractOptions): Promise<ExtractResult> {
  const phase = async (message: string) => { await input.onPhase?.(message) }
  await phase('提交 DocMind 解析')
  const parsed = await input.client.parse({ filePath: input.path, ...(input.pageIndex ? { pageIndex: input.pageIndex } : {}) }, {
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    onStatus: status => { void phase(`DocMind 解析中${typeof status.progress === 'number' ? ` ${status.progress}%` : ''}`) },
  })
  await phase('取回解析结果')
  const paged = pagesFromLayouts(parsed.layouts)
  const fetched = await localizeDocMindImages(parsed.markdown, input.fetchImage ?? defaultFetchImage)
  const result: ExtractResult = {
    engine: 'docmind',
    jobId: parsed.jobId,
    markdown: fetched.markdown,
    ...(fetched.images.length ? { images: fetched.images } : {}),
    ...(typeof parsed.status.pageCountEstimate === 'number' ? { pageCountEstimate: parsed.status.pageCountEstimate } : {}),
  }
  if (paged) return { ...result, pages: paged.pages, total: paged.total, ...(Object.keys(paged.pageSections).length ? { pageSections: paged.pageSections } : {}) }
  // 分页聚合失败：给出可读原因而不是假装成单页文档。
  const outline = extractOutline(fetched.markdown).nodes
  const fallbackTotal = typeof parsed.status.pageCountEstimate === 'number' && parsed.status.pageCountEstimate > 0 ? parsed.status.pageCountEstimate : Math.max(1, outline.length)
  return { ...result, pageNumbersUnavailable: '云端未返回逐页版式，本份资料按章节定位（无物理页码）', total: fallbackTotal }
}

async function defaultFetchImage(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`)
  const buffer = new Uint8Array(await response.arrayBuffer())
  if (buffer.length > IMAGE_MAX_BYTES) throw new Error('图片超过 32 MiB 上限')
  return buffer
}

/**
 * 本地回退：PDF 交给注入的解析器；纯文本直读；其它格式交给可选的 markdown 提取器
 * （由 bin.ts 注入 course-builder 的 extractTextToMarkdown）。都没有就明确报错。
 */
export async function localExtract(input: ExtractInput & {
  pdf?: (data: Uint8Array) => Promise<{ pages: Array<{ text: string; num: number }>; total: number }>
  /** 其它文档格式的本地提取器（course-builder 的 extractTextToMarkdown，按路径读）。 */
  document?: (path: string, fileName: string) => Promise<string>
  reason?: string
}): Promise<ExtractResult> {
  await input.onPhase?.(`本地解析${input.reason ? `（${input.reason}）` : ''}`)
  const ext = extname(input.name).toLowerCase()
  if (ext === '.pdf') {
    if (!input.pdf) throw new Error('PDF 解析器不可用')
    const result = await input.pdf(input.bytes)
    return { engine: 'local', pages: result.pages, total: result.total }
  }
  if (isPlainTextMaterial(input.name)) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes).replace(CRLF, '\n')
    return { engine: 'local', markdown: text, total: 1 }
  }
  if (input.document) {
    const markdown = await input.document(input.path, input.name)
    return { engine: 'local', markdown, total: 1, pageNumbersUnavailable: '本地解析无物理页码' }
  }
  throw new Error('这份格式需要 DocMind 解析；请在设置中配置 DocMind 后重试')
}

/** 解析产物的 markdown 标题大纲（阅读页章节导航）；无标题时为空数组。 */
export function documentOutline(markdown: string): Array<{ title: string; level: number; anchor: string }> {
  return extractOutline(markdown).nodes.map(node => ({ title: node.title, level: node.level, anchor: node.anchor }))
}