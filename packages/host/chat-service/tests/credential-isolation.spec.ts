/**
 * CR-07 / CR-08 凭据隔离回归（PR 的 credential-isolation.spec.ts，本地适配）：
 *  - CR-07：主密钥发布（并发只出一个 key、损坏不覆盖、启动校验不泄漏输入）；
 *  - CR-08：凭据只按本次解析目标（供应商 id / apiKeyEnv / 兼容命名）命中，
 *    绝不再回退 `default` 键，也不把其他供应商的密钥借给未配置的供应商。
 * 另含 CR-18/CR-19 的模型数据白名单抽样（源自 PR tools 的 security-batch0.spec.ts，
 * 本地 src/result.ts 已实现该白名单，这里钉住行为）。
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolResult } from '@syllora/tools'
import { loadChatConfig } from '../src/config.ts'
import { ensureMasterKey, sealCredentials, unsealCredentials, verifyCredentialsReadable } from '../src/secret-box.ts'

/** 固定夹具根（与 syllora-projects.spec.ts 同款）：临时密钥/课程收在仓库 tmp 下。 */
const temporaryRoot = resolve('..', 'tmp', 'credential-isolation-tests')
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
  for (const root of roots.splice(0)) {
    if (!root.startsWith(temporaryRoot)) throw new Error('unsafe test cleanup')
    await rm(root, { recursive: true, force: true })
  }
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

/** CR-18/CR-19：网页正文与 LSP 投影必须能进模型消息体（白名单抽样）。 */
describe('CR-18 / CR-19 model-visible data whitelist', () => {
  it('feeds the fetched page body and LSP projections back to the model', () => {
    const fetched = new ToolResult('success', '已获取 200', { url: 'https://example.com', status: 200, contentType: 'text/html', body: '网页正文内容' })
    expect(fetched.toToolMessage()).toContain('网页正文内容')
    const locations = new ToolResult('success', 'LSP goToDefinition', { kind: 'locations', locations: [{ uri: 'file:///a.ts', range: {} }] })
    expect(locations.toToolMessage()).toContain('file:///a.ts')
    const hover = new ToolResult('success', 'LSP hover', { kind: 'hover', hover: { contents: '函数说明' } })
    expect(hover.toToolMessage()).toContain('函数说明')
  })
})
