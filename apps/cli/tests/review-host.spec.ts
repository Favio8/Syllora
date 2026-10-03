import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const origin = 'https://syllora-review.vercel.app'
let root: string, child: ChildProcess, base: string, token: string
async function start() {
  child = spawn(process.execPath, ['--import', 'tsx', 'apps/cli/src/bin.ts', 'serve', '--port', '0'], {
    cwd: repo, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, TSX_TSCONFIG_PATH: join(repo, 'tsconfig.base.json'), SYLLORA_REVIEW_MODE: '1', SYLLORA_REVIEW_ROOT: root, SYLLORA_ALLOWED_ORIGINS: origin },
  })
  for (let n = 0; n < 200; n++) {
    const state = await readFile(join(root, 'home', 'host.json'), 'utf8').then(JSON.parse).catch(() => null)
    if (state?.pid === child.pid) { base = `http://127.0.0.1:${state.port}`; token = state.token; return }
    if (child.exitCode !== null) throw new Error('Review host exited before startup')
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('Review host startup timed out')
}
async function stop() {
  if (child?.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
}
function post(method: string, payload: unknown, credential = token) {
  return fetch(`${base}/api/${method}`, { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ payload }) })
}
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'syllora-review-http-')); await start() })
afterAll(async () => { await stop(); if (root) await rm(root, { recursive: true, force: true }) })
it('enforces exact CORS, bearer and Secure cookie authentication', async () => {
  const options = await fetch(`${base}/api/syllora/state`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Headers': 'Authorization,ngrok-skip-browser-warning' } })
  expect(options.status).toBe(204)
  expect(options.headers.get('Access-Control-Allow-Origin')).toBe(origin)
  const rogue = await fetch(`${base}/api/syllora/state`, { method: 'OPTIONS', headers: { Origin: 'https://attacker.example' } })
  expect(rogue.status).toBe(403); expect(rogue.headers.get('Access-Control-Allow-Origin')).toBeNull()
  expect((await post('syllora/state', {}, 'wrong')).status).toBe(401)
  const login = await fetch(`${base}/api/session`, { method: 'POST', headers: { Origin: origin, 'x-syllora-token': token } })
  expect(login.status).toBe(200)
  expect(login.headers.get('Set-Cookie')).toContain('HttpOnly')
  expect(login.headers.get('Set-Cookie')).toContain('Secure')
  expect(login.headers.get('Cache-Control')).toContain('no-store')
  const cookie = login.headers.get('Set-Cookie')!.split(';')[0]!
  const state = await fetch(`${base}/api/syllora/state`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ payload: {} }) })
  expect(state.status).toBe(200)
})
it('refuses external directories and legacy import paths before reading or registering them', async () => {
  const outside = join(root, 'outside'); await mkdir(outside)
  for (const [method, payload] of [
    ['workspaces.open', { path: outside }], ['workspaces.courses', { path: outside }],
    ['host.browseDirectory', { path: outside }], ['syllora/openCourse', { path: outside }],
    ['syllora/migrateCourse', { courseId: 'a26655f6-e697-4da1-b32c-d02076749a08', path: outside }],
    ['workspaces.createCourse', { courseName: 'escape', importPaths: [outside] }],
  ] as const) {
    const response = await post(method, payload); const body = await response.json() as { error?: unknown }
    expect(body.error, method).toBeDefined()
  }
  const listing = await post('workspaces.list', {}).then(r => r.json()) as any
  expect(JSON.stringify(listing)).not.toContain(outside.replaceAll('\\', '\\\\'))
})
it('persists courses across restarts while invalidating the previous bearer and cookie', async () => {
  const created = await post('syllora/createCourse', { name: 'Persisted review course', requestId: '8c7b8f6d-0487-403d-a951-0160f0b905ab' }).then(r => r.json()) as any
  expect(created.error).toBeUndefined(); expect(created.result.id).toBeTruthy()
  const login = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'x-syllora-token': token } })
  const cookie = login.headers.get('Set-Cookie')!.split(';')[0]!, previous = token
  await stop(); await start()
  expect(token).not.toBe(previous)
  expect((await post('syllora/state', {}, previous)).status).toBe(401)
  expect((await fetch(`${base}/api/syllora/state`, { method: 'POST', headers: { Cookie: cookie }, body: '{}' })).status).toBe(401)
  const state = await post('syllora/state', {}).then(r => r.json()) as any
  expect(state.result.courses.some((course: { id: string }) => course.id === created.result.id)).toBe(true)
})
it('does not cache authenticated review note assets', async () => {
  const courseId = '8c7b8f6d-0487-403d-a951-0160f0b905ab'
  const uploaded = await post('syllora/notes/uploadImage', { courseId, ext: 'png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXf8AAAAASUVORK5CYII=' }).then(r => r.json()) as any
  expect(uploaded.error).toBeUndefined()
  const image = await fetch(`${base}/api/syllora/notes/asset?courseId=${courseId}&name=${uploaded.result.name}`, { headers: { Authorization: `Bearer ${token}`, Origin: origin } })
  expect(image.status).toBe(200)
  expect(image.headers.get('Cache-Control')).toContain('no-store')
})
