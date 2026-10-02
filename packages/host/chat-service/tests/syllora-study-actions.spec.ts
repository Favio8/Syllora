/**
 * Study snapshot actions: the plan / mistakes / report / material projections
 * read `<courseDir>/.syllora/course.json` and degrade with a plain message
 * when the course folder has no Syllora snapshot yet.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createSylloraStudyActions } from '../src/syllora-study-actions.ts'
import { buildPlan, type Course, type Question } from '../src/syllora-domain.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function fixture(): Course {
  return {
    id: 'c', name: '数据结构', timezone: 'Asia/Shanghai', archived: false, createdAt: 0,
    materials: [{
      id: 'm', name: '讲义.txt', fingerprint: 'hash', status: 'ready', accepted: true, pages: 0,
      sources: [
        { id: 's', materialId: 'm', anchor: '段落 1', text: '队列是先进先出的线性表，入队在队尾，出队在队头。' },
        { id: 's2', materialId: 'm', anchor: '段落 2', text: '栈是后进先出的线性表，只在栈顶插入和删除。' },
      ],
    }],
    points: [{ id: 'p', name: '队列', chapter: '线性表', sourceIds: ['s'] }],
    scope: ['p'], plan: null, draft: null, questions: [], attempts: [], messages: [],
    actions: [], drafts: { prompt: '', answers: [] }, changes: [], notice: null,
  }
}

function addAttempt(course: Course, at: number, correct: boolean, assisted = false): Question {
  const id = randomUUID()
  const question: Question = {
    id, pointId: 'p', taskId: 't', slot: 0, family: id, stem: `队列的出入顺序是什么？(${id.slice(0, 4)})`,
    options: ['先进先出', '后进先出', '随机', '按优先级'], answer: 0,
    explanation: '队列在队尾入队、队头出队，因此先进先出。', sourceIds: ['s'], quote: '队列是先进先出',
    status: 'valid', assisted,
  }
  course.questions.push(question)
  course.attempts.push({ id: randomUUID(), questionId: id, option: correct ? 0 : 1, correct, assisted, at, sequence: course.attempts.length })
  return question
}

async function snapshot(course: Course): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'syllora-study-'))
  roots.push(root)
  await mkdir(join(root, '.syllora'), { recursive: true })
  await writeFile(join(root, '.syllora', 'course.json'), JSON.stringify({ version: 1, courses: [course], jobs: [], consent: false, calls: 0 }), 'utf8')
  return root
}

describe('Syllora study actions', () => {
  it('projects the confirmed plan into today and upcoming tasks', async () => {
    const course = fixture()
    const now = Date.now()
    course.plan = buildPlan(course, { scope: ['p'], dailyMinutes: 40, days: 7, restDays: [] }, now, randomUUID)
    course.scope = course.plan.scope
    const root = await snapshot(course)
    const actions = createSylloraStudyActions()
    const [summary, data] = await actions.getStudyPlan({ courseDir: root, workspaceRoot: root }, {})
    expect(summary).toContain('计划 v1')
    expect(summary).toContain('今天 1 项')
    const text = String(data['text'])
    expect(text).toContain('队列')
    expect(text).toContain('学习')
    expect(text).toContain('每天 40 分钟')
    expect(text).toContain('统计：完成 0 / 1')
  })

  it('explains that a course without a confirmed plan has no schedule', async () => {
    const root = await snapshot(fixture())
    const actions = createSylloraStudyActions()
    const [summary] = await actions.getStudyPlan({ courseDir: root, workspaceRoot: root }, {})
    expect(summary).toContain('还没有确认的学习计划')
  })

  it('lists attempted mistakes with the revealed answer, evidence and provenance', async () => {
    const course = fixture()
    const now = Date.now()
    const wrong = addAttempt(course, now - 3_600_000, false)
    addAttempt(course, now - 1_800_000, true)
    // 未作答的题不得泄露答案，也不出现在错题列表里。
    const untouched = addAttempt(course, now, true)
    course.attempts = course.attempts.filter(attempt => attempt.questionId !== untouched.id)
    const root = await snapshot(course)
    const actions = createSylloraStudyActions()
    const [summary, data] = await actions.getMistakes({ courseDir: root, workspaceRoot: root }, {})
    expect(summary).toBe('错题 1 题')
    const text = String(data['text'])
    expect(text).toContain('队列（证据：待加强）')
    expect(text).toContain('独立错答')
    expect(text).toContain('学生选择：B. 后进先出')
    expect(text).toContain('正确选项：A. 先进先出')
    expect(text).toContain('来源：s')
    expect(text).not.toContain(untouched.stem)
    expect(text).not.toContain(wrong.sourceIds.length === 0 ? 'never' : '（未知）')
  })

  it('reports progress numbers, distribution, due points and recent attempts', async () => {
    const course = fixture()
    const now = Date.now()
    addAttempt(course, now - 7_200_000, true)
    addAttempt(course, now - 3_600_000, true)
    const root = await snapshot(course)
    const actions = createSylloraStudyActions()
    const [summary, data] = await actions.getProgressReport({ courseDir: root, workspaceRoot: root }, { days: 7 })
    expect(summary).toContain('复盘：完成 0/0')
    expect(summary).toContain('覆盖 1/1')
    expect(summary).toContain('近 7 天作答 2 次')
    const text = String(data['text'])
    expect(text).toContain('证据状态分布：')
    expect(text).toContain('初步掌握 1')
    expect(text).toContain('最近 7 天作答：2 次（正确 2 · 错答 0 · 辅助 0）')
    const [focused, focusedData] = await actions.getProgressReport({ courseDir: root, workspaceRoot: root }, { pointId: 'p' })
    expect(focused).toContain('复盘：')
    expect(String(focusedData['text'])).toContain('知识点：队列')
    const [missing] = await actions.getProgressReport({ courseDir: root, workspaceRoot: root }, { pointId: 'nope' })
    expect(missing).toContain('知识点不存在')
  })

  it('lists, reads and searches material sources with provenance', async () => {
    const root = await snapshot(fixture())
    const actions = createSylloraStudyActions()
    const ctx = { courseDir: root, workspaceRoot: root }
    const [listed, listData] = await actions.readMaterial(ctx, {})
    expect(listed).toContain('课程资料 1 份')
    expect(String(listData['text'])).toContain('讲义.txt（id=m）')
    const [read, readData] = await actions.readMaterial(ctx, { materialId: 'm', maxSources: 1 })
    expect(read).toContain('已读取 1 / 2 个片段')
    expect(String(readData['text'])).toContain('(sourceId=s)')
    const [found, foundData] = await actions.readMaterial(ctx, { query: '栈' })
    expect(found).toContain('找到 1 个含「栈」的片段')
    expect(String(foundData['text'])).toContain('后进先出')
    const [empty] = await actions.readMaterial(ctx, { query: '堆' })
    expect(empty).toContain('没有找到「堆」')
    const [unknown] = await actions.readMaterial(ctx, { materialId: 'missing' })
    expect(unknown).toContain('没有找到资料 missing')
  })

  it('skips deleted materials and degrades without a snapshot file', async () => {
    const course = fixture()
    course.materials[0]!.status = 'deleted'
    const root = await snapshot(course)
    const actions = createSylloraStudyActions()
    const [deleted] = await actions.readMaterial({ courseDir: root, workspaceRoot: root }, {})
    expect(deleted).toContain('可读片段 0 个')
    const empty = await mkdtemp(join(tmpdir(), 'syllora-study-empty-'))
    roots.push(empty)
    for (const [name, args] of [
      ['readMaterial', {}],
      ['getStudyPlan', {}],
      ['getMistakes', {}],
      ['getProgressReport', {}],
    ] as const) {
      const [summary, data] = await actions[name]({ courseDir: empty, workspaceRoot: empty }, args)
      expect(summary, name).toContain('还没有 Syllora 学习快照')
      expect(String(data['text']), name).toContain('还没有 Syllora 学习快照')
    }
  })
})
