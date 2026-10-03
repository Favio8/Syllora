/** Syllora-owned paths and lossless migration of the former runtime layout. */
import { existsSync, lstatSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

function migrateDirectory(target: string, legacy: string): string {
  if (!existsSync(legacy)) return target
  if (lstatSync(legacy).isSymbolicLink() || !lstatSync(legacy).isDirectory()) {
    throw new Error(`旧运行目录不是普通目录，迁移已停止: ${legacy}`)
  }
  if (existsSync(target)) {
    throw new Error(`新旧运行目录同时存在，请先备份并人工整理，迁移不会覆盖数据: ${target} / ${legacy}`)
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
