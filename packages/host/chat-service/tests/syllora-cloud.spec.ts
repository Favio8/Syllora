/**
 * 云端客户端契约测试。
 *
 * 用一个真实的 HTTP 服务器模拟 OpenMAIC，验证客户端的网络行为：
 * 访问码换 cookie、把 cookie 带到后续请求、资料上传的头部与字节、
 * 生成任务的轮询与终态判定、以及错误归类（401 / 未连通 / 业务错误）。
 *
 * 这些断言对着实测过的线上契约写，不是对着实现写的——实现改了但契约没变时应当仍然通过。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { CloudError, OpenMaicCloud } from '../src/syllora-cloud.ts'

interface Recorded { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }

let server: Server | null = null
const requests: Recorded[] = []

/** 启动一个可编程的假云端，返回其根地址。 */
async function startCloud(handler: (req: Recorded, res: ServerResponse) => void): Promise<string> {
  requests.length = 0
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const recorded: Recorded = { method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body: Buffer.concat(chunks) }
      requests.push(recorded)
      handler(recorded, res)
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server!.address()
  if (!address || typeof address === 'string') throw new Error('无法获取测试服务器端口')
  return `http://127.0.0.1:${address.port}`
}

function json(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(payload))
}

afterEach(async () => {
  if (server) { await new Promise<void>(resolve => server!.close(() => resolve())); server = null }
})

const config = (baseUrl: string) => ({ baseUrl, accessCode: 'test-access-code' })

describe('OpenMaicCloud 鉴权', () => {
  it('用访问码换 cookie，并把它带到后续请求', async () => {
    const base = await startCloud((req, res) => {
      if (req.url === '/api/access-code/verify') {
        json(res, 200, { success: true, valid: true }, {
          'set-cookie': 'openmaic_access=abc123.def456; Path=/; HttpOnly; SameSite=lax',
        })
        return
      }
      if (req.url?.startsWith('/api/generate-classroom/capabilities')) {
        json(res, 200, { success: true, capabilities: { tts: false }, materials: { maxCount: 5 } })
        return
      }
      json(res, 404, { error: 'unexpected' })
    })
    const cloud = new OpenMaicCloud(config(base))
    const caps = await cloud.capabilities()
    expect(caps.materials.maxCount).toBe(5)

    // 校验请求不带 cookie；能力请求必须带上换来的 cookie
    expect(requests[0]!.headers.cookie).toBeUndefined()
    expect(requests[1]!.headers.cookie).toBe('openmaic_access=abc123.def456')
  })

  it('访问码被拒时归类为 UNAUTHORIZED，而不是笼统失败', async () => {
    const base = await startCloud((_req, res) => json(res, 401, { error: 'Access code required' }))
    const cloud = new OpenMaicCloud(config(base))
    await expect(cloud.connect()).rejects.toThrowError(/访问口令/)
    await expect(cloud.connect()).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 })
  })

  it('云端不可达时给出可定位的错误（含地址）', async () => {
    // 端口 1 不会有服务监听
    const cloud = new OpenMaicCloud({ baseUrl: 'http://127.0.0.1:1', accessCode: 'x' })
    await expect(cloud.connect()).rejects.toBeInstanceOf(CloudError)
    await expect(cloud.connect()).rejects.toMatchObject({ code: 'UNREACHABLE' })
    await expect(cloud.connect()).rejects.toThrowError(/127\.0\.0\.1:1/)
  })
})

describe('OpenMaicCloud 资料上传', () => {
  it('按云端契约发送 content-type 与 x-material-filename，并解析 materialId', async () => {
    const base = await startCloud((req, res) => {
      if (req.url === '/api/access-code/verify') {
        json(res, 200, { success: true }, { 'set-cookie': 'openmaic_access=token1; Path=/' })
        return
      }
      if (req.url === '/api/materials') {
        json(res, 201, { materialId: 'mat_abc', originalName: '第一章.md', bytes: 12, mime: 'text/markdown' })
        return
      }
      json(res, 404, {})
    })
    const cloud = new OpenMaicCloud(config(base))
    const bytes = new TextEncoder().encode('# 第一章\n\n内容')
    const material = await cloud.uploadMaterial('第一章.md', bytes, 'text/markdown')

    expect(material.materialId).toBe('mat_abc')
    const upload = requests.find(item => item.url === '/api/materials')!
    expect(upload.method).toBe('POST')
    expect(upload.headers['content-type']).toBe('text/markdown')
    expect(upload.headers['x-material-filename']).toBe(encodeURIComponent('第一章.md'))
    // 上传的是原始字节，不是被二次编码的字符串
    expect(upload.body.equals(Buffer.from(bytes))).toBe(true)
  })
})

describe('OpenMaicCloud 生成与轮询', () => {
  it('发起生成并轮询到成功，返回 classroomId 与进度', async () => {
    let polls = 0
    const base = await startCloud((req, res) => {
      if (req.url === '/api/access-code/verify') { json(res, 200, {}, { 'set-cookie': 'openmaic_access=t; Path=/' }); return }
      if (req.url === '/api/generate-classroom' && req.method === 'POST') {
        json(res, 202, { success: true, jobId: 'job1', status: 'queued', pollIntervalMs: 5000 })
        return
      }
      if (req.url === '/api/generate-classroom/job1') {
        polls += 1
        if (polls < 2) { json(res, 200, { success: true, jobId: 'job1', status: 'running', step: 'scenes', progress: 40, done: false }); return }
        // 如实模拟云端：产物在 `result` 下，不在顶层
        json(res, 200, {
          success: true, jobId: 'job1', status: 'succeeded', step: 'completed', progress: 100, done: true,
          result: { classroomId: 'cls_1', url: 'http://cloud/classroom/cls_1', scenesCount: 4 },
        })
        return
      }
      json(res, 404, {})
    })
    const cloud = new OpenMaicCloud(config(base))
    const jobId = await cloud.generateClassroom('生成第一章', ['mat_abc'])
    expect(jobId).toBe('job1')

    const seen: number[] = []
    const status = await cloud.waitForJob(jobId, { intervalMs: 10, onProgress: current => { seen.push(current.progress ?? -1) } })
    expect(status.status).toBe('succeeded')
    expect(status.classroomId).toBe('cls_1')
    expect(status.scenesGenerated).toBe(4)
    expect(seen).toEqual([40, 100])

    const start = requests.find(item => item.url === '/api/generate-classroom' && item.method === 'POST')!
    expect(JSON.parse(start.body.toString())).toEqual({ requirement: '生成第一章', materialIds: ['mat_abc'] })
  })

  it('云端把失败原因放在 error 字段，客户端原样带出（这是无模型 Key 时的真实响应）', async () => {
    const base = await startCloud((req, res) => {
      if (req.url === '/api/access-code/verify') { json(res, 200, {}, { 'set-cookie': 'openmaic_access=t; Path=/' }); return }
      if (req.url === '/api/generate-classroom') { json(res, 202, { jobId: 'job2', status: 'queued' }); return }
      json(res, 200, {
        jobId: 'job2', status: 'failed', step: 'failed', progress: 5, scenesGenerated: 0, done: true,
        error: 'No model is configured for course.outline. Set one in the model settings, or assign the slot (or an ancestor) in openmaic.yml.',
      })
    })
    const cloud = new OpenMaicCloud(config(base))
    const jobId = await cloud.generateClassroom('x', ['mat'])
    const status = await cloud.waitForJob(jobId)
    expect(status.status).toBe('failed')
    expect(status.error).toContain('No model is configured')
    expect(status.scenesGenerated).toBe(0)
  })

  it('取消（check 抛错）会中断轮询，不继续空转', async () => {
    let polls = 0
    const base = await startCloud((req, res) => {
      if (req.url === '/api/access-code/verify') { json(res, 200, {}, { 'set-cookie': 'openmaic_access=t; Path=/' }); return }
      if (req.url === '/api/generate-classroom') { json(res, 202, { jobId: 'job3', status: 'queued' }); return }
      polls += 1
      json(res, 200, { jobId: 'job3', status: 'running', step: 'x', done: false })
    })
    const cloud = new OpenMaicCloud(config(base))
    await cloud.generateClassroom('x', ['mat'])
    await expect(cloud.waitForJob('job3', { check: async () => { throw new Error('CANCELLED') } }))
      .rejects.toThrowError('CANCELLED')
    expect(polls).toBe(0)
  })
})

describe('OpenMaicCloud 取回场景', () => {
  it('先读 manifest 再按 id 批量取场景，并兼容多种返回形态', async () => {
    const base = await startCloud((req, res) => {
      if (req.url === '/api/access-code/verify') { json(res, 200, {}, { 'set-cookie': 'openmaic_access=t; Path=/' }); return }
      if (req.url === '/api/stages/cls_1/manifest') {
        json(res, 200, { success: true, scenes: [{ id: 's1' }, { id: 's2' }] })
        return
      }
      if (req.url?.startsWith('/api/stages/cls_1/scenes')) {
        json(res, 200, { success: true, scenes: [{ id: 's1', title: '一' }, { id: 's2', title: '二' }] })
        return
      }
      json(res, 404, {})
    })
    const cloud = new OpenMaicCloud(config(base))
    const scenes = await cloud.scenes('cls_1')
    expect(scenes.map(scene => scene.id)).toEqual(['s1', 's2'])
    const fetch = requests.find(item => item.url?.startsWith('/api/stages/cls_1/scenes'))!
    // 逗号在查询串里是合法的子分隔符，URL 不会转义它
    expect(fetch.url).toBe('/api/stages/cls_1/scenes?ids=s1,s2')
  })

  it('manifest 为空时不发多余的场景请求', async () => {
    const base = await startCloud((req, res) => {
      if (req.url === '/api/access-code/verify') { json(res, 200, {}, { 'set-cookie': 'openmaic_access=t; Path=/' }); return }
      if (req.url === '/api/stages/empty/manifest') { json(res, 200, { scenes: [] }); return }
      json(res, 404, {})
    })
    const cloud = new OpenMaicCloud(config(base))
    await expect(cloud.scenes('empty')).resolves.toEqual([])
    expect(requests.some(item => item.url?.includes('/scenes'))).toBe(false)
  })
})

describe('OpenMaicCloud 代填模型配置', () => {
  it('先写供应商，再按 <provider>:<model> 校验，最后写根槽位 llm', async () => {
    const puts: unknown[] = []
    const base = await startCloud((req, res) => {
      if (req.url === '/api/access-code/verify') { json(res, 200, {}, { 'set-cookie': 'openmaic_access=t; Path=/' }); return }
      if (req.url === '/api/verify-model') { json(res, 200, { success: true, message: 'Connection successful' }); return }
      if (req.url === '/api/model-config' && req.method === 'GET') {
        json(res, 200, { revision: puts.length, slots: {} })
        return
      }
      if (req.url === '/api/model-config' && req.method === 'PUT') {
        puts.push(JSON.parse(req.body.toString()))
        json(res, 200, { revision: puts.length, slots: {} })
        return
      }
      json(res, 404, {})
    })
    const cloud = new OpenMaicCloud(config(base))
    await cloud.configureModel({ providerId: 'deepseek', preset: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' })

    // 供应商必须在校验之前写入：verify-model 用已保存的供应商解析凭据
    expect(puts).toHaveLength(2)
    expect(puts[0]).toMatchObject({ revision: 0, change: { kind: 'provider', id: 'deepseek', preset: 'deepseek', apiKey: 'sk-test' } })
    // 槽位只需写根槽位 llm：course.outline / course.content 等子槽位未显式赋值时继承它
    expect(puts[1]).toMatchObject({ revision: 1, change: { kind: 'slots', set: { llm: 'deepseek:deepseek-v4-flash' } } })

    // 校验用 <provider>:<model>，且不传 providerType——它是协议类型而不是预设名，
    // 传预设名会被服务端拒绝（Provider type mismatch）
    const verify = requests.find(item => item.url === '/api/verify-model')!
    const body = JSON.parse(verify.body.toString())
    expect(body).toMatchObject({ model: 'deepseek:deepseek-v4-flash', apiKey: 'sk-test' })
    expect(body.providerType).toBeUndefined()
    const putIndex = requests.findIndex(item => item.method === 'PUT')
    const verifyIndex = requests.findIndex(item => item.url === '/api/verify-model')
    expect(putIndex).toBeLessThan(verifyIndex)
  })

  it('已保存的供应商引用不可解析时，回退到直传凭据的校验形式', async () => {
    let verifyCalls = 0
    const base = await startCloud((req, res) => {
      if (req.url === '/api/access-code/verify') { json(res, 200, {}, { 'set-cookie': 'openmaic_access=t; Path=/' }); return }
      if (req.url === '/api/verify-model') {
        verifyCalls += 1
        // 第一次（按引用）失败，第二次（直传凭据）成功
        if (verifyCalls === 1) { json(res, 401, { success: false, error: 'unknown provider' }); return }
        json(res, 200, { success: true })
        return
      }
      if (req.url === '/api/model-config') {
        if (req.method === 'PUT') { json(res, 200, { revision: 1 }); return }
        json(res, 200, { revision: 0 })
        return
      }
      json(res, 404, {})
    })
    const cloud = new OpenMaicCloud(config(base))
    await cloud.configureModel({ providerId: 'deepseek', preset: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' })
    expect(verifyCalls).toBe(2)
    const second = requests.filter(item => item.url === '/api/verify-model')[1]!
    expect(JSON.parse(second.body.toString())).toMatchObject({
      model: 'deepseek-v4-flash',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
    })
  })

  it('Key 校验不通过时抛出，且不写入槽位', async () => {
    const base = await startCloud((req, res) => {
      if (req.url === '/api/access-code/verify') { json(res, 200, {}, { 'set-cookie': 'openmaic_access=t; Path=/' }); return }
      if (req.url === '/api/verify-model') { json(res, 401, { success: false, error: 'invalid api key' }); return }
      if (req.url === '/api/model-config') { json(res, 200, { revision: 0 }); return }
      json(res, 404, {})
    })
    const cloud = new OpenMaicCloud(config(base))
    await expect(cloud.configureModel({ providerId: 'p', preset: 'p', model: 'm', apiKey: 'bad' }))
      .rejects.toBeInstanceOf(CloudError)
    // 供应商已写入一次；校验失败后不得继续写槽位
    expect(requests.filter(item => item.method === 'PUT')).toHaveLength(1)
  })
})
