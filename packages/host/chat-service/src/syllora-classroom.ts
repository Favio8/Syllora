/**
 * 虚拟课堂：在已部署的云端 OpenMAIC 上按需生成一节课，取回整份课堂到本地课程目录播放。
 *
 * 与「幻灯片讲义」共用同一个云端客户端（syllora-cloud.ts）与同一份连接配置（config.yaml 的
 * `cloud`），区别在于：幻灯片随初始化按章批量生成、只保留 slide 页；虚拟课堂由用户发起，
 * 保留 slide / quiz / interactive 全部场景与讲解动作，用于在应用内上课。
 *
 * 数据流向：用户选中的课程资料会**上传到所配置的云端服务器**。功能默认关闭，入口须明示。
 *
 * 本地存储（课程目录内，普通文件夹）：
 *   classrooms/<classroomId>/classroom.json   取回的整份课堂（stage + scenes + outline）
 *   classrooms/<classroomId>/meta.json        标题、需求、来源资料、生成时间、场景统计
 *   classrooms/<classroomId>/progress.json    本机播放进度与测验作答（自评，不计入学习证据）
 */
import { readFile, readdir, realpath, rm } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CloudError, OpenMaicCloud, CLOUD_MATERIAL_LIMITS, type CloudConfig } from './syllora-cloud.ts'
import { atomicJson, jsonFile } from './syllora-files.ts'
import type { Course, Source } from './syllora-domain.ts'

/** 入参类错误：由服务层转成 SylloraError（避免与 syllora.ts 形成循环导入）。 */
export class ClassroomInputError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ClassroomInputError' }
}

/** 云端课堂 id 形如 `stage-XXXX`；只接受安全字符，避免拼进路径时越界。 */
export const classroomIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)

/** 本地落盘的课堂元信息。 */
export interface ClassroomMeta {
  classroomId: string
  title: string
  requirement: string
  materialIds: string[]
  sourceCount: number
  sceneCount: number
  sceneTypes: Record<string, number>
  generatedAt: number
  fetchedAt: number
  cloudBase: string
}

/** 播放进度：当前页与每道测验题的作答。只是本机阅读状态，不进入课程证据。 */
export interface ClassroomProgress {
  sceneId: string | null
  answers: Record<string, string[]>
  updatedAt: number
}

/** 需求文本与资料选择的输入校验。 */
export const classroomGenerateSchema = z.object({
  courseId: z.string().uuid(),
  requestId: z.string().uuid(),
  requirement: z.string().trim().min(4, '请用一两句话描述想学的内容').max(2000),
  materialIds: z.array(z.string().uuid()).max(50).default([]),
  /** 首页附件（内存暂存，见 ClassroomAttachments）的 id；与课程资料合并后上云。 */
  attachmentIds: z.array(z.string().uuid()).max(4).default([]),
  /** 课堂角色配置（昵称/角色/音色等）随需求一起交给云端，云端自行取舍。 */
  roles: z.array(z.object({
    id: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(40),
    kind: z.enum(['teacher', 'student']),
    persona: z.string().trim().max(400).optional(),
    voice: z.string().trim().max(80).optional(),
  })).max(8).default([]),
}).strict()

/** 课堂作业轮询/读取/进度的入参（都带课程 id：作业与产物按课程隔离）。 */
export const classroomJobSchema = z.object({ courseId: z.string().uuid(), jobId: z.string().trim().min(1).max(120) }).strict()
export const classroomGetSchema = z.object({ courseId: z.string().uuid(), classroomId: classroomIdSchema }).strict()
export const classroomListSchema = z.object({ courseId: z.string().uuid() }).strict()
export const classroomProgressSchema = z.object({
  courseId: z.string().uuid(),
  classroomId: classroomIdSchema,
  sceneId: z.string().trim().max(120).nullable().default(null),
  answers: z.record(z.string().max(120), z.array(z.string().max(40)).max(8)).default({}),
}).strict()

/** 首页附件上限：与云端资料数一致（5 份里课程资料合并占 1 份，其余留给附件）。 */
export const CLOUD_ATTACHMENT_COUNT = CLOUD_MATERIAL_LIMITS.maxCount - 1

export interface StagedAttachment { id: string; courseId: string; name: string; mime: string; bytes: number; data: Uint8Array; at: number }

/**
 * 首页附件的内存暂存：上传只用于紧接着的一次生成，落盘没有意义，
 * 反而会把用户随手拖进来的文件永久留在课程目录里。进程内存 + 数量/总字节上限。
 */
export class ClassroomAttachments {
  private items = new Map<string, StagedAttachment>()

  add(courseId: string, name: string, mime: string, data: Uint8Array): StagedAttachment {
    const existing = [...this.items.values()].filter(item => item.courseId === courseId)
    if (existing.length >= CLOUD_ATTACHMENT_COUNT) fail(`附件最多 ${CLOUD_ATTACHMENT_COUNT} 份，请先移除后再添加`)
    const total = existing.reduce((sum, item) => sum + item.bytes, data.length)
    if (data.length > CLOUD_MATERIAL_LIMITS.maxDocumentBytes) fail(`单个附件不能超过 ${Math.round(CLOUD_MATERIAL_LIMITS.maxDocumentBytes / 1024 / 1024)} MB`)
    if (total > CLOUD_MATERIAL_LIMITS.maxTotalBytes) fail('附件合计超出云端 150 MB 限制')
    const item: StagedAttachment = { id: randomUUID(), courseId, name, mime, bytes: data.length, data, at: Date.now() }
    this.items.set(item.id, item)
    return item
  }

  /** 取走并移除（生成时一次性消费）：缺失的 id 会在返回值里列出，由调用方报错。 */
  take(courseId: string, ids: string[]): { items: StagedAttachment[]; missing: string[] } {
    const items: StagedAttachment[] = []
    const missing: string[] = []
    for (const id of ids) {
      const item = this.items.get(id)
      if (!item || item.courseId !== courseId) { missing.push(id); continue }
      this.items.delete(id)
      items.push(item)
    }
    return { items, missing }
  }

  /** 生成前的存在性校验（不消费）：缺失的 id 直接返回。 */
  missing(courseId: string, ids: string[]): string[] {
    return ids.filter(id => this.items.get(id)?.courseId !== courseId)
  }

  /** 该课程当前暂存的附件数与字节合计（设置页/输入卡片展示用）。 */
  stats(courseId: string): { count: number; bytes: number; names: string[] } {
    const items = [...this.items.values()].filter(item => item.courseId === courseId)
    return { count: items.length, bytes: items.reduce((sum, item) => sum + item.bytes, 0), names: items.map(item => item.name) }
  }

  /** 课程删除/取消时清掉暂存。 */
  clearCourse(courseId: string) {
    for (const [id, item] of this.items) if (item.courseId === courseId) this.items.delete(id)
  }
}

function fail(message: string): never { throw new ClassroomInputError('INVALID_REQUEST', message) }

/** 角色的可读描述，附在 requirement 之后交给云端（云端没有单独的角色接口）。 */
export function classroomRolesBrief(roles: Array<{ name: string; kind: 'teacher' | 'student'; persona?: string | undefined; voice?: string | undefined }>): string {
  if (!roles.length) return ''
  const lines = roles.map(role => `- ${role.kind === 'teacher' ? '主讲教师' : '学生'}「${role.name}」${role.persona ? `：${role.persona}` : ''}${role.voice ? `（音色 ${role.voice}）` : ''}`)
  return `\n\n课堂角色设定：\n${lines.join('\n')}`
}

/**
 * 把选中的课程资料合并成一份 Markdown（云端单次最多 5 份资料）。
 * 只取当前可用来源；每段带上资料名与位置，便于云端引用与本地追溯。
 */
export function classroomMaterialMarkdown(course: Course, materialIds: string[]): { markdown: string; sources: Source[] } {
  const wanted = new Set(materialIds)
  const materials = course.materials.filter(m => m.status !== 'deleted' && m.active !== false && (m.status === 'ready' || m.accepted) && (wanted.size === 0 || wanted.has(m.id)))
  const sources = materials.flatMap(m => m.sources)
  const parts = materials.map(m => [`# ${m.name}`, ...m.sources.map(s => `## ${s.anchor}\n\n${s.text}`)].join('\n\n'))
  return { markdown: parts.join('\n\n'), sources }
}

/** 统计每种场景的数量（slide / quiz / interactive …），用于列表展示与「不静默少页」的核对。 */
export function sceneTypeCounts(scenes: Array<{ type?: unknown; content?: { type?: unknown } }>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const scene of scenes) {
    const type = typeof scene.type === 'string' ? scene.type : typeof scene.content?.type === 'string' ? scene.content.type : 'unknown'
    counts[type] = (counts[type] ?? 0) + 1
  }
  return counts
}

/** 课堂云端链路：基于共享客户端，补充整份课堂取回。 */
export class ClassroomCloud {
  readonly client: OpenMaicCloud
  constructor(readonly config: CloudConfig) { this.client = new OpenMaicCloud(config) }

  /**
   * 增量取场景：按云端 manifest 的当前状态取回**已生成**的场景（生成过程中也能取到部分）。
   * 播放器用它做「边生成边上课」；任务完成后仍以本地保存的整份文档为准。
   */
  async liveScenes(classroomId: string): Promise<Array<Record<string, unknown>>> {
    return await this.client.scenes(classroomId) as Array<Record<string, unknown>>
  }

  /**
   * 云端课堂列表（`GET /api/stages`）：实测返回 id/name/createdAt/updatedAt/sceneCount。
   * 生成中的课堂也在里面（sceneCount 逐步增加）——「先进入课堂」靠它拿到当时还在生成的 stage id。
   */
  async liveStages(): Promise<Array<{ id: string; name: string; createdAt: number; updatedAt: number; sceneCount: number }>> {
    await this.client.connect()
    const fetchJson = (this.client as unknown as { fetchJson(path: string): Promise<{ json: unknown }> }).fetchJson.bind(this.client)
    const response = await fetchJson('/api/stages')
    const stages = (response.json as { stages?: unknown } | null)?.stages
    if (!Array.isArray(stages)) return []
    return stages.flatMap(item => {
      const stage = item as { id?: unknown; name?: unknown; createdAt?: unknown; updatedAt?: unknown; sceneCount?: unknown }
      if (typeof stage.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(stage.id)) return []
      return [{
        id: stage.id,
        name: typeof stage.name === 'string' ? stage.name.slice(0, 120) : '',
        createdAt: typeof stage.createdAt === 'number' ? stage.createdAt : 0,
        updatedAt: typeof stage.updatedAt === 'number' ? stage.updatedAt : 0,
        sceneCount: typeof stage.sceneCount === 'number' ? stage.sceneCount : 0,
      }]
    })
  }

  /** 删除云端课堂（级联删除其场景行）；失败由调用方决定是否忽略。 */
  async remove(classroomId: string): Promise<void> {
    await this.client.connect()
    const fetchJson = (this.client as unknown as { fetchJson(path: string, init?: RequestInit): Promise<{ json: unknown }> }).fetchJson.bind(this.client)
    await fetchJson(`/api/stages/${encodeURIComponent(classroomId)}`, { method: 'DELETE' })
  }

  /** 一次取回整份课堂文档（stage + scenes + outline），云端实测与 manifest+scenes 逐字段等价。 */
  async document(classroomId: string): Promise<{ stage: Record<string, unknown>; scenes: Array<Record<string, unknown>>; outline?: unknown; dslVersion?: unknown }> {
    await this.client.connect()
    const fetchJson = (this.client as unknown as { fetchJson(path: string): Promise<{ json: unknown }> }).fetchJson.bind(this.client)
    const response = await fetchJson(`/api/stages/${encodeURIComponent(classroomId)}`)
    const json = (response.json ?? {}) as { stage?: Record<string, unknown>; scenes?: Array<Record<string, unknown>>; outline?: unknown; dslVersion?: unknown }
    if (!json.stage || !Array.isArray(json.scenes)) throw new CloudError('云端课堂文档格式不完整', undefined, 'BAD_DOCUMENT')
    const scenes = [...json.scenes].sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
    return { stage: json.stage, scenes, ...(json.outline !== undefined ? { outline: json.outline } : {}), ...(json.dslVersion !== undefined ? { dslVersion: json.dslVersion } : {}) }
  }
}

/** 课程目录下的课堂存储。所有路径都经过 id 白名单与真实路径包含检查。 */
export class ClassroomStore {
  constructor(private readonly courseRoot: string) {}

  private dir(classroomId: string) {
    classroomIdSchema.parse(classroomId)
    return join(this.courseRoot, 'classrooms', classroomId)
  }

  /** 已下载到本地的课堂（只列出 classroom.json 与 meta.json 都齐全的目录）。 */
  async list(): Promise<ClassroomMeta[]> {
    const root = join(this.courseRoot, 'classrooms')
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const metas: ClassroomMeta[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !classroomIdSchema.safeParse(entry.name).success) continue
      const meta = await jsonFile<ClassroomMeta>(join(root, entry.name, 'meta.json')).catch(() => null)
      const hasDoc = await readFile(join(root, entry.name, 'classroom.json')).then(() => true, () => false)
      if (meta && hasDoc) metas.push(meta)
    }
    return metas.sort((a, b) => b.fetchedAt - a.fetchedAt)
  }

  /** 原子写入：先写 classroom.json，再写 meta.json；列表以 meta 为准，因此半成品不会出现。 */
  async save(meta: ClassroomMeta, document: unknown) {
    const dir = this.dir(meta.classroomId)
    await atomicJson(join(dir, 'classroom.json'), document)
    await atomicJson(join(dir, 'meta.json'), meta)
  }

  /** 删除本地保存的课堂（含进度）。目标必须落在 classrooms/ 内，且不能是目录链接。 */
  async remove(classroomId: string): Promise<boolean> {
    const dir = this.dir(classroomId)
    const resolvedRoot = await realpath(join(this.courseRoot, 'classrooms')).catch(() => null)
    const resolvedDir = await realpath(dir).catch(() => null)
    if (!resolvedRoot || !resolvedDir || !resolvedDir.startsWith(resolvedRoot + sep)) return false
    await rm(resolvedDir, { recursive: true, force: true })
    return true
  }

  async read(classroomId: string) {
    const dir = this.dir(classroomId)
    const resolvedRoot = await realpath(join(this.courseRoot, 'classrooms')).catch(() => null)
    const resolvedDir = await realpath(dir).catch(() => null)
    if (!resolvedRoot || !resolvedDir || !resolvedDir.startsWith(resolvedRoot + sep)) return null
    const [meta, document, progress] = await Promise.all([
      jsonFile<ClassroomMeta>(join(resolvedDir, 'meta.json')).catch(() => null),
      jsonFile<unknown>(join(resolvedDir, 'classroom.json')).catch(() => null),
      jsonFile<ClassroomProgress>(join(resolvedDir, 'progress.json')).catch(() => null),
    ])
    if (!meta || !document) return null
    return { meta, document, progress: progress ?? { sceneId: null, answers: {}, updatedAt: 0 } }
  }

  async saveProgress(classroomId: string, progress: ClassroomProgress) {
    await atomicJson(join(this.dir(classroomId), 'progress.json'), progress)
  }
}

/** 把云端错误转成可读、不含口令的提示。 */
export function classroomFailure(error: unknown): { code: string; message: string } {
  if (error instanceof CloudError) {
    if (error.code === 'UNAUTHORIZED' || error.status === 401) return { code: 'CLOUD_UNAUTHORIZED', message: '云端拒绝了访问口令，请在设置中检查虚拟课堂的连接配置。' }
    if (error.code === 'UNREACHABLE') return { code: 'CLOUD_UNREACHABLE', message: '无法连接云端课堂服务，请检查网络或服务地址后重试。' }
    if (error.code === 'TIMEOUT') return { code: 'CLOUD_TIMEOUT', message: '云端生成超时；任务可能仍在云端继续，稍后可在课堂列表刷新查看。' }
    if (error.status === 409) return { code: 'CLOUD_CONFLICT', message: '云端配置已被修改，请稍后重试。' }
    if ((error.status ?? 0) === 413) return { code: 'CLOUD_LIMIT', message: '资料超出云端限制（单份 50 MB、合计 150 MB）。请减少选择的资料。' }
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/No model is configured/i.test(message)) return { code: 'CLOUD_MODEL_MISSING', message: '云端尚未配置生成模型，请先在设置中为虚拟课堂配置模型。' }
  return { code: 'CLOUD_GENERATION_FAILED', message: '云端课堂生成未完成，未保存半成品。请稍后重试或调整需求。' }
}
