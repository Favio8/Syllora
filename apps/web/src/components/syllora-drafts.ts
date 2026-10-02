export interface LocalDraft {
  prompt: string
  answers: Record<string, number>
  revision: number
  savedRevision: number
  savedAt: number
  baseVersion?:number
}

export type DraftCache = Record<string, LocalDraft>

export interface ServerDraft {
  prompt: string
  answers: Array<{ questionId: string; option: number }>
  version?:number
}

const answersOf = (answers: ServerDraft['answers']): Record<string, number> => {
  const next: Record<string, number> = {}
  for (const answer of answers) next[answer.questionId] = answer.option
  return next
}

const sameAnswers = (left: Record<string, number>, right: Record<string, number>) => {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length && leftKeys.every(key => left[key] === right[key])
}

export function rememberServer(cache: DraftCache, courseId: string, server: ServerDraft, polledAt = Number.POSITIVE_INFINITY): DraftCache {
  const local = cache[courseId]
  if (local && local.revision !== local.savedRevision) return cache
  if (local && local.savedAt > polledAt) return cache
  const prompt = server.prompt
  const answers = answersOf(server.answers)
  if (local && local.prompt === prompt && sameAnswers(local.answers, answers)) return {...cache,[courseId]:{...local,baseVersion:server.version??0}}
  return { ...cache, [courseId]: { prompt, answers, revision: 0, savedRevision: 0, savedAt: 0,baseVersion:server.version??0 } }
}

export function editDraft(cache: DraftCache, courseId: string, prompt: string, answers: Record<string, number>): DraftCache {
  const current = cache[courseId] ?? { prompt: '', answers: {}, revision: 0, savedRevision: 0, savedAt: 0 }
  return { ...cache, [courseId]: { ...current,prompt, answers, revision: current.revision + 1, savedRevision: current.savedRevision, savedAt: current.savedAt } }
}

export function markSaved(cache: DraftCache, courseId: string, revision: number, savedAt = Date.now(),baseVersion?:number): DraftCache {
  const current = cache[courseId]
  if (!current) return cache
  return { ...cache, [courseId]: { ...current, savedRevision: Math.max(current.savedRevision,revision), savedAt,...(baseVersion===undefined?{}:{baseVersion}) } }
}

export function hydrateCourse(cache: DraftCache, courseId: string, server: ServerDraft): { prompt: string; answers: Record<string, number>; shouldSave: false } {
  const local = cache[courseId]
  if (local) return { prompt: local.prompt, answers: local.answers, shouldSave: false }
  const seeded = rememberServer(cache, courseId, server)[courseId]!
  return { prompt: seeded.prompt, answers: seeded.answers, shouldSave: false }
}
