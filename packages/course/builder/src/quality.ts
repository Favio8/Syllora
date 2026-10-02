/**
 * 题卡生成后质量闸（题卡质量 A 档）：纯规则、零 LLM 成本。
 * 在生成与入库之间执行——不合格的卡进 build report 的 degraded，不进题池。
 * 规则来自对真实题池的体检结论：
 * - 正确项恒最长（承载全部限定词，干扰项 30~60 字）→ 长度失衡卡直接丢弃；
 * - MCQ 缺/越界 answer_index → 无法客观判分，丢弃；
 * - 同概念内题干近似重复 → 丢弃后到者；
 * - 跨题答案泄漏（一题的题干/解析里出现另一题的正确选项文本）→ 丢弃泄漏卡（见下）。
 * @module @syllora/course-builder/src/quality
 */

import type { HarnessTask } from './models.ts'

export interface QualityGateResult {
  kept: HarnessTask[]
  dropped: Array<{ taskId: string; reason: string }>
  /** 答案位置分布（仅 MCQ）：key=位置，value=张数。供分布偏斜告警。 */
  answerPositionHistogram: Record<number, number>
}

/** 归一化题干：去空白/标点差异后的小写形式，用于近似重复判定。 */
function normalizeQuestion(question: string): string {
  return question.toLowerCase().replace(/[\s，。；：、！？"'"（）()【】\[\]—\-·…]/g, '')
}

/** 单卡规则检查：返回 null 表示合格，否则给出丢弃原因。
 *  seen：同概念 + 同源文件的已收录题干（跨文件的同概念题允许同题干——
 *  不同切片合并到同一概念是合法场景，如 id 冲突重排用例）。 */
export function checkTaskQuality(task: HarnessTask, seenQuestions: string[]): string | null {
  const options = task.options
  if (Array.isArray(options) && options.length > 0) {
    if (task.answer_index === null || task.answer_index === undefined) {
      return '选择题缺少 answer_index（无法客观判分）'
    }
    if (task.answer_index < 0 || task.answer_index >= options.length) {
      return `answer_index ${task.answer_index} 越界（选项数 ${options.length}）`
    }
    const lens = options.map(option => option.length)
    const shortest = Math.min(...lens)
    const longest = Math.max(...lens)
    if (shortest > 0 && longest / shortest > 2.5) {
      return `选项长度失衡（最长 ${longest} 字 / 最短 ${shortest} 字，正确项可被猜中）`
    }
  }
  const normalized = normalizeQuestion(task.question)
  for (const seen of seenQuestions) {
    // 只判归一化后完全一致：长公共前缀会让相似度阈值误杀「问题 1 / 问题 2」
    // 这类仅差末位序号的合法系列题（实测相似度高达 0.91），而 LLM 重复输出
    // 的典型形态恰是逐字回声。
    if (normalized === seen) {
      return '与同概念已有题卡题干完全一致（疑似重复）'
    }
  }
  return null
}

/** 归一化任意文本（题干、解析、选项）：用于跨题答案泄漏比对。 */
function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[\s，。；：、！？"'"（）()【】\[\]—\-·…]/g, '')
}

/** 跨题泄漏的最短判定长度：短选项（"3"、"加"）会在任何文本里误命中。 */
const LEAK_MIN_CHARS = 4

/**
 * 跨题答案泄漏：本题的**题干或解析**里，不得出现**另一题正确选项**的文本。
 * 逐字包含才算（归一化后），因为这是"答案被别的题面说破"的确凿形态；
 * 相似但不相同的表述交给人看，不做模糊判定。
 */
export function checkCrossQuestionLeak(task: HarnessTask, otherAnswers: string[]): string | null {
  const own = normalizeText(`${task.question}${task.answer_rationale ?? ''}`)
  for (const answer of otherAnswers) {
    if (answer.length < LEAK_MIN_CHARS) continue
    if (own.includes(answer)) return `题干或解析中含另一题的正确选项文本（"${answer.slice(0, 12)}…"），会泄漏答案`
  }
  return null
}

/** 对一批新卡执行质量闸：按序保留合格卡、记录丢弃原因与答案位置分布。 */
export function enforceTaskQuality(tasks: readonly HarnessTask[]): QualityGateResult {
  const kept: HarnessTask[] = []
  const dropped: QualityGateResult['dropped'] = []
  const seenByScope = new Map<string, string[]>()
  const answerPositionHistogram: Record<number, number> = {}
  for (const task of tasks) {
    const scope = `${task.concept_id}|${task.source_ref?.file ?? ''}`
    const reason = checkTaskQuality(task, seenByScope.get(scope) ?? [])
    if (reason !== null) {
      dropped.push({ taskId: task.task_id, reason })
      continue
    }
    const scopeSeen = seenByScope.get(scope) ?? []
    scopeSeen.push(normalizeQuestion(task.question))
    seenByScope.set(scope, scopeSeen)
    kept.push(task)
  }
  // 第二遍：跨题泄漏。先收集全部合格卡的正确选项，再逐卡比对"别人的答案"
  // ——同一批里题目是连着做的，任何一题的答案被另一题的题面说破都算泄漏。
  const answers = kept.map(task => {
    const index = task.answer_index
    if (!Array.isArray(task.options) || index === null || index === undefined || index < 0 || index >= task.options.length) return ''
    return normalizeText(task.options[index] ?? '')
  })
  const finalKept: HarnessTask[] = []
  for (const [position, task] of kept.entries()) {
    const others = answers.filter((_, index) => index !== position && answers[index] !== '')
    const leak = checkCrossQuestionLeak(task, others)
    if (leak !== null) {
      dropped.push({ taskId: task.task_id, reason: leak })
      continue
    }
    const index = task.answer_index
    if (Array.isArray(task.options) && task.options.length > 0 && index !== null && index !== undefined) {
      answerPositionHistogram[index] = (answerPositionHistogram[index] ?? 0) + 1
    }
    finalKept.push(task)
  }
  return { kept: finalKept, dropped, answerPositionHistogram }
}

/** 答案位置偏斜告警：单一位置占比超阈值时提示（不丢弃，仅提示出题方）。 */
export function answerPositionSkewWarning(histogram: Record<number, number>): string | null {
  const total = Object.values(histogram).reduce((sum, count) => sum + count, 0)
  if (total < 4) return null
  const [position, count] = Object.entries(histogram).reduce((max, entry) => (entry[1] > max[1] ? entry : max))
  if (count / total > 0.6) {
    return `answer_index=${position} 的题卡占 ${count}/${total}——正确项位置偏斜，建议检查 prompt 轮换是否生效`
  }
  return null
}
