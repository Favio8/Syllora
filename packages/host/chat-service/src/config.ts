/**
 * Chat configuration resolution: reads the workspace's `.syllora/config.yaml`
 * (Python parity) plus credentials (env var first, then
 * `.syllora/credentials.json`). Produces the resolved connection facts the
 * DeepSeek adapter needs.
 * @module @syllora/chat-service/src/config
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { workspaceStateDirOf } from '@syllora/tools'
import { normalizeProtocol, type ProviderProtocol } from './settings.ts'

export interface ResolvedChatConfig {
  /** Internal source of provider routes; never included in public settings. */
  readonly configRoot?: string
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
  readonly defaultMode: 'socratic' | 'quick' | 'feynman' | 'debug'
  readonly agentPreset?: string
  readonly permissionPreset?: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly plugins?: Record<string, boolean>
}

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
  readonly ui?: { default_mode?: string }
  readonly agent?: { preset?: string }
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
    baseUrl: entry?.base_url?.trim() || null,
    protocol: normalizeProtocol(entry?.protocol),
    model: entry?.model?.trim() || null,
    apiKeyEnv: entry?.api_key_env?.trim() || null,
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
 * Load and resolve the active chat config for one workspace.
 * @param workspaceRoot - The workspace root holding `.syllora/config.yaml`.
 * @returns resolved connection facts; `baseUrl`/`apiKey` may be null when
 * unconfigured (the host reports a clear error at chat time).
 */
export async function loadChatConfig(workspaceRoot: string, selection?: { providerId?: string; model?: string }): Promise<ResolvedChatConfig> {
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
      maxConcurrency: 4,
      maxTokens: null,
      defaultMode: 'socratic',
      agentPreset: 'syllora-learning',
      permissionPreset: 'workspace-write',
      plugins: {},
    }
  }
  const config = (yaml.load(raw) ?? {}) as ConfigYaml
  const providerId = selection?.providerId ?? resolveActiveProvider(config)
  const direct = providerFacts(config, providerId)
  const legacy = config.llm?.provider === providerId ? config.llm : undefined
  const baseUrl = normalizeBaseUrl(direct.baseUrl ?? legacy?.api_base ?? '')
  const model = selection?.model?.trim() || direct.model || legacy?.model?.trim() || ''
  const apiKeyEnv = direct.apiKeyEnv ?? legacy?.api_key_env ?? null
  const apiKey = await resolveCredential(workspaceRoot, providerId, apiKeyEnv)
  const temperature = direct.temperature ?? config.llm?.temperature ?? 0.3
  const maxConcurrency = direct.maxConcurrency ?? config.llm?.max_concurrency ?? 4
  const maxTokens = direct.maxTokens ?? config.llm?.max_tokens ?? null
  const defaultMode = config.ui?.default_mode === 'quick' || config.ui?.default_mode === 'feynman' || config.ui?.default_mode === 'debug'
    ? config.ui.default_mode
    : 'socratic'
  const permissionPreset = config.permissions?.preset === 'read-only' || config.permissions?.preset === 'danger-full-access'
    ? config.permissions.preset
    : 'workspace-write'
  const plugins: Record<string, boolean> = {}
  for (const [id, enabled] of Object.entries(config.plugins ?? {})) if (typeof enabled === 'boolean') plugins[id] = enabled
  const judgeEffortRaw = config.llm?.judge_reasoning_effort
  const judgeEffort = judgeEffortRaw === 'off' || judgeEffortRaw === 'low' || judgeEffortRaw === 'high' || judgeEffortRaw === 'max'
    ? judgeEffortRaw
    : null
  return {
    configRoot: workspaceRoot,
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
    agentPreset: config.agent?.preset === 'general' ? 'general' : 'syllora-learning',
    permissionPreset,
    plugins,
  }
}

/** Credential resolution: env var first, then `.syllora/credentials.json`. */
function credentialsPathOf(workspaceRoot: string): string {
  return join(workspaceStateDirOf(workspaceRoot), 'credentials.json')
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
  // CR-08：旧实现在末尾无条件回退 `default` 键——A 供应商没有自己的凭据时，
  // 会把凭据表里 `default` 的密钥（往往是另一个供应商的）发往 A 的 baseUrl，
  // 造成跨供应商密钥泄漏。改为只接受能确切对应本供应商的键：apiKeyEnv（设置
  // 层生成的 <PROVIDER>_API_KEY）、providerId 本身、去命名空间前缀的 id，以及
  // providers.<providerId> 的嵌套写法。缺失即返回 null（上层按"未配置"报错），
  // 不再借用其他供应商的密钥。
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
