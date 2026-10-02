import { createServer, request, type RequestListener, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { onClientDisconnect } from '../src/lib/client-disconnect.ts'

let server: Server | undefined
afterEach(async () => {
  if (!server) return
  server.closeAllConnections()
  await new Promise<void>(resolve => server!.close(() => resolve()))
  server = undefined
})
async function listen(handler: RequestListener) {
  server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  return `http://127.0.0.1:${address.port}`
}

describe('CR-01 / CR-15 HTTP disconnect handling', () => {
  it('does not abort after a complete POST body or a normally finished SSE response', async () => {
    let disconnected = false
    const url = await listen(async (req, res) => {
      onClientDisconnect(req, res, () => { disconnected = true })
      for await (const _chunk of req) { /* receive the entire body */ }
      await new Promise<void>(resolve => setImmediate(resolve))
      res.setHeader('content-type', 'text/event-stream')
      res.end('event: done\ndata: {}\n\n')
    })
    const response = await fetch(url, { method: 'POST', body: 'normal-body' })
    expect(await response.text()).toContain('event: done')
    expect(disconnected).toBe(false)
  })

  it('aborts when the client leaves an SSE response after the body was fully received', async () => {
    let complete = false, calls = 0
    let resolveDisconnect!: () => void
    const disconnected = new Promise<void>(resolve => { resolveDisconnect = resolve })
    const url = await listen(async (req, res) => {
      onClientDisconnect(req, res, () => { calls++; resolveDisconnect() })
      for await (const _chunk of req) { /* POST body has ended */ }
      complete = req.complete
      res.setHeader('content-type', 'text/event-stream')
      res.write('event: meta\ndata: {}\n\n')
    })
    const controller = new AbortController()
    const response = await fetch(url, { method: 'POST', body: 'normal-body', signal: controller.signal })
    const reader = response.body!.getReader()
    await reader.read()
    controller.abort()
    await disconnected
    expect(complete).toBe(true)
    expect(calls).toBe(1)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  })

  it('aborts once when the client disconnects during an incomplete upload', async () => {
    let calls = 0
    let resolveDisconnect!: () => void, resolveData!: () => void
    const disconnected = new Promise<void>(resolve => { resolveDisconnect = resolve })
    const received = new Promise<void>(resolve => { resolveData = resolve })
    const url = await listen((req, res) => {
      onClientDisconnect(req, res, () => { calls++; resolveDisconnect() })
      req.once('data', resolveData)
    })
    const client = request(url, { method: 'POST', headers: { 'content-length': '1000' } })
    client.on('error', () => {})
    client.write('partial')
    await received
    client.destroy()
    await disconnected
    expect(calls).toBe(1)
  })
})
