/**
 * `cloud.wait_timeout_minutes` 的解析契约。
 *
 * 背景：云端单章生成耗时随部署配置差异极大——实测「flash + 并发 + 关思维」约 12 秒/页，
 * 而「pro + 串行 + 开思维」约 135 秒/页（11 倍）。一本 40 页的课程在慢配置下要数小时，
 * 所以固定 30 分钟的上限会**先于云端完成而超时**。这里锁定：合法分钟数被换算成毫秒，
 * 非法值视为未配置（由客户端 120 分钟兜底），而不是静默变成 0 或 NaN 导致立刻超时。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadChatConfig } from '../src/config.ts'

async function writeCloudConfig(minutes: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'syllora-cloud-timeout-'))
  await mkdir(join(root, '.syllora'), { recursive: true })
  const cloud: Record<string, unknown> = {
    base_url: 'https://studyandchat.top',
    access_code: 'fixture-code',
  }
  if (minutes !== undefined) cloud['wait_timeout_minutes'] = minutes
  const { default: yaml } = await import('js-yaml')
  await writeFile(
    join(root, '.syllora', 'config.yaml'),
    yaml.dump({ ui: { slides: true }, cloud }),
    'utf8',
  )
  return root
}

describe('cloud.wait_timeout_minutes 解析', () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })
  const make = async (minutes: unknown) => {
    const root = await writeCloudConfig(minutes)
    roots.push(root)
    return loadChatConfig(root)
  }

  it.each([1, 45, 1440])('合法值 %s 分钟启用幻灯片并带上毫秒上限', async minutes => {
    const config = await make(minutes)
    expect(config.slides).toBe(true)
    expect(config.cloud?.waitTimeoutMs).toBe(minutes * 60_000)
  })

  it('未配置时退回客户端默认（不带 waitTimeoutMs）', async () => {
    const config = await make(undefined)
    expect(config.slides).toBe(true)
    expect(config.cloud?.waitTimeoutMs).toBeUndefined()
  })

  it('非法值按未配置处理，而不是变成 0 或 NaN 导致立刻超时', async () => {
    for (const bad of [0, 0.5, 1e-12, -5, Number.NaN, Number.POSITIVE_INFINITY, '30', null, 24 * 60 + 1]) {
      const config = await make(bad)
      expect(config.cloud?.waitTimeoutMs, `输入 ${String(bad)}`).toBeUndefined()
    }
  })
})
