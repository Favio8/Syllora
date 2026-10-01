import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { loadChatConfig } from '../src/config.ts'
import { sealCredentials } from '../src/secret-box.ts'

it('loads encrypted legacy workspace credentials without changing the master key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'syllora-sealed-migration-'))
  try {
    const home = join(root, 'home')
    vi.stubEnv('SYLLORA_HOME', home)
    vi.stubEnv('STUDYCLAW_HOME', '')
    const ciphertext = await sealCredentials({ fixture: 'test-key-for-migration' })
    const master = await readFile(join(home, 'master.key'), 'utf8')
    const workspace = join(root, 'workspace')
    await mkdir(join(workspace, '.studyclaw'), { recursive: true })
    await writeFile(join(workspace, '.studyclaw', 'credentials.json'), ciphertext)
    await writeFile(join(workspace, '.studyclaw', 'config.yaml'), 'active_provider: fixture\nproviders:\n  fixture:\n    model: test-only\n    base_url: http://127.0.0.1:12345/v1\nagent:\n  preset: studyclaw-learning\n')
    const config = await loadChatConfig(workspace)
    expect(config.model).toBe('test-only')
    expect(config.apiKey).toBe('test-key-for-migration')
    expect(config.agentPreset).toBe('syllora-learning')
    expect(await readFile(join(workspace, '.syllora', 'credentials.json'), 'utf8')).toBe(ciphertext)
    expect(await readFile(join(home, 'master.key'), 'utf8')).toBe(master)
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
