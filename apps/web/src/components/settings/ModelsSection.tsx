"use client";

/**
 * DSH 风格模型配置 Tab（v2 重构，对齐 ui-settings-models 交互）：
 * - 两个视图：「模型配置」（目录选型新增）与「供应商管理」（已配置 API 的
 *   管理：激活/编辑/删除），顶部「← 返回」一键回到模型配置起始状态
 * - 行卡片稳定：行永远可见（状态点/名称/使用中 + 操作），编辑器展开在行下方；
 *   编辑 / 添加两态互斥，一次只开一张卡
 * - Key 主字段化：API Key 是唯一主字段；协议、Base URL、默认模型、模型列表
 *   收进「自定义设置」折叠区
 * - 添加入口：内置目录选型（预填地址与协议，模型由用户发现/选择）；自定义
 *   OpenAI 兼容端点从目录选「OpenAI 兼容」条目手填
 * - 模型列表可从端点拉取（discover-models，用表单当前值询问），失败可手填
 * - 首次运行姿态：没有任何已配置密钥的 provider 时自动展开 setup 卡
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { api, ApiError, type CloudSettings, type DocMindSettings } from "@/src/lib/api";
import { useAppStore } from "@/src/store/useAppStore";
import { useFocusTrap } from "@/src/hooks/useFocusTrap";
import type {
  ProviderCatalogEntry,
  ProviderModelPayload,
  ProviderPayload,
  ProviderProtocol,
  SettingsPayload,
  ConnectionTestResult,
} from "@/src/types/api";

interface EditorProfile {
  id: string;
  name: string;
  model: string;
  baseUrl: string | null;
  temperature: number;
  maxConcurrency: number;
  models: ProviderModelPayload[];
  /** 线上协议；缺省 = 保留现值（编辑态）/ openai（创建态）。 */
  protocol?: ProviderProtocol;
  /** 编辑既有 id 时置 true（跳过 409）；创建态缺省。 */
  overwrite?: boolean;
}

/** 容量输入草稿：焦点期间保留原文，保存时才解析（避免「1000」被打断成「1K」）。 */
/** 行级稳定 key（FE-4）：删除中间行时 React 复用正确 DOM，展开态/IME 不再串位。 */
interface ModelDraft {
  rowKey: string;
  id: string;
  name: string;
  contextText: string;
  maxText: string;
}

let rowKeySeq = 0;
function nextRowKey(): string {
  rowKeySeq += 1;
  return `rk_${Date.now().toString(36)}_${rowKeySeq}`;
}

/** 「恢复内置列表」二次确认的武装窗口（ms）——够用户看清"确认恢复？"又不拖沓。 */
const RESTORE_CONFIRM_MS = 2500;

/** 添加卡按目录条目缓存整卡草稿（DSH：切换目录不丢已填内容）。 */
interface AddCardDraft {
  routeId: string;
  name: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  rows: ModelDraft[];
  temperature: number;
  maxConcurrency: number;
  protocol?: ProviderProtocol;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** 解析十进制 K/M 后缀容量；空串 → null（未填），非法 → "invalid"。 */
function parseCapacity(text: string): number | null | "invalid" {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(trimmed);
  if (!match) return "invalid";
  const multiplier = match[2].toUpperCase() === "M" ? 1_000_000 : match[2] ? 1_000 : 1;
  const value = Math.round(parseFloat(match[1]) * multiplier);
  return value > 0 ? value : "invalid";
}

function formatCapacity(value: number | null): string {
  if (value === null) return "";
  if (value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value % 1_000 === 0) return `${value / 1_000}K`;
  return String(value);
}

function draftsFrom(models: ProviderModelPayload[]): ModelDraft[] {
  return models.map((m) => ({
    rowKey: nextRowKey(),
    id: m.id,
    name: m.name,
    contextText: formatCapacity(m.contextWindow),
    maxText: formatCapacity(m.maxTokens),
  }));
}

function ProviderEditorCard({
  provider,
  entry,
  creating,
  onSave,
  onCancel,
  draftCache,
  occupiedIds = [],
}: {
  /** 编辑既有 provider；null = 创建。 */
  provider: ProviderPayload | null;
  /** 创建来源的目录条目（预填 + placeholder）；自定义声明为 null。 */
  entry: ProviderCatalogEntry | null;
  creating: boolean;
  onSave: (profile: EditorProfile, apiKey: string) => Promise<void>;
  onCancel: () => void;
  /** 添加卡草稿缓存：按目录条目 id 保存/恢复，切换条目不丢草稿（X4）。 */
  draftCache?: Map<string, AddCardDraft> | null;
  occupiedIds?: string[];
}) {
  const entryId = entry?.id ?? null;
  // X4：挂载时从按条目缓存的草稿恢复（切换条目靠 key 重挂载触发），
  // 这样「切走再切回」同一目录时已填内容仍在。
  const draft = draftCache?.get(entryId ?? "") ?? null;
  let availableId = entry?.id ?? '';
  for (let suffix = 2; occupiedIds.includes(availableId); suffix++) availableId = `${entry?.id}-${suffix}`;
  const [routeId, setRouteId] = useState(draft?.routeId ?? provider?.id ?? availableId);
  const [name, setName] = useState(draft?.name ?? provider?.name ?? entry?.name ?? "");
  const [model, setModel] = useState(draft?.model ?? provider?.model ?? "");
  const [baseUrl, setBaseUrl] = useState(draft?.baseUrl ?? provider?.baseUrl ?? entry?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(draft?.apiKey ?? "");
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [rows, setRows] = useState<ModelDraft[]>(() =>
    draft?.rows ?? draftsFrom(provider?.models ?? entry?.models ?? []),
  );
  // 高级字段：编辑态从既有 provider 初始化真实值，创建态用默认（X2）。
  const [temperature, setTemperature] = useState(draft?.temperature ?? provider?.temperature ?? 0.3);
  // 兜底必须与宿主默认值一致（config.ts / settings.ts 的 8）：这里是新建卡片的初值，
  // 保存时无条件发送，若用 4 会把运行时并发静默降回 4。
  const [maxConcurrency, setMaxConcurrency] = useState(draft?.maxConcurrency ?? provider?.maxConcurrency ?? 8);
  // 协议决定请求路径与鉴权头（openai: /chat/completions + Bearer；
  // anthropic: /v1/messages + x-api-key）。目录条目自带默认，编辑态以已存值为准。
  const [protocol, setProtocol] = useState<ProviderProtocol>(
    draft?.protocol ?? provider?.protocol ?? entry?.protocol ?? "openai",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ProviderModelPayload[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // P2：API Key 明文切换——type=password 且无 eye 按钮，粘贴后无法核对。
  const [keyVisible, setKeyVisible] = useState(false);
  // 「↺ 恢复内置列表」防误触：第一次点击只进入确认态， armed 期间再次点击才真正
  // 覆盖手改的模型行（旧实现一键丢弃，用户改半天的容量/ID 一次点飞）。
  const [restoreArmed, setRestoreArmed] = useState(false);
  const restoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarmRestore = useCallback(() => {
    if (restoreTimerRef.current !== null) {
      clearTimeout(restoreTimerRef.current);
      restoreTimerRef.current = null;
    }
    setRestoreArmed(false);
  }, []);
  const armRestore = useCallback(() => {
    if (restoreTimerRef.current !== null) clearTimeout(restoreTimerRef.current);
    setRestoreArmed(true);
    restoreTimerRef.current = setTimeout(() => {
      restoreTimerRef.current = null;
      setRestoreArmed(false);
    }, RESTORE_CONFIRM_MS);
  }, []);

  // 每次渲染后把最新表单快照存入 ref（渲染期不写 ref，effect 期允许）。
  const draftRef = useRef<AddCardDraft | null>(null);
  useEffect(() => {
    draftRef.current = { routeId, name, model, baseUrl, apiKey, rows, temperature, maxConcurrency, protocol };
  }, [routeId, name, model, baseUrl, apiKey, rows, temperature, maxConcurrency, protocol]);
  // 卸载（切走条目）时把最新草稿写回缓存，供切回时恢复。
  useEffect(() => {
    if (!draftCache || entryId === null) return;
    return () => {
      if (restoreTimerRef.current !== null) clearTimeout(restoreTimerRef.current);
      if (draftRef.current) {
        // FE-4：草稿缓存永不携带明文 apiKey——切走条目即丢弃未提交密钥。
        const { apiKey: _droppedApiKey, ...rest } = draftRef.current;
        void _droppedApiKey;
        draftCache.set(entryId, { ...rest, apiKey: "" });
      }
    };
  }, [entryId, draftCache]);

  const id = provider?.id ?? routeId.trim();
  const idValid = !creating || /^[a-z][a-z0-9-]*$/.test(id);
  const parsedRows = rows.map((row) => ({
    row,
    rowKey: row.rowKey,
    id: row.id.trim(),
    context: parseCapacity(row.contextText),
    max: parseCapacity(row.maxText),
  }));
  const rowIdsValid = parsedRows.every((r) => r.id.length > 0);
  const capacitiesValid = parsedRows.every(
    (r) => r.context !== "invalid" && r.max !== "invalid",
  );
  // 写入即校验（DSH write-time refusal）：Base URL 是可用配置的硬前提。
  // FL-47：默认模型允许留空保存——首次运行流是「贴 Key 即保存，之后再发现
  // 模型选默认」（测试契约 + 组件内既有警告文案都是这个语义）；空默认模型
  // 仅导致激活/构建不可用（后端 activate/构建侧已各自拒绝），不再阻止保存。
  const canSave =
    idValid &&
    id.length > 0 &&
    baseUrl.trim().length > 0 &&
    rowIdsValid &&
    capacitiesValid;

  /** 需求七：连接测试——用表单当前值（未保存也能测）。 */
  async function testNow() {
    setTestBusy(true);
    setTestResult(null);
    try {
      const result = await api.testConnection({
        baseUrl: baseUrl.trim(),
        ...(protocol ? { protocol } : {}),
        ...(apiKey.trim() !== "" ? { apiKey: apiKey.trim() } : {}),
        ...(provider ? { providerId: provider.id } : {}),
        ...(model.trim() !== "" ? { model: model.trim() } : {}),
      });
      setTestResult(result);
    } catch (cause) {
      setTestResult({ ok: false, kind: "network", message: errorMessage(cause), modelIds: [] });
    } finally {
      setTestBusy(false);
    }
  }

  async function submit() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      // 编辑态 = 更新既有 id，必须显式 overwrite；创建态不带，撞 id 时由
      // 上层弹 409 覆盖确认（X5）。高级字段编辑态保留真实值（X2）。
      await onSave(
        {
          id,
          name: name.trim(),
          model: model.trim(),
          baseUrl: baseUrl.trim() || null,
          temperature,
          maxConcurrency,
          protocol,
          models: parsedRows.map((r) => ({
            id: r.id,
            name: r.row.name.trim(),
            contextWindow: r.context === "invalid" ? null : r.context,
            maxTokens: r.max === "invalid" ? null : r.max,
          })),
          ...(provider !== null ? { overwrite: true } : {}),
        },
        apiKey.trim(),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  /** 用表单当前值（未保存的 Base URL + 已键入但未保存的 Key）询问端点。
   *  providerId 必须带上：编辑态密钥按设计不回填浏览器（留空=保留原值），
   *  服务端靠它去解密已存储的凭据；不带就等于不带 Authorization 打过去。 */
  async function discover() {
    setDiscovering(true);
    setDiscoverError(null);
    try {
      const result = await api.discoverModels({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        apiKeyEnv: apiKey.trim() ? undefined : provider?.apiKeyEnv ?? undefined,
        providerId: apiKey.trim() ? undefined : provider?.id ?? undefined,
        protocol,
      });
      setCandidates(result.models);
      // 已配置过的候选默认不勾选：采纳选择绝不覆盖用户已调优的容量。
      setChecked(
        new Set(
          result.models
            .filter((m) => !rows.some((row) => row.id.trim() === m.id))
            .map((m) => m.id),
        ),
      );
    } catch (cause) {
      setDiscoverError(errorMessage(cause));
    } finally {
      setDiscovering(false);
    }
  }

  function adoptCandidates() {
    if (!candidates) return;
    // P1-5：按模型 id 去重——候选默认过滤了已在列表中的模型，但用户可手动勾选
    // 重复项；旧实现直接 append，保存后 models 数组含重复 id（后端不校验唯一性），
    // 行卡片出现两行同一模型。
    const existing = new Set(rows.map((row) => row.id.trim()));
    const selected = candidates.filter((m) => checked.has(m.id) && !existing.has(m.id));
    const skipped = candidates.filter((m) => checked.has(m.id) && existing.has(m.id)).length;
    if (skipped > 0) {
      useAppStore.getState().flashStatusBanner(`已跳过 ${skipped} 个列表中已存在的模型`);
    }
    if (selected.length > 0) {
      setRows((current) => [...current, ...draftsFrom(selected)]);
    }
    setCandidates(null);
  }

  function updateRow(index: number, patch: Partial<ModelDraft>) {
    setRows((current) => current.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  // W-10：候选选择框的焦点圈闭（Escape 关闭，与遮罩点击同语义）。
  const candidatesDialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap({ containerRef: candidatesDialogRef, onEscape: () => setCandidates(null) });
  // 浏览器和密码管理器可能忽略 autocomplete="off"，尤其是新建表单。
  // 使用 new-password + 非语义化字段名，避免把用户的学号/账号资料误填进 Provider。
  const formAutoComplete = creating ? "new-password" : "off";
  const fieldAutoComplete = creating ? "new-password" : "off";
  const autofillGuardProps = {
    "data-1p-ignore": "true",
    "data-bwignore": "true",
    "data-form-type": "other",
    "data-lpignore": "true",
  } as const;
  const inputClass =
    "h-9 w-full rounded-lg border border-border-line bg-bg-root px-3 text-[13px] text-text-primary outline-none focus:border-accent-focus";
  const selectClass = `${inputClass} appearance-none`;
  // 默认模型候选 = 列表中的模型 ID；当前值不在列表时附加在首位，避免 select 静默改选。
  const rowIds = rows.map((r) => r.id.trim()).filter((v) => v.length > 0);
  const currentModel = model.trim();
  const modelOptions =
    currentModel && !rowIds.includes(currentModel) ? [currentModel, ...rowIds] : rowIds;

  return (
    <form
      autoComplete={formAutoComplete}
      onSubmit={(e) => e.preventDefault()}
      className="rounded-xl bg-bg-card p-4 shadow-lv2"
      {...autofillGuardProps}
    >
      {!creating ? (
        <div className="mb-3 flex items-baseline gap-2">
          <span className="text-sm font-medium text-text-primary">{provider?.name || id}</span>
          <span className="text-xs text-text-faint">{id}</span>
        </div>
      ) : null}

      {/* 主字段：API Key。其余字段全部收进折叠区。 */}
      <label className="flex flex-col gap-1.5 text-xs text-text-secondary">
        API Key
        <div className="relative">
          <input
            type={keyVisible ? "text" : "password"}
            autoComplete="new-password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className={`${inputClass} pr-10`}
            placeholder={provider?.apiKeyConfigured ? "保留当前密钥，留空不修改" : "输入 API Key"}
            name={`${uid}_secret_value`}
            {...autofillGuardProps}
          />
          {/* P2：显示/隐藏明文切换。 */}
          <button
            type="button"
            aria-label={keyVisible ? "隐藏 API Key" : "显示 API Key"}
            title={keyVisible ? "隐藏 API Key" : "显示 API Key"}
            onClick={() => setKeyVisible((v) => !v)}
            className="absolute top-1/2 right-2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-text-faint transition-colors hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
          >
            {keyVisible ? <EyeOff size={14} strokeWidth={1.8} aria-hidden /> : <Eye size={14} strokeWidth={1.8} aria-hidden />}
          </button>
        </div>
        {provider?.apiKeyConfigured ? (
          <span className="text-xs text-accent-pass">● 已配置</span>
        ) : (
          <span className="text-xs text-text-faint">当前未检测到密钥</span>
        )}
      </label>

      {creating ? (
        <div className="mt-3 grid grid-cols-1 gap-3 min-[560px]:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-xs text-text-secondary">
            Provider ID
            <input
              value={routeId}
              name={`${uid}_provider_value`}
              onChange={(e) => setRouteId(e.target.value)}
              className={`${inputClass} ${routeId.length > 0 && !idValid ? "border-accent-fail" : ""}`}
              placeholder="acme-gateway"
              autoComplete={fieldAutoComplete}
              {...autofillGuardProps}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-text-secondary">
            显示名称
            <input
              value={name}
              name={`${uid}_display_value`}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
              placeholder={id || "可选"}
              autoComplete={fieldAutoComplete}
              {...autofillGuardProps}
            />
          </label>
        </div>
      ) : null}

      {creating && routeId.length > 0 && !idValid ? (
        <p className="mt-2 text-xs text-accent-fail">Provider ID 必须以小写字母开头，只含小写字母、数字和连字符</p>
      ) : null}

      <details className="mt-3 rounded-lg border border-border-line bg-bg-panel" open={creating}>
        <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-text-secondary">
          自定义设置
        </summary>
        <div className="flex flex-col gap-3 px-3 pb-3 pt-1">
          <label className="flex flex-col gap-1.5 text-xs text-text-secondary">
            协议
            <select
              value={protocol}
              name={`${uid}_protocol`}
              onChange={(e) => setProtocol(e.target.value === "anthropic" ? "anthropic" : "openai")}
              className={inputClass}
            >
              <option value="openai">OpenAI 兼容（{"{base}"}/chat/completions）</option>
              <option value="anthropic">Anthropic 兼容（{"{base}"}/v1/messages）</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-text-secondary">
            Base URL（必填）
            <input
              value={baseUrl}
              name={`${uid}_endpoint_value`}
              onChange={(e) => setBaseUrl(e.target.value)}
              className={inputClass}
              placeholder={entry?.baseUrl ?? "https://your-gateway.example/v1"}
              autoComplete={fieldAutoComplete}
              {...autofillGuardProps}
            />
            {baseUrl.trim().length === 0 ? (
              <span className="text-[11px] text-accent-warn">必填：模型端点的 OpenAI 兼容 Base URL</span>
            ) : null}
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5 text-xs text-text-secondary">
              {protocol === 'anthropic' ? '温度（使用供应商默认值）' : '温度（temperature）'}
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={Number.isFinite(temperature) ? temperature : 0.3}
                disabled={protocol === 'anthropic'}
                onChange={(e) => setTemperature(Number(e.target.value))}
                className={inputClass}
                name={`${uid}_temperature_value`}
                autoComplete={fieldAutoComplete}
                {...autofillGuardProps}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-xs text-text-secondary">
              最大并发（maxConcurrency）
              <input
                type="number"
                min={1}
                max={16}
                step={1}
                value={Number.isFinite(maxConcurrency) ? maxConcurrency : 8}
                onChange={(e) => setMaxConcurrency(Number(e.target.value))}
                className={inputClass}
                name={`${uid}_concurrency_value`}
                autoComplete={fieldAutoComplete}
                {...autofillGuardProps}
              />
            </label>
          </div>

          <label className="flex flex-col gap-1.5 text-xs text-text-secondary">
            默认模型（新对话与课程构建使用，可留空先保存）
            {modelOptions.length > 0 ? (
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className={selectClass}
                aria-label="默认模型"
              >
                <option value="" disabled>请选择默认模型</option>
                {modelOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            ) : (
              <input
                value={model}
                name={`${uid}_model_value`}
                onChange={(e) => setModel(e.target.value)}
                className={inputClass}
                placeholder="例如 deepseek-reasoner"
                autoComplete={fieldAutoComplete}
                {...autofillGuardProps}
              />
            )}
            {model.trim().length === 0 ? (
              <span className="text-[11px] text-accent-warn">未选择默认模型：会话内仍可临时切换，但课程构建（/build）不可用</span>
            ) : null}
            {model === "deepseek-chat" || model === "deepseek-reasoner" ? (
              <span className="text-[11px] text-accent-warn">该模型已废弃，请重新选择或从端点获取。</span>
            ) : null}
          </label>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-text-secondary">模型列表</span>
              <div className="flex items-center gap-1.5">
                {entry && (entry.models?.length ?? 0) > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      const preset = entry.models ?? [];
                      if (!restoreArmed) {
                        armRestore();
                        return;
                      }
                      disarmRestore();
                      setRows(draftsFrom(preset));
                      useAppStore.getState().flashStatusBanner(`已恢复内置列表（${preset.length} 个模型）`);
                    }}
                    aria-label={restoreArmed ? "确认恢复内置列表" : "恢复内置列表"}
                    title={restoreArmed
                      ? `再次点击确认：放弃当前修改，恢复该供应商目录预置的 ${entry.models?.length ?? 0} 个模型`
                      : "放弃当前覆盖，恢复该供应商目录预置的模型列表"}
                    className={`rounded-lg border px-2 py-1 text-xs transition-colors ${
                      restoreArmed
                        ? "border-accent-fail bg-accent-fail/10 text-accent-fail"
                        : "border-border-line text-text-muted hover:bg-bg-card"
                    }`}
                  >
                    {restoreArmed ? "确认恢复？" : "↺ 恢复内置列表"}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void discover()}
                  disabled={discovering || busy || baseUrl.trim().length === 0}
                  title={baseUrl.trim().length === 0 ? "先填写 Base URL" : undefined}
                  className="rounded-lg border border-border-line px-2 py-1 text-xs text-text-muted hover:bg-bg-card disabled:opacity-40"
                >
                  {discovering ? "获取中..." : "⟳ 从端点获取"}
                </button>
                <button
                  type="button"
                  onClick={() => setRows((current) => [...current, { rowKey: nextRowKey(), id: "", name: "", contextText: "", maxText: "" }])}
                  className="rounded-lg border border-border-line px-2 py-1 text-xs text-text-muted hover:bg-bg-card"
                >
                  ＋ 手动添加
                </button>
              </div>
            </div>
            {discoverError ? (
              <p className="mb-2 text-xs text-accent-warn" role="alert">
                获取失败：{discoverError}。仍可手动填写下面的列表。
              </p>
            ) : null}
            {rows.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border-line px-3 py-3 text-xs text-text-faint">
                还没有模型；可从端点获取或手动添加。
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {parsedRows.map(({ row, id: rowId, context, max, rowKey }, index) => (
                  <div key={rowKey} className="rounded-lg border border-border-line bg-bg-root p-2">
                    <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
                      <input
                        value={row.id}
                        onChange={(e) => updateRow(index, { id: e.target.value })}
                        className={`${inputClass} ${rowId.length === 0 ? "border-accent-warn" : ""}`}
                        placeholder="模型 ID"
                        autoComplete={fieldAutoComplete}
                        name={`${uid}_catalog_value_${index}`}
                        {...autofillGuardProps}
                        aria-label={`模型 ID ${index + 1}`}
                      />
                      <input
                        value={row.name}
                        onChange={(e) => updateRow(index, { name: e.target.value })}
                        className={inputClass}
                        placeholder="显示名称（可选）"
                        autoComplete={fieldAutoComplete}
                        name={`${uid}_catalog_label_${index}`}
                        {...autofillGuardProps}
                        aria-label={`模型名称 ${index + 1}`}
                      />
                    </div>
                    <details className="mt-1">
                      <summary className="cursor-pointer select-none text-[11px] text-text-faint">
                        容量（可选）
                        {context === "invalid" || max === "invalid" ? (
                          <span className="ml-1 text-accent-fail">· 格式无效</span>
                        ) : null}
                      </summary>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <input
                          value={row.contextText}
                          onChange={(e) => updateRow(index, { contextText: e.target.value })}
                          className={inputClass}
                          placeholder="上下文窗口，如 128K"
                          autoComplete={fieldAutoComplete}
                          name={`${uid}_context_value_${index}`}
                          {...autofillGuardProps}
                          aria-label={`上下文窗口 ${index + 1}`}
                        />
                        <input
                          value={row.maxText}
                          onChange={(e) => updateRow(index, { maxText: e.target.value })}
                          className={inputClass}
                          placeholder="最大输出，如 8K"
                          autoComplete={fieldAutoComplete}
                          name={`${uid}_output_value_${index}`}
                          {...autofillGuardProps}
                          aria-label={`最大输出 ${index + 1}`}
                        />
                      </div>
                      {context === "invalid" || max === "invalid" ? (
                        <p className="mt-1 text-[11px] text-accent-fail">
                          第 {index + 1} 行容量格式无效；支持 200K / 1M 或纯数字。
                        </p>
                      ) : null}
                    </details>
                    <button
                      type="button"
                      className="mt-1 text-xs text-text-faint hover:text-accent-fail"
                      onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </details>

      {error ? <p className="mt-3 text-xs text-accent-fail" role="alert">{error}</p> : null}

      <div className="mt-4 flex items-center justify-end gap-2">
        {/* 需求七：保存前可先测一次（用表单当前值，未保存也能测）。 */}
        <div className="mr-auto flex min-w-0 flex-col">
          <button
            type="button"
            onClick={() => void testNow()}
            disabled={busy || testBusy || baseUrl.trim() === ""}
            className="w-max rounded-xl border border-border-line px-3 py-1.5 text-xs text-text-muted hover:bg-bg-panel disabled:opacity-40"
          >
            {testBusy ? "测试中…" : "测试连接"}
          </button>
          {testResult ? <p role="status" className={`mt-1 text-xs ${testResult.ok ? "text-accent-pass" : "text-accent-fail"}`}>{testResult.message}</p> : null}
        </div>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-xl border border-border-line px-3 py-1.5 text-xs text-text-muted hover:bg-bg-panel disabled:opacity-40"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !canSave}
          className="rounded-xl bg-accent-focus px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-focus-hover disabled:opacity-40"
        >
          {busy ? "保存中..." : "保存"}
        </button>
      </div>

      {candidates ? (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30 p-4"
          role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setCandidates(null); }}
        >
          <div
            ref={candidatesDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="选择要添加的模型"
            className="flex max-h-[70vh] w-[440px] flex-col rounded-xl border border-border-line bg-bg-panel p-4 shadow-lv3"
          >
            <h4 className="text-sm font-medium text-text-primary">选择要添加的模型</h4>
            <p className="mt-1 text-xs text-text-faint">已在列表中的模型默认未勾选，采纳不会覆盖已调优的容量。</p>
            <div className="mt-2 flex gap-2 text-xs">
              <button type="button" className="rounded-lg border border-border-line px-2 py-1 text-text-muted hover:bg-bg-card" onClick={() => setChecked(new Set(candidates.map((m) => m.id)))}>全选</button>
              <button type="button" className="rounded-lg border border-border-line px-2 py-1 text-text-muted hover:bg-bg-card" onClick={() => setChecked(new Set())}>全不选</button>
            </div>
            <ul className="m-0 mt-3 flex min-h-0 flex-1 list-none flex-col gap-1 overflow-y-auto p-0">
              {candidates.map((m) => (
                <li key={m.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-bg-card">
                    <input
                      type="checkbox"
                      checked={checked.has(m.id)}
                      onChange={(e) => {
                        setChecked((current) => {
                          const next = new Set(current);
                          if (e.target.checked) next.add(m.id);
                          else next.delete(m.id);
                          return next;
                        });
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">{m.id}</span>
                    {m.contextWindow !== null || m.maxTokens !== null ? (
                      <span className="shrink-0 text-[11px] text-text-faint">
                        {m.contextWindow !== null ? formatCapacity(m.contextWindow) : "?"}
                        {" / "}
                        {m.maxTokens !== null ? formatCapacity(m.maxTokens) : "?"}
                      </span>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setCandidates(null)} className="rounded-lg border border-border-line px-3 py-1.5 text-xs text-text-muted hover:bg-bg-card">取消</button>
              <button
                type="button"
                onClick={adoptCandidates}
                disabled={checked.size === 0}
                className="rounded-lg bg-accent-focus px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-focus-hover disabled:opacity-40"
              >
                采纳所选（{checked.size}）
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </form>
  );
}

export default function ModelsSection({ initial }: ModelsSectionProps) {
  const flashStatusBanner = useAppStore((s) => s.flashStatusBanner);
  const [payload, setPayload] = useState<SettingsPayload | null>(initial);
  // DocMind 文档解析（上传资料的解析引擎）：密钥与端点走 settings.docmind.*，
  // 读回只有 configured/endpoint，密钥从不回填到页面。
  const [docmind, setDocmind] = useState<DocMindSettings | null>(null);
  const [docmindKeyId, setDocmindKeyId] = useState("");
  const [docmindKeySecret, setDocmindKeySecret] = useState("");
  const [docmindEndpoint, setDocmindEndpoint] = useState("");
  const [docmindBusy, setDocmindBusy] = useState(false);
  const [docmindError, setDocmindError] = useState<string | null>(null);
  const [docmindSaved, setDocmindSaved] = useState(false);
  useEffect(() => {
    let alive = true;
    // DocMind 探测失败不影响模型配置面板本身（未配置时上传走本地回退）。
    void Promise.resolve().then(() => api.docmindSettings()).then(
      (result) => { if (alive) setDocmind(result); },
      () => { if (alive) setDocmind({ configured: false, endpoint: "docmind-api.cn-hangzhou.aliyuncs.com" }); },
    );
    return () => { alive = false };
  }, []);
  /** partial 语义：输入框留空＝不改该项；端点留空且原本未设置时不提交。 */
  const handleDocMindSave = async () => {
    const id = docmindKeyId.trim(), secret = docmindKeySecret.trim(), endpoint = docmindEndpoint.trim();
    if (id === "" && secret === "" && endpoint === "") { setDocmindError("请至少填写一项后再保存。"); return; }
    setDocmindBusy(true); setDocmindError(null); setDocmindSaved(false);
    try {
      const result = await api.saveDocMind({
        ...(id !== "" ? { accessKeyId: id } : {}),
        ...(secret !== "" ? { accessKeySecret: secret } : {}),
        ...(endpoint !== "" ? { endpoint } : {}),
      });
      // 宿主 save 响应统一为 {configured, endpoint}（回读真实解析结果）。
      const next = (result as unknown as DocMindSettings);
      setDocmind({ configured: Boolean(next.configured), endpoint: typeof next.endpoint === "string" ? next.endpoint : "docmind-api.cn-hangzhou.aliyuncs.com" });
      setDocmindKeyId(""); setDocmindKeySecret(""); setDocmindEndpoint("");
      setDocmindSaved(true);
      flashStatusBanner(next.configured ? "DocMind 设置已保存" : "已保存，但仍缺少 AccessKey ID 或 Secret");
    } catch (cause) {
      setDocmindError(`DocMind 保存失败：${errorMessage(cause)}`);
    } finally {
      setDocmindBusy(false);
    }
  };
  // 云端 OpenMAIC 连接（虚拟课堂 / 幻灯片共用）：地址与访问口令走 settings.cloud.*，
  // 口令加密保存、接口不回显；这里只保留「是否已配置」与地址。
  const [cloud, setCloud] = useState<CloudSettings | null>(null);
  const [cloudBaseUrl, setCloudBaseUrl] = useState("");
  const [cloudAccessCode, setCloudAccessCode] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudSaved, setCloudSaved] = useState(false);
  const [cloudProbe, setCloudProbe] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // 云端连接探测失败不影响模型配置面板本身。
    void Promise.resolve().then(() => api.cloudSettings()).then(
      (result) => { if (alive) setCloud(result); },
      () => { if (alive) setCloud({ configured: false, baseUrl: "", hasAccessCode: false, provider: "", preset: "", model: "", hasModelKey: false }); },
    );
    return () => { alive = false };
  }, []);
  /** partial 语义：输入框留空＝不改该项；「清除连接」走显式空串。 */
  const handleCloudSave = async (clear = false) => {
    const baseUrl = cloudBaseUrl.trim(), accessCode = cloudAccessCode.trim();
    if (!clear && baseUrl === "" && accessCode === "") { setCloudError("请至少填写服务地址或访问口令后再保存。"); return; }
    setCloudBusy(true); setCloudError(null); setCloudSaved(false); setCloudProbe(null);
    try {
      const next = await api.saveCloud(clear ? { baseUrl: "", accessCode: "" } : {
        ...(baseUrl !== "" ? { baseUrl } : {}),
        ...(accessCode !== "" ? { accessCode } : {}),
      });
      setCloud(next);
      setCloudBaseUrl(""); setCloudAccessCode("");
      setCloudSaved(true);
      flashStatusBanner(clear ? "已清除云端课堂连接" : next.configured ? "云端课堂连接已保存" : "已保存，但仍缺少服务地址或访问口令");
    } catch (cause) {
      setCloudError(`云端连接保存失败：${errorMessage(cause)}`);
    } finally {
      setCloudBusy(false);
    }
  };
  /** 能力探测：设置页也要能在生成前看到「云端支持什么」。 */
  const handleCloudProbe = async () => {
    setCloudBusy(true); setCloudError(null); setCloudProbe(null);
    try {
      const result = await api.classroomCapabilities();
      if (!result.configured) { setCloudProbe("云端连接尚未配置完整（需要服务地址与访问口令）。"); return; }
      const on = Object.entries(result.capabilities).filter(([, value]) => value === true).map(([key]) => key);
      setCloudProbe(`已连接 ${result.baseUrl}：资料最多 ${result.materials.maxCount} 份、单份 ≤ ${Math.round(result.materials.maxDocumentBytes / 1024 / 1024)} MB；${on.length > 0 ? `云端额外能力 ${on.join(" / ")}` : "云端未开放联网检索 / 图片 / 视频 / 语音能力"}`);
    } catch (cause) {
      setCloudError(`连接检测失败：${errorMessage(cause)}`);
    } finally {
      setCloudBusy(false);
    }
  };
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addEntryId, setAddEntryId] = useState("");
  // 供应商管理子界面：进入后只展示已配置供应商的管理列表。自定义 OpenAI 兼容
  // 的能力不丢——目录里本来就有「OpenAI 兼容」条目，从「添加供应商」选它即可。
  const [manageOpen, setManageOpen] = useState(false);
  const [dismissedSetup, setDismissedSetup] = useState<ReadonlySet<string>>(new Set());
  const [deleteId, setDeleteId] = useState<string | null>(null);
  // X5：创建时撞到已存在 id 的覆盖确认（409 provider-exists）。
  const [conflict, setConflict] = useState<{ profile: EditorProfile; apiKey: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [settingsRetry, setSettingsRetry] = useState(0);
  // X4：添加卡按目录条目缓存整卡草稿（切换条目不丢输入）。
  const addDraftsRef = useRef(new Map<string, AddCardDraft>());
  // 返航键要把设置弹窗右侧内容区滚回顶部；该容器是本组件的父节点。
  const sectionRef = useRef<HTMLElement | null>(null);
  // P2：空目录的添加卡被用户手动收起后，不因 SettingsDialog 的 loaded 刷新
  // （如去通用页签保存）而反复重开。
  const [dismissedEmptyAdd, setDismissedEmptyAdd] = useState(false);
  // W-10：删除/覆盖确认框的焦点圈闭（Escape 尊重 busy）。
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  const conflictDialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap({ containerRef: deleteDialogRef, onEscape: () => { if (!busy) setDeleteId(null); } });
  useFocusTrap({ containerRef: conflictDialogRef, onEscape: () => { if (!busy) setConflict(null); } });

  // SettingsDialog loads its payload asynchronously. Keep the section in
  // sync when it becomes available after the models tab has mounted, while
  // preserving any in-progress editor state in the card itself.
  useEffect(() => {
    if (initial !== null) {
      setPayload(initial);
      // An empty provider directory needs an editor to get started. A
      // provider that exists but lacks a key uses the dsh setup-row posture
      // and must not open a second add card beside it.
      if (initial.providers.length === 0 && !dismissedEmptyAdd) setAdding(true);
    }
  }, [initial, dismissedEmptyAdd]);

  // Syllora 直接以 `initial={null}` 挂载本组件（它不经过 SettingsDialog），
  // 旧实现此时 payload 永远是 null——供应商管理界面因此恒为空。没有调用方
  // 喂 payload 时自己拉一次。
  useEffect(() => {
    if (initial !== null) return;
    let alive = true;
    void api.settings().then(
      (loaded) => { if (alive) { setPayload(loaded); setError(null); if (loaded.providers.length === 0) setAdding(true); } },
      (failure) => { if (alive) setError(`读取模型设置失败：${errorMessage(failure)}`); },
    );
    return () => { alive = false };
  }, [initial, settingsRetry]);

  useEffect(() => {
    let alive = true;
    // 目录加载失败不阻塞页面：手填与编辑既有 provider 的路径完全可用，
    // 但必须显式提示——否则「＋ 添加供应商」会被静默禁用成死按钮。
    setCatalogFailed(false);
    void api.providerCatalog().then(
      (result) => { if (alive) setCatalog(result.catalog); },
      () => { if (alive) { setCatalog([]); setCatalogFailed(true); } },
    );
    return () => { alive = false; };
  }, [catalogRetry]);

  const [testState, setTestState] = useState<Record<string, { busy: boolean; result: ConnectionTestResult | null }>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [transferNotice, setTransferNotice] = useState<string | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  // 需求七：展示顺序由 providerOrder 决定（服务端持久化；缺项按写入顺序补齐）。
  const providers = useMemo(() => {
    const list = payload?.providers ?? [];
    const order = payload?.providerOrder ?? [];
    if (order.length === 0) return list;
    const index = new Map(order.map((id, position) => [id, position]));
    return [...list].sort((a, b) => (index.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (index.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }, [payload]);
  const activeId = payload?.activeProviderId ?? "";
  const anyUsable = providers.some((p) => p.apiKeyConfigured);

  const addableCatalog = useMemo(() => {
    if (!catalog) return [];
    // 「OpenAI 兼容」也留在列表里：它是用户点名要预选的五项之一，靠 catalog
    // 条目（带默认协议）比只能手填的声明卡更好用。已配置过的 id 仍要剔除。
    return catalog.filter((entry) => entry.id === 'custom' || entry.id === 'anthropic' || !providers.some((p) => p.id === entry.id));
  }, [catalog, providers]);

  useEffect(() => {
    if ((adding || !anyUsable) && !addEntryId && addableCatalog.length > 0) {
      setAddEntryId(addableCatalog[0].id);
    }
  }, [adding, anyUsable, addEntryId, addableCatalog]);

  // 首次运行姿态：没有任何可用 provider 时，第一张缺 Key 的行自动展开 setup 卡。
  const setupId = anyUsable
    ? null
    : providers.find((p) => !p.apiKeyConfigured && !dismissedSetup.has(p.id))?.id ?? null;

  function dismissSetup(id: string) {
    setDismissedSetup((current) => new Set([...current, id]));
  }

  /** 收起所有打开的卡片。**不**退出供应商管理子界面——保存后用户应留在
   *  管理列表里看到结果；退出子界面是「← 返回」的职责。 */
  function closeAllCards() {
    setEditingId(null);
    setAdding(false);
  }

  /**
   * 返航键：无论当前在编辑某家供应商、在新增、还是在供应商管理子界面，
   * 一下回到模型配置的起始状态。滚动容器是设置弹窗的右侧内容区。
   */
  function backToHome() {
    closeAllCards();
    setManageOpen(false);
    setError(null);
    // jsdom 不实现 Element.scrollTo：能力探测，测试环境里静默跳过滚动。
    const scroller = (sectionRef.current?.closest(".sy-settings-body")
      ?? sectionRef.current?.parentElement) as HTMLElement | null;
    if (typeof scroller?.scrollTo === "function") scroller.scrollTo({ top: 0 });
  }

  /** 打开某行的编辑器；一次只开一张卡，打开前先收起其他卡。 */
  function openEditOnly(id: string) {
    setAdding(false);
    setEditingId(id);
  }

  async function handleSave(profile: EditorProfile, apiKey: string) {
    const wasActive = payload?.activeProviderId ?? "";
    const saved = await api.saveProvider(profile);
    const label = profile.name || profile.id;
    let finalPayload = saved;
    if (apiKey) {
      try {
        finalPayload = await api.setProviderCredential(profile.id, apiKey);
      } catch (cause) {
        // P1-4：配置已落盘但 Key 保存失败——旧实现不刷新 payload（行不显示、
        // 状态不一致）且把异常抛回卡片，用户重试必撞 409 覆盖确认、文案还对不上。
        // 现在：payload 照刷新（行立即可见）、卡片正常收起、横幅指明补救路径
        // （编辑该行补填 Key，编辑态带 overwrite 不会再撞 409）。
        setPayload(saved);
        setDismissedSetup((current) => new Set([...current, profile.id]));
        closeAllCards();
        flashStatusBanner(`⚠ ${label} 的配置已保存，但 API Key 保存失败：${errorMessage(cause)}。请点击该行「编辑」补填 Key 后再保存。`);
        return;
      }
    }
    setPayload(finalPayload);
    // 保存后不再对该行重开 setup 姿态（即使仍未贴 Key）。
    setDismissedSetup((current) => new Set([...current, profile.id]));
    closeAllCards();
    flashStatusBanner(
      finalPayload.activeProviderId === profile.id && wasActive !== profile.id
        ? `已保存并激活 ${label}（新对话与课程构建将使用它）`
        : `模型配置已保存（${label}）`,
    );
  }

  /** X5：保存时若目标 id 已存在且未带 overwrite，后端返回 409；弹确认框。 */
  async function handleSaveWithConflict(profile: EditorProfile, apiKey: string) {
    try {
      await handleSave(profile, apiKey);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "provider-exists") {
        setConflict({ profile, apiKey });
        return;
      }
      throw cause;
    }
  }

  /** 用户在确认框点「覆盖」：带 overwrite 重发。
   *  N-1：委托 handleSave（而非自链两步保存）——自链版本在 setProviderCredential
   *  失败时不刷新 payload、错误闷在确认框里，正是 P1-4 的同类问题；委托后
   *  credential 失败走统一的「配置已保存 + 补救横幅」路径，确认框正常关闭。 */
  async function handleOverwrite() {
    if (!conflict) return;
    setBusy(true);
    setError(null);
    try {
      const { profile, apiKey } = conflict;
      await handleSave({ ...profile, overwrite: true }, apiKey);
      setConflict(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await api.deleteProvider(id);
      setPayload(next);
      setDeleteId(null);
      flashStatusBanner(`已删除 ${id}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  /** 需求七：落位后持久化顺序（乐观更新，失败回落到服务端事实）。 */
  async function handleReorder(ids: string[]) {
    if (!payload) return;
    const index = new Map(ids.map((id, position) => [id, position]));
    setPayload({ ...payload, providers: [...payload.providers].sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0)), providerOrder: ids });
    try {
      setPayload(await api.reorderProviders(ids));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function moveProvider(id: string, direction: 'up' | 'down') {
    const ids = providers.map((provider) => provider.id);
    const from = ids.indexOf(id);
    const to = direction === 'up' ? from - 1 : from + 1;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]!);
    void handleReorder(ids);
  }

  /** 需求七：连接测试——最小请求（列模型）并按错误分类给可操作提示。 */
  async function handleTest(provider: ProviderPayload) {
    setTestState((current) => ({ ...current, [provider.id]: { busy: true, result: null } }));
    try {
      const result = await api.testConnection({
        baseUrl: provider.baseUrl ?? '',
        protocol: provider.protocol,
        providerId: provider.id,
        ...(provider.model ? { model: provider.model } : {}),
      });
      setTestState((current) => ({ ...current, [provider.id]: { busy: false, result } }));
    } catch (cause) {
      setTestState((current) => ({ ...current, [provider.id]: { busy: false, result: { ok: false, kind: 'network', message: errorMessage(cause), modelIds: [] } } }));
    }
  }

  /** 需求七：导出结构（不含明文密钥）。 */
  async function handleExport() {
    setTransferBusy(true);
    setTransferNotice(null);
    try {
      const exported = await api.exportProviders();
      // 兜底断言：导出体里绝不能出现密钥字段（域层已保证，这里再拒一次）。
      const text = JSON.stringify(exported, null, 2);
      if (/"(apiKey|api_key|api_key_env|secret|token)"\s*:/.test(text)) throw new Error('导出内容包含疑似密钥字段，已中止');
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `syllora-providers-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setTransferNotice(`已导出 ${exported.providers.length} 个供应商结构（不含明文密钥）`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setTransferBusy(false);
    }
  }

  /** 需求七：导入结构；密钥不导入，需逐项补 Key。 */
  async function handleImportFile(file: File) {
    setTransferBusy(true);
    setTransferNotice(null);
    try {
      // 兼容两种读取路径：现代浏览器的 Blob.text() 与 jsdom 等仅实现
      // FileReader 的环境（测试环境）。
      const text = typeof file.text === 'function'
        ? await file.text()
        : await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? ''));
            reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
            reader.readAsText(file);
          });
      const parsed = JSON.parse(text) as unknown;
      const result = await api.importProviders(parsed);
      setPayload(result.saved);
      setTransferNotice(`已导入 ${result.imported.length} 个供应商${result.skipped.length > 0 ? `；跳过已存在的 ${result.skipped.join('、')}` : ''}。密钥不含在文件里，请为每个供应商补填 API Key 后测试连接。`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setTransferBusy(false);
    }
  }

  async function handleActivate(id: string) {
    try {
      const next = await api.activateProvider(id);
      setPayload(next);
      flashStatusBanner(`已切换为 ${id}`);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  const selectedEntry = addableCatalog.find((entry) => entry.id === addEntryId) ?? null;

  return (
    <section ref={sectionRef} className="models-section flex max-w-[720px] flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-medium text-text-primary">
            {manageOpen ? "供应商管理" : "模型配置"}
          </h3>
          {manageOpen && (
            <p className="mt-1 text-sm leading-6 text-text-faint">
              已配置的模型 API 都在这里：可激活、编辑或删除；激活后新对话与课程构建将使用它。
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={backToHome}
          title="收起当前操作，回到模型配置起始状态"
          className="flex shrink-0 items-center gap-1 rounded-lg border border-border-line px-2.5 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-card"
        >
          ← 返回
        </button>
      </div>

      {error ? (
        <div className="rounded-xl border border-accent-fail/30 bg-accent-fail/5 p-3 text-xs text-accent-fail" role="alert">
          {error}
          {payload === null && <button type="button" onClick={() => setSettingsRetry(n => n + 1)}>重新读取设置</button>}
        </div>
      ) : null}

      {/* 供应商管理子界面：只看已配置的 API。 */}
      {manageOpen ? (
        providers.length === 0 ? (
          <p className="text-xs text-text-faint">
            还没有已配置的供应商。先回到「模型配置」添加一个。
          </p>
        ) : (
          <>
          {/* 需求七：导入/导出（导出不含明文密钥；导入需逐项补 Key）。 */}
          <div className="mb-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={transferBusy || providers.length === 0}
              className="button small"
            >
              导出配置
            </button>
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              disabled={transferBusy}
              className="button small"
            >
              导入配置
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              aria-label="导入供应商配置文件"
              className="hidden"
              onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void handleImportFile(file); }}
            />
          </div>
          {transferNotice ? <p role="status" className="mb-3 text-xs text-text-muted">{transferNotice}</p> : null}
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {providers.map((provider) => {
          const setupPosture = setupId === provider.id;
          const editing = editingId === provider.id;
          return (
            <li
              key={provider.id}
              className={`rounded-xl border border-border-line bg-bg-panel p-3 ${draggingId === provider.id ? "opacity-50" : ""}`}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
              onDrop={(e) => {
                e.preventDefault();
                const source = e.dataTransfer.getData("text/plain") || draggingId;
                setDraggingId(null);
                if (!source || source === provider.id) return;
                const ids = providers.map((item) => item.id);
                const from = ids.indexOf(source);
                const to = ids.indexOf(provider.id);
                if (from < 0 || to < 0) return;
                ids.splice(to, 0, ids.splice(from, 1)[0]!);
                void handleReorder(ids);
              }}
            >
              <div className="flex items-center gap-2.5">
                {/* 需求七：拖拽排序（与需求一左栏同一交互模式）。 */}
                <button
                  type="button"
                  draggable
                  aria-label={`拖动排序 ${provider.name || provider.id}`}
                  title="拖动排序"
                  onDragStart={(e) => { setDraggingId(provider.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", provider.id); }}
                  onDragEnd={() => setDraggingId(null)}
                  className="cursor-grab active:cursor-grabbing text-text-faint"
                >
                  ⋮⋮
                </button>
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${provider.apiKeyConfigured ? "bg-accent-pass" : "bg-accent-fail"}`}
                  title={provider.apiKeyConfigured ? "API Key 已配置" : "API Key 缺失"}
                />
                <span className="min-w-0 truncate text-sm font-medium text-text-primary">
                  {provider.name || provider.id}
                </span>
                <span className="rounded border border-border-line px-1.5 py-0.5 text-[11px] leading-4 text-text-muted">
                  {provider.id}
                </span>
                {provider.id === activeId ? (
                  <span
                    className="rounded bg-accent-focus/10 px-1.5 py-0.5 text-[11px] font-medium leading-4 text-accent-focus"
                    title="新对话与课程构建（/build）将使用该供应商"
                  >
                    使用中
                  </span>
                ) : null}
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void handleActivate(provider.id)}
                    disabled={provider.id === activeId}
                    title="激活后新对话与课程构建将使用该供应商"
                    className="rounded-full border border-border-line px-2.5 py-1 text-xs text-text-muted hover:bg-bg-card disabled:opacity-40"
                  >
                    激活
                  </button>
                  {/* 需求七：连接测试（最小请求 + 可操作错误提示）。 */}
                  <button
                    type="button"
                    aria-label={`测试连接 ${provider.name || provider.id}`}
                    onClick={() => void handleTest(provider)}
                    disabled={testState[provider.id]?.busy === true}
                    title="用当前配置发一次最小请求，验证地址、密钥与模型"
                    className="rounded-full border border-border-line px-2.5 py-1 text-xs text-text-muted hover:bg-bg-card disabled:opacity-40"
                  >
                    {testState[provider.id]?.busy === true ? "测试中…" : "测试"}
                  </button>
                  <div className="flex flex-col">
                    <button type="button" aria-label={`${provider.name || provider.id} 上移`} title="上移" onClick={() => moveProvider(provider.id, 'up')} className="px-1 text-text-faint hover:text-text-primary">↑</button>
                    <button type="button" aria-label={`${provider.name || provider.id} 下移`} title="下移" onClick={() => moveProvider(provider.id, 'down')} className="px-1 text-text-faint hover:text-text-primary">↓</button>
                  </div>
                  <button
                    type="button"
                    aria-expanded={editing || setupPosture}
                    onClick={() => {
                      if (editing) setEditingId(null);
                      else openEditOnly(provider.id);
                    }}
                    className="rounded-full border border-border-line px-2.5 py-1 text-xs text-text-muted hover:bg-bg-card"
                  >
                    {editing || setupPosture ? "收起" : "编辑"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteId(provider.id)}
                    className="rounded-full px-2.5 py-1 text-xs text-accent-fail hover:bg-accent-fail/10"
                  >
                    删除
                  </button>
                </div>
              </div>
              {testState[provider.id]?.result ? (
                <p
                  role="status"
                  className={`mt-2 text-xs ${testState[provider.id]!.result!.ok ? "text-accent-pass" : "text-accent-fail"}`}
                >
                  {testState[provider.id]!.result!.message}
                </p>
              ) : null}
              {editing || setupPosture ? (
                <div className="mt-3">
                  <ProviderEditorCard
                    provider={provider}
                    entry={null}
                    creating={false}
                    onSave={handleSaveWithConflict}
                    onCancel={() => {
                      setEditingId(null);
                      if (setupPosture) dismissSetup(provider.id);
                    }}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
          </ul>
          </>
        )
      ) : (
        <>
      {catalogFailed ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-accent-warn/30 bg-accent-warn/5 p-3 text-xs text-accent-warn" role="alert">
          <span>内置供应商目录加载失败，「＋ 添加供应商」暂不可用；仍可从目录选择「OpenAI 兼容」手填。</span>
          <button
            type="button"
            onClick={() => setCatalogRetry((n) => n + 1)}
            className="shrink-0 rounded-lg border border-accent-warn/40 px-2.5 py-1 text-accent-warn hover:bg-accent-warn/10"
          >
            重试
          </button>
        </div>
      ) : null}

      {adding ? (
        <div className="rounded-xl bg-bg-card p-4 shadow-lv2">
          <label className="mb-3 flex flex-col gap-1.5 text-xs text-text-secondary">
            选择供应商
            <select
              value={addEntryId}
              onChange={(e) => setAddEntryId(e.target.value)}
              className="h-9 w-full rounded-lg border border-border-line bg-bg-root px-3 text-[13px] text-text-primary outline-none focus:border-accent-focus"
            >
              {addableCatalog.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.name}</option>
              ))}
            </select>
            <span className="text-[11px] text-text-faint">地址已预填；模型请手动添加或从端点获取后选择。</span>
          </label>
          {selectedEntry ? (
            <ProviderEditorCard
              key={selectedEntry.id}
              provider={null}
              entry={selectedEntry}
              occupiedIds={providers.map(provider => provider.id)}
              creating
              onSave={handleSaveWithConflict}
              onCancel={() => {
                setAdding(false);
                // P2：空目录下手动收起添加卡后记住选择，不随 loaded 刷新重开。
                if (providers.length === 0) setDismissedEmptyAdd(true);
              }}
              draftCache={addDraftsRef.current}
            />
          ) : (
            <p className="text-xs text-text-faint">正在加载内置供应商目录...</p>
          )}
        </div>
      ) : (
        <div className="provider-entry-actions flex gap-2">
          <button
            type="button"
            disabled={addableCatalog.length === 0}
            onClick={() => { setEditingId(null); setAdding(true); }}
            className="flex-1 rounded-xl border border-border-line px-3 py-2 text-sm text-text-muted hover:bg-bg-card disabled:opacity-40"
          >
            {/* P2：目录加载期间说明按钮禁用原因（旧实现无提示地灰住）。 */}
            {catalog === null ? "加载目录中…" : "＋ 添加供应商"}
          </button>
          <button
            type="button"
            onClick={() => { setAdding(false); setManageOpen(true); }}
            className="flex-1 rounded-xl border border-border-line px-3 py-2 text-sm text-text-muted hover:bg-bg-card"
          >
            供应商管理{providers.length > 0 ? `（${providers.length}）` : ""}
          </button>
        </div>
      )}
        </>
      )}

      {deleteId ? (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30 p-4"
          role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setDeleteId(null); }}
        >
          <div
            ref={deleteDialogRef}
            role="dialog"
            aria-modal="true"
            className="w-[380px] rounded-xl border border-border-line bg-bg-panel p-4 shadow-lv3"
          >
            <h4 className="text-sm font-medium text-text-primary">确认删除 Provider</h4>
            <p className="mt-2 text-sm text-text-muted">确定要删除 {deleteId} 吗？该操作同时会移除已保存的 API Key。</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" disabled={busy} onClick={() => setDeleteId(null)} className="rounded-lg border border-border-line px-3 py-1.5 text-xs text-text-muted hover:bg-bg-card disabled:opacity-40">取消</button>
              <button type="button" disabled={busy} onClick={() => void handleDelete(deleteId)} className="rounded-lg bg-accent-fail px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-fail/80 disabled:opacity-40">
                {busy ? "删除中..." : "删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {!manageOpen ? (
        <div className="docmind-card mt-4 rounded-xl border border-border-line bg-bg-card p-3">
          <div className="flex items-center gap-2.5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${docmind?.configured ? "bg-accent-pass" : "bg-accent-fail"}`} aria-hidden="true" />
            <span className="min-w-0 text-sm font-medium text-text-primary">DocMind 文档解析</span>
            <span className="rounded border border-border-line px-1.5 py-0.5 text-[11px] text-text-muted">{docmind === null ? "读取中" : docmind.configured ? "已配置" : "未配置"}</span>
            <div className="ml-auto">
              <button
                aria-label="保存 DocMind 设置"
                type="button"
                disabled={docmindBusy}
                onClick={() => void handleDocMindSave()}
                className="rounded-lg border border-border-line px-3 py-1.5 text-xs text-text-muted hover:bg-bg-card disabled:opacity-40"
              >
                {docmindBusy ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
          <p className="mt-1.5 text-xs text-text-faint">上传的资料统一由阿里云文档智能（DocMind）解析（PDF/Word/PPT/Excel/HTML/纯文本都会上传到云端解析；未配置时本地回退并在资料上标注）。留空的项保持原值不变；端点留空使用默认地址{docmind?.endpoint ? `（当前 ${docmind.endpoint}）` : ""}。密钥加密保存在本机，不会回显。</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <input
              aria-label="DocMind AccessKey ID"
              value={docmindKeyId}
              onChange={(e) => setDocmindKeyId(e.target.value)}
              placeholder={docmind?.configured ? "AccessKey ID（已保存，留空不改）" : "AccessKey ID"}
              autoComplete="off"
              spellCheck={false}
              className="h-9 rounded-lg border border-border-line bg-bg-root px-3 text-[13px] text-text-primary outline-none focus:border-accent-focus"
            />
            <input
              aria-label="DocMind AccessKey Secret"
              type="password"
              value={docmindKeySecret}
              onChange={(e) => setDocmindKeySecret(e.target.value)}
              placeholder={docmind?.configured ? "AccessKey Secret（已保存，留空不改）" : "AccessKey Secret"}
              autoComplete="new-password"
              className="h-9 rounded-lg border border-border-line bg-bg-root px-3 text-[13px] text-text-primary outline-none focus:border-accent-focus"
            />
            <input
              aria-label="DocMind 端点"
              value={docmindEndpoint}
              onChange={(e) => setDocmindEndpoint(e.target.value)}
              placeholder="端点（默认 docmind-api.cn-hangzhou.aliyuncs.com）"
              spellCheck={false}
              className="h-9 rounded-lg border border-border-line bg-bg-root px-3 text-[13px] text-text-primary outline-none focus:border-accent-focus sm:col-span-2"
            />
          </div>
          {docmindError && <p className="mt-1.5 text-xs text-accent-fail" role="alert">{docmindError}</p>}
          {docmindSaved && <p className="mt-1.5 text-xs text-accent-pass" role="status">已保存</p>}
        </div>
      ) : null}
      {!manageOpen ? (
        <div className="docmind-card mt-4 rounded-xl border border-border-line bg-bg-card p-3">
          <div className="flex items-center gap-2.5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${cloud?.configured ? "bg-accent-pass" : "bg-accent-fail"}`} aria-hidden="true" />
            <span className="min-w-0 text-sm font-medium text-text-primary">虚拟课堂（云端 OpenMAIC）</span>
            <span className="rounded border border-border-line px-1.5 py-0.5 text-[11px] text-text-muted">{cloud === null ? "读取中" : cloud.configured ? "已配置" : "未配置"}</span>
            <div className="ml-auto flex gap-2">
              <button
                aria-label="检测云端连接"
                type="button"
                disabled={cloudBusy}
                onClick={() => void handleCloudProbe()}
                className="rounded-lg border border-border-line px-3 py-1.5 text-xs text-text-muted hover:bg-bg-card disabled:opacity-40"
              >
                检测连接
              </button>
              <button
                aria-label="保存云端连接"
                type="button"
                disabled={cloudBusy}
                onClick={() => void handleCloudSave()}
                className="rounded-lg border border-border-line px-3 py-1.5 text-xs text-text-muted hover:bg-bg-card disabled:opacity-40"
              >
                {cloudBusy ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
          <p className="mt-1.5 text-xs text-text-faint">
            虚拟课堂与「幻灯片讲义」都在云端 OpenMAIC 生成，本地只负责播放与导出。
            <strong>开启即意味着所选资料会上传到下面配置的服务器</strong>；口令加密保存在本机、不会回显。
            留空的项保持原值不变{cloud?.baseUrl ? `（当前 ${cloud.baseUrl}）` : ""}。
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <input
              aria-label="云端服务地址"
              value={cloudBaseUrl}
              onChange={(e) => setCloudBaseUrl(e.target.value)}
              placeholder={cloud?.baseUrl ? "服务地址（已保存，留空不改）" : "服务地址，如 https://studyandchat.top"}
              spellCheck={false}
              className="h-9 rounded-lg border border-border-line bg-bg-root px-3 text-[13px] text-text-primary outline-none focus:border-accent-focus"
            />
            <input
              aria-label="云端访问口令"
              type="password"
              value={cloudAccessCode}
              onChange={(e) => setCloudAccessCode(e.target.value)}
              placeholder={cloud?.hasAccessCode ? "访问口令（已保存，留空不改）" : "站点访问口令"}
              autoComplete="new-password"
              spellCheck={false}
              className="h-9 rounded-lg border border-border-line bg-bg-root px-3 text-[13px] text-text-primary outline-none focus:border-accent-focus"
            />
          </div>
          {cloudProbe && <p className="mt-1.5 text-xs text-text-muted" role="status">{cloudProbe}</p>}
          {cloudError && <p className="mt-1.5 text-xs text-accent-fail" role="alert">{cloudError}</p>}
          {cloudSaved && <p className="mt-1.5 text-xs text-accent-pass" role="status">已保存</p>}
          {cloud?.configured ? (
            <button
              type="button"
              disabled={cloudBusy}
              onClick={() => void handleCloudSave(true)}
              className="mt-2 rounded-lg border border-border-line px-3 py-1.5 text-xs text-text-muted hover:bg-bg-card disabled:opacity-40"
            >
              清除云端连接
            </button>
          ) : null}
        </div>
      ) : null}
      {conflict ? (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30 p-4"
          role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setConflict(null); }}
        >
          <div
            ref={conflictDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Provider 已存在"
            className="w-[380px] rounded-xl border border-border-line bg-bg-panel p-4 shadow-lv3"
          >
            <h4 className="text-sm font-medium text-text-primary">Provider 已存在</h4>
            <p className="mt-2 text-sm text-text-muted">
              「{conflict.profile.id}」已存在。覆盖会保留其 API Key，但会用当前表单内容替换配置。确定覆盖吗？
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" disabled={busy} onClick={() => setConflict(null)} className="rounded-lg border border-border-line px-3 py-1.5 text-xs text-text-muted hover:bg-bg-card disabled:opacity-40">取消</button>
              <button type="button" disabled={busy} onClick={() => void handleOverwrite()} className="rounded-lg bg-accent-focus px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-focus-hover disabled:opacity-40">
                {busy ? "覆盖中..." : "覆盖"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface ModelsSectionProps {
  initial: SettingsPayload | null;
}
