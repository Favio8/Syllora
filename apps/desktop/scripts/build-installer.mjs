#!/usr/bin/env node
/**
 * 安装包构建包装（electron-builder 的安全入口）。
 *
 * 为什么需要它：`electron-builder --win` 会**整体重建** `dist/<platform>-unpacked`。
 * 桌面壳默认把课程目录放在「exe 所在目录」下的 `.syllora/`，所以直接跑 builder 会把
 * 用户的课程资料一并删掉——安装版有 `scripts/preserve-courses.nsh` 兜底（升级/卸载时
 * 把 `.syllora` 改名保全），直接运行 unpacked 目录时却没有保护。这里在构建前后搬运：
 *
 *   构建前   dist/<x>-unpacked/.syllora  →  dist/.syllora-stash-<时间戳>-<x>/（移动）
 *   构建后   stash 里「目标不存在的课程」逐个拷回 dist/<x>-unpacked/.syllora/
 *
 * 幂等与恢复：上一次构建若中途失败（stash 还在、unpacked 缺数据），下次运行会先把
 * 遗留的 stash 合并回去再开始，不会让数据卡在 stash 里。
 *
 * 用法：node scripts/build-installer.mjs [--win|--mac|--linux] [--dir] [--publish never] …
 * 除 `--preserve-only` 外，其余参数原样透传给 electron-builder。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, '..')
// SYLLORA_DESKTOP_DIST：仅用于测试指向临时 dist 树；正常构建不要设置。
const distRoot = process.env.SYLLORA_DESKTOP_DIST ? resolve(process.env.SYLLORA_DESKTOP_DIST) : join(desktopRoot, 'dist')
const args = process.argv.slice(2)
const preserveOnly = args.includes('--preserve-only')
const builderArgs = args.filter(arg => arg !== '--preserve-only')

const unpackedDirs = () => existsSync(distRoot)
  ? readdirSync(distRoot).filter(name => name.endsWith('-unpacked') && statSync(join(distRoot, name)).isDirectory())
  : []
const stashDirs = () => existsSync(distRoot)
  ? readdirSync(distRoot).filter(name => name.startsWith('.syllora-stash-')).sort()
  : []
const hasCourses = dir => existsSync(dir) && readdirSync(dir).length > 0

/**
 * 把 stash 里的课程合并回目标 unpacked 目录：目标缺哪门课就补哪门。
 * 两边都有同一门课时保留目标（构建期间应用不会写入，目标即最新），并把差异写进报告。
 */
function mergeStash(stashName, report) {
  const stashPath = join(distRoot, stashName, 'syllora')
  if (!existsSync(stashPath)) return
  const platform = stashName.slice('.syllora-stash-'.length).replace(/^\d+-/, '')
  const target = join(distRoot, `${platform}-unpacked`, '.syllora')
  mkdirSync(target, { recursive: true })
  let conflicts = 0
  for (const entry of readdirSync(stashPath)) {
    const from = join(stashPath, entry), to = join(target, entry)
    // 目标已有同名课程：保留目标（构建期间应用不会写入，目标即最新），stash 留作人工核对。
    if (existsSync(to)) { report.kept.push(`${entry}（目标已有，stash 保留在 ${stashName}）`); conflicts += 1; continue }
    cpSync(from, to, { recursive: true })
    report.restored.push(entry)
  }
  // 没有冲突说明每门课都已在目标里落地：stash 只是副本，直接清掉，避免堆积。
  if (conflicts === 0) rmSync(join(distRoot, stashName), { recursive: true, force: true })
  else report.leftover.push(stashName)
}

const report = { stashed: [], restored: [], kept: [], leftover: [] }

// 1) 先合并上一次构建遗留的 stash（崩溃/中断恢复）。
for (const name of stashDirs()) mergeStash(name, report)

if (preserveOnly) {
  // 只做「把遗留 stash 合并回去」，绝不搬运正在使用的数据：可用于崩溃后的手工恢复。
  printReport()
  process.exit(0)
}

// 2) 本次构建前：把现有 unpacked 目录里的课程目录搬进 stash（只有真的要构建时才搬）。
const stamp = Date.now()
for (const dir of unpackedDirs()) {
  const live = join(distRoot, dir, '.syllora')
  if (!hasCourses(live)) continue
  const stash = join(distRoot, `.syllora-stash-${stamp}-${dir.replace(/-unpacked$/, '')}`)
  mkdirSync(join(stash, '..'), { recursive: true })
  mkdirSync(stash, { recursive: true })
  // 同名 stash 已存在时先并入（同一时间戳下不会发生，仅防御）。
  renameSync(live, join(stash, 'syllora'))
  report.stashed.push(`${dir}/.syllora → ${stash}`)
  console.log(`[preserve] 已暂存课程目录：${dir}/.syllora → ${stash.replace(distRoot + '\\', '').replace(distRoot + '/', '')}`)
}

// 3) 运行 electron-builder（同一 node，直接调 CLI，不依赖 .bin shim / 全局 pnpm）。
const cli = join(desktopRoot, 'node_modules', 'electron-builder', 'cli.js')
const result = spawnSync(process.execPath, [cli, ...builderArgs], { cwd: desktopRoot, stdio: 'inherit' })

// 4) 无论成败都把课程目录搬回去：构建失败时更不能留下「数据在 stash、应用看见空目录」。
for (const name of stashDirs()) mergeStash(name, report)

printReport()
process.exit(result.status ?? 1)

function printReport() {
  if (report.restored.length > 0) console.log(`[preserve] 已还原 ${report.restored.length} 项：${report.restored.join('、')}`)
  if (report.stashed.length > 0) console.log(`[preserve] 本次暂存：${report.stashed.length} 处`)
  if (report.kept.length > 0) console.log(`[preserve] 目标已有同名的项（保留目标）：${report.kept.join('；')}`)
  if (report.leftover.length > 0) console.log(`[preserve] 仍有遗留 stash 待人工确认：${report.leftover.join('、')}`)
  if (report.restored.length === 0 && report.stashed.length === 0 && report.kept.length === 0) console.log('[preserve] 无课程目录需要搬运')
}