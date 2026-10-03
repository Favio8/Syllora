import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { migrateLegacyHome, sylloraHome, workspaceStateDirOf } from '../src/runtime-paths.ts'

const fake = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => fake.home }))
const roots: string[] = []
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'syllora-migration-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('runtime layout migration', () => {
  it('moves all workspace files once and preserves their bytes', async () => {
    const path = await root()
    const legacy = join(path, '.studyclaw')
    await mkdir(join(legacy, 'history'), { recursive: true })
    await writeFile(join(legacy, 'config.yaml'), 'agent:\n  preset: studyclaw-learning\n')
    await writeFile(join(legacy, 'history', 'session.json'), '{"messages":["原始学习记录"]}')
    const target = workspaceStateDirOf(path)
    expect(target).toBe(join(path, '.syllora'))
    expect(existsSync(legacy)).toBe(false)
    expect(await readFile(join(target, 'history', 'session.json'), 'utf8')).toBe('{"messages":["原始学习记录"]}')
    expect(workspaceStateDirOf(path)).toBe(target)
  })
  it('leaves both directories untouched when they conflict', async () => {
    const path = await root()
    for (const name of ['.studyclaw', '.syllora']) {
      await mkdir(join(path, name))
      await writeFile(join(path, name, 'config.yaml'), name)
    }
    expect(() => workspaceStateDirOf(path)).toThrow('新旧运行目录同时存在')
    expect(await readFile(join(path, '.studyclaw', 'config.yaml'), 'utf8')).toBe('.studyclaw')
    expect(await readFile(join(path, '.syllora', 'config.yaml'), 'utf8')).toBe('.syllora')
  })
  it('preserves the old master key when migrating the default home', async () => {
    fake.home = await root()
    vi.stubEnv('SYLLORA_HOME', '')
    vi.stubEnv('STUDYCLAW_HOME', '')
    await mkdir(join(fake.home, '.studyclaw'))
    const key = 'a'.repeat(64) + '\n'
    await writeFile(join(fake.home, '.studyclaw', 'master.key'), key)
    expect(migrateLegacyHome()).toBe(join(fake.home, '.syllora'))
    expect(await readFile(join(fake.home, '.syllora', 'master.key'), 'utf8')).toBe(key)
    expect(migrateLegacyHome()).toBe(join(fake.home, '.syllora'))
  })
  it('resolves explicit homes consistently and gives the new override priority', () => {
    vi.stubEnv('STUDYCLAW_HOME', ' old-home ')
    vi.stubEnv('SYLLORA_HOME', ' new-home ')
    expect(sylloraHome()).toBe(resolve('new-home'))
    expect(migrateLegacyHome()).toBe(resolve('new-home'))
    vi.stubEnv('SYLLORA_HOME', '')
    expect(sylloraHome()).toBe(resolve('old-home'))
  })
  it('does not move a home with an outstanding old host lock', async () => {
    fake.home = await root()
    vi.stubEnv('SYLLORA_HOME', '')
    vi.stubEnv('STUDYCLAW_HOME', '')
    await mkdir(join(fake.home, '.studyclaw'))
    await writeFile(join(fake.home, '.studyclaw', 'host.lock'), JSON.stringify({ pid: process.pid }))
    expect(() => migrateLegacyHome()).toThrow('旧 Host 锁仍存在')
    expect(existsSync(join(fake.home, '.studyclaw', 'host.lock'))).toBe(true)
  })
})
