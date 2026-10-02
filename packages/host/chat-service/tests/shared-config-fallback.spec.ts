/**
 * 共享设置根回落：设置页把供应商写在共享目录（桌面壳的 SYLLORA_DATA_DIR），
 * 对话/构课解析的是课程目录。课程目录没有自己的 config.yaml 时必须回落，
 * 否则稳定复现「设置里已配好、对话却报未配置」。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadChatConfig } from '../src/config.ts'
import { saveProvider, setCredential, settingsPayload } from '../src/settings.ts'
import { setSharedConfigRoot } from '../src/shared-root.ts'

const PLACEHOLDER = 'placeholder-value'

/** 只建目录、不写 config.yaml 的"课程文件夹"。 */
async function emptyCourseRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'syllora-course-'))
  await mkdir(join(root, '.syllora'), { recursive: true })
  return root
}

/** 共享设置目录：一个已激活的供应商 + 一条密封凭据。 */
async function sharedRootWithProvider(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'syllora-shared-'))
  process.env.SYLLORA_HOME = join(root, '.syllora')
  await saveProvider(root, { id: 'mimo', name: 'Fixture', model: 'fixture-flash', baseUrl: 'https://api.example.com/v1' })
  await setCredential(root, 'mimo', PLACEHOLDER)
  return root
}

/** 课程目录自带一份 config.yaml（不同供应商、没有凭据）。 */
async function courseRootWithOwnProvider(): Promise<string> {
  const root = await emptyCourseRoot()
  await writeFile(join(root, '.syllora', 'config.yaml'), [
    'active_provider: local',
    'providers:',
    '  local:',
    '    id: local',
    '    name: Local',
    '    model: local-model',
    '    base_url: https://local.example.com/v1',
    '    api_key_env: LOCAL_API_KEY',
    '',
  ].join('\n'), 'utf8')
  return root
}

afterEach(() => {
  setSharedConfigRoot('')
  delete process.env.SYLLORA_HOME
})

describe('shared settings root fallback', () => {
  it('resolves the shared provider for a course folder with no config of its own', async () => {
    const shared = await sharedRootWithProvider()
    const course = await emptyCourseRoot()
    try {
      setSharedConfigRoot(shared)
      const config = await loadChatConfig(course)
      expect(config.providerId).toBe('mimo')
      expect(config.model).toBe('fixture-flash')
      expect(config.baseUrl).toBe('https://api.example.com/v1')
      expect(config.apiKey).toBe(PLACEHOLDER)
    } finally {
      await rm(shared, { recursive: true, force: true })
      await rm(course, { recursive: true, force: true })
    }
  })

  it('honours a session model selection against the shared provider', async () => {
    const shared = await sharedRootWithProvider()
    const course = await emptyCourseRoot()
    try {
      setSharedConfigRoot(shared)
      const config = await loadChatConfig(course, { providerId: 'mimo', model: 'fixture-pro' })
      expect(config.providerId).toBe('mimo')
      expect(config.model).toBe('fixture-pro')
      expect(config.apiKey).toBe(PLACEHOLDER)
    } finally {
      await rm(shared, { recursive: true, force: true })
      await rm(course, { recursive: true, force: true })
    }
  })

  it('keeps a course-local provider instead of silently switching to the shared one', async () => {
    const shared = await sharedRootWithProvider()
    const course = await courseRootWithOwnProvider()
    try {
      setSharedConfigRoot(shared)
      const config = await loadChatConfig(course)
      expect(config.providerId).toBe('local')
      expect(config.model).toBe('local-model')
      expect(config.apiKey).toBeNull()
    } finally {
      await rm(shared, { recursive: true, force: true })
      await rm(course, { recursive: true, force: true })
    }
  })

  it('borrows the key from the shared root when the same provider lacks credentials locally', async () => {
    const shared = await sharedRootWithProvider()
    const course = await emptyCourseRoot()
    await writeFile(join(course, '.syllora', 'config.yaml'), [
      'active_provider: mimo',
      'providers:',
      '  mimo:',
      '    id: mimo',
      '    model: fixture-flash',
      '    base_url: https://api.example.com/v1',
      '    api_key_env: MIMO_API_KEY',
      '',
    ].join('\n'), 'utf8')
    try {
      setSharedConfigRoot(shared)
      const config = await loadChatConfig(course)
      expect(config.providerId).toBe('mimo')
      expect(config.apiKey).toBe(PLACEHOLDER)
    } finally {
      await rm(shared, { recursive: true, force: true })
      await rm(course, { recursive: true, force: true })
    }
  })

  it('stays unconfigured when no shared root is registered', async () => {
    const shared = await sharedRootWithProvider()
    const course = await emptyCourseRoot()
    try {
      const config = await loadChatConfig(course)
      expect(config.providerId).toBe('')
      expect(config.apiKey).toBeNull()
    } finally {
      await rm(shared, { recursive: true, force: true })
      await rm(course, { recursive: true, force: true })
    }
  })

  it('projects the shared providers into the course-scoped settings payload', async () => {
    const shared = await sharedRootWithProvider()
    const course = await emptyCourseRoot()
    try {
      setSharedConfigRoot(shared)
      const payload = await settingsPayload(course)
      expect(payload.activeProviderId).toBe('mimo')
      expect(payload.providers.map(provider => provider.id)).toEqual(['mimo'])
      expect(payload.llm.apiKeyConfigured).toBe(true)
    } finally {
      await rm(shared, { recursive: true, force: true })
      await rm(course, { recursive: true, force: true })
    }
  })
})
