#!/usr/bin/env node
/**
 * 阶段三整机冒烟：真实路径 `electron .`（main.cjs）——
 * spawn sidecar → 轮询 host.json → 开窗 loadURL → UI 就绪 → 应用自身退出路径。
 * 验证点：
 *   1. sidecar 进程拉起、host.json 写出（userData/host-home/）
 *   2. 窗口加载成功（console 无 net::ERR / fatal）
 *   3. 应用自身退出路径收尾：优先 SIGTERM（非 Windows）/ taskkill 无 /F 的
 *      WM_CLOSE 请求（Windows）走 before-quit → stopHost，sidecar 无残留（R6）；
 *      仅当优雅退出宽限内未生效才兜底强杀（强杀会留下孤儿 sidecar，属已知产品
 *      限制，此路径下不断言 residue）。
 *
 * 用法：node scripts/smoke-desktop.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeMissingHost, diagnosticEntries, electronLaunchOptions, formatStage, redactSecrets } from './startup-diagnosis.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(here, '..')
const require = createRequire(import.meta.url)
const electron = process.env.ELECTRON_PATH ?? require('electron')
const launch = electronLaunchOptions()
console.log('[smoke] electron =', electron)

// 隔离的 userData：通过 main.cjs 的 SYLLORA_DESKTOP_USERDATA override
// 精确指定（A9），不再枚举猜测 Electron 的 app name 目录规则。
const userData = mkdtempSync(join(tmpdir(), 'syllora-desktop-ud-'))
console.log('[smoke] userData =', userData)

// ELECTRON_RUN_AS_NODE 会让 electron 二进制退化为纯 Node 运行（app 未定义，
// main.cjs 直接崩）——调用方环境（CI/Harness）可能带着它，必须显式剔除。
const childEnv = { ...process.env, ELECTRON_ENABLE_LOGGING: '1', SYLLORA_DESKTOP_USERDATA: userData, SYLLORA_DESKTOP_SMOKE: '1' }
delete childEnv.ELECTRON_RUN_AS_NODE

const child = spawn(electron, ['.'], {
  cwd: desktop,
  env: childEnv,
  stdio: launch.stdio,
  windowsHide: launch.windowsHide,
})
let out = ''
let spawnError = null
let exit = null
child.on('error', error => { spawnError = error })
child.on('exit', (code, signal) => { exit = { code, signal } })
child.stdout.on('data', d => { out += d })
child.stderr.on('data', d => { out += d })

const hostJsonPath = join(userData, 'host-home', 'host.json')

// 跨平台进程树终止与存活探测：taskkill/tasklist 是 Windows 专属命令，
// 非 Windows 平台用 kill/--kill 及 kill(pid, 0)。方案面向 win/mac/linux。
const killTree = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} }
  }
}
const pidAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

let cfg = null
let pass = false
const diagnostics = () => {
  const path = join(userData, 'desktop.log')
  return existsSync(path) ? readFileSync(path, 'utf8') : '(desktop.log was not created: Electron did not enter main.cjs)'
}
try {

const t0 = Date.now()
let printedLines = 0
let reportedPreMain = false
while (Date.now() - t0 < 20000) {
  const entries = diagnosticEntries(diagnostics())
  for (const entry of entries.slice(printedLines)) {
    const stamped = entry.at ? Date.parse(entry.at) - t0 : Date.now() - t0
    console.log('[smoke] stage', formatStage(entry, stamped))
  }
  printedLines = entries.length
  if (entries.at(-1)?.message.startsWith('fatal:')) break
  if (entries.length === 0 && !reportedPreMain && Date.now() - t0 > 2000) {
    console.log('[smoke] stage', formatStage({ at: null, message: 'waiting for main.cjs' }, Date.now() - t0))
    reportedPreMain = true
  }
  if (existsSync(hostJsonPath)) break
  if (spawnError !== null || exit !== null) break
  await new Promise(r => setTimeout(r, 250))
}
if (!existsSync(hostJsonPath)) {
  throw new Error(`${describeMissingHost({
    desktopLog: diagnostics(),
    spawnCode: spawnError?.code ?? null,
    exit,
    windowsHide: launch.windowsHide,
    elapsedMs: Date.now() - t0,
  })}\n${redactSecrets(out.slice(-1500))}`)
}
// host.json 同理由非原子 writeFile 写出：existsSync 命中时可能只写了一半，
// 裸 JSON.parse 会抛未捕获异常崩栈（CLI 集成测试对同一场景专门做了重试）。
for (let i = 0; i < 20 && cfg === null; i++) {
  try {
    cfg = JSON.parse(readFileSync(hostJsonPath, 'utf8'))
  } catch {
    await new Promise(r => setTimeout(r, 250))
  }
}
if (cfg === null) {
  throw new Error('host.json 无法解析\n' + diagnostics())
}
console.log('[smoke] host.json =', hostJsonPath)
console.log('[smoke] port =', cfg.port)

// 给窗口加载留出时间，然后检查渲染端日志中的致命错误。
const loadDeadline = Date.now() + 15000
while (!diagnostics().includes('window loaded') && Date.now() < loadDeadline && exit === null) {
  await new Promise(r => setTimeout(r, 250))
}
if (!diagnostics().includes('window loaded')) throw new Error('窗口未完成加载\n' + diagnostics())
const fatalErrors = (out + '\n' + diagnostics()).split('\n').filter(line =>
  /net::ERR_|Unable to load URL|Uncaught Exception|FATAL|fatal:/.test(line),
)
console.log('[smoke] fatal renderer errors:', fatalErrors.length)
if (fatalErrors.length > 0) console.log(fatalErrors.slice(0, 5).join('\n'))

// UI 就绪探针：Host 侧 GET / 返回 200 即窗口 loadURL 同源可用。
const ui = await fetch(`http://127.0.0.1:${cfg.port}/`, { signal: AbortSignal.timeout(8000) })
const html = await ui.text()
console.log('[smoke] GET / via sidecar →', ui.status, 'token-injected:', html.includes('__SYLLORA__'))

// 退出：优先走应用自身的退出路径（before-quit → stopHost），验证收尾；
// 优雅退出宽限内未生效才兜底强杀，并标记 graceful=false。
// residue 只在优雅退出成功时纳入 pass 条件：强杀路径留下孤儿 sidecar 是已知
// 产品限制，不该让冒烟把"已知限制"判成失败；但优雅路径一旦不生效，R6 就被
// 跳过——所以这里显式告警，并可用 SMOKE_STRICT=1 把"优雅退出失败"本身判失败。
const gracefulStop = () => {
  if (process.platform === 'win32') {
    // 无 /F：向 GUI 窗口发 WM_CLOSE 关闭请求 → Electron 走正常退出流程。
    // taskkill 对无响应窗口/拒绝访问会失败，退出码必须看（否则静默走兜底）。
    const killed = spawnSync('taskkill', ['/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true })
    if (killed.status !== 0) {
      console.log('[smoke] taskkill 关闭请求失败，status =', killed.status, killed.error?.code ?? '')
    }
  } else {
    child.kill('SIGTERM')
  }
}
gracefulStop()
await new Promise(r => setTimeout(r, 6000))
let graceful = !pidAlive(child.pid)
if (!graceful) {
  console.log('[smoke] 优雅退出宽限未生效，兜底强杀（R6 residue 断言被跳过）')
  killTree(child.pid)
}
await new Promise(r => setTimeout(r, 2000))
const residue = pidAlive(cfg.pid) ? 1 : 0
console.log('[smoke] graceful exit:', graceful, '| sidecar residue:', residue)

const strict = process.env.SMOKE_STRICT === '1'
pass = fatalErrors.length === 0 && ui.ok && html.includes('__SYLLORA__')
  && (graceful ? residue === 0 : !strict)
console.log(pass ? '[smoke] RESULT: PASS' : '[smoke] RESULT: FAIL')
} catch (error) {
  console.error('[smoke] FAIL:', error.message)
} finally {
  // Keep only startup diagnostics, never host.json (which contains a token).
  const artifacts = process.env.SYLLORA_SMOKE_ARTIFACTS
  if (artifacts) {
    mkdirSync(artifacts, { recursive: true })
    writeFileSync(join(artifacts, 'desktop-startup.log'), diagnostics())
    writeFileSync(join(artifacts, 'smoke-summary.json'), JSON.stringify({ pass, platform: process.platform, spawnError: spawnError?.code ?? null, exit }, null, 2))
  }
  killTree(child.pid)
  if (cfg?.pid && pidAlive(cfg.pid)) killTree(cfg.pid)
  rmSync(userData, { recursive: true, force: true })
}
process.exitCode = pass ? 0 : 1
