/**
 * Read-only study actions for the learning agent: project the per-course
 * Syllora snapshot (`.syllora/course.json`) into compact tool payloads.
 * Kept in the host so the agent never re-implements `evidence()` /
 * `publicCourse()`; a course folder without a snapshot returns a plain
 * "not available yet" message instead of an error.
 * @module @syllora/chat-service/src/syllora-study-actions
 */

import { join } from 'node:path'
import type { ToolActionContext, ToolActions, ToolHandlerResult } from '@syllora/tools'
import { jsonFile } from './syllora-files.ts'
import { localDate, publicCourse, type Course, type Task } from './syllora-domain.ts'

export type StudyReadActions = Required<Pick<ToolActions, 'readMaterial' | 'getStudyPlan' | 'getMistakes' | 'getProgressReport'>>

/** Model-visible text budget: one tool message is capped at 4000 chars, so a
 *  single payload is pre-cropped here instead of being silently truncated. */
const MAX_TEXT_CHARS = 2500

function cap(text: string, maxChars: number = MAX_TEXT_CHARS): string {
  if (text.length <= maxChars) return text
  const kept = Math.max(0, maxChars - 30)
  return `${text.slice(0, kept)}\n…[已裁剪 ${text.length - kept} 字符]`
}

function textArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : ''
}

function intArg(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = Number(args[key])
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function snippet(value: string, maxChars: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat
}

const OPTION_LETTERS = 'ABCD'

/** Projected questions keep `answer`/`explanation` only after the attempt. */
interface ProjectedQuestion {
  readonly id: string
  readonly pointId: string
  readonly stem: string
  readonly options: string[]
  readonly answer?: number
  readonly explanation?: string
  readonly sourceIds: string[]
}

function optionText(question: ProjectedQuestion, index: number | null | undefined): string {
  if (index === null || index === undefined || index < 0 || index >= question.options.length) return '（未知）'
  return `${OPTION_LETTERS[index] ?? '?'}. ${snippet(question.options[index] ?? '', 80)}`
}

interface Snapshot {
  readonly course: Course | null
  readonly message: string
}

/** A project folder owns at most one Syllora course snapshot. */
async function loadSnapshot(courseDir: string): Promise<Snapshot> {
  const path = join(courseDir, '.syllora', 'course.json')
  const data = await jsonFile<{ courses?: Course[] }>(path).catch(() => null)
  const course = data?.courses?.find((item): item is Course => item !== null && typeof item === 'object') ?? null
  return course === null
    ? { course: null, message: '当前课程还没有 Syllora 学习快照（.syllora/course.json）：先在 Syllora 工作台打开课程文件夹、导入资料并确认计划后可用。' }
    : { course, message: '' }
}


/** Usable material sources: published (or accepted partial) and still active. */
function readableSources(course: Course): Array<{ materialName: string; materialId: string; anchor: string; sourceId: string; text: string }> {
  return course.materials
    .filter(material => material.status !== 'deleted' && material.active !== false && (material.status === 'ready' || material.accepted))
    .flatMap(material => material.sources.map(source => ({
      materialName: material.name,
      materialId: material.id,
      anchor: source.anchor,
      sourceId: source.id,
      text: source.text,
    })))
}

function pointNames(course: Course): Map<string, string> {
  return new Map(course.points.map(point => [point.id, point.name]))
}

const TASK_KIND_LABEL: Record<string, string> = { learn: '学习', review: '复习' }
const TASK_STATUS_LABEL: Record<string, string> = { todo: '待开始', in_progress: '进行中', completed: '已完成', skipped: '已跳过' }

function describeTask(task: Task, names: Map<string, string>): string {
  const name = names.get(task.pointId) ?? task.pointId
  const kind = task.immediate === true ? '即时巩固' : TASK_KIND_LABEL[task.kind] ?? task.kind
  return `${task.date} ${name} · ${kind} · ${task.minutes} 分钟 · ${TASK_STATUS_LABEL[task.status] ?? task.status}`
}

/** `read_material`: list, read, or search the imported material sources. */
async function readMaterial(ctx: ToolActionContext, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  const snapshot = await loadSnapshot(ctx.courseDir)
  if (snapshot.course === null) return [snapshot.message, { text: snapshot.message }]
  const view = publicCourse(snapshot.course, Date.now())
  const maxSources = intArg(args, 'maxSources', 6, 1, 20)
  const maxChars = intArg(args, 'maxChars', MAX_TEXT_CHARS, 200, 6000)
  const query = textArg(args, 'query')
  const materialId = textArg(args, 'materialId')
  const sources = readableSources(snapshot.course)
  if (query === '' && materialId === '') {
    const materialLines = view.materials
      .filter(material => material.status !== 'deleted')
      .map(material => `- ${material.name}（id=${material.id}）· ${material.status === 'partial' ? '部分可用' : '可用'} · ${material.sources.length} 个片段`)
    const text = [`课程资料 ${materialLines.length} 份，共 ${sources.length} 个可读片段：`, ...materialLines, '', '用 query 检索正文，或用 materialId 读取某份资料。'].join('\n')
    return [`课程资料 ${materialLines.length} 份 · 可读片段 ${sources.length} 个`, { text: cap(text, maxChars) }]
  }
  const scoped = materialId === '' ? sources : sources.filter(source => source.materialId === materialId)
  if (scoped.length === 0) {
    const message = materialId === ''
      ? '当前课程没有可读的资料片段：请先在工作台导入资料并确认可用部分。'
      : `没有找到资料 ${materialId} 的可读片段（可能已删除或未确认）。`
    return [message, { text: message }]
  }
  if (query === '') {
    const blocks = scoped.slice(0, maxSources).map(source => `【${source.materialName} · ${source.anchor}】(sourceId=${source.sourceId})\n${source.text}`)
    return [`已读取 ${Math.min(maxSources, scoped.length)} / ${scoped.length} 个片段`, { text: cap(blocks.join('\n\n'), maxChars) }]
  }
  const needle = query.toLowerCase()
  const matches: string[] = []
  for (const source of scoped) {
    if (matches.length >= maxSources) break
    const index = source.text.toLowerCase().indexOf(needle)
    if (index < 0) continue
    const start = Math.max(0, index - 160)
    const end = Math.min(source.text.length, index + needle.length + 240)
    const window = `${start > 0 ? '…' : ''}${source.text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < source.text.length ? '…' : ''}`
    matches.push(`【${source.materialName} · ${source.anchor}】(sourceId=${source.sourceId})\n${window}`)
  }
  if (matches.length === 0) {
    const message = `资料正文中没有找到「${query}」（已检索 ${scoped.length} 个片段）。可以换关键词，或用 materialId 读取资料正文。`
    return [message, { text: message }]
  }
  return [`找到 ${matches.length} 个含「${query}」的片段`, { text: cap(matches.join('\n\n'), maxChars) }]
}

/** `get_study_plan`: today's tasks plus the next N days of the confirmed plan. */
async function getStudyPlan(ctx: ToolActionContext, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  const snapshot = await loadSnapshot(ctx.courseDir)
  if (snapshot.course === null) return [snapshot.message, { text: snapshot.message }]
  const course = snapshot.course
  const now = Date.now()
  const view = publicCourse(course, now)
  const names = pointNames(course)
  const days = intArg(args, 'days', 7, 1, 30)
  const includeCompleted = args['includeCompleted'] === true
  if (view.plan === null) {
    const message = `「${course.name}」还没有确认的学习计划：先在工作台导入资料、确认学习范围与每日预算，生成草案并确认后才有日程。`
    return [message, { text: message }]
  }
  const plan = view.plan
  const today = localDate(now, course.timezone)
  const horizon = localDate(now + days * 86_400_000, course.timezone)
  const visible = plan.tasks.filter(task => includeCompleted || (task.status !== 'completed' && task.status !== 'skipped'))
  const todayTasks = visible.filter(task => task.date <= today)
  const upcoming = visible.filter(task => task.date > today && task.date <= horizon).sort((a, b) => a.date.localeCompare(b.date))
  const lines = [
    `课程：${course.name} · 今天 ${today}（${course.timezone}）`,
    `计划 v${plan.version}：每天 ${plan.dailyMinutes} 分钟${plan.deadline === null ? '' : ` · 目标日期 ${plan.deadline}`} · 范围 ${plan.scope.length} 个知识点`,
    todayTasks.length === 0 ? '今天（含此前未完成）：无任务' : '今天（含此前未完成）：',
  ]
  for (const task of todayTasks) lines.push(`- ${describeTask(task, names)}`)
  lines.push(upcoming.length === 0 ? `未来 ${days} 天：无任务` : `未来 ${days} 天（至 ${horizon}）：`)
  for (const task of upcoming) lines.push(`- ${describeTask(task, names)}`)
  if (plan.overflow.length > 0) {
    const overflow = [...new Set(plan.overflow.map(entry => `${names.get(entry.pointId) ?? entry.pointId}（${entry.reason === 'task-too-large' ? '单任务超过每日预算' : '窗口放不下'}）`))]
    lines.push(`预算放不下：${overflow.join('、')}`)
  }
  const completed = plan.tasks.filter(task => task.status === 'completed').length
  const skipped = plan.tasks.filter(task => task.status === 'skipped').length
  lines.push(`统计：完成 ${completed} / ${plan.tasks.length}${skipped > 0 ? ` · 跳过 ${skipped}` : ''}`)
  return [`计划 v${plan.version} · 今天 ${todayTasks.length} 项 · 未来 ${days} 天 ${upcoming.length} 项`, { text: cap(lines.join('\n')) }]
}

/** `get_mistakes`: attempted wrong answers with the revealed correct option. */
async function getMistakes(ctx: ToolActionContext, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  const snapshot = await loadSnapshot(ctx.courseDir)
  if (snapshot.course === null) return [snapshot.message, { text: snapshot.message }]
  const course = snapshot.course
  const view = publicCourse(course, Date.now())
  const names = pointNames(course)
  const pointId = textArg(args, 'pointId')
  const limit = intArg(args, 'limit', 5, 1, 10)
  const questions = view.questions as unknown as ProjectedQuestion[]
  const wrong = view.attempts
    .filter(attempt => {
      if (attempt.correct) return false
      const question = questions.find(item => item.id === attempt.questionId)
      return question !== undefined && (pointId === '' || question.pointId === pointId)
    })
    .sort((a, b) => b.at - a.at)
  const blocks: string[] = []
  const pointsWithMistakes = new Set<string>()
  for (const attempt of wrong) {
    if (blocks.length >= limit) break
    const question = questions.find(item => item.id === attempt.questionId)
    if (question === undefined) continue
    pointsWithMistakes.add(question.pointId)
    const evidence = view.evidence[question.pointId]
    const lines = [
      `- ${names.get(question.pointId) ?? question.pointId}${evidence === undefined ? '' : `（证据：${evidence.state}）`} · ${localDate(attempt.at, course.timezone)} · ${attempt.assisted ? '辅助学习' : '独立错答'}`,
      `  题干：${snippet(question.stem, 200)}`,
      `  学生选择：${optionText(question, attempt.option)}`,
    ]
    if (question.answer !== undefined) lines.push(`  正确选项：${optionText(question, question.answer)}`)
    if (question.explanation !== undefined) lines.push(`  解释：${snippet(question.explanation, 200)}`)
    if (question.sourceIds.length > 0) lines.push(`  来源：${question.sourceIds.join('、')}`)
    blocks.push(lines.join('\n'))
  }
  if (blocks.length === 0) {
    const message = pointId === '' ? '当前课程还没有错题记录（只统计已作答的题）。' : '该知识点还没有错题记录。'
    return [message, { text: message }]
  }
  const header = pointId === '' ? `错题 ${blocks.length} 题（涉及 ${pointsWithMistakes.size} 个知识点）：` : `该知识点错题 ${blocks.length} 题：`
  return [`错题 ${blocks.length} 题`, { text: cap([header, ...blocks].join('\n'), 2000) }]
}

/** `get_progress_report`: the round summary numbers, computed by the host. */
async function getProgressReport(ctx: ToolActionContext, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  const snapshot = await loadSnapshot(ctx.courseDir)
  if (snapshot.course === null) return [snapshot.message, { text: snapshot.message }]
  const course = snapshot.course
  const now = Date.now()
  const view = publicCourse(course, now)
  const names = pointNames(course)
  const days = intArg(args, 'days', 7, 1, 30)
  const pointId = textArg(args, 'pointId')
  const since = now - days * 86_400_000
  const recentAttempts = view.attempts.filter(attempt => attempt.at >= since)
  const attemptCounts = (attempts: typeof recentAttempts): string => `${attempts.length} 次（正确 ${attempts.filter(attempt => attempt.correct).length} · 错答 ${attempts.filter(attempt => !attempt.correct).length} · 辅助 ${attempts.filter(attempt => attempt.assisted).length}）`
  const lines = [`课程：${course.name} · 复盘最近 ${days} 天`]
  if (pointId === '') {
    const due = course.scope.filter(id => {
      const evidence = view.evidence[id]
      return evidence !== undefined && evidence.dueAt !== null && evidence.dueAt <= now
    })
    const weak = course.scope.filter(id => {
      const evidence = view.evidence[id]
      return evidence !== undefined && (evidence.state === '待加强' || evidence.state === '未评估')
    })
    lines.push(`活动完成：${view.progress.activityLabel ?? `${view.progress.completed} / ${view.progress.total}${view.progress.skipped > 0 ? `（跳过 ${view.progress.skipped}）` : ''}`}`)
    lines.push(`有效评估覆盖：${view.progress.scopeLabel ?? `${view.progress.covered} / ${view.progress.scope}`}`)
    lines.push(`证据状态分布：${Object.entries(view.progress.distribution).map(([state, count]) => `${state} ${count}`).join(' · ')}`)
    lines.push(`到期复习：${due.length === 0 ? '无' : due.map(id => names.get(id) ?? id).join('、')}`)
    lines.push(`薄弱知识点：${weak.length === 0 ? '无' : weak.map(id => `${names.get(id) ?? id}（${view.evidence[id]?.state}）`).join('、')}`)
    lines.push(`最近 ${days} 天作答：${attemptCounts(recentAttempts)}`)
  } else {
    const evidence = view.evidence[pointId]
    if (evidence === undefined) return [`知识点不存在：${pointId}`, { text: `知识点不存在：${pointId}` }]
    const pointAttempts = recentAttempts.filter(attempt => view.questions.find(question => question.id === attempt.questionId)?.pointId === pointId)
    lines.push(`知识点：${names.get(pointId) ?? pointId}`)
    lines.push(`证据：${evidence.state} · ${evidence.count} 次有效独立作答${evidence.dueAt === null ? '' : ` · 下次复习 ${localDate(evidence.dueAt, course.timezone)}`}`)
    lines.push(`最近 ${days} 天作答：${attemptCounts(pointAttempts)}`)
  }
  lines.push(`下一行动：${view.next.text}`)
  if (view.actions.length > 0) {
    lines.push('最近行动记录：')
    for (const action of view.actions.slice(-3).reverse()) lines.push(`- [${action.kind}] ${action.text}（${localDate(action.at, course.timezone)}）`)
  }
  if (view.changes.length > 0) {
    lines.push('最近计划变化：')
    for (const change of view.changes.slice(-2).reverse()) lines.push(`- ${snippet(change.text, 220)}`)
  }
  return [`复盘：完成 ${view.progress.completed}/${view.progress.total} · 覆盖 ${view.progress.covered}/${view.progress.scope} · 近 ${days} 天作答 ${recentAttempts.length} 次`, { text: cap(lines.join('\n'), 2000) }]
}

/** Build the read-only snapshot actions. The tool context carries the course
 *  folder of the running session, so no per-call directory is needed. */
export function createSylloraStudyActions(): StudyReadActions {
  return {
    readMaterial,
    getStudyPlan,
    getMistakes,
    getProgressReport,
  }
}
