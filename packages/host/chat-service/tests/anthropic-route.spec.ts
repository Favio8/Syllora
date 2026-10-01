import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { createDeepSeekToolClient } from '../src/adapter.ts'
it('dispatches Anthropic through the shared tool client and retains calls without argument deltas', async () => {
  const requests: unknown[] = []
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const server = createServer((req, res) => {
    let body = ''; req.on('data', part => { body += part }); req.on('end', () => {
      expect(req.url).toBe('/v1/messages'); expect(req.headers['x-api-key']).toBe('placeholder-value')
      requests.push(JSON.parse(body)); res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(frame('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'call_fixture', name: 'list' } }) + frame('message_delta', { delta: { stop_reason: 'tool_use' } }) + frame('message_stop', {}))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const client = createDeepSeekToolClient({ providerId: 'fixture', model: 'fixture', protocol: 'anthropic', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: 'placeholder-value', apiKeyEnv: null, temperature: 0.3, maxConcurrency: 1, defaultMode: 'quick' })
    const results = []; for await (const result of client.request('system', [{ role: 'user', content: 'list' }], [{ function: { name: 'list', description: 'List', parameters: { type: 'object', properties: {} } } }])) results.push(result)
    expect(results).toEqual([{ kind: 'toolCalls', calls: [{ id: 'call_fixture', name: 'list', arguments: {} }] }])
    expect(requests[0]).toMatchObject({ system: 'system', tools: [{ name: 'list', input_schema: { type: 'object' } }] })
    expect(requests[0]).not.toHaveProperty('temperature')
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
