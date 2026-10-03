/**
 * 针对**真实云端**的端到端集成测试（默认跳过）。
 *
 * 单元测试用假服务器验证协议；这一个验证真实部署上的行为——只有它能回答
 * "云端返回的场景结构是否是我们解析的那种"。
 *
 * 运行方式（凭据从环境变量读，不写进仓库）：
 *   SYLLORA_CLOUD_E2E=1 \
 *   SYLLORA_CLOUD_BASE_URL=https://studyandchat.top \
 *   SYLLORA_CLOUD_ACCESS_CODE=... \
 *   SYLLORA_CLOUD_API_KEY=... \
 *   SYLLORA_CLOUD_PROVIDER=deepseek SYLLORA_CLOUD_PRESET=deepseek \
 *   SYLLORA_CLOUD_MODEL=deepseek-v4-flash \
 *   vitest run --project node packages/host/chat-service/tests/syllora-cloud-live.spec.ts
 */
import { describe, expect, it } from 'vitest'
import { OpenMaicCloud } from '../src/syllora-cloud.ts'
import { normalizeCloudScenes } from '../src/syllora-slides.ts'

const enabled = process.env.SYLLORA_CLOUD_E2E === '1'
const baseUrl = process.env.SYLLORA_CLOUD_BASE_URL ?? ''
const accessCode = process.env.SYLLORA_CLOUD_ACCESS_CODE ?? ''
const apiKey = process.env.SYLLORA_CLOUD_API_KEY ?? ''
const provider = process.env.SYLLORA_CLOUD_PROVIDER ?? 'deepseek'
const preset = process.env.SYLLORA_CLOUD_PRESET ?? 'deepseek'
const model = process.env.SYLLORA_CLOUD_MODEL ?? 'deepseek-v4-flash'

// 资料刻意写得像真实教材片段：云端要有内容才生成得出幻灯片。
const MATERIAL = `# 第一章 勾股定理

直角三角形两条直角边的平方和等于斜边的平方。若两直角边为 a、b，斜边为 c，则 a² + b² = c²。

常见勾股数有 3、4、5 与 5、12、13。反过来，若三角形三边满足 a² + b² = c²，则它是直角三角形，这称为勾股定理的逆定理。

证明思路：以斜边为边长作正方形，将其分割为四个与原三角形全等的直角三角形与一个小正方形，比较面积即得。
`

describe.runIf(enabled)('真实云端端到端', () => {
  it('代填模型配置能通过真实云端的校验', async () => {
    expect(baseUrl, '需要 SYLLORA_CLOUD_BASE_URL').not.toBe('')
    expect(accessCode, '需要 SYLLORA_CLOUD_ACCESS_CODE').not.toBe('')
    expect(apiKey, '需要 SYLLORA_CLOUD_API_KEY').not.toBe('')
    const cloud = new OpenMaicCloud({ baseUrl, accessCode })
    await cloud.configureModel({ providerId: provider, preset, model, apiKey })
    // 配置后应能读回（读回空也说明调用成功，失败会抛错）
    const caps = await cloud.capabilities()
    expect(caps.materials).toBeTruthy()
  }, 180_000)

  it('真实生成一章并确认场景结构可被归一化', async () => {
    const cloud = new OpenMaicCloud({ baseUrl, accessCode })
    const material = await cloud.uploadMaterial('勾股定理.md', new TextEncoder().encode(MATERIAL), 'text/markdown')
    expect(material.materialId).toMatch(/^mat_/)

    const jobId = await cloud.generateClassroom('根据提供的资料生成《第一章 勾股定理》这一章的课堂幻灯片，面向学生复习使用。', [material.materialId])
    expect(jobId).toBeTruthy()

    const steps: string[] = []
    const status = await cloud.waitForJob(jobId, {
      intervalMs: 5_000,
      // 实测生成耗时在 13–20 分钟之间波动（8 页课堂），所以放宽容忍度而不是把它当失败
      timeoutMs: 26 * 60_000,
      onProgress: current => { steps.push(`${current.step}:${current.progress ?? ''}`) },
    })
    // 失败时把云端原话带出来，便于定位（例如未配置模型）
    expect(status.error ?? '', `任务失败，云端返回：${status.error ?? ''}`).toBe('')
    expect(status.status).toBe('succeeded')
    expect(status.classroomId).toBeTruthy()

    const scenes = await cloud.scenes(status.classroomId!)
    expect(scenes.length, '云端应返回至少一页场景').toBeGreaterThan(0)
    // 关键：真实场景必须能被归一化出可渲染的 canvas，否则说明契约假设有误
    const { scenes: normalized, cloudSceneCount, skippedNonSlideCount } = normalizeCloudScenes(scenes)
    expect(normalized.length, `归一化后为空；原始场景样例：${JSON.stringify(scenes[0]).slice(0, 600)}`).toBeGreaterThan(0)
    expect(normalized[0]!.content.canvas).toBeTruthy()
    // 丢弃的只应是云端课堂里的非幻灯片页（quiz / interactive），且数量对得上
    expect(cloudSceneCount).toBe(scenes.length)
    expect(normalized.length + skippedNonSlideCount).toBe(cloudSceneCount)
    for (const scene of scenes) {
      if ((scene.content as { type?: string } | undefined)?.type && (scene.content as { type: string }).type !== 'slide') {
        expect((scene.content as { canvas?: unknown }).canvas).toBeUndefined()
      }
    }

    // 把真实结构打印出来，供人工核对字段名
    console.warn('LIVE-SCENE-KEYS', JSON.stringify(Object.keys(scenes[0]!)))
    console.warn('LIVE-CONTENT-KEYS', JSON.stringify(Object.keys((scenes[0] as { content?: object }).content ?? {})))
    console.warn('LIVE-SCENE-COUNT', String(scenes.length), 'NORMALIZED', String(normalized.length), 'SKIPPED', String(skippedNonSlideCount))
    console.warn('LIVE-CONTENT-TYPES', JSON.stringify([...new Set(scenes.map(s => (s.content as { type?: string } | undefined)?.type))]))
    console.warn('LIVE-STEPS', JSON.stringify(steps.slice(0, 12)))
  }, 30 * 60_000)
})
