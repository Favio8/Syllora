/**
 * 需求六：辅助阅读「直接提问」的流式问答。
 *
 * 与 AI解释 / AI搜索 两条老路径（走课程知识库检索、落盘成课程消息、带来源）
 * 不同，这条路径：
 *  - 不检索课程知识库，只用模型自身知识作答；
 *  - 不标注、不返回任何知识来源；
 *  - 逐 token 流式下发，前端边收边渲染；
 *  - 不落盘任何记录（无课程消息、无活动记录）。
 *
 * @module @syllora/chat-service/src/reading-ask
 */

import type { ToolLlmClient } from '@syllora/session'
import type { ResolvedChatConfig } from './config.ts'
import { createDeepSeekToolClient } from './adapter.ts'

export interface ReadingAskInput {
  /** 用户提示词（必填，1..4000 字符）。 */
  prompt: string
  /** 框选文字（可空）。 */
  selection?: string
  /** 阅读资料标题（可空，仅作为上下文提示，不注入正文）。 */
  documentTitle?: string
}

/** 流式问答的一次回包：token 逐段下发，最后 done 收尾，失败下发 error。 */
export interface ReadingAskChunk {
  kind: 'token' | 'done' | 'error'
  delta?: string
  message?: string
}

/**
 * LLM 客户端接缝：与 `createDeepSeekToolClient` 的 `request` 同形。测试用
 * 假客户端替换它，避免真的打网络。
 */
export type ReadingAskClientFactory = (config: ResolvedChatConfig) => Pick<ToolLlmClient, 'request'>

/** 提示词与选中文字的长度上限；与 Web 端校验、路由校验同口径。 */
export const READING_ASK_MAX_CHARS = 4000

const THINK_TAG = '<think>'

const READING_ASK_SYSTEM = [
  '你是 Syllora 的学习助手。请直接、完整地回答用户的问题。',
  '要求：',
  '1. 用你自己掌握的知识作答，不要声称引用了用户的课程资料；',
  '2. 不要输出「来源」「引用」清单，也不要提及任何资料标题或章节；',
  '3. 不确定的内容直接说明不确定，不要编造；',
  '4. 公式用 LaTeX 书写：行内 $…$，独立公式 $$…$$。',
].join('\n')

/** 错误消息净化：只保留首行，抹掉密钥痕迹（栈与换行细节不出口）。 */
function sanitizeAskError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const cleaned = raw
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, 'AIza***')
    .replace(/([?&](?:api[_-]?key|apikey|access[_-]?token|token|secret|password|key)=)[^&\s'"]+/gi, '$1***')
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .split('\n')[0]!
    .trim()
    .slice(0, 300)
  return cleaned === '' ? 'AI 直答未完成，请重试。' : cleaned
}

/**
 * 累计文本里可以安全下发的**前缀**：不含任何 `<think>` 片段，且结尾不落在
 * 一个可能长成 `<think>` 的半截标签上（如末尾的 `<thi`）。
 *
 * 流式下发的 `<think>` 处理只能是"缓冲少量、下发安全前缀"：完整块就地剥掉，
 * 未闭合的 `<think>` 之后一律扣住不发——宁可少发几个字，也不能让 think 标记
 * 漏到界面。
 */
function thinkSafePrefix(raw: string): string {
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const lower = stripped.toLowerCase()
  // 完整块已剥掉后还剩下 `<think>`：它是未闭合的开标签，从它起全部扣住。
  const open = lower.lastIndexOf(THINK_TAG)
  const closed = open < 0 ? stripped : stripped.slice(0, open)
  // 结尾若是 `<think>` 的真前缀（`<`、`<t`、`<thi`…），也先扣住等后续字节。
  for (let length = Math.min(THINK_TAG.length, closed.length); length > 0; length--) {
    if (THINK_TAG.startsWith(closed.slice(closed.length - length).toLowerCase())) {
      return closed.slice(0, closed.length - length)
    }
  }
  return closed
}

/** 组装用户消息：资料标题/选中文字只作上下文提示，提示词是真正的问题。 */
function askUserMessage(input: ReadingAskInput, prompt: string): string {
  const parts: string[] = []
  const title = input.documentTitle?.trim() ?? ''
  if (title !== '') parts.push(`资料标题：${title.slice(0, 200)}`)
  const selection = input.selection?.trim().slice(0, READING_ASK_MAX_CHARS) ?? ''
  if (selection !== '') parts.push(`选中文字：${selection}`, `提示词：${prompt}`)
  else parts.push(prompt)
  return parts.join('\n\n')
}

/**
 * 辅助阅读「直接提问」的流式回答。
 *
 * `config === null`（未配置模型）时只下发一条 error 回包；成功路径先逐段下发
 * token，最后下发 done。全程不落盘。
 *
 * @param clientFactory 测试接缝；缺省用真实适配器客户端。
 */
export async function* streamReadingAsk(
  config: ResolvedChatConfig | null,
  input: ReadingAskInput,
  signal?: AbortSignal,
  clientFactory: ReadingAskClientFactory = createDeepSeekToolClient,
): AsyncGenerator<ReadingAskChunk> {
  if (config === null) {
    yield { kind: 'error', message: '尚未配置模型，无法回答。请先在设置里配置模型供应商。' }
    return
  }
  const prompt = input.prompt.trim().slice(0, READING_ASK_MAX_CHARS)
  if (prompt === '') {
    yield { kind: 'error', message: '请输入提示词后再发送。' }
    return
  }
  const user = askUserMessage(input, prompt)
  let raw = ''
  let sent = 0
  try {
    for await (const chunk of clientFactory(config).request(READING_ASK_SYSTEM, [{ role: 'user', content: user }], null, signal)) {
      if (chunk.kind !== 'text') continue
      raw += chunk.delta
      const safe = thinkSafePrefix(raw)
      if (safe.length > sent) {
        const delta = safe.slice(sent)
        sent = safe.length
        yield { kind: 'token', delta }
      }
    }
  } catch (error) {
    // 客户端已断开时不再回包（路由侧也已停止写帧），只收尾。
    if (signal?.aborted === true) return
    yield { kind: 'error', message: sanitizeAskError(error) }
    return
  }
  if (signal?.aborted === true) return
  yield { kind: 'done' }
}
