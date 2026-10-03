/**
 * DocMind 运行时客户端（阿里云文档智能解析）。
 *
 * 基于官方 SDK `@alicloud/docmind-api20220711`（已加入本包依赖）实现
 * 三步流程：提交（SubmitDocParserJobAdvance，本地文件流）→ 轮询
 * （QueryDocParserStatus）→ 取结构结果（GetDocParserResult）+ 下载正文。
 *
 * 注意：pnpm 严格依赖布局下本包不直接依赖 `@alicloud/openapi-core` 与
 * `@darabonba/typescript`，这里不 import 它们的类型，而是通过
 * `ConstructorParameters` / 参数推断取得 Config 与 RuntimeOptions 的形状。
 *
 * 费用口径：标准解析走 DocMind 免费额度（3000 页/月）；`llmEnhancement`
 * 与 `formulaEnhancement` 会额外消耗资源，调用方自行决定开关。
 */
import { createReadStream } from 'node:fs'
import Client, {
  QueryDocParserStatusRequest,
  GetDocParserResultRequest,
  SubmitDocParserJobAdvanceRequest,
  SubmitDocParserJobAdvanceRequestLLMParam,
} from '@alicloud/docmind-api20220711'

export const DOCMIND_ENDPOINT = 'docmind-api.cn-hangzhou.aliyuncs.com'

/** 结构化版面块（getDocParserResult 返回的一个块）。 */
export interface DocMindLayoutBlock {
  index?: number
  type?: string // text | table | picture | title ...
  pageNum?: number
  pos?: number[]
  text?: string
  markdownContent?: string
  // 图片类块
  imageUrl?: string
  // 表格类块
  tableCellContents?: unknown
  // 样式
  style?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * 解析结果查询（getDocParserResult）的归一化形状。
 * 该接口按「(layoutNum=起始下标, layoutStepSize=每批条数)」分页返回顶层
 * `data.layouts[]`（每条即一个内容块，含 text/markdownContent/type/pageNum/
 * index/uniqueId 等；内部的 blocks[] 是细粒度子块，这里不展开）。
 */
export interface DocMindLayouts {
  total: number
  layouts: DocMindLayoutBlock[]
  /** 与 layouts 同源，便于统一消费。 */
  blocks: DocMindLayoutBlock[]
}

export interface DocMindParseStatus {
  jobId: string
  status: string // success | processing | fail ...
  progress: number // 0-100
  pageCountEstimate: number | null
  paragraphCount: number | null
  tableCount: number | null
  imageCount: number | null
  tokens: number | null
  outputUrl: string | null
  message?: string
}

export interface DocMindParseOptions {
  /** 本地文件绝对路径（提交时以文件流上传）。 */
  filePath: string
  fileName?: string
  fileNameExtension?: string
  /** 如 "1-15"，为空则解析全部页。 */
  pageIndex?: string
  /** 输出格式，默认 ['markdown']。 */
  outputFormat?: string[]
  formulaEnhancement?: boolean
  llmEnhancement?: boolean
  llmModel?: string
  llmPrompt?: string
  needHeaderFooter?: boolean
}

export interface DocMindParseResult {
  jobId: string
  markdown: string
  layouts: DocMindLayouts | null
  status: DocMindParseStatus
}

export interface DocMindClientOptions {
  accessKeyId: string
  accessKeySecret: string
  endpoint?: string
}

type SdkClient = InstanceType<typeof Client>

/**
 * CJS 互操作兜底：该包以 `exports.default = Client` 编译且未标记 __esModule，
 * 语言层 default 导入在不同环境下可能直接拿到构造器，也可能拿到 exports 对象
 * （构造器在 `.default` 上）。两种形态都兼容。
 */
function resolveClientConstructor(fallback: typeof Client): typeof Client {
  const candidate = (Client as unknown as { default?: unknown }).default
  return typeof candidate === 'function' ? (candidate as typeof Client) : fallback
}

export class DocMindError extends Error {
  constructor(
    message: string,
    readonly phase: 'submit' | 'poll' | 'fetch' | 'config',
    readonly jobId?: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'DocMindError'
  }
}

function readError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** tea SDK 默认读/连超时仅 3s，上传/下载大文件必然超时；统一放宽。 */
type TeaRuntime = Parameters<SdkClient['submitDocParserJobAdvance']>[1]
function teaRuntime(readTimeout = 120_000, connectTimeout = 20_000): TeaRuntime {
  return { readTimeout, connectTimeout } as TeaRuntime
}

export class DocMindClient {
  private readonly client: SdkClient

  constructor(options: DocMindClientOptions) {
    if (!options.accessKeyId || !options.accessKeySecret) {
      throw new DocMindError('DocMind 未配置 AccessKey：请在设置中填写', 'config')
    }
    const ClientCtor = resolveClientConstructor(Client)
    this.client = new ClientCtor({
      accessKeyId: options.accessKeyId,
      accessKeySecret: options.accessKeySecret,
      endpoint: options.endpoint ?? DOCMIND_ENDPOINT,
    } as ConstructorParameters<typeof Client>[0])
  }

  /** 提交解析任务，返回任务号。 */
  async submit(options: DocMindParseOptions): Promise<string> {
    const fileName = options.fileName ?? options.filePath.split(/[\\/]/).at(-1) ?? 'input'
    const ext = (options.fileNameExtension ?? fileName.split('.').at(-1) ?? '').toLowerCase()
    const llmParam =
      options.llmModel || options.llmPrompt
        ? new SubmitDocParserJobAdvanceRequestLLMParam({
            ...(options.llmModel ? { model: options.llmModel } : {}),
            ...(options.llmPrompt ? { prompt: options.llmPrompt } : {}),
          })
        : undefined
    const request = new SubmitDocParserJobAdvanceRequest({
      fileName,
      fileNameExtension: ext,
      fileUrlObject: createReadStream(options.filePath),
      outputFormat: options.outputFormat ?? ['markdown'],
      pageIndex: options.pageIndex,
      formulaEnhancement: options.formulaEnhancement ?? false,
      llmEnhancement: options.llmEnhancement ?? false,
      needHeaderFooter: options.needHeaderFooter ?? true,
      ...(llmParam ? { LLMParam: llmParam } : {}),
    })
    try {
      // 整本教材（150 MiB 闸口内）上传到 OSS 预签名地址需要余量：120s 读超时
      // 对 30MB+ 慢速上行不够，submit 专用 300s，状态/结果小请求维持默认。
      const response = await this.client.submitDocParserJobAdvance(request, teaRuntime(300_000))
      const jobId = response.body?.data?.id
      if (!jobId) throw new DocMindError('DocMind 提交未返回任务号', 'submit', undefined, response.body?.code)
      return jobId
    } catch (error) {
      if (error instanceof DocMindError) throw error
      throw new DocMindError(`DocMind 提交失败：${readError(error)}`, 'submit')
    }
  }

  /** 轮询直到成功或失败。 */
  async waitForStatus(
    jobId: string,
    options: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<DocMindParseStatus> {
    const intervalMs = options.intervalMs ?? 5000
    const timeoutMs = options.timeoutMs ?? 2 * 60 * 60 * 1000
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (options.signal?.aborted) throw new DocMindError('DocMind 解析已取消', 'poll', jobId, 'CANCELLED')
      if (Date.now() > deadline) throw new DocMindError('DocMind 解析超时', 'poll', jobId, 'TIMEOUT')
      let data: NonNullable<NonNullable<Awaited<ReturnType<SdkClient['queryDocParserStatus']>>['body']>['data']> | null = null
      try {
        // SDK 的 queryDocParserStatus 类型层只声明 1 参，但 tea 运行时接受
        // RuntimeOptions 作第 2 参（超时必须放宽，否则 3s 必挂）——签名对齐运行时。
        const response = await (
          this.client.queryDocParserStatus as (request: QueryDocParserStatusRequest, runtime?: TeaRuntime) => ReturnType<SdkClient['queryDocParserStatus']>
        )(new QueryDocParserStatusRequest({ id: jobId }), teaRuntime())
        data = response.body?.data ?? null
      } catch (error) {
        // 单次查询失败不视为解析失败，继续重试（限流/抖动）。
        await sleep(intervalMs)
        continue
      }
      const status = data?.status ?? ''
      const statusText = ['success', 'failed', 'fail', 'error', 'done'].find((value) => status.toLowerCase().includes(value))
      if (statusText === 'success' || statusText === 'done') {
        return {
          jobId,
          status,
          progress: data?.processing ?? 100,
          pageCountEstimate: data?.pageCountEstimate ?? null,
          paragraphCount: data?.paragraphCount ?? null,
          tableCount: data?.tableCount ?? null,
          imageCount: data?.imageCount ?? null,
          tokens: data?.tokens ?? null,
          outputUrl: pickOutputUrl(data),
        }
      }
      if (statusText === 'failed' || statusText === 'fail' || statusText === 'error') {
        throw new DocMindError(`DocMind 解析失败（状态 ${status}）`, 'poll', jobId)
      }
      await sleep(intervalMs, options.signal)
    }
  }

  /** 下载正文产物（OSS 预签名 URL）。 */
  async fetchMarkdown(outputUrl: string, options: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<string> {
    const maxBytes = options.maxBytes ?? 32 * 1024 * 1024
    try {
      const response = await fetch(outputUrl, { ...(options.signal !== undefined ? { signal: options.signal } : {}) })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const length = Number(response.headers.get('content-length') ?? 0)
      if (length > maxBytes) throw new Error(`正文产物过大（${length} 字节）`)
      let received = 0
      const chunks: Uint8Array[] = []
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.length
        if (received > maxBytes) throw new Error(`正文产物超过 ${maxBytes} 字节限制`)
        chunks.push(chunk)
      }
      return Buffer.concat(chunks).toString('utf8')
    } catch (error) {
      if (error instanceof DocMindError) throw error
      throw new DocMindError(`DocMind 正文下载失败：${readError(error)}`, 'fetch')
    }
  }

  /** 取结构化结果（layouts：按「起始=layoutNum、每批=layoutStepSize」翻页汇总）。 */
  async fetchLayouts(jobId: string): Promise<DocMindLayouts | null> {
    const collected: DocMindLayoutBlock[] = []
    const take = 200
    let start = 0
    try {
      for (;;) {
        const response = await (
          this.client.getDocParserResult as (request: GetDocParserResultRequest, runtime?: TeaRuntime) => ReturnType<SdkClient['getDocParserResult']>
        )(new GetDocParserResultRequest({ id: jobId, layoutNum: start, layoutStepSize: take }), teaRuntime())
        const data = response?.body?.data as { layouts?: DocMindLayoutBlock[] } | undefined
        const chunk = Array.isArray(data?.layouts) ? data.layouts : []
        if (chunk.length === 0) {
          if (start === 0) {
            start = 1 // 起始下标 0 非法时从 1 开始
            continue
          }
          break
        }
        collected.push(...chunk)
        if (chunk.length < take || collected.length > 50_000) break
        start += take
      }
    } catch (error) {
      throw new DocMindError(`DocMind 结果下载失败：${readError(error)}`, 'fetch', jobId)
    }
    return { total: collected.length, layouts: collected, blocks: collected }
  }

  /** 一站式：提交 → 轮询 → 取 markdown + layouts。 */
  async parse(options: DocMindParseOptions, poll: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DocMindParseResult> {
    const jobId = await this.submit(options)
    const status = await this.waitForStatus(jobId, poll)
    if (!status.outputUrl) throw new DocMindError('解析成功但未返回正文地址', 'fetch', jobId)
    const [markdown, layouts] = await Promise.all([
      this.fetchMarkdown(status.outputUrl, { ...(poll.signal !== undefined ? { signal: poll.signal } : {}) }),
      this.fetchLayouts(jobId),
    ])
    return { jobId, markdown, layouts, status }
  }
}

function pickOutputUrl(data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null
  const outputFormatResult = (data as { outputFormatResult?: unknown }).outputFormatResult
  if (!Array.isArray(outputFormatResult)) return null
  const markdown = outputFormatResult.find(
    (item) => item !== null && typeof item === 'object' && (item as { outputType?: unknown }).outputType === 'markdown',
  )
  const candidate = markdown ?? outputFormatResult[0]
  if (candidate === null || typeof candidate !== 'object') return null
  const url = (candidate as { outputFileUrl?: unknown }).outputFileUrl
  return typeof url === 'string' && url !== '' ? url : null
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new DocMindError('DocMind 解析已取消', 'poll', undefined, 'CANCELLED'))
    }
    if (signal?.aborted) {
      onAbort()
    } else {
      signal?.addEventListener('abort', onAbort, { once: true })
    }
  })
}