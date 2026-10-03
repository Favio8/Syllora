/**
 * 电子书管线 · 投喂入口（。
 *
 * 上传原件落盘到 `{courseRoot}/ebook/{ebookId}/`，DocMind 整本解析后把
 * markdown / layouts / status 三件套存到 `.../docmind/`。后续里程碑
 * （章节切分 → 精炼 → 拟序）都在这三件套的基础上做，本模块不碰模型。
 *
 * 注意：与「资料库 20MiB/100 页」闸口完全分离——电子书是独立对象
 * ，大小/页数上限由调用方（syllora.ts 的 ebookIngest）把关。
 */
import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DocMindClient, DocMindError } from './docmind.ts'
import { refineMarkdown, type EbookRefineFix } from './syllora-refine.ts'
import { extractOutline } from './syllora-outline.ts'

/** 运行时 DocMind 凭据（resolveDocMindCredential 的结构兼容形态）。 */
export interface EbookDocMindCredentials {
  accessKeyId: string
  accessKeySecret: string
  endpoint: string
}

export interface EbookIngestInput {
  /** 课程文件夹（`courseRoot`），电子书内容与资料库/笔记同级存放。 */
  courseRoot: string
  ebookId: string
  fileName: string
  bytes: Uint8Array
  docmind: EbookDocMindCredentials
  /** 如 "1-15"；缺省解析全部页。 */
  pageIndex?: string
  signal?: AbortSignal
  /** 阶段回调：message 直接进 job.message。 */
  onPhase?: (message: string) => Promise<void>
}

export interface EbookIngestResult {
  jobId: string
  pages: number | null
  blocks: number
  tables: number | null
  images: number | null
  tokens: number | null
  markdownChars: number
  /** 本地化图片：成功 / 失败 张数。 */
  imagesDownloaded: number
  imagesFailed: number
  /** 精炼：规则清洗修正项（refined.md 内容字符数）。 */
  refineFixes: EbookRefineFix[]
  refinedChars: number
  /** 目录骨架：从文档自带标题层级离线提取的节点数。 */
  outlineCount: number
  outputDir: string
}

/** DocMind 支持 PDF/Word/PPT/Excel/HTML；本轮前端预览仅保证 PDF。 */
const EBOOK_ALLOWED_EXT = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'html'])

export function ebookExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : ''
}

/** 只接受 DocMind 产物域名的签名图，避免把任意 URL 当图片抓取。 */
const DOCMIND_IMAGE_HOST = 'docmind-api-cn-hangzhou.oss-cn-hangzhou.aliyuncs.com'

/**
 * 图片本地化：DocMind 的 markdown 内插图是 OSS 预签名 URL（24h 过期），
 * 解析后必须尽快下载到 `images/` 并把引用改写为相对路径，否则电子书会碎图。
 * 返回改写后的 markdown 与下载统计；失败的图引用保留 URL 原样（可重试）。
 */
export async function localizeEbookImages(
  markdown: string,
  dir: string,
  signal?: AbortSignal,
): Promise<{ markdown: string; downloaded: number; failed: number }> {
  const pattern = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g
  const targets: Array<{ url: string; alt: string }> = []
  for (const match of markdown.matchAll(pattern)) {
    let host: string
    try {
      host = new URL(match[2]!).host
    } catch {
      continue
    }
    if (host === DOCMIND_IMAGE_HOST) targets.push({ url: match[2]!, alt: match[1]! })
  }
  if (targets.length === 0) return { markdown, downloaded: 0, failed: 0 }
  const imagesDir = join(dir, 'images')
  await mkdir(imagesDir, { recursive: true })
  let downloaded = 0
  let failed = 0
  // 已下载的 URL 缓存（同一张图可能在正文出现多次）。
  const cache = new Map<string, string>()
  for (const target of targets) {
    try {
      const path = await downloadImage(target.url, imagesDir, signal, cache)
      if (path !== null) {
        markdown = markdown.replace(target.url, path)
        downloaded++
      } else {
        failed++
      }
    } catch {
      failed++
    }
  }
  return { markdown, downloaded, failed }
}

async function downloadImage(url: string, imagesDir: string, signal: AbortSignal | undefined, cache: Map<string, string>): Promise<string | null> {
  const cached = cache.get(url)
  if (cached !== undefined) return cached
  const response = await fetch(url, { ...(signal !== undefined ? { signal } : {}) })
  if (!response.ok || !response.body) return null
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > 32 * 1024 * 1024) return null
  let ext = 'png'
  let pathExt = ''
  try {
    pathExt = new URL(url).pathname.split('.').pop() ?? ''
    if (/^(png|jpe?g|gif|webp|bmp)$/i.test(pathExt)) ext = pathExt.toLowerCase().replace('jpeg', 'jpg')
  } catch { /* 忽略 */ }
  // content-type 兜底（部分签名 URL 无扩展名）。
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('image/jpeg')) ext = 'jpg'
  else if (contentType.includes('image/gif')) ext = 'gif'
  else if (contentType.includes('image/webp')) ext = 'webp'
  else if (/^\s*(png|jpe?g|gif|webp|bmp|image\/(png|jpeg|gif|webp|bmp))\s*$/i.test(pathExt) === false && contentType.includes('image/png')) ext = 'png'
  const name = `img-${createHash('sha256').update(url).digest('hex').slice(0, 12)}.${ext}`
  await writeFile(join(imagesDir, name), bytes)
  const relative = `images/${name}`
  cache.set(url, relative)
  return relative
}

export async function ingestEbook(input: EbookIngestInput): Promise<EbookIngestResult> {
  const ext = ebookExtension(input.fileName)
  if (ext === '' || !EBOOK_ALLOWED_EXT.has(ext)) {
    throw new DocMindError(`暂不支持该文件类型（支持：${[...EBOOK_ALLOWED_EXT].join(', ')}）`, 'config')
  }
  // 修复：先写 `{ebookId}.pending/`，全流程成功后 rename 为正式目录——
  // DocMind 提交/解析失败不再残留半成品目录（上层 catch 会清理 pending）。
  const pendingDir = join(input.courseRoot, 'ebook', `${input.ebookId}.pending`)
  const dir = join(input.courseRoot, 'ebook', input.ebookId)
  const docmindDir = join(pendingDir, 'docmind')
  await mkdir(docmindDir, { recursive: true })
  const sourcePath = join(pendingDir, `source.${ext}`)
  await writeFile(sourcePath, Buffer.from(input.bytes))
  await input.onPhase?.('已保存原件，正在提交 DocMind 解析…')

  const client = new DocMindClient(input.docmind)
  const result = await client.parse(
    {
      filePath: sourcePath,
      needHeaderFooter: true,
      ...(input.pageIndex && input.pageIndex.trim() !== '' ? { pageIndex: input.pageIndex.trim() } : {}),
    },
    { ...(input.signal !== undefined ? { signal: input.signal } : {}), timeoutMs: 2 * 60 * 60 * 1000 },
  )
  await input.onPhase?.('解析完成，正在本地化图片（签名 URL 24h 过期）…')
  const localized = await localizeEbookImages(result.markdown, pendingDir, input.signal)
  // 精炼：免费规则清洗（决策  默认不启用公式/模型增强规则）。
  const refined = refineMarkdown(localized.markdown)
  // 目录骨架：文档自带标题层级（决策），AI 校验/纠序在后续阶段。
  const outline = extractOutline(refined.markdown)
  // 修复：持久化原始文件名等元信息，`ebook/list` 不再显示「电子书.pdf」占位。
  const meta = {
    fileName: input.fileName,
    ext,
    ...(input.pageIndex && input.pageIndex.trim() !== '' ? { pageIndex: input.pageIndex.trim() } : {}),
    pages: result.status.pageCountEstimate ?? null,
    jobId: result.jobId,
    createdAt: Date.now(),
  }
  await Promise.all([
    writeFile(join(docmindDir, 'markdown.md'), localized.markdown, 'utf8'),
    writeFile(join(docmindDir, 'markdown.raw.md'), result.markdown, 'utf8'),
    writeFile(join(docmindDir, 'refined.md'), refined.markdown, 'utf8'),
    writeFile(join(docmindDir, 'refined-fixes.json'), JSON.stringify(refined.fixes), 'utf8'),
    writeFile(join(docmindDir, 'outline.json'), JSON.stringify(outline), 'utf8'),
    writeFile(join(docmindDir, 'layouts.json'), JSON.stringify(result.layouts?.layouts ?? []), 'utf8'),
    writeFile(join(docmindDir, 'status.json'), JSON.stringify(result.status), 'utf8'),
    writeFile(join(docmindDir, 'meta.json'), JSON.stringify(meta), 'utf8'),
  ])
  await rename(pendingDir, dir)
  return {
    jobId: result.jobId,
    pages: result.status.pageCountEstimate,
    blocks: result.layouts?.total ?? 0,
    tables: result.status.tableCount,
    images: result.status.imageCount,
    tokens: result.status.tokens,
    markdownChars: localized.markdown.length,
    imagesDownloaded: localized.downloaded,
    imagesFailed: localized.failed,
    refineFixes: refined.fixes,
    refinedChars: refined.markdown.length,
    outlineCount: outline.nodes.length,
    outputDir: dir,
  }
}