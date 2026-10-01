import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AnthropicAdapter } from '../src/adapter.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function endpoint(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
function adapter(baseURL: string, idle = 5000) {
  return new AnthropicAdapter({ options: () => ({ baseURL, maxTokens: 1024, defaultContextWindow: 200000, models: [], streamIdleTimeoutMs: idle }), resolveApiKey: async () => 'placeholder-value', resolveUserId: () => 'fixture' as never })
}
const request = () => ({ provider: 'fixture', model: 'fixture', messages: [createUserMessage({ content: [{ type: 'text' as const, text: 'Hello' }], source: { kind: 'user' as const } })] })
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const reply = frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '中文 answer' } }) + frame('message_delta', { delta: { stop_reason: 'end_turn' } }) + frame('message_stop', {})
async function collect(stream: AsyncIterable<StreamChunk>) { const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks }

describe('Anthropic HTTP/SSE boundary', () => {
  it('uses one version segment, required headers and split UTF-8 SSE', async () => {
    let path = '', headers: IncomingMessage['headers'] = {}, body = ''
    const base = await endpoint((req, res) => {
      path = req.url!; headers = req.headers
      req.on('data', part => { body += part }); req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const bytes = Buffer.from(reply), split = bytes.indexOf(Buffer.from('中文')) + 1
        res.write(bytes.subarray(0, split)); res.end(bytes.subarray(split))
      })
    })
    const chunks = await collect(adapter(`${base}/gateway/v1/`).stream(request()))
    expect(path).toBe('/gateway/v1/messages')
    expect(headers['x-api-key']).toBe('placeholder-value')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers.authorization).toBeUndefined()
    expect(JSON.parse(body)).toMatchObject({ model: 'fixture', max_tokens: 1024, stream: true })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: '中文 answer' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
  it('does not resend a POST after the provider accepted it and disconnected', async () => {
    let calls = 0
    const base = await endpoint((req) => { calls++; req.resume(); req.on('end', () => req.socket.destroy()) })
    await expect(collect(adapter(base).stream(request()))).rejects.toMatchObject({ code: 'TRANSPORT' })
    expect(calls).toBe(1)
  })
  it('rejects truncated SSE and HTTP authentication failures', async () => {
    const base = await endpoint((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(frame('content_block_start', { index: 0, content_block: { type: 'text' } })) })
    await expect(collect(adapter(base).stream(request()))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
    const auth = await endpoint((_req, res) => { res.writeHead(401); res.end(JSON.stringify({ error: { message: 'Rejected placeholder' } })) })
    await expect(collect(adapter(auth).stream(request()))).rejects.toMatchObject({ code: 'AUTH', failure: { status: 401 } })
    const rate = await endpoint((_req, res) => { res.writeHead(429, { 'retry-after': '0' }); res.end('{}') })
    await expect(collect(adapter(rate).stream(request()))).rejects.toMatchObject({ code: 'RATE_LIMIT' })
  })
  it('honors cancellation and idle timeout', async () => {
    const cancel = new AbortController()
    const base = await endpoint((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); cancel.abort() })
    await expect(collect(adapter(base).stream({ ...request(), signal: cancel.signal }))).rejects.toMatchObject({ code: 'ABORTED' })
    const idle = await endpoint((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders() })
    await expect(collect(adapter(idle, 100).stream(request()))).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
  it('closes the provider connection when the consumer stops reading', async () => {
    let closed!: () => void
    const stopped = new Promise<void>(resolve => { closed = resolve })
    const base = await endpoint((_req, res) => { res.on('close', closed); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(reply.slice(0, reply.indexOf('event: message_delta'))) })
    const stream = adapter(base).stream(request())[Symbol.asyncIterator]()
    await stream.next(); await stream.return!()
    await stopped
  })
  it('does not forward credentials to a redirect destination', async () => {
    let calls = 0
    const other = await endpoint((_req, res) => { calls++; res.end(reply) })
    const base = await endpoint((_req, res) => { res.writeHead(307, { location: `${other}/v1/messages` }); res.end() })
    await expect(collect(adapter(base).stream(request()))).rejects.toMatchObject({ code: 'TRANSPORT' })
    expect(calls).toBe(0)
  })
})
