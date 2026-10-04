/**
 * 虚拟课堂（云端 OpenMAIC 生成 → 本地保存与播放）。
 *
 * 用一个真实的本地 HTTP 服务器冒充云端，跑通「合并资料 → 上传 → 发起生成 →
 * 轮询 → 取回整份课堂 → 落课程目录」全链路，并守住几条关键契约：
 *  - 课堂 id 只在 result.classroomId（顶层读不到）；
 *  - 轮询容忍瞬时失败，但授权类 4xx 立即停；
 *  - 未配置云端返回「未配置」而不是网络错误；
 *  - 非终态作业在取消/失败后不落半成品；
 *  - 本地存储只接受白名单 id，路径不越界；
 *  - 角色描述、附件暂存上限与失败映射的具体行为。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { SylloraProjects } from '../src/syllora-projects.ts'
import { cloudConfigPayload, setCloudConfig } from '../src/settings.ts'
import { resolveCloudConfig } from '../src/config.ts'
import { CloudError } from '../src/syllora-cloud.ts'
import {
  ClassroomAttachments, ClassroomStore, classroomFailure, classroomMaterialMarkdown, classroomRolesBrief,
  sceneTypeCounts, type ClassroomMeta,
} from '../src/syllora-classroom.ts'

const temp = resolve('..', 'tmp', 'syllora-classroom-tests'), roots: string[] = []
const savedHome = process.env.SYLLORA_HOME
let server: Server | null = null

afterEach(async () => {
  if (savedHome === undefined) delete process.env.SYLLORA_HOME; else process.env.SYLLORA_HOME = savedHome
  if (server) { const current = server; server = null; await new Promise<void>(done => current.close(() => done())) }
  for (const root of roots.splice(0)) { if (!root.startsWith(temp)) throw new Error('unsafe test cleanup'); await rm(root, { recursive: true, force: true }) }
})

async function scratch(): Promise<string> {
  await mkdir(temp, { recursive: true })
  const root = await mkdtemp(join(temp, 'case-')); roots.push(root)
  // 主密钥与运行目录都指向本次临时目录，绝不触碰真实 ~/.syllora。
  process.env.SYLLORA_HOME = join(root, 'home')
  return root
}

/** 合成课程：一份资料、两个来源、一个知识点。 */
const courseFixture = (id: string) => ({
  id, name: '合成课堂课程', timezone: 'Asia/Shanghai', archived: false, createdAt: Date.now(),
  materials: [{
    id: '00000000-0000-4000-8000-0000000000aa', name: '讲义.txt', fingerprint: 'fixture', status: 'ready', accepted: true, pages: 0,
    sources: [
      { id: 's1', materialId: '00000000-0000-4000-8000-0000000000aa', anchor: '§1 定义', text: '勾股定理：直角三角形两直角边平方和等于斜边平方。' },
      { id: 's2', materialId: '00000000-0000-4000-8000-0000000000aa', anchor: '§2 例题', text: '例：3、4、5 构成直角三角形。' },
    ],
  }],
  points: [{ id: '00000000-0000-4000-8000-0000000000bb', name: '勾股定理', chapter: '第一章', sourceIds: ['s1', 's2'] }],
  scope: [], plan: null, draft: null, questions: [], attempts: [], messages: [], actions: [], drafts: { prompt: '', answers: [] }, changes: [], notice: null,
})

/**
 * 合成课程目录：先用一个临时实例打开文件夹拿到课程 id，写入课程状态（与宿主落盘
 * 的 Database 信封同形），再用真正参与断言的实例重新打开——服务在首次事务读取时
 * 缓存 state，因此状态必须就位之后再建实例。
 */
async function setup(options: NonNullable<ConstructorParameters<typeof SylloraProjects>[1]> = {}) {
  const root = await scratch()
  const app = join(root, 'app'), folder = join(root, 'course')
  await mkdir(folder, { recursive: true })
  const throwaway = new SylloraProjects(app)
  const first = await throwaway.handle('openCourse', { path: folder }) as { id: string }
  await writeFile(join(folder, '.syllora', 'course.json'), JSON.stringify({ version: 1, courses: [courseFixture(first.id)], jobs: [], consent: true, calls: 0 }), 'utf8')
  const projects = new SylloraProjects(app, options)
  const opened = await projects.handle('openCourse', { path: folder }) as { id: string }
  if (opened.id !== first.id) throw new Error('合成课程 id 不稳定')
  return { root, app, folder, id: opened.id, projects }
}

interface Recorded { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }
const requests: Recorded[] = []

/** 假云端：按云端实测契约应答；handler 可覆盖单条响应。 */
async function startCloud(handler?: (req: Recorded, res: ServerResponse) => boolean): Promise<string> {
  requests.length = 0
  const scenes = [
    { id: 'scene_1', type: 'slide', order: 1, title: '导入', content: { type: 'slide', canvas: { viewportSize: 1000, viewportRatio: 0.5625, elements: [{ id: 't1', type: 'text', left: 40, top: 40, width: 900, height: 80, content: '<p>勾股定理</p>' }] } } },
    { id: 'scene_2', type: 'quiz', order: 2, title: '小测', content: { type: 'quiz', questions: [{ id: 'q1', type: 'single', question: '3-4-5 是直角三角形吗？', options: [{ label: 'A', value: '是' }, { label: 'B', value: '否' }], answer: ['A'], analysis: '满足平方和。' }] } },
    { id: 'scene_3', type: 'interactive', order: 3, title: '交互演示', content: { type: 'interactive', url: 'https://example.test/w.html', widgetType: 'demo' } },
  ]
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const recorded: Recorded = { method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body: Buffer.concat(chunks) }
      requests.push(recorded)
      if (handler?.(recorded, res)) return
      const json = (target: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}) => { target.writeHead(status, { 'content-type': 'application/json', ...headers }); target.end(JSON.stringify(payload)) }
      if (recorded.url === '/api/access-code/verify') { json(res, 200, { success: true }, { 'set-cookie': 'openmaic_access=test-cookie; Path=/; HttpOnly' }); return }
      if (recorded.url === '/api/materials') { json(res, 201, { materialId: `mat_${requests.length}`, originalName: '资料.md', bytes: recorded.body.length, mime: 'text/markdown' }); return }
      if (recorded.url === '/api/generate-classroom/capabilities') { json(res, 200, { capabilities: { webSearch: false, imageGeneration: false, videoGeneration: false, tts: false }, materials: { formats: ['pdf', 'txt', 'markdown'], maxCount: 5, maxTotalBytes: 157286400, maxDocumentBytes: 52428800 } }); return }
      if (recorded.url === '/api/generate-classroom' && recorded.method === 'POST') { json(res, 202, { jobId: 'cloudjob_1', status: 'queued', step: 'queued', pollIntervalMs: 5000 }); return }
      if (recorded.url === '/api/generate-classroom/cloudjob_1') { json(res, 200, { success: true, jobId: 'cloudjob_1', status: 'succeeded', step: 'completed', progress: 100, scenesGenerated: 3, totalScenes: 3, result: { classroomId: 'stage-ABC123', url: 'https://studyandchat.top/classroom/stage-ABC123', scenesCount: 3 }, done: true }); return }
      if (recorded.url === '/api/stages' && recorded.method === 'GET') { json(res, 200, { stages: [{ id: 'stage-ABC123', name: '勾股定理课堂', createdAt: Date.now() - 60_000, updatedAt: Date.now() - 30_000, sceneCount: scenes.length }] }); return }
      if (recorded.url === '/api/stages/stage-ABC123/manifest') { json(res, 200, { rev: 1, scenes: scenes.map((scene, index) => ({ id: scene.id, order: index + 1, rev: 1 })) }); return }
      if (recorded.url?.startsWith('/api/stages/stage-ABC123/scenes') === true) {
        const ids = (decodeURIComponent(recorded.url.split('ids=')[1] ?? '')).split(',').filter(Boolean)
        json(res, 200, { scenes: scenes.filter(scene => ids.includes(scene.id)) }); return
      }
      if (recorded.url === '/api/stages/stage-ABC123' && recorded.method === 'DELETE') { json(res, 200, { success: true }); return }
      if (recorded.url === '/api/stages/stage-ABC123') { json(res, 200, { stage: { id: 'stage-ABC123', name: '勾股定理课堂' }, scenes, dslVersion: '1', outline: { outlines: [] } }); return }
      json(res, 404, { error: `unexpected ${recorded.url}` })
    })
  })
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done))
  const address = server!.address()
  if (!address || typeof address === 'string') throw new Error('无法获取测试服务器端口')
  return `http://127.0.0.1:${address.port}`
}

const cloudConfig = (baseUrl: string) => async () => ({ baseUrl, accessCode: 'fixture-code' })

/** 轮询作业状态直到满足断言（worker 在后台跑，固定 sleep 会因为调度抖动而不稳定）。 */
async function waitForJob(
  projects: SylloraProjects, courseId: string, jobId: string,
  predicate: (job: { status: string; step: string; progress?: number | undefined }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = await projects.classroomJob(courseId, jobId) as { status: string; step: string; progress?: number | undefined }
    if (predicate(job)) return job
    if (Date.now() > deadline) throw new Error(`等待作业状态超时：当前 ${job.status}/${job.step}`)
    await new Promise<void>(done => setTimeout(done, 25))
  }
}

describe('虚拟课堂：资料合并与场景统计', () => {
  it('merges the selected materials into one markdown with anchors, and counts scene types without dropping any', () => {
    const course = courseFixture('id') as never
    const { markdown, sources } = classroomMaterialMarkdown(course, [])
    expect(markdown).toContain('# 讲义.txt')
    expect(markdown).toContain('## §1 定义')
    expect(markdown).toContain('勾股定理：直角三角形两直角边平方和等于斜边平方。')
    expect(sources.map(source => source.id)).toEqual(['s1', 's2'])
    // 选中的资料 id 之外不参与合并。
    expect(classroomMaterialMarkdown(course, ['00000000-0000-4000-8000-0000000000cc']).markdown).toBe('')

    expect(sceneTypeCounts([
      { type: 'slide' }, { type: 'slide' }, { content: { type: 'quiz' } }, { type: 'interactive' },
    ])).toEqual({ slide: 2, quiz: 1, interactive: 1 })
  })

  it('describes classroom roles without inventing personas the user did not set', () => {
    expect(classroomRolesBrief([])).toBe('')
    const brief = classroomRolesBrief([
      { name: '小艾', kind: 'teacher', persona: '耐心，多用生活例子' },
      { name: '阿布', kind: 'student', voice: 'zh-CN-XiaoxiaoNeural' },
    ])
    expect(brief).toContain('主讲教师「小艾」：耐心，多用生活例子')
    expect(brief).toContain('学生「阿布」（音色 zh-CN-XiaoxiaoNeural）')
  })
})

describe('虚拟课堂：本地存储与失败映射', () => {
  it('rejects ids outside the whitelist and never reads outside classrooms/', async () => {
    const root = await scratch()
    const store = new ClassroomStore(root)
    await expect(store.read('../secrets')).rejects.toThrowError()
    expect(await store.read('does-not-exist')).toBeNull()
  })

  it('maps cloud failures to readable codes without echoing the access code', () => {
    expect(classroomFailure(new CloudError('云端拒绝了访问口令（401）。请检查 config.yaml 的 cloud.accessCode', 401, 'UNAUTHORIZED'))).toEqual({ code: 'CLOUD_UNAUTHORIZED', message: expect.stringContaining('访问口令') })
    expect(classroomFailure(new CloudError('无法连接云端', undefined, 'UNREACHABLE')).code).toBe('CLOUD_UNREACHABLE')
    expect(classroomFailure(new CloudError('云端生成超时', undefined, 'TIMEOUT')).code).toBe('CLOUD_TIMEOUT')
    expect(classroomFailure(new Error('No model is configured for course.outline')).code).toBe('CLOUD_MODEL_MISSING')
    expect(classroomFailure(new Error('随便什么上游错误')).code).toBe('CLOUD_GENERATION_FAILED')
    expect(classroomFailure(new Error('ACCESS_CODE=fixture-code')).message).not.toContain('fixture-code')
  })

  it('bounds staged attachments by count and total bytes and consumes them once', async () => {
    const attachments = new ClassroomAttachments()
    const course = randomUUID(), other = randomUUID()
    const first = attachments.add(course, 'a.md', 'text/markdown', new Uint8Array(10))
    attachments.add(course, 'b.md', 'text/markdown', new Uint8Array(10))
    attachments.add(course, 'c.md', 'text/markdown', new Uint8Array(10))
    attachments.add(course, 'd.md', 'text/markdown', new Uint8Array(10))
    expect(() => attachments.add(course, 'e.md', 'text/markdown', new Uint8Array(10))).toThrowError(/最多 4 份/)
    expect(attachments.stats(course)).toEqual({ count: 4, bytes: 40, names: ['a.md', 'b.md', 'c.md', 'd.md'] })
    // 课程隔离：别的课程 id 取不到这份附件。
    expect(attachments.missing(other, [first.id])).toEqual([first.id])
    expect(attachments.missing(course, [first.id])).toEqual([])
    const { items, missing } = attachments.take(course, [first.id])
    expect(items).toHaveLength(1)
    expect(missing).toEqual([])
    // 一次性消费：第二次取同一 id 变成缺失。
    expect(attachments.take(course, [first.id]).missing).toEqual([first.id])
    attachments.clearCourse(course)
    expect(attachments.stats(course).count).toBe(0)
  })
})

describe('虚拟课堂：端到端（假云端）', () => {
  it('generates, fetches and stores a classroom, then reports it through job/get/list', async () => {
    const base = await startCloud()
    const s = await setup({ cloud: cloudConfig(base) })
    const projects = s.projects
    const opened = { id: s.id }
    const requestId = randomUUID()

    const started = await projects.handle('classroom/generate', {
      courseId: opened.id, requestId, requirement: '根据资料生成一节勾股定理入门课',
      materialIds: ['00000000-0000-4000-8000-0000000000aa'], attachmentIds: [],
      roles: [{ id: 'teacher-1', name: '小艾', kind: 'teacher', persona: '多用生活例子' }],
    }) as { jobId: string; status: string }
    expect(started.status).toBe('queued')
    // 幂等：同一 requestId 再次提交返回同一个作业，不会重复上云。
    const again = await projects.handle('classroom/generate', {
      courseId: opened.id, requestId, requirement: '根据资料生成一节勾股定理入门课', materialIds: ['00000000-0000-4000-8000-0000000000aa'], attachmentIds: [], roles: [],
    }) as { jobId: string }
    expect(again.jobId).toBe(started.jobId)

    const job = await waitForJob(projects, opened.id, started.jobId, state => state.status === 'succeeded')
    await projects.settleJobs(courseId => opened.id)
    expect(job.status).toBe('succeeded')
    expect(job.done).toBe(true)
    expect(job.classroomId).toBe('stage-ABC123')

    // 上传的是一份合并后的 Markdown，文件名走百分号编码的头部。
    const upload = requests.find(item => item.url === '/api/materials')
    expect(upload).toBeTruthy()
    expect(upload!.headers['x-material-filename']).toBe(encodeURIComponent('课程资料.md'))
    expect(upload!.body.toString('utf8')).toContain('## §1 定义')
    const generate = requests.find(item => item.url === '/api/generate-classroom')
    const payload = JSON.parse(generate!.body.toString('utf8')) as { requirement: string; materialIds: string[] }
    expect(payload.requirement).toContain('课堂角色设定')
    expect(payload.materialIds).toHaveLength(1)

    const stored = await projects.classroomGet(opened.id, 'stage-ABC123') as { meta: ClassroomMeta; scenes: unknown[]; stage: { name?: string } }
    expect(stored.stage.name).toBe('勾股定理课堂')
    expect(stored.scenes).toHaveLength(3)
    expect(stored.meta.sceneTypes).toEqual({ slide: 1, quiz: 1, interactive: 1 })
    expect(stored.meta.sourceCount).toBe(2)
    expect(stored.meta.classroomId).toBe('stage-ABC123')
    const listed = await projects.classroomList(opened.id) as { classrooms: ClassroomMeta[] }
    expect(listed.classrooms.map(item => item.classroomId)).toEqual(['stage-ABC123'])
    // 产物落在课程目录里（用户可见的普通文件夹），不是应用数据目录。
    const onDisk = JSON.parse(await readFile(join(s.folder, 'classrooms', 'stage-ABC123', 'classroom.json'), 'utf8')) as { scenes: unknown[] }
    expect(onDisk.scenes).toHaveLength(3)

    // 播放进度：仅本机阅读状态。
    await projects.classroomSaveProgress(opened.id, { classroomId: 'stage-ABC123', sceneId: 'scene_2', answers: { q1: ['A'] } })
    const after = await projects.classroomGet(opened.id, 'stage-ABC123') as { progress: { sceneId: string; answers: Record<string, string[]> } }
    expect(after.progress).toEqual({ sceneId: 'scene_2', answers: { q1: ['A'] }, updatedAt: expect.any(Number) })

    // 作业也进了课程的任务列表（前端「任务」页可见）。
    const state = await projects.handle('state', {}) as { jobs: Array<{ id: string; kind: string; state: string; message: string }> }
    const visible = state.jobs.find(item => item.id === started.jobId)
    expect(visible?.kind).toBe('classroom')
    expect(visible?.state).toBe('succeeded')
    expect(visible?.message).toContain('3 个场景')
  })

  it('tolerates transient polling failures but stops immediately on a rejected access code', async () => {
    let polls = 0
    const base = await startCloud((req, res) => {
      if (req.url === '/api/generate-classroom/cloudjob_1') {
        polls += 1
        if (polls === 1) { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"bad gateway"}'); return true }
        return false
      }
      return false
    })
    const s = await setup({ cloud: cloudConfig(base) })
    const projects = s.projects
    const opened = { id: s.id }
    const started = await projects.handle('classroom/generate', {
      courseId: opened.id, requestId: randomUUID(), requirement: '生成本章课堂', materialIds: [], attachmentIds: [], roles: [],
    }) as { jobId: string }
    const job = await waitForJob(projects, opened.id, started.jobId, state => state.status === 'succeeded', 30_000)
    // 单次 5xx 不该判死整个任务：继续轮询直到成功。
    expect(job.status).toBe('succeeded')

    const rejected = await startCloud((req, res) => {
      if (req.url === '/api/generate-classroom/cloudjob_1') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"Access code required"}'); return true }
      return false
    })
    const other = await setup({ cloud: cloudConfig(rejected) })
    const projects2 = other.projects
    const opened2 = { id: other.id }
    const failed = await projects2.handle('classroom/generate', {
      courseId: opened2.id, requestId: randomUUID(), requirement: '生成本章课堂', materialIds: [], attachmentIds: [], roles: [],
    }) as { jobId: string }
    const job2 = await waitForJob(projects2, opened2.id, failed.jobId, state => state.status === 'failed')
    expect(job2.status).toBe('failed')
    expect(job2.done).toBe(true)
    expect(job2.error).toContain('访问口令')
    // 失败不留半成品。
    expect(await projects2.classroomList(opened2.id)).toEqual({ classrooms: [] })
  })

  it('reports an unconfigured cloud instead of a network error, and refuses to start without a course', async () => {
    const s = await setup()
    const projects = s.projects
    const capabilities = await projects.classroomCapabilities() as { configured: boolean; materials: { maxCount: number } }
    expect(capabilities.configured).toBe(false)
    expect(capabilities.materials.maxCount).toBe(5)
    await expect(projects.handle('classroom/generate', {
      courseId: s.id, requestId: randomUUID(), requirement: '生成本章课堂', materialIds: [], attachmentIds: [], roles: [],
    })).rejects.toMatchObject({ code: 'CLOUD_NOT_CONFIGURED' })
    // 没有可用正文时明确提示，不发网络请求。
    await expect(projects.handle('classroom/generate', {
      courseId: s.id, requestId: randomUUID(), requirement: '生成本章课堂', materialIds: ['00000000-0000-4000-8000-0000000000cc'], attachmentIds: [], roles: [],
    })).rejects.toMatchObject({ code: 'CLOUD_NOT_CONFIGURED' })
  })

  it('stages an attachment once and consumes it in the next generation', async () => {
    const base = await startCloud()
    const s = await setup({ cloud: cloudConfig(base) })
    const projects = s.projects
    const opened = { id: s.id }
    const staged = await projects.stageClassroomMaterial(opened.id, '补充阅读.md', 'text/markdown', new TextEncoder().encode('# 补充\n\n勾股数。')) as { attachmentId: string; count: number }
    expect(staged.count).toBe(1)
    expect((await projects.classroomAttachments(opened.id)).names).toEqual(['补充阅读.md'])

    // materialIds 显式指向一份不存在的资料：表示「不带课程资料，只带附件」。
    const started = await projects.handle('classroom/generate', {
      courseId: opened.id, requestId: randomUUID(), requirement: '带附件生成本章课堂', materialIds: ['00000000-0000-4000-8000-0000000000dd'], attachmentIds: [staged.attachmentId], roles: [],
    }) as { jobId: string }
    expect((await waitForJob(projects, opened.id, started.jobId, state => state.status === 'succeeded')).status).toBe('succeeded')
    // 只有附件、没有课程资料：上传的就是附件本身。
    const uploads = requests.filter(item => item.url === '/api/materials')
    expect(uploads).toHaveLength(1)
    expect(uploads[0]!.body.toString('utf8')).toContain('勾股数')
    expect((await projects.classroomAttachments(opened.id)).count).toBe(0)
  })

  it('cancels a running classroom job and never stores a partial classroom', async () => {
    let releasePoll: (() => void) | null = null
    const base = await startCloud((req, res) => {
      if (req.url === '/api/generate-classroom/cloudjob_1') {
        // 一直停在生成中，直到测试放行。
        if (releasePoll === null) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ success: true, jobId: 'cloudjob_1', status: 'running', step: 'generating_scenes', progress: 40, scenesGenerated: 2, totalScenes: 8, done: false }))
          return true
        }
        return false
      }
      return false
    })
    const s = await setup({ cloud: cloudConfig(base) })
    const projects = s.projects
    const opened = { id: s.id }
    const started = await projects.handle('classroom/generate', {
      courseId: opened.id, requestId: randomUUID(), requirement: '生成本章课堂', materialIds: [], attachmentIds: [], roles: [],
    }) as { jobId: string }
    const running = await waitForJob(projects, opened.id, started.jobId, state => state.status === 'running' && state.progress === 40)
    expect(running.progress).toBe(40)
    await projects.handle('cancel', { courseId: opened.id, jobId: started.jobId })
    releasePoll = () => undefined
    const cancelled = await waitForJob(projects, opened.id, started.jobId, state => state.status === 'cancelled')
    await projects.settleJobs(courseId => opened.id)
    expect(cancelled.status).toBe('cancelled')
    expect(await projects.classroomList(opened.id)).toEqual({ classrooms: [] })
  })

  it('stores the access code sealed in settings and never returns it', async () => {
    const root = await scratch()
    expect(await cloudConfigPayload(root)).toEqual({ configured: false, baseUrl: '', hasAccessCode: false, provider: '', preset: '', model: '', hasModelKey: false })
    const saved = await setCloudConfig(root, { baseUrl: 'https://studyandchat.top/', accessCode: 'fixture-access-code', provider: 'deepseek', preset: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-fixture' })
    expect(saved).toMatchObject({ configured: true, baseUrl: 'https://studyandchat.top', hasAccessCode: true, hasModelKey: true, model: 'deepseek-v4-flash' })
    expect(JSON.stringify(saved)).not.toContain('fixture-access-code')
    expect(JSON.stringify(saved)).not.toContain('sk-fixture')
    const configText = await readFile(join(root, '.syllora', 'config.yaml'), 'utf8')
    expect(configText).not.toContain('fixture-access-code')
    expect(configText).not.toContain('sk-fixture')
    expect(configText).toContain('access_code_env')
    const credentials = await readFile(join(root, '.syllora', 'credentials.json'), 'utf8')
    expect(credentials).not.toContain('fixture-access-code')
    // 解析层读得回来，且 baseUrl 去掉结尾斜杠。
    const resolved = await resolveCloudConfig([root])
    expect(resolved).toEqual({ baseUrl: 'https://studyandchat.top', accessCode: 'fixture-access-code', provider: 'deepseek', preset: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-fixture' })
    // partial 语义：省略字段保留，空串清除。
    const kept = await setCloudConfig(root, { model: '' })
    expect(kept.model).toBe('')
    expect(kept.configured).toBe(true)
    const cleared = await setCloudConfig(root, { accessCode: '' })
    expect(cleared.configured).toBe(false)
    expect(await resolveCloudConfig([root])).toBeNull()
  })
})

describe('虚拟课堂：增量取场景、删除、清除历史任务', () => {
  it('reads the scenes generated so far and adopts the generating stage from a jobId', async () => {
    const base = await startCloud()
    const s = await setup({ cloud: cloudConfig(base) })
    const projects = s.projects
    // 直接给 classroomId：按 manifest + scenes 取回当前已生成的全部页。
    const direct = await projects.classroomLive(projects === null ? '' : s.id, { classroomId: 'stage-ABC123' }) as { count: number; sceneTypes: Record<string, number>; generating: boolean }
    expect(direct.count).toBe(3)
    expect(direct.sceneTypes).toEqual({ slide: 1, quiz: 1, interactive: 1 })
    expect(direct.generating).toBe(false)
    // 只给 jobId：宿主用「课堂列表 + 作业开始时间」认领正在生成的那一份。
    const started = await projects.handle('classroom/generate', {
      courseId: s.id, requestId: randomUUID(), requirement: '生成本章课堂', materialIds: [], attachmentIds: [], roles: [],
    }) as { jobId: string }
    const adopted = await projects.classroomLive(s.id, { jobId: started.jobId }) as { classroomId: string | null; count: number }
    expect(adopted.classroomId).toBe('stage-ABC123')
    expect(adopted.count).toBe(3)
    await projects.settleJobs(courseId => courseId === s.id)
  })

  it('deletes a classroom locally, tells the cloud outcome, and refuses unknown ids', async () => {
    const base = await startCloud()
    const s = await setup({ cloud: cloudConfig(base) })
    const projects = s.projects
    const started = await projects.handle('classroom/generate', {
      courseId: s.id, requestId: randomUUID(), requirement: '生成本章课堂', materialIds: [], attachmentIds: [], roles: [],
    }) as { jobId: string }
    await waitForJob(projects, s.id, started.jobId, state => state.status === 'succeeded')
    await projects.settleJobs(courseId => courseId === s.id)
    expect((await projects.classroomList(s.id)).classrooms).toHaveLength(1)
    const deleted = await projects.classroomDelete(s.id, 'stage-ABC123', true) as { deleted: boolean; cloud: string }
    expect(deleted).toEqual({ deleted: true, cloud: 'deleted' })
    expect((await projects.classroomList(s.id)).classrooms).toEqual([])
    // 产物目录真的没了；重复删除如实报「不存在」。
    expect(await readFile(join(s.folder, 'classrooms', 'stage-ABC123', 'classroom.json'), 'utf8').catch(() => null)).toBeNull()
    await expect(projects.classroomDelete(s.id, 'stage-ABC123', false)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('dismisses finished job notifications while retaining recovery records', async () => {
    const base = await startCloud()
    const s = await setup({ cloud: cloudConfig(base) })
    const projects = s.projects
    const first = await projects.handle('classroom/generate', {
      courseId: s.id, requestId: randomUUID(), requirement: '生成本章课堂', materialIds: [], attachmentIds: [], roles: [],
    }) as { jobId: string }
    await waitForJob(projects, s.id, first.jobId, state => state.status === 'succeeded')
    await projects.settleJobs(courseId => courseId === s.id)
    const before = await projects.handle('state', {}) as { jobs: Array<{ id: string; state: string }> }
    expect(before.jobs.some(job => job.id === first.jobId && job.state === 'succeeded')).toBe(true)
    const cleared = await projects.handle('clearJobs', { courseId: s.id }) as { cleared: number }
    expect(cleared.cleared).toBeGreaterThanOrEqual(1)
    const after = await projects.handle('state', {}) as { jobs: Array<{ id: string; dismissedAt?: number }> }
    expect(after.jobs.find(job => job.id === first.jobId)?.dismissedAt).toBeGreaterThan(0)
    // 全局清除（不带 courseId）也要能跑。
    expect((await projects.handle('clearJobs', {}) as { cleared: number }).cleared).toBe(0)
  })
})

describe('虚拟课堂：音频读取边界', () => {
  it('reads only narration referenced by the saved classroom and keeps cloud credentials server-side', async () => {
    const base = await startCloud((req, res) => {
      if (!req.url.startsWith('/api/persistence/assets/')) return false
      expect(req.headers.cookie).toBe('openmaic_access=test-cookie')
      res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(Buffer.from('RIFF-audio-fixture')); return true
    })
    const s = await setup({ cloud: cloudConfig(base) })
    await new ClassroomStore(s.folder).save({ classroomId: 'stage-audio', title: '声音', requirement: '', materialIds: [], sourceCount: 0, sceneCount: 1, sceneTypes: { slide: 1 }, generatedAt: 1, fetchedAt: 1, cloudBase: base }, {
      scenes: [{ id: 'scene-audio', actions: [{ type: 'speech', audioId: 'ast_audio' }] }],
    })
    const input = { courseId: s.id, classroomId: 'stage-audio', sceneId: 'scene-audio', audioId: 'ast_audio' }
    const result = await s.projects.handle('classroom/audio', input)
    expect(result).toEqual({ mime: 'audio/wav', base64: Buffer.from('RIFF-audio-fixture').toString('base64') })
    const count = requests.length
    await expect(s.projects.handle('classroom/audio', { ...input, audioId: 'ast_other' })).rejects.toThrow('不属于当前课堂')
    await expect(s.projects.handle('classroom/audio', { ...input, sceneId: 'other' })).rejects.toThrow('不属于当前课堂')
    await expect(s.projects.handle('classroom/audio', { ...input, classroomId: 'stage-other' })).rejects.toThrow('不属于当前课堂')
    await expect(s.projects.handle('classroom/audio', { ...input, classroomId: '../secret' })).rejects.toThrow()
    await expect(s.projects.handle('classroom/audio', { ...input, courseId: randomUUID() })).rejects.toThrow()
    expect(requests).toHaveLength(count)
  })
})

describe('任务通知持久化', () => {
  it('dismisses only the selected course job and survives reopening without losing the result', async () => {
    const base = await startCloud(); const s = await setup({ cloud: cloudConfig(base) });
    const input = { courseId: s.id, requestId: randomUUID(), requirement: '生成本章课堂', materialIds: [], attachmentIds: [], roles: [] };
    const first = await s.projects.handle('classroom/generate', input) as { jobId: string };
    await expect(s.projects.handle('dismissJob', { courseId: s.id, jobId: first.jobId })).rejects.toMatchObject({ code: 'JOB_RUNNING' });
    await waitForJob(s.projects, s.id, first.jobId, state => state.status === 'succeeded');
    await s.projects.settleJobs(() => true);
    await expect(s.projects.handle('dismissJob', { courseId: randomUUID(), jobId: first.jobId })).rejects.toThrow();
    await expect(s.projects.handle('dismissJob', { courseId: s.id, jobId: first.jobId })).resolves.toEqual({ dismissed: true });
    const restored = new SylloraProjects(s.app, { cloud: cloudConfig(base) });
    const state = await restored.handle('state', {}) as { jobs: Array<{ id: string; dismissedAt?: number }> };
    expect(state.jobs.find(job => job.id === first.jobId)?.dismissedAt).toBeGreaterThan(0);
    expect((await restored.classroomList(s.id)).classrooms).toHaveLength(1);
    expect((await restored.handle('classroom/generate', input) as { jobId: string }).jobId).toBe(first.jobId);
  });
});
