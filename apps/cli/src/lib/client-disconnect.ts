import type { IncomingMessage, ServerResponse } from 'node:http'

/** 请求体完成会关闭可读流；SSE 断连则发生在响应尚未写完时。 */
export function onClientDisconnect(request: IncomingMessage, response: ServerResponse, listener: () => void): void {
  let disconnected = false
  const trigger = () => {
    if (disconnected) return
    disconnected = true
    listener()
  }
  request.once('aborted', trigger)
  request.once('error', trigger)
  request.once('close', () => { if (!request.complete) trigger() })
  response.once('close', () => { if (!response.writableFinished) trigger() })
  if ((!request.complete && request.destroyed) || (response.destroyed && !response.writableFinished)) trigger()
}
