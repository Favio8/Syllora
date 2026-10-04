/**
 * 云端 OpenMAIC 客户端。
 *
 * Syllora 本地不跑 OpenMAIC：它是一个服务端 + PostgreSQL 的重型应用，因此部署在云上，
 * 由本模块通过 HTTP 调用它生成课堂，再把场景取回本地渲染。
 *
 * 契约来源：对运行中的 OpenMAIC 1.1.1（commit 5312c2b）实测确认，不是从文档推测：
 *
 *   POST /api/access-code/verify        {code}                    -> 200，Set-Cookie: openmaic_access
 *   POST /api/materials                 body=文件字节              -> 201 {materialId,originalName,bytes,mime}
 *                                       headers: content-type, x-material-filename
 *   GET  /api/generate-classroom/capabilities                     -> {capabilities,materials}
 *   POST /api/generate-classroom        {requirement,materialIds} -> 202 {jobId,status,pollUrl,pollIntervalMs}
 *   GET  /api/generate-classroom/{id}                             -> {status,step,progress,scenesGenerated,error,done}
 *   GET  /api/stages/{id}/manifest                                -> 场景清单
 *   GET  /api/stages/{id}/scenes?ids=a,b                          -> 场景数组
 *   POST /api/verify-model              {model,apiKey,baseUrl,providerType}
 *   GET  /api/model-config                                        -> {revision,...} 用于乐观并发
 *   PUT  /api/model-config              {revision,change}         -> 写入供应商/槽位
 *
 * 门禁：除 verify 与登录页外，所有接口都要求有效的 `openmaic_access` cookie（HMAC 签名，
 * 由 access-code 换取，7 天有效）。cookie 只存在于本进程内存，不落盘。
 */

/** 云端的资料上限，取自 GET /api/generate-classroom/capabilities 的实测值。 */
export const CLOUD_MATERIAL_LIMITS = { maxCount: 5, maxTotalBytes: 157_286_400, maxDocumentBytes: 52_428_800 } as const

export interface CloudConfig {
  /** 站点根地址，如 https://studyandchat.top（不带结尾斜杠）。 */
  baseUrl: string
  /** 站点访问口令（ACCESS_CODE）。 */
  accessCode: string
  /** 可选的模型代填信息（configureModel 使用；客户端本身不读，供调用方展示）。 */
  readonly provider?: string
  readonly preset?: string
  readonly model?: string
  readonly apiKey?: string
}

export interface CloudMaterial { materialId: string; originalName: string; bytes: number; mime: string }

export interface CloudJobStatus {
  jobId: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  step: string
  progress: number | undefined
  scenesGenerated: number | undefined
  /** 云端上报的总场景数（生成中即可用，用于「已生成 x/y」）。 */
  totalScenes: number | undefined
  /** 成功时的产物标识。注意云端把它放在 `result` 里，不在顶层。 */
  classroomId: string | undefined
  classroomUrl: string | undefined
  error: string | undefined
  done: boolean
}

/** 云端返回的场景。`content.canvas` 就是 `@openmaic/renderer` 能渲染的幻灯片。 */
export interface CloudScene {
  id: string
  title?: string
  order?: number
  content?: { type?: string; canvas?: unknown }
  [key: string]: unknown
}

export class CloudError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message)
    this.name = 'CloudError'
  }
}

const TIMEOUT_MS = 120_000
const POLL_INTERVAL_MS = 5_000

/**
 * 单章生成默认等待上限。
 *
 * 实测（同一份 775 字资料、10–11 页课堂）：
 * - 慢配置（`pro` + 串行 + 开思维）：约 135 秒/页
 * - 快配置（`flash` + 并发 + 关思维）：约 12 秒/页
 *
 * 差 11 倍，所以固定的 30 分钟会**先于云端完成而超时**：一本 40 页的课程在慢配置下要数小时。
 * 默认放到 2 小时覆盖快配置下的整本书，慢配置则应由 `cloud.wait_timeout_minutes` 显式调大。
 */
const DEFAULT_WAIT_TIMEOUT_MS = 120 * 60_000

/**
 * 一个云端会话：先换 cookie，之后所有请求带上它。
 *
 * cookie 保存在实例字段里而不写磁盘——Syllora 的课程目录是用户可见的普通文件夹，
 * 把凭据写进去等于泄露给任何能读该目录的人。
 */
export class OpenMaicCloud {
  private cookie: string | null = null
  private readonly base: string

  constructor(private readonly config: CloudConfig) {
    this.base = config.baseUrl.replace(/\/+$/, '')
  }

  /** 换取访问 cookie（幂等：已有则直接复用）。 */
  async connect(): Promise<void> {
    if (this.cookie) return
    const response = await this.fetchJson('/api/access-code/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: this.config.accessCode }),
      // 校验请求自身不能带旧 cookie，否则失败态会被缓存
      skipCookie: true,
    })
    const setCookie = response.cookie
    if (!setCookie) throw new CloudError('云端未返回访问 cookie；请确认站点访问口令正确', 401, 'NO_COOKIE')
    this.cookie = setCookie
  }

  /** 探测云端能力与资料限制，用于在生成前给出可读的失败原因。 */
  async capabilities(): Promise<{ capabilities: Record<string, boolean>; materials: typeof CLOUD_MATERIAL_LIMITS }> {
    await this.connect()
    const body = await this.fetchJson('/api/generate-classroom/capabilities')
    const data = (body.json ?? {}) as { capabilities?: Record<string, boolean>; materials?: typeof CLOUD_MATERIAL_LIMITS }
    return {
      capabilities: data.capabilities ?? {},
      materials: data.materials ?? CLOUD_MATERIAL_LIMITS,
    }
  }

  /** Read narration bytes through the cloud gate; never expose its cookie to the browser. */
  async audio(assetId: string): Promise<{ mime: string; base64: string }> {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(assetId)) throw new CloudError('音频标识无效', 400, 'BAD_AUDIO')
    await this.connect()
    const response = await fetch(`${this.base}/api/persistence/assets/${encodeURIComponent(assetId)}/content`, {
      headers: { cookie: this.cookie! }, redirect: 'manual', signal: AbortSignal.timeout(30_000),
    }).catch(() => { throw new CloudError('无法读取云端讲解音频，请稍后重试', undefined, 'UNREACHABLE') })
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
    const limit = 16 * 1024 * 1024
    if (!response.ok || !/^audio\/(wav|x-wav|mpeg|mp3|ogg|webm|mp4|aac|flac)$/.test(mime) || Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel()
      throw new CloudError('云端讲解音频不可用，请检查连接或稍后重试', response.status, 'BAD_AUDIO')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new CloudError('云端讲解音频为空', undefined, 'BAD_AUDIO')
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > limit) throw new CloudError('单段讲解音频超过 16 MB', undefined, 'BAD_AUDIO')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => undefined) }
    if (length === 0) throw new CloudError('云端讲解音频为空', undefined, 'BAD_AUDIO')
    return { mime, base64: Buffer.concat(chunks).toString('base64') }
  }

  /** 上传一份资料，返回云端 materialId。注意资料会离开本机。 */
  async uploadMaterial(name: string, bytes: Uint8Array, mime: string): Promise<CloudMaterial> {
    await this.connect()
    const response = await this.fetchJson('/api/materials', {
      method: 'POST',
      headers: {
        'content-type': mime,
        // 头必须是 ASCII：中文文件名直接放进头会抛 "Cannot convert argument to a ByteString"。
        // 云端用 decodeURIComponent 解码，这与 OpenMAIC 官方客户端 session-store.ts 的做法一致。
        'x-material-filename': encodeURIComponent(name),
      },
      // fetch 的 BodyInit 不接受 Uint8Array 视图，转成 ArrayBuffer 传字节
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    })
    const json = (response.json ?? {}) as Partial<CloudMaterial>
    if (!json.materialId) throw new CloudError(`云端未返回 materialId（${name}）`, response.status, 'NO_MATERIAL_ID')
    return { materialId: json.materialId, originalName: json.originalName ?? name, bytes: json.bytes ?? bytes.length, mime: json.mime ?? mime }
  }

  /** 发起一次课堂生成；返回 jobId 供轮询。 */
  async generateClassroom(requirement: string, materialIds: string[]): Promise<string> {
    await this.connect()
    const response = await this.fetchJson('/api/generate-classroom', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requirement, materialIds }),
    })
    const json = (response.json ?? {}) as { jobId?: string }
    if (!json.jobId) throw new CloudError('云端未返回 jobId', response.status, 'NO_JOB_ID')
    return json.jobId
  }

  /** 轮询任务直到终态，或直到 check() 抛错（取消）。 */
  async waitForJob(jobId: string, options: {
    check?: () => Promise<void>
    onProgress?: (status: CloudJobStatus) => Promise<void> | void
    timeoutMs?: number
    /** 轮询间隔；默认 5 秒（与云端返回的 pollIntervalMs 一致），测试里可缩短。 */
    intervalMs?: number
  } = {}): Promise<CloudJobStatus> {
    await this.connect()
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
    const interval = options.intervalMs ?? POLL_INTERVAL_MS
    // 一次真实生成要 13–20 分钟，期间可能发生若干次瞬时网络故障（实测遇到过一次
    // `fetch failed`，直接把已经跑了 13 分钟的任务判死）。轮询对这类错误必须容忍：
    // 累计失败超过上限才放弃，单次抖动只是重试。
    const maxTransientFailures = 10
    let transientFailures = 0
    for (;;) {
      await options.check?.()
      let response: Awaited<ReturnType<OpenMaicCloud['fetchJson']>>
      try {
        response = await this.fetchJson(`/api/generate-classroom/${encodeURIComponent(jobId)}`)
        transientFailures = 0
      } catch (error) {
        const transient = error instanceof CloudError
          && (error.code === 'UNREACHABLE' || error.status === undefined || (error.status ?? 0) >= 500)
        if (!transient) throw error
        transientFailures += 1
        if (transientFailures > maxTransientFailures) throw error
        if (Date.now() > deadline) throw new CloudError('云端生成超时', undefined, 'TIMEOUT')
        await new Promise(resolve => setTimeout(resolve, interval))
        continue
      }
      const raw = (response.json ?? {}) as Partial<CloudJobStatus> & {
        success?: boolean
        // 云端把产物放在 `result` 下（见上游 classroom-job-store 的成功分支）：
        // result: { classroomId, url, scenesCount }
        result?: { classroomId?: string; url?: string; scenesCount?: number }
      }
      const status: CloudJobStatus = {
        jobId,
        status: (raw.status ?? 'running') as CloudJobStatus['status'],
        step: raw.step ?? '',
        progress: raw.progress,
        scenesGenerated: raw.scenesGenerated ?? raw.result?.scenesCount,
        totalScenes: raw.totalScenes,
        classroomId: raw.result?.classroomId ?? raw.classroomId,
        classroomUrl: raw.result?.url,
        error: raw.error,
        done: raw.done === true || raw.status === 'succeeded' || raw.status === 'failed',
      }
      await options.onProgress?.(status)
      if (status.done) return status
      if (Date.now() > deadline) throw new CloudError('云端生成超时', undefined, 'TIMEOUT')
      await new Promise(resolve => setTimeout(resolve, interval))
    }
  }

  /** 取回一个课堂的全部场景（先读 manifest，再按 id 批量取）。 */
  async scenes(classroomId: string): Promise<CloudScene[]> {
    await this.connect()
    const manifest = await this.fetchJson(`/api/stages/${encodeURIComponent(classroomId)}/manifest`)
    const ids = collectSceneIds(manifest.json)
    if (ids.length === 0) return []
    const chunks: CloudScene[] = []
    // 云端单次批量上限 200，分片以防超限
    for (let i = 0; i < ids.length; i += 200) {
      const slice = ids.slice(i, i + 200)
      const response = await this.fetchJson(`/api/stages/${encodeURIComponent(classroomId)}/scenes?ids=${slice.map(encodeURIComponent).join(',')}`)
      chunks.push(...normalizeScenes(response.json))
    }
    return chunks
  }

  /**
   * 代填模型配置：先写供应商，再按 `<provider>:<model>` 校验 Key，最后赋值给根槽位 `llm`。
   *
   * 顺序很重要，这一点是实测出来的：`/api/verify-model` 的 `providerType` 是**协议类型**
   * （如 `openai`），不是预设名——传预设名会得到
   * `Provider type mismatch for openai: expected openai, received deepseek`。
   * 传 `<provider>:<model>` 时服务端用已保存的供应商解析凭据，因此必须先保存供应商再校验。
   *
   * `course.outline` / `course.content` 等子槽位未显式赋值时继承 `llm`，因此不必逐个写。
   * 写入带乐观并发（revision）。
   */
  async configureModel(input: { providerId: string; preset: string; model: string; apiKey: string; baseUrl?: string }): Promise<void> {
    await this.connect()
    const current = await this.fetchJson('/api/model-config')
    const revision = (current.json as { revision?: number } | null)?.revision ?? null
    await this.fetchJson('/api/model-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        revision,
        change: {
          kind: 'provider',
          id: input.providerId,
          preset: input.preset,
          apiKey: input.apiKey,
          ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        },
      }),
    })

    // 先按已保存的供应商引用校验；若该部署未按此解析，再回退到直传凭据的形式。
    const savedRef = `${input.providerId}:${input.model}`
    const verified = await this.fetchJson('/api/verify-model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: savedRef, apiKey: input.apiKey }),
    }).catch(async (error: unknown) => {
      if (!(error instanceof CloudError)) throw error
      return this.fetchJson('/api/verify-model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: input.model,
          apiKey: input.apiKey,
          ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        }),
      })
    })
    if ((verified.json as { success?: boolean } | null)?.success === false) {
      throw new CloudError('模型校验未通过，请检查 Key 与模型名', verified.status, 'VERIFY_FAILED')
    }

    const afterProvider = await this.fetchJson('/api/model-config')
    const nextRevision = (afterProvider.json as { revision?: number } | null)?.revision ?? null
    await this.fetchJson('/api/model-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        revision: nextRevision,
        change: { kind: 'slots', set: { llm: savedRef } },
      }),
    })
  }

  /** 统一的请求入口：注入 cookie、超时、错误归一化。 */
  private async fetchJson(path: string, init: RequestInit & { skipCookie?: boolean } = {}): Promise<{ status: number; json: unknown; cookie: string | null }> {
    const headers = new Headers(init.headers)
    if (!init.skipCookie && this.cookie) headers.set('cookie', this.cookie)
    let response: Response
    try {
      response = await fetch(`${this.base}${path}`, {
        ...init,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new CloudError(`无法连接云端 ${this.base}：${reason}`, undefined, 'UNREACHABLE')
    }

    // 未授权：把口令问题与其它错误区分开，便于用户定位
    if (response.status === 401) {
      throw new CloudError('云端拒绝了访问口令（401）。请检查 config.yaml 的 cloud.accessCode', 401, 'UNAUTHORIZED')
    }

    const setCookie = readAccessCookie(response.headers)
    let json: unknown = null
    const text = await response.text().catch(() => '')
    if (text) {
      try { json = JSON.parse(text) } catch { json = null }
    }
    if (!response.ok) {
      const detail = readErrorMessage(json) ?? text.slice(0, 200) ?? `HTTP ${response.status}`
      throw new CloudError(`云端返回 ${response.status}：${detail}`, response.status)
    }
    return { status: response.status, json, cookie: setCookie }
  }
}

/** 从 Set-Cookie 里取出 openmaic_access 的 `name=value` 片段。 */
function readAccessCookie(headers: Headers): string | null {
  const raw = headers.getSetCookie?.() ?? []
  for (const value of raw) {
    const match = /(?:^|,\s*)(openmaic_access=[^;]+)/.exec(value)
    if (match) return match[1]!
  }
  const single = headers.get('set-cookie')
  const match = single ? /(?:^|,\s*)(openmaic_access=[^;]+)/.exec(single) : null
  return match ? match[1]! : null
}

function readErrorMessage(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null
  const candidate = json as { error?: unknown; errorCode?: unknown; message?: unknown }
  if (typeof candidate.error === 'string') return candidate.error
  if (typeof candidate.message === 'string') return candidate.message
  return null
}

/** 从 manifest 里尽力收集场景 id；形态随云端版本变化，因此做多种兜底。 */
function collectSceneIds(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== 'object') return []
  const source = manifest as Record<string, unknown>
  const candidates = [source.scenes, source.sceneIds, (source.manifest as Record<string, unknown> | undefined)?.scenes]
  for (const value of candidates) {
    if (!Array.isArray(value)) continue
    const ids = value
      .map(item => (typeof item === 'string' ? item : typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : null))
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
    if (ids.length > 0) return ids
  }
  return []
}

/** 归一化场景数组：兼容 `{scenes:[...]}`、`{data:[...]}` 与裸数组三种形态。 */
function normalizeScenes(payload: unknown): CloudScene[] {
  if (Array.isArray(payload)) return payload as CloudScene[]
  if (payload && typeof payload === 'object') {
    const source = payload as Record<string, unknown>
    for (const key of ['scenes', 'data', 'items']) {
      if (Array.isArray(source[key])) return source[key] as CloudScene[]
    }
  }
  return []
}
