/**
 * Chat configuration resolution: reads the workspace's `.syllora/config.yaml`
 * (Python parity) plus credentials (env var first, then
 * `.syllora/credentials.json`). Produces the resolved connection facts the
 * DeepSeek adapter needs.
 * @module @syllora/chat-service/src/config
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import yaml from 'js-yaml'
import { workspaceStateDirOf } from '@syllora/tools'
import { normalizeProtocol, type ProviderProtocol } from './settings.ts'
import { sharedConfigRootOf } from './shared-root.ts'

export interface ResolvedChatConfig {
  readonly providerId: string
  readonly model: string
  /** DSH-style per-Agent reasoning effort; absent means provider default. */
  readonly reasoningEffort?: string | null
  /** 判题专用模型（A 档提速）：config.yaml `llm.judge_model`；null=跟随主模型。 */
  readonly judgeModel?: string | null
  /** 判题思考档位：`llm.judge_reasoning_effort`；null=判题路径缺省 off（关思考）。 */
  readonly judgeEffort?: 'off' | 'low' | 'high' | 'max' | null
  readonly baseUrl: string
  /** Wire protocol of the active provider; selects the LLM adapter. */
  readonly protocol: ProviderProtocol
  readonly apiKeyEnv: string | null
  readonly apiKey: string | null
  readonly temperature: number
  readonly maxConcurrency: number
  /** Per-request output cap（config.yaml `max_tokens`）；null=适配器默认。 */
  readonly maxTokens?: number | null
  readonly defaultMode: 'quick' | 'feynman' | 'debug'
  /**
   * 是否在初始化时生成"幻灯片讲义"（`ui.slides`）。默认**关**。
   *
   * 开启后每章会向云端 OpenMAIC 发一次生成请求（资料会上传到该服务器），
   * 属于用户应显式选择的成本与数据流向，不应该是升级后静默多出来的行为。
   * 还必须在 `cloud` 里配好 `base_url` 与 `access_code`，否则不会启用。
   */
  readonly slides: boolean
  /**
   * 是否把「先提炼、再整理」作为初始化管线（`ui.digest`）。默认**开**。
   *
   * 开：材料先按章/页组经模型提炼成结构化知识文档，再按节建来源整理讲义——调用次数与
   * 耗时显著下降（整本教材尤其明显）；关：仍对 DocMind 原始切片按批整理（旧管线）。
   * 需要模型才能提炼，未配置模型时初始化本来就会失败，这里无需额外条件。
   */
  readonly digest?: boolean
  /** 云端 OpenMAIC 连接信息；未配置时幻灯片功能不可用。 */
  readonly cloud?: {
    readonly baseUrl: string
    readonly accessCode: string
    readonly provider?: string
    readonly preset?: string
    readonly model?: string
    readonly apiKey?: string
    /** 单章生成等待上限（毫秒）；缺省由客户端用 120 分钟兜底。 */
    readonly waitTimeoutMs?: number
  }
  readonly agentPreset?: string
  /** 用户自定义的 agent 预设提示词；空串=使用预设自带的默认提示词。 */
  readonly agentSystemPrompt?: string
  /** 教学技能 id（见 skills.ts）；空串=不启用技能。 */
  readonly agentSkill?: string
  readonly permissionPreset?: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly plugins?: Record<string, boolean>
}

/** 自定义预设提示词上限：与 settings RPC 的校验一致。 */
export const MAX_AGENT_PROMPT_CHARS = 8000

interface ConfigYaml {
  readonly llm?: { provider?: string; model?: string; api_key_env?: string | null; api_base?: string | null; temperature?: number; max_concurrency?: number; max_tokens?: number | null; judge_model?: string | null; judge_reasoning_effort?: string | null }
  readonly active_provider?: string
  readonly providers?: Record<string, {
    readonly base_url?: string | null
    /** Wire protocol; absent (every config written before this field existed) reads as openai. */
    readonly protocol?: string | null
    readonly model?: string
    readonly api_key_env?: string | null
    readonly temperature?: number
    readonly max_concurrency?: number
    readonly max_tokens?: number | null
  }>
  readonly ui?: { default_mode?: string; slides?: boolean; digest?: boolean }
  /**
   * 云端 OpenMAIC：幻灯片在云端生成，本地只负责渲染。
   * - `base_url`：站点根地址，如 https://studyandchat.top
   * - `access_code`：站点访问口令（对应 OpenMAIC 的 ACCESS_CODE）
   * - `model_*`：代填到云端的模型配置（用户本地输入，写入云端后由云端调用）
   */
  readonly cloud?: {
    readonly base_url?: string
    readonly access_code?: string
    /** 密封凭据里的口令引用（settings.cloud.save 写入）；与 access_code 二选一，优先 access_code。 */
    readonly access_code_env?: string | null
    readonly provider?: string
    readonly preset?: string
    readonly model?: string
    readonly api_key?: string
    /** 密封凭据里的模型 Key 引用；与 api_key 二选一，优先 api_key。 */
    readonly api_key_env?: string | null
    /** 单章生成的等待上限（分钟）。慢配置下 40 页要数小时，默认 120 分钟。 */
    readonly wait_timeout_minutes?: number
  }
  readonly agent?: { preset?: string; system_prompt?: string; skill?: string }
  readonly permissions?: { preset?: string }
  readonly plugins?: Record<string, unknown>
}

/** Read one provider entry's connection facts from the config shape. */
export function providerFacts(config: ConfigYaml, providerId: string): {
  baseUrl: string | null
  protocol: ProviderProtocol
  model: string | null
  apiKeyEnv: string | null
  temperature: number | null
  maxConcurrency: number | null
  maxTokens: number | null
} {
  const entry = config.providers?.[providerId]
  return {
    baseUrl: entry?.base_url ?? null,
    protocol: normalizeProtocol(entry?.protocol),
    model: entry?.model ?? null,
    apiKeyEnv: entry?.api_key_env ?? null,
    temperature: entry?.temperature ?? null,
    maxConcurrency: entry?.max_concurrency ?? null,
    maxTokens: entry?.max_tokens ?? null,
  }
}

/**
 * DSH live-default posture: an empty or dangling active pointer falls back to
 * the first declared provider, so a workspace whose `active_provider` was lost
 * (or never written) still resolves a usable route at read time. A workspace
 * with no `providers` map keeps the legacy `llm`-segment id as-is.
 */
function resolveActiveProvider(config: ConfigYaml): string {
  const declared = config.active_provider ?? config.llm?.provider ?? ''
  const providerIds = Object.keys(config.providers ?? {})
  if (providerIds.length === 0) return declared
  if (declared !== '' && providerIds.includes(declared)) return declared
  return providerIds[0] ?? ''
}

/** Trim whitespace and trailing slashes so `{base}/chat/completions` joins cleanly. */
function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

/**
 * 共享设置目录：Host 启动时登记（见 shared-root.ts）。工作台的模型配置写在
 * 共享目录，课程目录通常没有自己的 `.syllora/config.yaml`，不回落就会出现
 * 「设置里已配好、对话却报未配置」。
 */

/** 「能发出一次请求」才算可用：缺供应商、缺 Base URL、缺模型都算未配置。 */
function configUsable(config: ResolvedChatConfig): boolean {
  return config.providerId !== '' && config.baseUrl !== '' && config.model !== ''
}

/**
 * 工作区根与共享根之间取值，不做静默换供应商：
 * 1. 工作区根读不出可用供应商 → 用共享根（课程目录从没配过就是这一种）；
 * 2. 工作区根有供应商但缺 API Key，共享根对同一供应商/同一 baseUrl/同一模型有 Key → 只借 Key；
 * 3. 其余一律保持工作区根。
 */
function pickChatConfig(primary: ResolvedChatConfig, fallback: ResolvedChatConfig | null): ResolvedChatConfig {
  if (fallback === null) return primary
  if (!configUsable(primary)) return configUsable(fallback) ? fallback : primary
  if (primary.apiKey === null && fallback.apiKey !== null
    && fallback.providerId === primary.providerId
    && fallback.baseUrl === primary.baseUrl
    && fallback.model === primary.model) {
    return { ...primary, apiKey: fallback.apiKey }
  }
  return primary
}

/**
 * Load and resolve the active chat config for one workspace, falling back to
 * the registered shared settings root when the workspace itself is unconfigured.
 * @param workspaceRoot - The workspace root holding `.syllora/config.yaml`.
 * @returns resolved connection facts; `baseUrl`/`apiKey` may be null when
 * unconfigured (the host reports a clear error at chat time).
 */
export async function loadChatConfig(workspaceRoot: string, selection?: { providerId?: string; model?: string }): Promise<ResolvedChatConfig> {
  const primary = await readChatConfig(workspaceRoot, selection)
  const sharedRoot = sharedConfigRootOf()
  if (sharedRoot === null || sharedRoot === resolve(workspaceRoot)) return primary
  const shared = await readChatConfig(sharedRoot, selection).catch(() => null)
  return pickChatConfig(primary, shared)
}

/** 只读给定根自己的 config.yaml：loadChatConfig 的回落由上层包装负责。 */
async function readChatConfig(workspaceRoot: string, selection?: { providerId?: string; model?: string }): Promise<ResolvedChatConfig> {
  const configPath = join(workspaceStateDirOf(workspaceRoot), 'config.yaml')
  const raw = await readFile(configPath, 'utf8').catch(() => null)
  if (raw === null) {
    return {
      providerId: '',
      model: '',
      reasoningEffort: null,
      judgeModel: null,
      judgeEffort: null,
      baseUrl: '',
      protocol: 'openai',
      apiKeyEnv: null,
      apiKey: null,
      temperature: 0.3,
      maxConcurrency: 8,
      maxTokens: null,
      defaultMode: 'quick',
      slides: false,
      agentPreset: 'syllora-learning',
      agentSystemPrompt: '',
      agentSkill: '',
      permissionPreset: 'workspace-write',
      plugins: {},
    }
  }
  const config = yaml.load(raw) as ConfigYaml
  const providerId = selection?.providerId ?? resolveActiveProvider(config)
  const direct = providerFacts(config, providerId)
  const baseUrl = normalizeBaseUrl(direct.baseUrl ?? config.llm?.api_base ?? '')
  const model = selection?.model ?? direct.model ?? config.llm?.model ?? ''
  const apiKeyEnv = direct.apiKeyEnv ?? config.llm?.api_key_env ?? null
  const apiKey = await resolveCredential(workspaceRoot, providerId, apiKeyEnv)
  const temperature = direct.temperature ?? config.llm?.temperature ?? 0.3
  const maxConcurrency = direct.maxConcurrency ?? config.llm?.max_concurrency ?? 8
  const maxTokens = direct.maxTokens ?? config.llm?.max_tokens ?? null
  const defaultMode = config.ui?.default_mode === 'quick' || config.ui?.default_mode === 'feynman' || config.ui?.default_mode === 'debug'
    ? config.ui.default_mode
    : 'quick'
  const permissionPreset = config.permissions?.preset === 'read-only' || config.permissions?.preset === 'danger-full-access'
    ? config.permissions.preset
    : 'workspace-write'
  const plugins: Record<string, boolean> = {}
  for (const [id, enabled] of Object.entries(config.plugins ?? {})) if (typeof enabled === 'boolean') plugins[id] = enabled
  const judgeEffortRaw = config.llm?.judge_reasoning_effort
  const judgeEffort = judgeEffortRaw === 'off' || judgeEffortRaw === 'low' || judgeEffortRaw === 'high' || judgeEffortRaw === 'max'
    ? judgeEffortRaw
    : null
  // 单章生成的等待上限。实测快慢配置差 11 倍（12 秒/页 vs 135 秒/页），
  // 所以允许配置；非法值（0、负数、非数、超过一天）按「未配置」处理，用客户端默认值。
  const waitMinutesRaw = config.cloud?.wait_timeout_minutes
  const waitTimeoutMs = typeof waitMinutesRaw === 'number' && Number.isFinite(waitMinutesRaw)
    && waitMinutesRaw >= 1 && waitMinutesRaw <= 24 * 60
    ? Math.round(waitMinutesRaw * 60_000)
    : null
  const cloud = await resolveCloudBlock(workspaceRoot, config)
  return {
    providerId,
    model,
    reasoningEffort: null,
    judgeModel: config.llm?.judge_model ?? null,
    judgeEffort,
    baseUrl,
    protocol: direct.protocol,
    apiKeyEnv,
    apiKey,
    temperature,
    maxConcurrency,
    maxTokens,
    defaultMode,
    // 幻灯片只有同时具备开关与云端连接信息时才启用，避免"开了但连不上"的模糊状态。
    // `cloud` 由 resolveCloudBlock 解析（支持字面量与密封凭据两种来源）。
    slides: config.ui?.slides === true && cloud !== null,
    ...(cloud ? { cloud: { ...cloud, ...(waitTimeoutMs !== null ? { waitTimeoutMs } : {}) } } : {}),
    agentPreset: config.agent?.preset === 'general' ? 'general' : 'syllora-learning',
    agentSystemPrompt: typeof config.agent?.system_prompt === 'string' ? config.agent.system_prompt.trim().slice(0, MAX_AGENT_PROMPT_CHARS) : '',
    agentSkill: typeof config.agent?.skill === 'string' ? config.agent.skill.trim() : '',
    permissionPreset,
    plugins,
  }
}

/** Credential resolution: env var first, then `.syllora/credentials.json`. */
function credentialsPathOf(workspaceRoot: string): string {
  return join(workspaceStateDirOf(workspaceRoot), 'credentials.json')
}

/**
 * 解析 `cloud` 段：地址 + 口令 + 可选的模型代填信息。
 *
 * 口令与模型 Key 都支持「字面量写在 config.yaml」与「密封凭据引用（*_env）」两种来源，
 * 字面量优先——手工编辑过 config.yaml 的部署仍按原样工作；设置页保存走密封凭据，
 * 避免把凭据以明文写进用户可见的目录。
 */
async function resolveCloudBlock(workspaceRoot: string, config: ConfigYaml): Promise<ResolvedChatConfig['cloud'] | null> {
  const cloud = config.cloud
  if (!cloud) return null
  const baseUrl = (cloud.base_url ?? '').trim().replace(/\/+$/, '')
  const literalCode = (cloud.access_code ?? '').trim()
  const accessCode = literalCode !== ''
    ? literalCode
    : (await resolveCredential(workspaceRoot, 'openmaic', cloud.access_code_env ?? null)) ?? ''
  if (baseUrl === '' || accessCode === '') return null
  const literalKey = (cloud.api_key ?? '').trim()
  const apiKey = literalKey !== ''
    ? literalKey
    : (await resolveCredential(workspaceRoot, 'openmaic-model', cloud.api_key_env ?? null)) ?? ''
  return {
    baseUrl,
    accessCode,
    ...(cloud.provider?.trim() ? { provider: cloud.provider.trim() } : {}),
    ...(cloud.preset?.trim() ? { preset: cloud.preset.trim() } : {}),
    ...(cloud.model?.trim() ? { model: cloud.model.trim() } : {}),
    ...(apiKey !== '' ? { apiKey } : {}),
  }
}

/**
 * 云端连接配置的独立解析：候选目录（课程状态目录 → 课程根）→ 共享设置目录，取第一份齐全的。
 *
 * 不复用 loadChatConfig 的回落是因为它的「借 Key」分支只在本地供应商缺失时生效：
 * 课程自己配了模型（primary 可用）时不会把共享目录里的 cloud 段带出来，
 * 而设置页保存的云端配置按设计只写共享目录一处。
 * @param roots - 候选目录（可为空项）；按顺序查找，最后兜底共享设置目录。
 */
export async function resolveCloudConfig(roots: Array<string | null | undefined>): Promise<NonNullable<ResolvedChatConfig['cloud']> | null> {
  const candidates = [...roots, sharedConfigRootOf()]
  for (const root of candidates) {
    if (typeof root !== 'string' || root.trim() === '') continue
    const resolved = await readChatConfig(root).then(config => config.cloud ?? null).catch(() => null)
    if (resolved) return resolved
  }
  return null
}

async function resolveCredential(workspaceRoot: string, providerId: string, apiKeyEnv: string | null): Promise<string | null> {
  if (apiKeyEnv !== null) {
    const envValue = process.env[apiKeyEnv]
    if (typeof envValue === 'string' && envValue !== '') return envValue
  }
  const credsRaw = await readFile(credentialsPathOf(workspaceRoot), 'utf8').catch(() => null)
  if (credsRaw === null || credsRaw.trim() === '') return null
  let creds: Record<string, unknown>
  try {
    // P0-2：凭据为 AES-GCM 密文；legacy 明文由 settings 层读取时自动迁移，
    // 这里只需透明解密。解密失败按"未配置"降级而不是让所有 chat 崩溃，
    // 但必须留痕（L7）：master.key 与工作区错位时静默降级会让排障变成猜谜。
    const { unsealCredentials } = await import('./secret-box.ts')
    creds = (await unsealCredentials(credsRaw)).data
  } catch {
    console.warn('[config] credentials.json 解密失败，本次按未配置凭据处理；请在设置中重新填写 API Key')
    return null
  }
  // CR-08：旧实现在末尾无条件回退 `default` 键——某供应商没有自己的凭据时，会把
  // 凭据表里 `default` 的密钥（往往是另一个供应商的）发往它的 baseUrl：既是静默
  // 串号，也等于凭据外带。这里只认与本次解析目标严格相关的键；本地保留
  // `providers.<id>` 的嵌套读法（迁移期的历史结构）。
  const exactKeys = [apiKeyEnv, providerId, providerId.replace(/^openai\//, '')]
  for (const key of exactKeys) {
    if (key === null) continue
    const value = creds[key]
    if (typeof value === 'string' && value !== '') return value
  }
  const nested = creds['providers'] as Record<string, unknown> | undefined
  const nestedValue = nested?.[providerId]
  if (typeof nestedValue === 'string' && nestedValue !== '') return nestedValue
  return null
}
