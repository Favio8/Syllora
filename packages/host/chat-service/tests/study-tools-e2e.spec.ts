/**
 * Study-tool e2e: a mock OpenAI-compatible SSE server drives the real tool
 * loop and the agent must read the Syllora course snapshot through the new
 * read-only tools (`get_study_plan` / `read_material`). Pins both the tool
 * projection and the fact that the model receives the snapshot text.
 */

import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chatStream } from '../src/service.ts'
import { loadChatConfig } from '../src/config.ts'
import { buildPlan, type Course, type Question } from '../src/syllora-domain.ts'

function sse(res: import('node:http').ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`)
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: chunk, finish_reason: null }] })}\n\n`)
  }
  res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

let server: Server | null = null
let baseUrl = ''
/** 第二轮请求体：断言工具结果真的回灌给了模型。 */
let secondRound: { messages?: Array<{ role: string; content?: unknown }> } | null = null

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const payload = JSON.parse(body) as { messages?: Array<{ role: string; content?: unknown }> }
      const hasToolResult = (payload.messages ?? []).some(message => message.role === 'tool')
      if (hasToolResult) {
        secondRound = payload
        sse(res, [{ content: '按计划今天先学「队列」。' }])
        return
      }
      sse(res, [
        { content: '先看计划。' },
        {
          tool_calls: [
            { index: 0, id: 'call_plan', type: 'function', function: { name: 'get_study_plan', arguments: '{}' } },
            { index: 1, id: 'call_material', type: 'function', function: { name: 'read_material', arguments: JSON.stringify({ query: '先进先出' }) } },
          ],
        },
      ])
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => {
    const address = server!.address()
    if (typeof address === 'object' && address !== null) baseUrl = `http://127.0.0.1:${address.port}/v1`
    resolve()
  }))
})

afterAll(async () => {
  await new Promise<void>(resolve => server?.close(() => resolve()))
})

function snapshot(): Course {
  const course: Course = {
    id: 'c1', name: '数据结构', timezone: 'Asia/Shanghai', archived: false, createdAt: 0,
    materials: [{
      id: 'm1', name: '讲义.txt', fingerprint: 'hash', status: 'ready', accepted: true, pages: 0,
      sources: [{ id: 's1', materialId: 'm1', anchor: '段落 1', text: '队列是先进先出的线性表，入队在队尾，出队在队头。' }],
    }],
    points: [{ id: 'p1', name: '队列', chapter: '线性表', sourceIds: ['s1'] }],
    scope: ['p1'], plan: null, draft: null, questions: [], attempts: [], messages: [],
    actions: [], drafts: { prompt: '', answers: [] }, changes: [], notice: null,
  }
  const now = Date.now()
  const wrongId = randomUUID()
  const question: Question = {
    id: wrongId, pointId: 'p1', taskId: 't1', slot: 0, family: wrongId, stem: '队列的出入顺序是什么？',
    options: ['先进先出', '后进先出', '随机', '按优先级'], answer: 0, explanation: '队尾入队、队头出队。',
    sourceIds: ['s1'], quote: '队列是先进先出', status: 'valid', assisted: false,
  }
  course.questions.push(question)
  course.attempts.push({ id: randomUUID(), questionId: wrongId, option: 1, correct: false, assisted: false, at: now - 3_600_000, sequence: 0 })
  course.plan = buildPlan(course, { scope: ['p1'], dailyMinutes: 40, days: 7, restDays: [] }, now, randomUUID)
  course.scope = course.plan.scope
  return course
}

describe('study tools e2e (snapshot reads through the agent loop)', () => {
  it('executes get_study_plan and read_material and feeds the snapshot back to the model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'syllora-study-e2e-'))
    const courseDir = join(root, '数据结构')
    await mkdir(join(courseDir, '.syllora'), { recursive: true })
    await writeFile(join(courseDir, '.syllora', 'course.json'), JSON.stringify({ version: 1, courses: [snapshot()], jobs: [], consent: false, calls: 0 }), 'utf8')
    await writeFile(join(courseDir, '.syllora', 'config.yaml'), [
      'version: 1',
      'llm:',
      '  provider: mock',
      '  model: mock-model',
      '  api_key_env: MOCK_KEY',
      `  api_base: ${baseUrl}`,
      '  temperature: 0.3',
      '  max_concurrency: 1',
      'ui:',
      '  default_mode: quick',
      '',
    ].join('\n'), 'utf8')

    process.env.MOCK_KEY = 'test-key'
    const config = await loadChatConfig(courseDir)
    delete process.env.MOCK_KEY

    const tools: Array<Record<string, unknown>> = []
    for await (const event of chatStream(courseDir, basename(courseDir), { message: '今天学什么？', mode: 'quick' }, config)) {
      if (event.kind === 'tool') tools.push(event.payload)
    }

    expect(tools.map(tool => tool['name'])).toEqual(['get_study_plan', 'read_material'])
    const plan = tools.find(tool => tool['name'] === 'get_study_plan')!
    expect(plan['status']).toBe('success')
    expect(String(plan['summary'])).toContain('计划 v1')
    expect(String(plan['summary'])).toContain('今天 1 项')
    const material = tools.find(tool => tool['name'] === 'read_material')!
    expect(material['status']).toBe('success')
    expect(String(material['summary'])).toContain('先进先出')

    // 模型侧：两条 tool 消息都要带上快照内容，否则「工具跑了但模型没看到」。
    const toolMessages = (secondRound?.messages ?? []).filter(message => message.role === 'tool')
    expect(toolMessages).toHaveLength(2)
    const fedBack = toolMessages.map(message => String(message.content)).join('\n')
    expect(fedBack).toContain('队列')
    expect(fedBack).toContain('每天 40 分钟')
    expect(fedBack).toContain('sourceId=s1')
    await rm(root, { recursive: true, force: true })
  })
})
