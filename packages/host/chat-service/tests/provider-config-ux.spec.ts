/*
 * PRD 需求七：供应商配置完备化（预设 / 连接测试 / 排序 / 导入导出 / 脱敏）。
 * 连接测试用本机 http 服务模拟 401、404、400、模型缺失与成功五条路径。
 */
import { createServer, type Server } from 'node:http'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * 凭据密封用进程级主密钥（sylloraHome 下的 secret-box），必须把 SYLLORA_HOME
 * 指到临时目录，否则测试会去碰真实用户 home（并被迁移守卫拦下）。
 */
let sharedHome = ''
beforeAll(async () => {
  sharedHome = await mkdtemp(join(tmpdir(), 'syllora-provider-home-'))
  process.env.SYLLORA_HOME = sharedHome
})
afterAll(async () => {
  delete process.env.SYLLORA_HOME
  await rm(sharedHome, { recursive: true, force: true })
})
import {
  exportProviders,
  importProviders,
  providerCatalog,
  reorderProviders,
  saveProvider,
  setCredential,
  settingsPayload,
  testConnection,
} from '../src/settings.ts'

async function seed(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'syllora-provider-ux-'))
  await saveProvider(root, { id: 'alpha', name: '甲', model: 'a-1', baseUrl: 'https://a.example/v1' })
  await saveProvider(root, { id: 'beta', name: '乙', model: 'b-1', baseUrl: 'https://b.example/v1' })
  await saveProvider(root, { id: 'gamma', name: '丙', model: 'g-1', baseUrl: 'https://g.example/v1' })
  return root
}

/** 起一个一次性本机端点，跑完 cb 后关闭。 */
async function withServer(handler: Parameters<typeof createServer>[0], run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server: Server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  try {
    await run(`http://127.0.0.1:${address.port}/v1`)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

describe('PRD 需求七：供应商预设清单', () => {
  it('covers the requested providers and prefills usable defaults', () => {
    const catalog = providerCatalog()
    for (const id of ['deepseek', 'moonshot', 'glm', 'sensenova', 'openrouter', 'siliconflow', 'custom', 'anthropic']) {
      const entry = catalog.find(item => item.id === id)
      expect(entry, `catalog is missing ${id}`).toBeDefined()
      // 选预设后只需填 Key：除自定义条目外，地址与协议都要预填。
      expect(['openai', 'anthropic']).toContain(entry!.protocol)
      if (id !== 'custom') expect(entry!.baseUrl).toMatch(/^https:\/\//)
    }
  })
})

describe('PRD 需求七：供应商顺序', () => {
  it('persists an explicit order and exposes it in the payload', async () => {
    const root = await seed()
    try {
      const saved = await reorderProviders(root, ['gamma', 'alpha', 'beta'])
      expect(saved.providerOrder).toEqual(['gamma', 'alpha', 'beta'])
      // 持久化在 config.yaml，不是内存态：重新读一次仍在。
      expect((await settingsPayload(root)).providerOrder).toEqual(['gamma', 'alpha', 'beta'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an order that is not a permutation of the configured providers', async () => {
    const root = await seed()
    try {
      await expect(reorderProviders(root, ['alpha', 'alpha', 'beta'])).rejects.toThrow()
      await expect(reorderProviders(root, ['alpha', 'beta', 'unknown'])).rejects.toThrow()
      // 被拒绝的顺序不改写既有顺序。
      expect((await settingsPayload(root)).providerOrder).toEqual(['alpha', 'beta', 'gamma'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a newly saved provider visible when the stored order omits it', async () => {
    const root = await seed()
    try {
      await reorderProviders(root, ['beta', 'alpha', 'gamma'])
      await saveProvider(root, { id: 'delta', name: '丁', model: 'd-1', baseUrl: 'https://d.example/v1' })
      // 顺序字段缺项按写入顺序补齐，绝不因缺项从列表消失。
      expect((await settingsPayload(root)).providerOrder).toContain('delta')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('PRD 需求七：导入导出（不含明文密钥）', () => {
  it('exports structure only — never a plaintext key', async () => {
    const root = await seed()
    try {
      await setCredential(root, 'alpha', 'sk-super-secret-value')
      const exported = await exportProviders(root)
      const text = JSON.stringify(exported)
      expect(text).not.toContain('sk-super-secret-value')
      expect(text).not.toMatch(/"(apiKey|api_key|api_key_env|secret|token)":/)
      expect(exported.credentialsExcluded).toBe(true)
      expect(exported.providers.map(provider => provider.id)).toEqual(['alpha', 'beta', 'gamma'])
      expect(exported.providers[0]).toMatchObject({ id: 'alpha', name: '甲', model: 'a-1', baseUrl: 'https://a.example/v1', protocol: 'openai' })
      // 只回显「是否已配置密钥」，不回传密钥本身。
      expect(exported.providers[0]!.apiKeyConfigured).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('imports structure without keys and never overwrites an existing provider', async () => {
    const root = await seed()
    try {
      await setCredential(root, 'alpha', 'sk-alpha-secret')
      const exported = await exportProviders(root)
      // 人为在导入体里塞入密钥字段：必须被丢弃，不能落盘。
      const hostile = {
        ...exported,
        providers: [
          ...exported.providers.map(provider => ({ ...provider, apiKey: 'sk-injected', api_key: 'sk-injected-2' })),
          { id: 'epsilon', name: '戊', model: 'e-1', baseUrl: 'https://e.example/v1', protocol: 'openai' as const, temperature: 0.5, maxConcurrency: 2, models: [], apiKeyConfigured: false },
        ],
      }
      const result = await importProviders(root, hostile)
      expect(result.imported).toEqual(['epsilon'])
      expect(result.skipped).toEqual(['alpha', 'beta', 'gamma'])
      const yamlText = await readFile(join(root, '.syllora', 'config.yaml'), 'utf8')
      expect(yamlText).not.toContain('sk-injected')
      expect(yamlText).not.toContain('sk-alpha-secret')
      // 原有密钥仍可用（未被导入覆盖），新供应商显示为缺 Key 需补填。
      expect(result.saved.providers.find(provider => provider.id === 'alpha')?.apiKeyConfigured).toBe(true)
      expect(result.saved.providers.find(provider => provider.id === 'epsilon')?.apiKeyConfigured).toBe(false)
      // 结构字段按导出内容还原。
      expect(result.saved.providers.find(provider => provider.id === 'epsilon')).toMatchObject({ model: 'e-1', baseUrl: 'https://e.example/v1', temperature: 0.5, maxConcurrency: 2 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a malformed import payload without touching the config', async () => {
    const root = await seed()
    try {
      await expect(importProviders(root, { version: 2, providers: [] })).rejects.toThrow()
      await expect(importProviders(root, { version: 1, providers: [] })).rejects.toThrow()
      await expect(importProviders(root, null)).rejects.toThrow()
      expect((await settingsPayload(root)).providers.map(provider => provider.id)).toEqual(['alpha', 'beta', 'gamma'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an empty providers list and leaves the config alone', async () => {
    const root = await seed()
    try {
      const exported = await exportProviders(root)
      await expect(importProviders(root, { ...exported, providers: [] })).rejects.toThrow()
      expect((await settingsPayload(root)).providers.map(provider => provider.id)).toEqual(['alpha', 'beta', 'gamma'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('PRD 需求七：连接测试', () => {
  it('classifies failures with actionable messages and never echoes the key', async () => {
    const cases: Array<{ status: number; kind: string }> = [
      { status: 401, kind: 'unauthorized' },
      { status: 404, kind: 'not-found' },
      { status: 400, kind: 'protocol' },
    ]
    for (const item of cases) {
      await withServer((_request, response) => { response.writeHead(item.status); response.end('{"error":"nope"}') }, async baseUrl => {
        const result = await testConnection({ baseUrl, apiKey: 'sk-should-not-leak' })
        expect(result.ok).toBe(false)
        expect(result.kind).toBe(item.kind)
        expect(result.message.length).toBeGreaterThan(10)
        expect(result.message).not.toContain('sk-should-not-leak')
        expect(result.message).not.toContain(baseUrl)
      })
    }
  })

  it('flags a missing default model and names the available candidates', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'real-model-1' }, { id: 'real-model-2' }] }))
    }, async baseUrl => {
      const missing = await testConnection({ baseUrl, model: 'typo-model' })
      expect(missing.ok).toBe(false)
      expect(missing.kind).toBe('model-missing')
      expect(missing.message).toContain('typo-model')
      expect(missing.message).toContain('real-model-1')
      const ok = await testConnection({ baseUrl, model: 'real-model-1' })
      expect(ok.ok).toBe(true)
    })
  })

  it('rejects an unusable Base URL before any network call', async () => {
    const result = await testConnection({ baseUrl: 'not-a-url' })
    expect(result.ok).toBe(false)
    expect(result.kind).toBe('invalid-config')
  })
})
