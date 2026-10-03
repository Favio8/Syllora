/**
 * 需求一（输入可靠性）：中文输入法的组合期（composition）里，页面任何一次
 * 「大范围重渲染 + 值回写」都可能打断组合，用户看到的是"字打不进去"。宿主
 * 状态每 1.5 秒轮询一次并 setState，正好落在组合窗口里就会触发这个现象。
 *
 * 这里在 document 上记录组合状态（capture，输入法事件只发给正在输入的元素），
 * 供轮询方判断"此刻先别刷"：组合结束后留一小段宽限期，等提交落到输入框里。
 */

let composing = false
let releasedAt = 0
const GRACE_MS = 250

/** 安装监听（幂等；由顶层组件在挂载时调用一次）。 */
export function installTypingGuard(): () => void {
  const start = () => { composing = true }
  const end = () => { composing = false; releasedAt = Date.now() }
  composing = false
  releasedAt = 0
  document.addEventListener('compositionstart', start, true)
  document.addEventListener('compositionend', end, true)
  return () => {
    document.removeEventListener('compositionstart', start, true)
    document.removeEventListener('compositionend', end, true)
    composing = false
    releasedAt = 0
  }
}

/** 当前是否正在输入法组合中（含组合刚结束的宽限期）。 */
export function isTextComposing(): boolean {
  if (composing) return true
  return releasedAt !== 0 && Date.now() - releasedAt < GRACE_MS
}
