/** Syllora-owned paths and lossless migration of the former runtime layout. */
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

function migrateDirectory(target: string, legacy: string): string {
  if (!existsSync(legacy)) return target
  if (lstatSync(legacy).isSymbolicLink() || !lstatSync(legacy).isDirectory()) {
    throw new Error(`旧运行目录不是普通目录，迁移已停止: ${legacy}`)
  }
  if (existsSync(target)) {
    // An earlier workbench created course.json before migrating the legacy
    // runtime. Preflight the entire tree before copying anything. Conflicting
    // bytes and links still require manual resolution; never pick a winner.
    const files: Array<[string, string]> = []
    const directories: string[] = []
    const inspect = (source: string, destination: string): void => {
      const info = lstatSync(source)
      const existing = existsSync(destination) ? lstatSync(destination) : null
      if (info.isSymbolicLink() || existing?.isSymbolicLink()) throw new Error('运行目录包含链接，迁移已停止')
      if (info.isDirectory()) {
        if (existing && !existing.isDirectory()) throw new Error(`新旧运行目录同时存在且类型冲突: ${destination}`)
        directories.push(destination)
        for (const entry of readdirSync(source)) inspect(join(source, entry), join(destination, entry))
      } else if (info.isFile()) {
        if (existing && (!existing.isFile() || !readFileSync(source).equals(readFileSync(destination)))) {
          throw new Error(`新旧运行目录同时存在且内容冲突，请先备份并人工整理: ${destination}`)
        }
        files.push([source, destination])
      } else throw new Error(`运行目录包含特殊文件，迁移已停止: ${source}`)
    }
    inspect(legacy, target)
    for (const directory of directories) mkdirSync(directory, { recursive: true })
    for (const [source, destination] of files) {
      if (!existsSync(destination)) copyFileSync(source, destination, constants.COPYFILE_EXCL)
      if (!readFileSync(source).equals(readFileSync(destination))) throw new Error(`迁移校验失败，旧目录仍保留: ${source}`)
    }
    // Keep a complete recoverable original, including encrypted credentials.
    // If interrupted before this rename, the byte comparison makes retry safe.
    renameSync(legacy, `${legacy}-backup-${randomUUID()}`)
    return target
  }
  // Same-parent rename keeps config, ciphertext and state together. On failure
  // the old directory remains intact; no marker can hide a partial migration.
  renameSync(legacy, target)
  return target
}

export function workspaceStateDirOf(workspaceRoot: string): string {
  return migrateDirectory(join(workspaceRoot, '.syllora'), join(workspaceRoot, '.studyclaw'))
}

export function sylloraHome(): string {
  // The former home override remains a migration alias. All new launchers and
  // documentation use SYLLORA_HOME; an explicit new override wins.
  const override = process.env.SYLLORA_HOME?.trim() || process.env.STUDYCLAW_HOME?.trim()
  return override ? resolve(override) : join(homedir(), '.syllora')
}

export function migrateLegacyHome(): string {
  const target = sylloraHome()
  if (process.env.SYLLORA_HOME?.trim() || process.env.STUDYCLAW_HOME?.trim()) return target
  const legacy = join(homedir(), '.studyclaw')
  // Moving a live host's discovery/lock files would break its identity.
  if (existsSync(join(legacy, 'host.lock'))) {
    throw new Error(`旧 Host 锁仍存在，请先停止旧服务并检查锁后迁移: ${legacy}`)
  }
  return migrateDirectory(target, legacy)
}
