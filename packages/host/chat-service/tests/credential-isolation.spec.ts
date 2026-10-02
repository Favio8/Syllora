import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadChatConfig } from '../src/config.ts'
import { ensureMasterKey, sealCredentials, unsealCredentials, verifyCredentialsReadable } from '../src/secret-box.ts'

const temporaryRoot = resolve('..', 'tmp', 'workbench-ux-closeout-2026-10-02', 'credentials')
const roots: string[] = []
async function fixture() {
  await mkdir(temporaryRoot, { recursive: true })
  const root = await mkdtemp(join(temporaryRoot, 'case-'))
  roots.push(root)
  vi.stubEnv('SYLLORA_HOME', join(root, 'home'))
  await mkdir(join(root, '.syllora'), { recursive: true })
  return root
}
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('CR-07 / CR-08 credential isolation', () => {
  it('publishes one complete master key to concurrent creators and decrypts every envelope', async () => {
    const root = await fixture()
    const keys = await Promise.all(Array.from({ length: 32 }, () => ensureMasterKey()))
    expect(new Set(keys.map(key => key.toString('hex'))).size).toBe(1)
    expect((await readFile(join(root, 'home', 'master.key'), 'utf8')).trim()).toBe(keys[0]!.toString('hex'))
    const envelopes = await Promise.all(Array.from({ length: 8 }, (_, index) => sealCredentials({ provider: `fixture-${index}` })))
    for (let index = 0; index < envelopes.length; index++) {
      expect((await unsealCredentials(envelopes[index]!)).data).toEqual({ provider: `fixture-${index}` })
    }
    expect((await readdir(join(root, 'home'))).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('does not replace an invalid master key or log secret-bearing parser input', async () => {
    const root = await fixture()
    await mkdir(join(root, 'home'))
    await writeFile(join(root, 'home', 'master.key'), 'invalid-existing-key')
    await expect(ensureMasterKey()).rejects.toThrow('master.key 内容无效')
    expect(await readFile(join(root, 'home', 'master.key'), 'utf8')).toBe('invalid-existing-key')
    const credentialsPath = join(root, '.syllora', 'credentials.json')
    await writeFile(credentialsPath, '{"provider":"fixture-sensitive-value", BROKEN')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await verifyCredentialsReadable(credentialsPath)
    expect(warning).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warning.mock.calls)).not.toContain('fixture-sensitive-value')
  })

  it.each([{ default: 'fixture-other-key' }, { default: 'fixture-other-key', providerA: 'fixture-a' }])(
    'does not lend default credentials to an unconfigured provider: %j', async credentials => {
      const root = await fixture()
      await writeFile(join(root, '.syllora', 'config.yaml'), 'version: 1\nllm:\n  provider: providerB\n  model: fixture-model\nproviders:\n  providerA:\n    model: fixture-model\n    baseUrl: https://a.example/v1\n  providerB:\n    model: fixture-model\n    baseUrl: https://b.example/v1\n')
      await writeFile(join(root, '.syllora', 'credentials.json'), JSON.stringify(credentials))
      expect((await loadChatConfig(root)).apiKey).toBeNull()
      await writeFile(join(root, '.syllora', 'credentials.json'), JSON.stringify({ ...credentials, providerB: 'fixture-b' }))
      expect((await loadChatConfig(root)).apiKey).toBe('fixture-b')
    },
  )
})
