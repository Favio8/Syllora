/** Syllora MVP rules. Original attempts are immutable; projections are replayable. */
export const RULE_VERSION = 'syllora-v1'
export const HOUR = 3_600_000
export interface Source { id: string; materialId: string; anchor: string; text: string }
export interface Material { id: string; name: string; fingerprint: string; status: 'ready' | 'partial' | 'deleted'; accepted: boolean; pages: number; sources: Source[] }
export interface Point { id: string; chapter: string; name: string; sourceIds: string[] }
export interface Question { id: string; pointId: string; taskId: string; slot: number; family: string; stem: string; options: string[]; answer: number; explanation: string; sourceIds: string[]; quote: string; status: 'valid' | 'disputed' | 'invalid'; assisted: boolean }
export interface Attempt { id: string; questionId: string; option: number; correct: boolean; assisted: boolean; at: number; sequence: number }
export interface Evidence { state: '未评估' | '待验证' | '待加强' | '初步掌握' | '复测通过'; count: number; streak: number; learnedAt: number | null; dueAt: number | null; interval: number; lastAt: number | null; reason: string; ruleVersion: string }
export interface Task { id: string; pointId: string; kind: 'learn' | 'review'; date: string; minutes: number; status: 'todo' | 'in_progress' | 'completed' | 'skipped'; explained: boolean; slots: number; cycle: number | null; immediate?: boolean }
export interface OverflowEntry { pointId: string; reason: 'window-full' | 'task-too-large' }
export interface PlanInput { scope: string[]; dailyMinutes: number; days: number; restDays: number[]; deadline?: string | null; estimates?: Record<string, number> }
export interface Plan { id: string; version: number; baseVersion: number; scope: string[]; tasks: Task[]; overflow: OverflowEntry[]; dailyMinutes: number; feasible: boolean; days: number; deadline: string | null; restDays: number[]; estimates: Record<string, number> }
export interface Message { id: string; role: 'user' | 'assistant'; text: string; sourceIds: string[]; at: number }
export interface AnswerDraft { questionId: string; option: number }
export interface Drafts { prompt: string; answers: AnswerDraft[] }
export interface PlanDiff {
  scopeAdded: string[]
  scopeRemoved: string[]
  tasksAdded: Array<{ id: string; pointId: string; date: string; minutes: number; immediate: boolean }>
  tasksRemoved: Array<{ id: string; pointId: string; date: string; minutes: number }>
  tasksMoved: Array<{ id: string; pointId: string; from: string; to: string }>
  minutesBefore: number
  minutesAfter: number
}
export interface DenominatorChange { id: string; at: number; planVersion: number; activityBefore: number; activityAfter: number; scopeBefore: number; scopeAfter: number; skipped: number; text: string; diff: PlanDiff }
export interface ScheduleNotice { kind: 'due' | 'restore' | 'immediate'; pointIds: string[]; text: string }
export interface NextAction {
  id: string
  kind: 'continue' | 'retest' | 'review' | 'planned' | 'summary' | 'prepare' | 'archived'
  text: string
  reason: string
  pointId: string | null
  taskId: string | null
  evidenceState: Evidence['state'] | null
  evidenceCount: number | null
  availableAt: number | null
  at: number
  trigger: 'grade' | 'dispute' | 'plan' | 'review' | 'material' | 'task' | 'due' | 'archive' | 'init' | 'sync'
  practice: { pointId: string; text: string } | null
}
export interface Course { id: string; name: string; timezone: string; archived: boolean; materials: Material[]; points: Point[]; scope: string[]; plan: Plan | null; draft: Plan | null; questions: Question[]; attempts: Attempt[]; messages: Message[]; actions: NextAction[]; drafts: Drafts; changes: DenominatorChange[]; notice: ScheduleNotice | null; createdAt: number }
export const EVIDENCE_STATES = ['未评估', '待验证', '待加强', '初步掌握', '复测通过'] as const

export function normalizeCourse(course: Course) {
  if (!Array.isArray(course.actions)) course.actions = []
  if (!course.drafts || typeof course.drafts.prompt !== 'string' || !Array.isArray(course.drafts.answers)) course.drafts = { prompt: '', answers: [] }
  if (!Array.isArray(course.changes)) course.changes = []
  if (course.notice === undefined) course.notice = null
  course.plan = normalizePlan(course.plan)
  course.draft = normalizePlan(course.draft)
}

function normalizePlan(plan: Plan | null): Plan | null {
  if (!plan) return plan
  if (!Number.isInteger(plan.days) || plan.days < 1) {
    const dates = plan.tasks.map(task => task.date).sort()
    plan.days = dates.length ? Math.max(1, Math.round((Date.parse(`${dates.at(-1)}T12:00:00Z`) - Date.parse(`${dates[0]}T12:00:00Z`)) / 86400000) + 1) : 7
  }
  if (plan.deadline === undefined) plan.deadline = null
  if (!Array.isArray(plan.restDays)) plan.restDays = []
  if (!plan.estimates || typeof plan.estimates !== 'object' || Array.isArray(plan.estimates)) plan.estimates = {}
  if (plan.overflow.some(entry => typeof entry === 'string')) plan.overflow = (plan.overflow as unknown[]).map(entry => typeof entry === 'string' ? { pointId: entry, reason: 'window-full' as const } : entry as OverflowEntry)
  return plan
}

export function usableSources(course: Course): Source[] {
  return course.materials.filter(m => m.status !== 'deleted' && (m.status === 'ready' || m.accepted)).flatMap(m => m.sources)
}

export function evidence(course: Course, pointId: string): Evidence {
  const result: Evidence = { state: '未评估', count: 0, streak: 0, learnedAt: null, dueAt: null, interval: 24, lastAt: null, reason: '尚无有效独立作答', ruleVersion: RULE_VERSION }
  const sources = new Set(usableSources(course).map(s => s.id))
  const seen = new Set<string>()
  let hadError = false
  for (const attempt of [...course.attempts].sort((a,b) => a.at - b.at || a.sequence - b.sequence)) {
    const q = course.questions.find(q => q.id === attempt.questionId)
    if (!q || q.pointId !== pointId || q.status !== 'valid' || attempt.assisted || !q.sourceIds.length || q.sourceIds.some(id => !sources.has(id)) || seen.has(q.family)) continue
    seen.add(q.family)
    result.count++
    result.lastAt = attempt.at
    if (!attempt.correct) {
      hadError = true
      result.state = '待加强'
      result.streak = 0
      result.learnedAt = null
      result.interval = 24
      result.dueAt = Math.min(result.dueAt ?? Infinity, attempt.at + 24 * HOUR)
      // Consuming an already due cycle starts a new cycle, rather than leaving it overdue.
      if (result.dueAt <= attempt.at) result.dueAt = attempt.at + 24 * HOUR
    } else {
      result.streak++
      if (result.streak < 2) {
        result.state = hadError ? '待加强' : '待验证'
        if (result.dueAt !== null && attempt.at >= result.dueAt) result.dueAt = attempt.at + 24 * HOUR
      } else if (result.learnedAt === null) {
        result.state = '初步掌握'
        result.learnedAt = attempt.at
        result.interval = 24
        result.dueAt = attempt.at + 24 * HOUR
      } else if (result.dueAt !== null && attempt.at >= result.dueAt && attempt.at >= result.learnedAt + 24 * HOUR) {
        result.state = '复测通过'
        result.interval = result.interval === 24 ? 72 : 168
        result.dueAt = attempt.at + result.interval * HOUR
      }
    }
  }
  result.reason = result.count ? `${result.count} 次有效独立作答，最近连续正确 ${result.streak} 次` : '尚无有效独立作答'
  return result
}

export function localDate(at: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}
export function addDate(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + days * 24 * HOUR).toISOString().slice(0, 10)
}

export function planWindowDays(input: Pick<PlanInput, 'days' | 'deadline'>, today: string): number {
  let windowDays = input.days
  if (input.deadline) windowDays = Math.round((Date.parse(`${input.deadline}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000) + 1
  return Math.max(0, Math.min(windowDays, 366))
}

export function placeTasks(base: Task[], pending: Task[], input: Pick<PlanInput, 'dailyMinutes' | 'days' | 'restDays' | 'deadline'>, today: string): { tasks: Task[]; overflow: OverflowEntry[] } {
  const tasks = structuredClone(base)
  const unplaced: Task[] = []
  const overflow: OverflowEntry[] = []
  const windowDays = planWindowDays(input, today)
  for (const day of new Set(base.filter(task => task.date >= today && task.status !== 'skipped').map(task => task.date))) {
    const fixed = base.filter(task => task.date === day && task.status !== 'skipped')
    if (fixed.reduce((sum, task) => sum + task.minutes, 0) > input.dailyMinutes) {
      for (const task of fixed) overflow.push({ pointId: task.pointId, reason: task.minutes > input.dailyMinutes ? 'task-too-large' : 'window-full' })
    }
  }
  for (const task of pending) {
    if (task.minutes > input.dailyMinutes) {
      overflow.push({ pointId: task.pointId, reason: 'task-too-large' }); unplaced.push({ ...task }); continue
    }
    let placed = false
    for (let offset = 0; offset < windowDays; offset++) {
      const day = addDate(today, offset)
      if (input.restDays.includes(new Date(`${day}T12:00:00Z`).getUTCDay())) continue
      const used = tasks.filter(t => t.date === day && t.status !== 'skipped').reduce((n,t) => n + t.minutes, 0)
      if (used + task.minutes <= input.dailyMinutes) { tasks.push({ ...task, date: day }); placed = true; break }
    }
    // Keep unscheduled tasks editable so lowering their minutes can repair an infeasible draft.
    if (!placed) { overflow.push({ pointId: task.pointId, reason: 'window-full' }); unplaced.push({ ...task }) }
  }
  return { tasks: [...tasks, ...unplaced], overflow }
}

export function buildPlan(course: Course, input: PlanInput, now: number, id: () => string): Plan {
  const today = localDate(now, course.timezone)
  const preserved = course.plan?.tasks.filter(t => t.status === 'completed' || t.status === 'in_progress' || t.status === 'skipped') ?? []
  const tasks = structuredClone(preserved)
  // Future todo tasks keep their identity across regenerations so diffs show moves instead of remove+add.
  const reusable = new Map<string, string>()
  const todoMinutes = new Map<string, number>()
  for (const task of course.plan?.tasks ?? []) if (task.status === 'todo') {
    const key = `${task.kind}:${task.pointId}:${task.cycle ?? ''}`
    reusable.set(key, task.id); todoMinutes.set(key, task.minutes)
  }
  const pending: Task[] = []
  for (const pointId of input.scope) {
    const e = evidence(course, pointId)
    if (e.dueAt !== null && e.dueAt <= now && !tasks.some(t => t.pointId === pointId && t.kind === 'review' && t.cycle === e.dueAt)) {
      pending.push({ id: reusable.get(`review:${pointId}:${e.dueAt}`) ?? id(), pointId, kind: 'review', date: today, minutes: todoMinutes.get(`review:${pointId}:${e.dueAt}`) ?? 10, status: 'todo', explained: true, slots: 1, cycle: e.dueAt })
    }
  }
  pending.sort((a,b) => (a.cycle ?? 0) - (b.cycle ?? 0))
  for (const pointId of input.scope) {
    if (!tasks.some(t => t.pointId === pointId && t.kind === 'learn')) pending.push({ id: reusable.get(`learn:${pointId}:`) ?? id(), pointId, kind: 'learn', date: today, minutes: input.estimates?.[pointId] ?? todoMinutes.get(`learn:${pointId}:`) ?? 20, status: 'todo', explained: false, slots: 2, cycle: null })
  }
  const placed = placeTasks(tasks, pending, input, today)
  const estimates = Object.fromEntries(placed.tasks.filter(task => task.kind === 'learn' && input.scope.includes(task.pointId)).map(task => [task.pointId, task.minutes]))
  return { id: id(), version: (course.plan?.version ?? 0) + 1, baseVersion: course.plan?.version ?? 0, scope: input.scope, tasks: placed.tasks, overflow: placed.overflow, dailyMinutes: input.dailyMinutes, feasible: !placed.overflow.length && !!input.scope.length, days: input.days, deadline: input.deadline ?? null, restDays: input.restDays, estimates }
}

function evidenceSnap(course: Course, pointId: string | null) {
  if (!pointId) return { evidenceState: null, evidenceCount: null }
  const current = evidence(course, pointId)
  return { evidenceState: current.state, evidenceCount: current.count }
}

export function recommend(course: Course, now: number): Omit<NextAction, 'id' | 'at' | 'trigger'> {
  const practiceId = course.scope.find(id => {
    if (evidence(course, id).state !== '待加强') return false
    const last = [...course.attempts].reverse().find(attempt => {
      const question = course.questions.find(item => item.id === attempt.questionId)
      return question?.pointId === id && question.status === 'valid' && !attempt.assisted
    })
    return last?.correct === false
  })
  const practice = practiceId ? { pointId: practiceId, text: '可选：生成即时巩固草案，确认后才进入日程' } : null
  if (course.archived) return { kind: 'archived', text: '课程已归档，恢复后可继续学习', reason: '归档课程不新增推荐或提醒', pointId: null, taskId: null, ...evidenceSnap(course, null), availableAt: null, practice: null }
  const active = course.plan?.tasks.find(task => task.status === 'in_progress')
  if (active) return { kind: 'continue', text: '继续当前任务', reason: `先完成进行中的${active.kind === 'review' ? '复习' : '学习'}，再处理队列中的其他事项`, pointId: active.pointId, taskId: active.id, ...evidenceSnap(course, active.pointId), availableAt: null, practice }
  const invalid = course.scope.find(id => course.questions.some(question => question.pointId === id && question.status !== 'valid' && course.attempts.some(attempt => attempt.questionId === question.id)) && evidence(course, id).count < 2)
  if (invalid) return { kind: 'retest', text: '评估依据有变更，进行补测', reason: '争议或失效题目已移出证据，剩余有效作答不足，需要补测', pointId: invalid, taskId: null, ...evidenceSnap(course, invalid), availableAt: null, practice }
  const due = course.scope.map(id => ({ id, item: evidence(course, id) })).filter(entry => entry.item.dueAt !== null && entry.item.dueAt <= now).sort((a, b) => a.item.dueAt! - b.item.dueAt!)[0]
  if (due) return { kind: 'review', text: '该知识点已到复习时间', reason: `证据为${due.item.state}，到期复习优先于新的计划内容`, pointId: due.id, taskId: null, ...evidenceSnap(course, due.id), availableAt: due.item.dueAt ?? now, practice }
  const todo = course.plan?.tasks.find(task => task.status === 'todo')
  if (todo) return { kind: 'planned', text: '按已确认计划继续学习', reason: `计划 v${course.plan?.version ?? 0} 的下一项尚未开始`, pointId: todo.pointId, taskId: todo.id, ...evidenceSnap(course, todo.pointId), availableAt: null, practice }
  if (course.scope.length) {
    const nextDue = course.scope.map(id => evidence(course, id).dueAt).filter((at): at is number => at !== null).sort((a, b) => a - b)[0] ?? null
    return { kind: 'summary', text: '本轮任务已结束，可查看下次复习时间或补充学习范围', reason: nextDue === null ? '当前范围没有未完成任务' : '未到期复习可以查看，提前练习只记为即时巩固', pointId: null, taskId: null, evidenceState: null, evidenceCount: null, availableAt: nextDue, practice }
  }
  return { kind: 'prepare', text: '导入资料，确认大纲与学习计划', reason: '还没有确认的学习范围', pointId: null, taskId: null, evidenceState: null, evidenceCount: null, availableAt: null, practice: null }
}

export function recordNext(course: Course, now: number, makeId: () => string, trigger: NextAction['trigger'], force = false): boolean {
  normalizeCourse(course)
  const recommendation = recommend(course, now)
  const last = course.actions.at(-1)
  if (!force && last && last.kind === recommendation.kind && last.pointId === recommendation.pointId && last.taskId === recommendation.taskId && last.text === recommendation.text && last.evidenceState === recommendation.evidenceState && last.reason === recommendation.reason && last.practice?.pointId === recommendation.practice?.pointId && last.availableAt === recommendation.availableAt) return false
  course.actions.push({ ...recommendation, id: makeId(), at: now, trigger })
  if (course.actions.length > 40) course.actions.splice(0, course.actions.length - 40)
  return true
}

function sameAction(left: Omit<NextAction, 'id' | 'at' | 'trigger'>, right: Omit<NextAction, 'id' | 'at' | 'trigger'>) {
  return left.kind === right.kind && left.pointId === right.pointId && left.taskId === right.taskId && left.text === right.text && left.evidenceState === right.evidenceState && left.reason === right.reason && left.practice?.pointId === right.practice?.pointId && left.availableAt === right.availableAt
}

export function nextSyncTrigger(course: Course, now: number): NextAction['trigger'] | null {
  normalizeCourse(course)
  if (!course.actions.length) return 'init'
  const last = course.actions.at(-1)!
  const current = recommend(course, now)
  if (sameAction(last, current)) return null
  const earlier = recommend(course, last.at)
  return current.kind === 'review' && earlier.kind !== 'review' ? 'due' : 'sync'
}

const scheduledMinutes = (tasks: Task[]) => tasks.filter(task => task.status !== 'skipped').reduce((sum, task) => sum + task.minutes, 0)

export function planDiff(before: Plan | null, after: Plan): PlanDiff {
  const previous = before?.tasks ?? []
  const previousById = new Map(previous.map(task => [task.id, task]))
  const nextById = new Map(after.tasks.map(task => [task.id, task]))
  const previousScope = new Set(before?.scope ?? [])
  return {
    scopeAdded: after.scope.filter(id => !previousScope.has(id)),
    scopeRemoved: [...previousScope].filter(id => !after.scope.includes(id)),
    tasksAdded: after.tasks.filter(task => !previousById.has(task.id)).map(task => ({ id: task.id, pointId: task.pointId, date: task.date, minutes: task.minutes, immediate: task.immediate === true })),
    tasksRemoved: previous.filter(task => !nextById.has(task.id)).map(task => ({ id: task.id, pointId: task.pointId, date: task.date, minutes: task.minutes })),
    tasksMoved: after.tasks.flatMap(task => {
      const older = previousById.get(task.id)
      return older && older.date !== task.date ? [{ id: task.id, pointId: task.pointId, from: older.date, to: task.date }] : []
    }),
    minutesBefore: scheduledMinutes(previous),
    minutesAfter: scheduledMinutes(after.tasks),
  }
}

export function describeDiff(diff: PlanDiff, name: (id: string) => string): string {
  const parts = [
    ...diff.scopeAdded.map(id => `新增范围 ${name(id)}`),
    ...diff.scopeRemoved.map(id => `移出范围 ${name(id)}，作答仍保留`),
    ...diff.tasksAdded.map(task => `新增${task.immediate ? '即时巩固' : '任务'} ${name(task.pointId)} ${task.date} ${task.minutes} 分钟`),
    ...diff.tasksRemoved.map(task => `移出任务 ${name(task.pointId)} ${task.date}`),
    ...diff.tasksMoved.map(task => `移动 ${name(task.pointId)} ${task.from} → ${task.to}`),
    `估时 ${diff.minutesBefore} → ${diff.minutesAfter} 分钟`,
  ]
  return parts.join('；')
}

export function proposeReviews(course: Course, pointIds: string[], now: number, makeId: () => string): Plan {
  const base = course.plan
  if (!base) throw new Error('没有已确认计划')
  const today = localDate(now, course.timezone)
  const tasks = structuredClone(base.tasks)
  const overflow: OverflowEntry[] = []
  for (const pointId of pointIds) {
    const current = evidence(course, pointId)
    const used = tasks.filter(task => task.date === today && task.status !== 'skipped').reduce((sum, task) => sum + task.minutes, 0)
    if (used + 10 > base.dailyMinutes) overflow.push({ pointId, reason: base.dailyMinutes < 10 ? 'task-too-large' : 'window-full' })
    tasks.push({ id: makeId(), pointId, kind: 'review', date: today, minutes: 10, status: 'todo', explained: true, slots: 1, cycle: current.dueAt, immediate: current.dueAt === null || current.dueAt > now })
  }
  return { id: makeId(), version: base.version + 1, baseVersion: base.version, scope: [...base.scope], tasks, overflow, dailyMinutes: base.dailyMinutes, feasible: overflow.length === 0 && pointIds.length > 0, days: base.days, deadline: base.deadline, restDays: base.restDays, estimates: base.estimates }
}

export function restoreNotice(course: Course, now: number): ScheduleNotice | null {
  const due = duePointIds(course, now)
  return due.length ? { kind: 'restore', pointIds: due, text: `恢复后有 ${due.length} 项复习已到期。确认新日程前，原计划保持不变。` } : null
}

export function duePointIds(course: Course, now: number): string[] {
  return course.scope.filter(id => {
    const current = evidence(course, id)
    return current.dueAt !== null && current.dueAt <= now && !course.plan?.tasks.some(task => task.pointId === id && task.kind === 'review' && task.status !== 'completed' && task.status !== 'skipped')
  })
}

export function refreshNotice(course: Course, now: number): boolean {
  if (!course.notice) return false
  const pending = course.notice.pointIds.filter(id => {
    const scheduled = course.plan?.tasks.some(task => task.pointId === id && task.kind === 'review' && task.status !== 'completed' && task.status !== 'skipped')
    if (scheduled) return false
    if (course.notice?.kind === 'immediate') return true
    const current = evidence(course, id)
    return current.dueAt !== null && current.dueAt <= now
  })
  if (!pending.length) { course.notice = null; return true }
  if (pending.length === course.notice.pointIds.length) return false
  course.notice = { ...course.notice, pointIds: pending, text: course.notice.kind === 'restore' ? `恢复后有 ${pending.length} 项复习已到期。确认新日程前，原计划保持不变。` : course.notice.text }
  return true
}

export function noteChange(course: Course, now: number, makeId: () => string, before: Plan | null) {
  normalizeCourse(course)
  const after = course.plan
  if (!after) return
  const diff = planDiff(before, after)
  const name = (id: string) => course.points.find(point => point.id === id)?.name ?? '知识点'
  const skipped = after.tasks.filter(task => task.status === 'skipped').length
  const text = `计划 v${after.version}：任务 ${before?.tasks.length ?? 0} → ${after.tasks.length}，范围 ${before?.scope.length ?? 0} → ${after.scope.length}。${describeDiff(diff, name)}。跳过 ${skipped} 项单独列出，不记入完成。`
  course.changes.push({ id: makeId(), at: now, planVersion: after.version, activityBefore: before?.tasks.length ?? 0, activityAfter: after.tasks.length, scopeBefore: before?.scope.length ?? 0, scopeAfter: after.scope.length, skipped, text, diff })
  if (course.changes.length > 20) course.changes.splice(0, course.changes.length - 20)
}

export function nextAction(course: Course, now: number): { text: string; pointId: string | null; taskId: string | null } {
  const current = course.actions?.at(-1) ?? recommend(course, now)
  return { text: current.text, pointId: current.pointId, taskId: current.taskId }
}

export interface DetailedPlanDiff { added: Task[]; removed: Task[]; moved: Task[]; changed: { from: Task; to: Task }[]; unchanged: Task[] }

export function diffPlan(oldPlan: Plan | null, newDraft: Plan): DetailedPlanDiff {
  const added: Task[] = []; const removed: Task[] = []; const moved: Task[] = []; const changed: { from: Task; to: Task }[] = []; const unchanged: Task[] = []
  if (!oldPlan) return { added: newDraft.tasks, removed: [], moved: [], changed: [], unchanged: [] }
  const oldById = new Map(oldPlan.tasks.map(t => [t.id, t]))
  const oldUnfinished = new Set(oldPlan.tasks.filter(t => t.status === 'todo').map(t => t.id))
  const used = new Set<string>()
  for (const t of newDraft.tasks) {
    const matched = oldById.get(t.id)
    if (!matched) { added.push(t); continue }
    used.add(matched.id)
    if (!oldUnfinished.has(matched.id)) { unchanged.push(t); continue }
    if (matched.date !== t.date) { moved.push(t); continue }
    if (matched.minutes !== t.minutes) { changed.push({ from: matched, to: t }); continue }
    unchanged.push(t)
  }
  for (const [id, t] of oldById) if (oldUnfinished.has(id) && !used.has(id)) removed.push(t)
  return { added, removed, moved, changed, unchanged }
}

export function publicCourse(course: Course, now: number) {
  normalizeCourse(course)
  const distribution = Object.fromEntries(EVIDENCE_STATES.map(state => [state, course.scope.filter(id => evidence(course, id).state === state).length])) as Record<(typeof EVIDENCE_STATES)[number], number>
  const completed = course.plan?.tasks.filter(task => task.status === 'completed').length ?? 0
  const total = course.plan?.tasks.length ?? 0
  const stored = course.actions.at(-1)
  return {
    ...course,
    questions: course.questions.map(question => {
      const answered = course.attempts.some(attempt => attempt.questionId === question.id)
      const { answer, explanation, quote, ...safe } = question
      return answered || question.assisted ? { ...safe, answer, explanation, quote } : safe
    }),
    evidence: Object.fromEntries(course.points.map(point => [point.id, evidence(course, point.id)])),
    next: stored ?? { ...recommend(course, now), id: '', at: now, trigger: 'init' as const },
    draftDiff: course.draft ? planDiff(course.plan, course.draft) : null,
    detailedDraftDiff: course.draft ? diffPlan(course.plan, course.draft) : null,
    progress: {
      completed,
      total,
      skipped: course.plan?.tasks.filter(task => task.status === 'skipped').length ?? 0,
      covered: course.scope.filter(id => evidence(course, id).count > 0).length,
      scope: course.scope.length,
      activityLabel: total === 0 ? '暂无任务' : null,
      scopeLabel: course.scope.length === 0 ? '暂无范围' : null,
      distribution,
      change: course.changes.at(-1)?.text ?? null,
    },
  }
}
