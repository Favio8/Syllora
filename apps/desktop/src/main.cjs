// @ts-check
'use strict'
// Syllora 桌面壳主进程：生命周期 / 单实例 / sidecar 托管 / 窗口 / 菜单。
// 业务逻辑全部在 sidecar（Host bundle）里，壳只做进程胶水——见
// apps/desktop/README.md 与 docs/RUNTIME_MIGRATION.md。
const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const { existsSync, readFileSync, mkdirSync, rmSync, appendFileSync } = require('node:fs')
const { join } = require('node:path')
const { migrateLegacyData, managedDirectory } = require('./local-data.cjs')

// 开发联调模式：设置 SYLLORA_DESKTOP_DEV_URL 后不拉起 sidecar，
// 直接加载外部地址（配合 `pnpm serve` / `next dev` 热更新，plan 3.4）。
const DEV_URL = process.env.SYLLORA_DESKTOP_DEV_URL || ''
const isDev = DEV_URL !== ''
app.setName('Syllora')
if (process.platform === 'win32') app.setAppUserModelId('ai.syllora.desktop')
// A9（第三轮审查）：冒烟/测试可精确指定 userData——必须在单实例锁之前
// 设置（锁文件位于 userData 下），且早于一切 getPath('userData') 消费者。
if (process.env.SYLLORA_DESKTOP_USERDATA) {
  app.setPath('userData', process.env.SYLLORA_DESKTOP_USERDATA)
}
// Windows GUI executables do not reliably forward stdout to CI. Keep startup
// diagnostics on disk, without discovery tokens or provider credentials.
const diagnosticPath = join(app.getPath('userData'), 'desktop.log')
function diagnostic(message) {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    appendFileSync(diagnosticPath, `${new Date().toISOString()} ${message}\n`)
  } catch (error) { console.error('[desktop] diagnostic write failed', error.message) }
}
diagnostic(`starting platform=${process.platform} packaged=${app.isPackaged}`)
const START_TIMEOUT_MS = 15_000
const RESTART_BACKOFF_MS = [1_000, 2_000, 4_000]

/** @type {import('electron').BrowserWindow | null} */
let win = null
/** @type {import('node:child_process').ChildProcess | null} */
let host = null
let hostHome = ''
let hostJsonPath = ''
/** Syllora 学习数据的落盘根。必须显式传给 Host：Host 的 `SYLLORA_DATA_DIR`
 *  是它启动时"建并打开工作区"的唯一触发条件，而设置读写以 lastOpenedPath
 *  为根——不注入时注册表为空，所有设置写操作都会被守卫拒绝（FL-03），症状
 *  是"保存模型供应商失败，详见宿主日志"而日志里只有一句"没有已打开的工作区"。
 *  开发态 scripts/syllora-serve.mjs 一直有注入，所以这个缺陷只在桌面壳暴露。 */
let sylloraDataDir = ''
let restartIdx = 0
let quitting = false
/** 5 分钟窗口内的崩溃重启计数（plan 4.3：超过 3 次停止重试并弹错）。 */
let lastRestartWindow = []

function paths() {
  // userData 是各平台规范的应用数据目录；Host 的全部状态收在 host-home/
  // 子目录里（workspace 注册表、config、加密凭据、host.json、logs），
  // 不污染用户家目录的 ~/.syllora。
  hostHome = join(app.getPath('userData'), 'host-home')
  hostJsonPath = join(hostHome, 'host.json')
  // 学习数据与宿主状态分开：host-home 存注册表/凭据/host.json/logs，
  // syllora-data 存课程、资料、作答与生成作业。
  sylloraDataDir = join(app.getPath('userData'), 'syllora-data')
  // 打包态：process.resourcesPath 已是 <app>/resources（extraResources to:host
  // 直接落在其下）；开发态：main.cjs 在 src/ 下一层，resources 与 src 平级。
  const resourcesRoot = app.isPackaged ? process.resourcesPath : join(__dirname, '..', 'resources')
  const hostBundle = join(resourcesRoot, 'host', 'bin.js')
  const webDist = join(resourcesRoot, 'web')
  return { resourcesRoot, hostBundle, webDist }
}

/** C-3：崩溃退避重启的挂起计时器——startHost 成功即取消（被顶替），stopHost
 *  也取消（退出不该再重启）。无主计时器会和 activate 触发的 startHost 双 spawn。 */
let restartTimer = null

function startHost() {
  if (isDev) return // dev：外部已运行的 serve 就是 Host
  // C-3：重入保护——崩溃后 1s 退避计时器挂起期间用户触发 activate → startHost()
  // 与计时器到点后的 startHost() 会双重 spawn：后者 rmSync 掉前者的 host.json
  // 并再 spawn，新 Host 因前一个持 host.lock 启动失败 → 又进重启循环 → 5 分钟
  // 内第 4 次即 fatal，应用被自身状态机锁死。
  if (host !== null) return
  if (restartTimer !== null) { clearTimeout(restartTimer); restartTimer = null }
  const { hostBundle, webDist } = paths()
  diagnostic(`starting host bundle=${hostBundle}`)
  if (!existsSync(hostBundle)) {
    fatal('缺少 Host 资源 resources/host/bin.js，请先运行 node scripts/assemble-host.mjs')
    return
  }
  if (!existsSync(hostHome)) mkdirSync(hostHome, { recursive: true })
  // 残留 host.json 竞态：正常退出路径就是强杀（taskkill /F），Host 只在优雅
  // 退出时删 host.json——每次退出后都残留上一会话的死 pid/死端口配置。
  // waitForHost 首个 tick 在新 Host 写出配置前执行，若读到残留文件（仅校验
  // port 为正整数）就会 loadURL 死端口 → ERR_CONNECTION_REFUSED。spawn 前
  // 先删掉，保证 waitForHost 只可能读到本次进程写出的配置；waitForHost 里
  // 再按 pid 复核兜底。
  try { rmSync(hostJsonPath, { force: true }) } catch {}
  // ELECTRON_RUN_AS_NODE=1：让应用可执行文件本身充当纯 Node.js 运行时跑
  // Host bundle——壳不需要额外分发 Node 安装包（零额外运行时体积）。
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    SYLLORA_HOME: hostHome,
    SYLLORA_DATA_DIR: sylloraDataDir,
    SYLLORA_WEB_DIST: webDist,
    NODE_ENV: 'production',
  }
  try { mkdirSync(sylloraDataDir, { recursive: true }) } catch {}
  // 一次性迁移：数据根由 host-home/syllora（无工作区时的旧回退路径）迁到
  // syllora-data。只在目标缺失、源存在时复制一次，避免升级后用户已有课程
  // 凭空消失。不删源文件——若新路径后续出问题，旧数据仍在原处可查。
  try {
    if (migrateLegacyData(hostHome, sylloraDataDir)) {
      console.log('[desktop] migrated legacy syllora.json into syllora-data')
    }
  } catch (error) {
    console.error('[desktop] legacy data migration failed:', error instanceof Error ? error.message : String(error))
  }
  host = spawn(process.execPath, [hostBundle, 'serve', '--port', '0'], {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  host.stdout?.on('data', d => process.stdout.write(`[host] ${d}`))
  host.stderr?.on('data', d => process.stderr.write(`[host] ${d}`))
  diagnostic(`host spawned pid=${host.pid}`)
  host.on('error', e => { diagnostic(`host spawn failed code=${e.code}`); fatal('本地服务进程无法启动，请查看 desktop.log') })
  host.on('exit', (code, signal) => {
    diagnostic(`host exited code=${code} signal=${signal}`)
    host = null
    if (quitting || isDev) return
    console.error(`[desktop] host exited code=${code} signal=${signal}`)
    const now = Date.now()
    lastRestartWindow = lastRestartWindow.filter(t => now - t < 300_000)
    if (lastRestartWindow.length >= 3) {
      fatal('本地服务多次启动失败，请查看日志：' + join(hostHome, 'logs'))
      return
    }
    lastRestartWindow.push(now)
    const wait = RESTART_BACKOFF_MS[Math.min(restartIdx++, RESTART_BACKOFF_MS.length - 1)]
    restartTimer = setTimeout(() => {
      restartTimer = null
      startHost()
      // Host 以 --port 0 启动，每次重启都是新端口；崩溃时存活（或新开）的
      // 窗口必须跟随新端口，否则继续连已死的旧端口。pid 复核的 waitForHost
      // 保证读到的是本次重启写出的配置。
      waitForHost().then(cfg => {
        const target = `http://127.0.0.1:${cfg.port}/`
        const existing = BrowserWindow.getAllWindows()
        if (existing.length > 0) {
          for (const w of existing) void w.loadURL(target)
        } else {
          void createMainWindow()
        }
      }).catch(() => fatal('本地服务重启失败，请查看日志：' + join(hostHome, 'logs')))
    }, wait)
  })
}

function stopHost() {
  // C-3：退出路径先取消挂起的重启计时器——否则 app.quit() 后计时器到点仍会
  // spawn 一个新 Host（退出后复活）。
  if (restartTimer !== null) { clearTimeout(restartTimer); restartTimer = null }
  if (!host || host.pid === undefined) return
  const pid = host.pid
  try {
    if (process.platform === 'win32') {
      // /T 清整棵进程树（Electron-as-node 在部分路径下会派生辅助进程）。
      // 强杀不触发 Host 的 SIGTERM 优雅收尾（host.json/lock 残留），但
      // Host 启动时对过期 lock 自愈（冒烟已验证二次启动自愈）。
      // C-4：校验退出码——fire-and-forget 时 taskkill 是否真正执行无迹可查；
      // 用户随后强杀 Electron 会让 sidecar 成孤儿（继续占端口、写 lock），
      // 后续每次启动都因孤儿 pid 存活被拒 → 3 次重启后 fatal 且报错只指向
      // 日志。退出码/错误落日志至少让"退出后仍有残留"可诊断。
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
        .on('error', e => console.error('[desktop] taskkill 启动失败', e))
        .on('exit', code => { if (code !== 0) console.error(`[desktop] taskkill 退出码 ${code}（PID ${pid} 可能残留）`) })
    } else {
      host.kill('SIGTERM') // Host 有 SIGTERM 优雅退出 handler
      const ref = host
      // C-10：兜底强杀的宽限必须大于 Host 自己的关停兜底（bin.ts shutdown 是
      // server.close + 5s 超时后 process.exit）。旧值 3s 会在 Host 还在收尾时
      // 就 SIGKILL，host.json/host.lock 必然残留——下次启动虽能靠锁自愈，但
      // 用户会看到"退出后文件还在"。6s > 5s，正常路径远快于该值。
      setTimeout(() => { try { ref.kill('SIGKILL') } catch {} }, 6_000)
    }
  } catch (e) {
    console.error('[desktop] stopHost error', e)
  }
  host = null
}

function readHostConfig() {
  try {
    const cfg = JSON.parse(readFileSync(hostJsonPath, 'utf8'))
    if (Number.isInteger(cfg.port) && cfg.port > 0) return cfg
  } catch {}
  return null
}

function waitForHost() {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const cfg = readHostConfig()
      // pid 复核兜底（与 smoke-sidecar 同法）：host.json 是跨会话残留文件，
      // 只有本次 spawn 的 Host 写出的配置才能用于握手。
      if (cfg && (host === null || cfg.pid === host.pid)) return resolve(cfg)
      if (Date.now() - t0 > START_TIMEOUT_MS) return reject(new Error('host-start-timeout'))
      setTimeout(tick, 150)
    }
    tick()
  })
}

async function createMainWindow() {
  let url
  if (isDev) {
    url = DEV_URL
  } else {
    const cfg = await waitForHost()
    url = `http://127.0.0.1:${cfg.port}/`
  }
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#F4F3EE',
    title: 'Syllora',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  // 外链一律走系统浏览器，绝不在应用内开新窗。
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) shell.openExternal(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, target) => {
    // C-5：仅放行本次 Host 的端口（host.json 实端口，pid 已由 waitForHost 复核）
    // ——任意 localhost 端口放行会把"页内脚本可取 token"的面放大到同机全部
    // 本地服务。其余一律外开系统浏览器（与 setWindowOpenHandler 同语义）。
    const cfg = isDev ? { port: null } : readHostConfig()
    const allowed = isDev ? target.startsWith(DEV_URL) : (cfg !== null && target.startsWith(`http://127.0.0.1:${cfg.port}/`))
    if (!allowed) { e.preventDefault(); shell.openExternal(target) }
  })
  await win.loadURL(url)
  diagnostic('window loaded')
  win.on('closed', () => { win = null })
}

function fatal(message) {
  diagnostic(`fatal: ${message}`)
  // showErrorBox is modal. In CI nobody dismisses it, so the process stays up
  // with no further stdout and the smoke wait expires without an exit code.
  // Smoke sets this env so the fatal line in desktop.log can be read and the
  // process can exit. Interactive launches still show the dialog.
  if (process.env.SYLLORA_DESKTOP_SMOKE === '1') {
    console.error(`[desktop] fatal: ${message}`)
    app.exit(1)
    return
  }
  dialog.showErrorBox('Syllora 启动失败', message)
  app.quit()
}

function buildMenu() {
  // 不安装应用菜单：Windows/Linux 下 `Menu.setApplicationMenu` 会在窗口顶部
  // 常驻一行 File/Edit/View 菜单栏（用户可见的 "File / Exit" 就是 fileMenu
  // 里 quit 项的自动展开结果），与三栏工作台视觉无关且无处关闭。
  // 原「帮助」里的「打开数据目录／打开日志目录」已移到设置弹窗的「诊断日志」
  // 分区（见 syllora:open-path），功能没丢。
  // 副作用：随菜单一起消失的还有 Ctrl+R / F12 等菜单快捷键——这是期望行为；
  // 输入框的复制粘贴由 Chromium 原生处理，不受影响。
  Menu.setApplicationMenu(process.platform === 'darwin'
    ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }])
    : null)
}

// 单实例：二次启动聚焦已有窗口（与 Host 的 host.lock 双保险，R8）。
const gotLock = app.requestSingleInstanceLock()
diagnostic(`single instance lock=${gotLock}`)
if (!gotLock) { app.quit() } else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.whenReady().then(async () => {
    diagnostic('app ready')
    buildMenu()
    startHost()
    try {
      await createMainWindow()
    } catch (e) {
      fatal(`无法连接本地学习服务（${String(e && e.message || e)}）。数据目录：${hostHome}`)
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length > 0) return
      // darwin 关窗只停 Host 不退应用（window-all-closed 置了 quitting）；
      // 重新激活必须复位退出标记并重启 Host（新进程新端口），否则窗口会
      // 在死端口上等到超时。catch 落 fatal：吞掉 rejection 就是静默僵死。
      quitting = false
      restartIdx = 0
      if (host === null && !isDev) startHost()
      void createMainWindow().catch(e => fatal(`无法连接本地学习服务（${String(e && e.message || e)}）。数据目录：${hostHome}`))
    })
  })

  app.on('before-quit', () => { quitting = true; stopHost() })
  app.on('window-all-closed', () => {
    quitting = true
    stopHost()
    if (process.platform !== 'darwin') app.quit()
  })
  // POSIX 上 SIGTERM/SIGINT 的默认行为是直接终止进程，JS 侧的 before-quit
  // （→ stopHost 收 sidecar）根本不跑：系统关机/会话结束/`kill` 一下就把
  // Host sidecar 留成孤儿。显式转成 app.quit() 走正常退出路径。
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (quitting) return
      quitting = true
      app.quit()
    })
  }
}

// contextIsolation 之后的诊断信息最小暴露面（供未来的桌面诊断 UI 使用）。
// C-5：不再透出 host.json 全文（含明文访问 token）——旧实现把 token+port 经
// contextBridge 暴露给窗口内页面，而 will-navigate 放行任意 127.0.0.1 端口，
// 任一 localhost 页面即可取 token 驱动全部 RPC；preload 注释"桌面壳不额外
// 注入任何凭据"与实现相反。收敛为 {dev, port}（Web UI 全库不调用该 API，
// 已 grep 证实，无兼容负担）。
ipcMain.handle('syllora:host-info', () => {
  if (isDev) return { dev: true }
  const cfg = readHostConfig()
  // hostHome / logsDir / dataDir 只是目录路径，不含 token，可以透出：设置里的
  // 「本机与诊断」要把它们显示给用户（排查模型配置失败第一步就是看宿主日志，
  // 这是本次 FL-03 事故里用户拿不到的关键信息）。host.json 全文仍然不透出。
  return {
    dev: false,
    port: cfg === null ? null : cfg.port,
    hostHome: paths().hostHome,
    logsDir: join(paths().hostHome, 'logs'),
    dataDir: sylloraDataDir,
  }
})

// 「打开数据目录／打开日志目录」的原入口是应用菜单的「帮助」，菜单已整体移除
// （顶部 File/Exit 菜单栏），改由设置弹窗的「本机与诊断」分区经此 IPC 调用。
// 只允许打开 hostHome 子树内的路径：这个通道一旦放开任意路径，页面里一段脚本
// 就能用系统默认程序打开磁盘上任何位置（含可执行文件），是明确的提权面。
ipcMain.handle('syllora:open-path', (_event, target) => {
  try {
    const directory = managedDirectory(app.getPath('userData'), target)
    return shell.openPath(directory).then(error => error === '' ? { ok: true } : { ok: false, error })
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
})

// The chooser belongs to the desktop window; Web keeps the Host browse fallback.
ipcMain.handle('syllora:pick-directory', async event => {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Invalid directory chooser caller')
  const currentUrl=win.webContents.getURL()
  if (!currentUrl || new URL(event.senderFrame.url).origin !== new URL(currentUrl).origin) throw new Error('Invalid directory chooser origin')
  const result=await dialog.showOpenDialog(win,{title:'选择课程文件夹',properties:['openDirectory']})
  return {path:result.canceled?null:result.filePaths[0]??null}
})
