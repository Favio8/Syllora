/**
 * Structured LLM output helper: zod schema → JSON Schema tool, force via a
 * single `_emit` tool; when the model answers with plain text instead, the
 * JSON is extracted from the text (markdown fences included) — the
 * instructor-equivalent of Python's JSON_SCHEMA → JSON → MD_JSON fallback
 * chain, implemented over the dsh StreamChunk vocabulary.
 * @module @syllora/course-builder/src/structured
 */

import { z } from 'zod'
import type { GenerateOptions, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { CallId, HarnessError } from '@deepseek-ai/dsh-llm'

export interface StructuredCallClient {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

const EMIT_TOOL = '_emit_structured'

/** PERF-2：重试退避参数——失败后立即打回去只会加剧 429/限流。 */
const RETRY_INITIAL_DELAY_MS = 500
const RETRY_MAX_DELAY_MS = 8_000

async function retryBackoffDelay(attempt: number): Promise<void> {
  const exponential = Math.min(RETRY_MAX_DELAY_MS, RETRY_INITIAL_DELAY_MS * 2 ** attempt)
  const jitter = Math.round(exponential * (0.8 + Math.random() * 0.4))
  await new Promise(resolve => setTimeout(resolve, jitter))
}

/** Extract a JSON object from model text (fenced or bare, Python parity).
 *  RV-9：括号扫描必须感知字符串字面量，且围栏内损坏对象的括号会污染全文
 *  深度计数——因此对每个 `{` 位置独立做字符串感知的平衡扫描，首个解析成功
 *  的对象胜出；纯 JSON 候选走快路径。扫描长度封顶防病态输入。 */
const MAX_SCAN_CHARS = 1_000_000

function tryParseObjectFrom(text: string, start: number): unknown {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as unknown
        } catch {
          return null
        }
      }
      if (depth < 0) return null
    }
  }
  return null
}

/**
 * 兼容把"工具调用"写成 XML 文本的供应商方言：部分 OpenAI 兼容网关（实测
 * 小米 MiMo）偶尔不返回标准 tool_calls，而是把参数塞进正文：
 *   <tool_call><function=_emit_structured><parameter=text>…</parameter>…</tool_call>
 * 两种常见写法都认：`<parameter=NAME>` 与 `<parameter name="NAME">`。
 * 值优先按 JSON 解析（数组/布尔/数字/带引号字符串），失败则作为原始文本，
 * 并做 XML 实体反转义。返回 null 表示不是这种方言。
 */
export function extractXmlToolCall(text: string): Record<string, unknown> | null {
  const bounded = text.slice(0, MAX_SCAN_CHARS)
  const pattern = /<parameter\s*(?:=\s*"?([\w.-]+)"?|name\s*=\s*"([\w.-]+)")\s*>([\s\S]*?)<\/parameter\s*>/g
  const fields: Record<string, unknown> = {}
  let matched = false
  for (const hit of bounded.matchAll(pattern)) {
    const key = hit[1] ?? hit[2]
    if (key === undefined) continue
    matched = true
    const rawValue = hit[3] ?? ''
    try {
      fields[key] = JSON.parse(rawValue) as unknown
      continue
    } catch {
      // 非 JSON 字面量：当纯文本用。
    }
    fields[key] = rawValue
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .trim()
  }
  return matched ? fields : null
}

export function extractJsonObject(text: string): unknown {
  try {
    return extractJsonObjectOnly(text)
  } catch {
    // 最后一道：XML 工具调用方言（参数在正文里，不是标准 tool_calls）。
  }
  const xml = extractXmlToolCall(text.slice(0, MAX_SCAN_CHARS))
  if (xml !== null) return xml
  throw new Error('响应中未找到合法 JSON')
}

/** 只认 JSON（围栏/裸 JSON/平衡扫描），不做 XML 方言兜底——降级抢救要靠它
 *  区分"模型回的是 JSON 但字段不全"还是"回的是 XML 工具调用方言"。 */
function extractJsonObjectOnly(text: string): unknown {
  const bounded = text.slice(0, MAX_SCAN_CHARS)
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(bounded)
  const candidates = fenced !== null ? [fenced[1]!, bounded] : [bounded]
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      // 非纯 JSON：逐个 `{` 位置尝试平衡扫描。
    }
    let index = candidate.indexOf('{')
    while (index >= 0) {
      const parsed = tryParseObjectFrom(candidate, index)
      if (parsed !== null) return parsed
      index = candidate.indexOf('{', index + 1)
    }
  }
  throw new Error('响应中未找到合法 JSON')
}

export interface SalvagedFields {
  /** 可发布的正文（可能为空串：调用方据此决定是否降级）。 */
  text: string
  /** 从原文里识别出的来源 id（未做存在性校验，调用方必须自行过滤）。 */
  sourceIds: string[]
  /** 还原路径：json=标准/围栏 JSON；xml=XML 工具调用方言；text=只剩正文。 */
  recovered: 'json' | 'xml' | 'text'
}

/**
 * 结构校验失败后的"抢救"：尽量把模型已经写出来的内容还原成可发布字段。
 * 不是宽容解析的替代品——严格路径能过就走严格路径，这里只服务于
 * 「检查失败也放行」的降级发布。
 */
export function salvageStructuredFields(raw: string): SalvagedFields {
  const bounded = raw.slice(0, MAX_SCAN_CHARS)
  let object: Record<string, unknown> | null = null
  let recovered: SalvagedFields['recovered'] = 'text'
  try {
    const parsed = extractJsonObjectOnly(bounded)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) { object = parsed as Record<string, unknown>; recovered = 'json' }
  } catch {
    // 连 JSON 都没有：可能是 XML 工具调用方言，或纯散文。
  }
  if (object === null) {
    const xml = extractXmlToolCall(bounded)
    if (xml !== null) { object = xml; recovered = 'xml' }
  }
  const pickText = (value: unknown): string => typeof value === 'string' ? value : ''
  const pickIds = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : []
  if (object !== null) {
    const text = pickText(object['text']) || pickText(object['answer']) || pickText(object['content'])
    let sourceIds = pickIds(object['sourceIds'] ?? object['source_ids'] ?? object['sources'])
    if (sourceIds.length === 0) sourceIds = collectQuotedIds(bounded)
    return { text: text.slice(0, 16_000), sourceIds, recovered }
  }
  // 只剩散文：剥掉 XML/工具调用脚手架、内联思维链与代码围栏，实体反转义后发布。
  const stripped = bounded
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<\/?tool_call\s*>/gi, ' ').replace(/<\/?function[^>]*>/gi, ' ')
    .replace(/<\/?parameter[^>]*>/gi, ' ').replace(/<\/?antml:[^>]*>/gi, ' ')
    .replace(/<[^>]{1,120}>/g, ' ')
    .replace(/```[\s\S]*?```/g, block => block.replace(/```\w*\n?/g, ''))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return { text: stripped.slice(0, 16_000), sourceIds: collectQuotedIds(bounded), recovered: 'text' }
}

/** 从原文里捞形如 "…" 的 32/64 位十六进制片段 id（来源 id 的形状）。 */
function collectQuotedIds(text: string): string[] {
  const found = new Set<string>()
  for (const hit of text.matchAll(/"([0-9a-f]{16,64})"/gi)) if (hit[1] !== undefined) found.add(hit[1])
  return [...found].slice(0, 12)
}

/**
 * One structured call: asks the model for the schema via a single `_emit`
 * tool; on a text-only reply, falls back to JSON extraction; on parse
 * failure the error is injected and the call retried up to `maxRetries`.
 * @returns the validated output.
 */
export async function structuredCall<S extends z.ZodType>(
  client: StructuredCallClient,
  schema: S,
  options: Omit<GenerateOptions, 'tools'> & { tools?: ToolSchema[] },
  maxRetries = 3,
): Promise<z.infer<S>> {
  const attempt = await tryStructuredCall(client, schema, options, maxRetries)
  if (attempt.ok && attempt.value !== undefined) return attempt.value
  throw new Error(`结构化输出尝试 ${maxRetries} 次仍失败：${attempt.reason}`, { cause: attempt.cause })
}

export interface StructuredAttempt<S> {
  ok: boolean
  value?: S
  /** 失败时：模型原始输出（供降级发布抢救正文/来源用）。 */
  raw: string
  /** 失败原因（首行，可直接拼进日志）。 */
  reason: string
  /** 失败时的原始异常（调用方需要保留 cause 链时使用）。 */
  cause?: unknown
}

/** 只有"输出形状"类失败算可重试/可降级；供应商错误（截断/取消/限流/鉴权）
 *  必须原样抛出，不能被当成"格式问题"放行。 */
function isShapeFailure(error: unknown): boolean {
  if (error instanceof z.ZodError) return true
  return error instanceof Error && error.message === '响应中未找到合法 JSON'
}

/**
 * structuredCall 的"不抛形状异常"版本：形状失败返回 {ok:false, raw, reason}，
 * 交给调用方决定是降级发布还是照常失败；供应商级错误仍然直接抛出。
 */
export async function tryStructuredCall<S extends z.ZodType>(
  client: StructuredCallClient,
  schema: S,
  options: Omit<GenerateOptions, 'tools'> & { tools?: ToolSchema[] },
  maxRetries = 1,
): Promise<StructuredAttempt<z.infer<S>>> {
  const toolSchema: ToolSchema = {
    name: EMIT_TOOL,
    description: '输出符合给定 Schema 的 JSON 数据（只输出一个 JSON 对象）',
    parameters: z.toJSONSchema(schema, { target: 'json-schema' }) as Record<string, unknown>,
  }
  const tools = [...(options.tools ?? []), toolSchema]
  let feedback = ''
  let lastError: unknown
  let lastRaw = ''
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    if (attempt > 0) await retryBackoffDelay(attempt - 1)
    const system = `${options.system ?? ''}\n\n只允许调用 ${EMIT_TOOL} 工具输出结果，不要输出解释文字。${feedback !== '' ? `\n\n上一次失败原因：${feedback}` : ''}`
    try {
      const outcome = await callOnce(client, { ...options, system, tools })
      lastRaw = outcome.raw
      return { ok: true, value: schema.parse(outcome.value) as z.infer<S>, raw: outcome.raw, reason: '' }
    } catch (error) {
      // 外层截止/取消优先：把 signal 的原因（TimeoutError 等）作为 cause 抛出，
      // 错误分类才能区分「上游超时」与「调用方取消」。
      const aborted = options.signal?.aborted === true
      if (aborted || !isShapeFailure(error)) {
        const cause = aborted && options.signal?.reason instanceof Error ? options.signal.reason : error
        throw new Error(`结构化输出尝试 ${attempt + 1} 次仍失败：${error instanceof Error ? error.message : String(error)}`, { cause })
      }
      lastError = error
      lastRaw = error instanceof ShapeFailureError ? error.raw : lastRaw
      feedback = error instanceof Error ? error.message : String(error)
      if (options.signal?.aborted) { lastError = options.signal.reason instanceof Error ? options.signal.reason : error; break }
    }
  }
  return { ok: false, raw: lastRaw, reason: feedback === '' ? '模型未返回可解析的结构化输出' : feedback, cause: lastError }
}

/** 形状失败专用错误：带上原始输出，便于降级发布抢救。 */
export class ShapeFailureError extends Error {
  readonly raw: string
  constructor(message: string, raw: string) { super(message); this.name = 'ShapeFailureError'; this.raw = raw }
}

interface CallOutcome { value: unknown; raw: string }

async function callOnce(client: StructuredCallClient, options: GenerateOptions): Promise<CallOutcome> {
  options.signal?.throwIfAborted()
  const calls = new Map<number, { id: string; name: string; argumentsDelta: string }>()
  const textParts: string[] = []
  const reasoningParts: string[] = []
  for await (const chunk of client.stream(options)) {
    if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) throw new HarnessError('模型调用未完成', chunk.reason.failure.code)
    if (chunk.type === 'finish' && chunk.reason.kind === 'max-tokens') throw new HarnessError('模型输出已截断', 'OUTPUT_TRUNCATED')
    if (chunk.type === 'text-delta') textParts.push(chunk.text)
    else if (chunk.type === 'reasoning-delta') reasoningParts.push(chunk.text)
    else if (chunk.type === 'tool-call-delta') {
      const existing = calls.get(chunk.index) ?? { id: '', name: '', argumentsDelta: '' }
      if (chunk.id !== undefined) existing.id = String(chunk.id)
      if (chunk.name !== undefined) existing.name = chunk.name
      existing.argumentsDelta += chunk.argumentsDelta
      calls.set(chunk.index, existing)
    } else if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
      // Anthropic can deliver complete input with no incremental argument deltas.
      calls.set(chunk.index, { id:String(chunk.block.id), name:chunk.block.name, argumentsDelta:chunk.block.arguments })
    }
  }
  options.signal?.throwIfAborted()
  const text = textParts.join('')
  const reasoning = reasoningParts.join('')
  const emit = [...calls.values()].find(call => call.name === EMIT_TOOL)
  // raw 是"降级发布"要用的原文：优先 EMIT 工具参数（本意要输出的 JSON），
  // 其次**正文通道**——绝不含模型的自我推演（reasoning），否则降级发布会把
  // 模型的内心独白当成学习内容发出去（实测 MiMo 的 reasoning 就是自言自语）。
  // 正文里内联的 <think>…</think> 也在这里剥掉。
  const cleanText = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const raw = [emit?.argumentsDelta ?? [...calls.values()].map(call => call.argumentsDelta).join('\n'), cleanText !== '' ? cleanText : reasoning]
    .filter(part => part.trim() !== '')
    .join('\n')
  try {
    // value 的候选集合保持旧行为（正文 + 推理都参与 JSON 提取）。
    return { value: emit !== undefined ? extractJsonObject(emit.argumentsDelta) : extractJsonObject(`${text}${reasoning}`), raw }
  } catch (error) {
    if (error instanceof Error && error.message === '响应中未找到合法 JSON') throw new ShapeFailureError(error.message, raw)
    throw error
  }
}

export { CallId }
