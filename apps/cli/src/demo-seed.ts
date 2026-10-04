/**
 * 首次启动的演示数据种子（用户要求：下载即用，含 AI 与虚拟课堂）。
 *
 * - `seedDemoProfile`：profile 里没有配置时，把 {@link DEMO_DEFAULTS} 里内嵌的演示凭据
 *   通过**正常的设置保存链路**写进去（模型 Key / DocMind AccessKey 走密封凭据，
 *   云端口令走 config.yaml + 凭据），因此设置页可正常查看与覆盖，不存在"锁死"。
 *   只补缺、不覆盖：任何一项已配置就跳过该项。
 * - `seedDemoCourses`：课程注册表为空时，把随包分发的示例课程复制进课程目录并登记。
 *   示例课程含完整状态（讲义 revision / 解析产物 / 虚拟课堂），开箱即可看到效果。
 *
 * 两个函数都幂等；`SYLLORA_SKIP_DEMO_SEED=1` 可整体关闭（测试/纯净部署用）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { saveProvider, setCloudConfig, setCredential, setDocMindCredential, settingsPayload } from '@syllora/chat-service'
import { DEMO_DEFAULTS } from './demo-defaults.ts'

const skipSeed = (): boolean => process.env.SYLLORA_SKIP_DEMO_SEED === '1'

/** 把内嵌演示凭据写入空缺位置；返回写入了哪些项（用于启动日志）。 */
export async function seedDemoProfile(settingsRoot: string): Promise<string[]> {
  if (skipSeed() || DEMO_DEFAULTS === null) return []
  const demo = DEMO_DEFAULTS
  const applied: string[] = []
  const payload = await settingsPayload(settingsRoot).catch(() => null)
  if (payload === null || payload.providers.length === 0) {
    await saveProvider(settingsRoot, {
      id: demo.provider.id,
      name: demo.provider.name,
      model: demo.provider.model,
      baseUrl: demo.provider.baseUrl,
      protocol: demo.provider.protocol,
      temperature: demo.provider.temperature,
      maxConcurrency: demo.provider.maxConcurrency,
      models: demo.provider.models.map(model => ({ ...model })),
    })
    await setCredential(settingsRoot, demo.provider.id, demo.provider.apiKey)
    applied.push('模型供应商')
  }
  if (payload === null || payload.docmind.configured !== true) {
    await setDocMindCredential(settingsRoot, {
      accessKeyId: demo.docmind.accessKeyId,
      accessKeySecret: demo.docmind.accessKeySecret,
      endpoint: demo.docmind.endpoint,
    })
    applied.push('DocMind')
  }
  if (payload === null || payload.cloud.hasAccessCode !== true) {
    await setCloudConfig(settingsRoot, {
      baseUrl: demo.cloud.baseUrl,
      accessCode: demo.cloud.accessCode,
      ...(demo.cloud.provider !== '' ? { provider: demo.cloud.provider } : {}),
      ...(demo.cloud.preset !== '' ? { preset: demo.cloud.preset } : {}),
      ...(demo.cloud.model !== '' ? { model: demo.cloud.model } : {}),
    })
    applied.push('云端课堂')
  }
  return applied
}

interface RegistryEntry { id: string; path: string; name: string }

/**
 * 课程注册表为空时把示例课程复制到课程目录并登记。
 * 复制用 `force:false` 语义：目标已存在同名课程时保留用户数据，只补登记。
 */
export async function seedDemoCourses(options: { settingsRoot: string; coursesRoot: string; sampleRoot: string | null }): Promise<string[]> {
  if (skipSeed()) return []
  const { settingsRoot, coursesRoot, sampleRoot } = options
  if (sampleRoot === null || !existsSync(sampleRoot)) return []
  const registryPath = join(settingsRoot, '.syllora', 'projects.json')
  const existing: unknown = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf8')) : []
  if (Array.isArray(existing) && existing.length > 0) return []
  const entries: RegistryEntry[] = []
  mkdirSync(coursesRoot, { recursive: true })
  for (const id of readdirSync(sampleRoot)) {
    const source = join(sampleRoot, id)
    if (!statSync(source).isDirectory()) continue
    const target = join(coursesRoot, id)
    if (!existsSync(target)) cpSync(source, target, { recursive: true })
    let name = id
    try {
      const state = JSON.parse(readFileSync(join(target, '.syllora', 'course.json'), 'utf8')) as { courses?: Array<{ name?: string }> }
      name = state.courses?.[0]?.name ?? id
    } catch { /* 状态缺失时以目录名为名 */ }
    entries.push({ id, path: target, name })
  }
  if (entries.length === 0) return []
  mkdirSync(join(settingsRoot, '.syllora'), { recursive: true })
  writeFileSync(registryPath, `${JSON.stringify(entries, null, 2)}\n`)
  return entries.map(entry => entry.name)
}