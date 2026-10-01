/** Syllora MVP rules. Original attempts are immutable; projections are replayable. */
export const RULE_VERSION = 'syllora-v1'
export const HOUR = 3_600_000
export interface Source { id: string; materialId: string; anchor: string; text: string }
export interface Material { id: string; name: string; fingerprint: string; status: 'ready' | 'partial' | 'deleted'; accepted: boolean; pages: number; sources: Source[] }
export interface Point { id: string; chapter: string; name: string; sourceIds: string[] }
export interface Question { id: string; pointId: string; taskId: string; slot: number; family: string; stem: string; options: string[]; answer: number; explanation: string; sourceIds: string[]; quote: string; status: 'valid' | 'disputed' | 'invalid'; assisted: boolean }
export interface Attempt { id: string; questionId: string; option: number; correct: boolean; assisted: boolean; at: number; sequence: number }
export interface Evidence { state: '未评估' | '待验证' | '待加强' | '初步掌握' | '复测通过'; count: number; streak: number; learnedAt: number | null; dueAt: number | null; interval: number; lastAt: number | null; reason: string; ruleVersion: string }
export interface Task { id: string; pointId: string; kind: 'learn' | 'review'; date: string; minutes: number; status: 'todo' | 'in_progress' | 'completed' | 'skipped'; explained: boolean; slots: number; cycle: number | null }
export interface Plan { id: string; version: number; baseVersion: number; scope: string[]; tasks: Task[]; overflow: string[]; dailyMinutes: number; feasible: boolean; days: number; restDays: number[] }
export interface Message { id: string; role: 'user' | 'assistant'; text: string; sourceIds: string[]; at: number }
export interface Course { id: string; name: string; timezone: string; archived: boolean; materials: Material[]; points: Point[]; scope: string[]; plan: Plan | null; draft: Plan | null; questions: Question[]; attempts: Attempt[]; messages: Message[]; createdAt: number }

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

export function placeTasks(
  base: Task[],
  pending: Task[],
  input: { dailyMinutes: number; days: number; restDays: number[] },
  today: string,
): { tasks: Task[]; overflow: string[] } {
  const tasks = structuredClone(base)
  const overflow: string[] = []
  for (const task of pending) {
    let placed = false
    for (let offset = 0; offset < input.days; offset++) {
      const day = addDate(today, offset)
      if (input.restDays.includes(new Date(`${day}T12:00:00Z`).getUTCDay())) continue
      const used = tasks.filter(t => t.date === day && t.status !== 'skipped').reduce((n, t) => n + t.minutes, 0)
      if (used + task.minutes <= input.dailyMinutes) { tasks.push({ ...task, date: day }); placed = true; break }
    }
    if (!placed) overflow.push(task.pointId)
  }
  return { tasks, overflow }
}

export function buildPlan(course: Course, input: { scope: string[]; dailyMinutes: number; days: number; restDays: number[] }, now: number, id: () => string): Plan {
  const today = localDate(now, course.timezone)
  // Preserve completed/in_progress/skipped tasks exactly, plus keep todo task minutes
  const preserved = course.plan?.tasks.filter(t => t.status === 'completed' || t.status === 'in_progress' || t.status === 'skipped') ?? []
  const todoMinutes = new Map(course.plan?.tasks.filter(t => t.status === 'todo').map(t => [t.pointId + t.kind + (t.cycle ?? ''), t.minutes]) ?? [])
  const tasks = structuredClone(preserved)
  const pending: Task[] = []
  for (const pointId of input.scope) {
    const e = evidence(course, pointId)
    if (e.dueAt !== null && e.dueAt <= now && !tasks.some(t => t.pointId === pointId && t.kind === 'review' && t.cycle === e.dueAt)) {
      const saved = todoMinutes.get(pointId + 'review' + e.dueAt)
      pending.push({ id: id(), pointId, kind: 'review', date: today, minutes: saved ?? 10, status: 'todo', explained: true, slots: 1, cycle: e.dueAt })
    }
  }
  pending.sort((a,b) => (a.cycle ?? 0) - (b.cycle ?? 0))
  for (const pointId of input.scope) {
    if (!tasks.some(t => t.pointId === pointId && t.kind === 'learn')) {
      const saved = todoMinutes.get(pointId + 'learn')
      pending.push({ id: id(), pointId, kind: 'learn', date: today, minutes: saved ?? 20, status: 'todo', explained: false, slots: 2, cycle: null })
    }
  }
  const { tasks: placedTasks, overflow } = placeTasks(tasks, pending, input, today)
  return { id: id(), version: (course.plan?.version ?? 0) + 1, baseVersion: course.plan?.version ?? 0, scope: input.scope, tasks: placedTasks, overflow, dailyMinutes: input.dailyMinutes, feasible: !overflow.length && !!input.scope.length, days: input.days, restDays: input.restDays }
}

export function nextAction(course: Course, now: number): { text: string; pointId: string | null; taskId: string | null } {
  if (course.archived) return { text: '课程已归档，恢复后可继续学习', pointId: null, taskId: null }
  const active = course.plan?.tasks.find(t => t.status === 'in_progress')
  if (active) return { text: '继续当前任务', pointId: active.pointId, taskId: active.id }
  const invalid = course.scope.find(id => course.questions.some(q => q.pointId === id && q.status !== 'valid' && course.attempts.some(a => a.questionId === q.id)) && evidence(course,id).count < 2)
  if (invalid) return { text: '评估依据有变更，进行补测', pointId: invalid, taskId: null }
  const due = course.scope.map(id => ({ id, e: evidence(course,id) })).filter(x => x.e.dueAt !== null && x.e.dueAt <= now).sort((a,b) => a.e.dueAt! - b.e.dueAt!)[0]
  if (due) return { text: '该知识点已到复习时间', pointId: due.id, taskId: null }
  const todo = course.plan?.tasks.find(t => t.status === 'todo')
  if (todo) return { text: '按已确认计划继续学习', pointId: todo.pointId, taskId: todo.id }
  return { text: course.scope.length ? '本轮任务已结束，可查看下次复习时间或补充学习范围' : '导入资料，确认大纲与学习计划', pointId: null, taskId: null }
}

export interface PlanDiff { added: Task[]; removed: Task[]; moved: Task[]; changed: { from: Task; to: Task }[]; unchanged: Task[] }

export function diffPlan(oldPlan: Plan | null, newDraft: Plan): PlanDiff {
  const added: Task[] = []; const removed: Task[] = []; const moved: Task[] = []; const changed: { from: Task; to: Task }[] = []; const unchanged: Task[] = []
  if (!oldPlan) return { added: newDraft.tasks, removed: [], moved: [], changed: [], unchanged: [] }
  const oldById = new Map(oldPlan.tasks.map(t => [t.id, t]))
  const oldUnfinished = new Set(oldPlan.tasks.filter(t => t.status === 'todo' || t.status === 'in_progress' || t.status === 'skipped').map(t => t.id))
  const candidates = oldPlan.tasks.filter(o => oldUnfinished.has(o.id))
  const used = new Set<string>()
  for (const t of newDraft.tasks) {
    const matched = oldById.get(t.id) ?? candidates.find(o => o.pointId === t.pointId && o.kind === t.kind && o.cycle === t.cycle && !used.has(o.id))
    if (!matched) { added.push(t); continue }
    used.add(matched.id)
    if (!oldUnfinished.has(matched.id)) continue
    if (matched.date !== t.date) { moved.push(t); continue }
    if (matched.minutes !== t.minutes) { changed.push({ from: matched, to: t }); continue }
    unchanged.push(t)
  }
  for (const [id, t] of oldById) if (oldUnfinished.has(id) && !used.has(id)) removed.push(t)
  return { added, removed, moved, changed, unchanged }
}

export function publicCourse(course: Course, now: number) {
  return {
    ...course,
    questions: course.questions.map(q => {
      const answered = course.attempts.some(a => a.questionId === q.id)
      const { answer, explanation, quote, ...safe } = q
      return answered || q.assisted ? { ...safe, answer, explanation, quote } : safe
    }),
    evidence: Object.fromEntries(course.points.map(p => [p.id, evidence(course,p.id)])),
    next: nextAction(course, now),
    progress: { completed: course.plan?.tasks.filter(t => t.status === 'completed').length ?? 0, total: course.plan?.tasks.length ?? 0, covered: course.scope.filter(id => evidence(course,id).count > 0).length, scope: course.scope.length },
  }
}
