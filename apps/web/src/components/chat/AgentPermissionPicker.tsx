"use client";

import { useEffect, useState } from "react";
import { api } from "@/src/lib/api";
import Dropdown from "@/src/features/workbench/components/Dropdown";

/**
 * 工具条里的 Agent 权限选择（「Agent 管理」右侧）：与 ZCode 一样，选中即生效——
 * 直接写 settings.update({permissionPreset})，不需要进弹窗再保存。
 * 三个档位来自宿主 settings payload（只读 / 工作区写入 / 完全访问）。
 */
export default function AgentPermissionPicker({ disabled = false, onSaved }: { disabled?: boolean; onSaved?: (message: string) => void }) {
  const [preset, setPreset] = useState("");
  const [presets, setPresets] = useState<Array<{ id: string; name: string; description: string }>>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    void api.settings()
      .then(data => { if (disposed) return; setPreset(data.permissions.preset); setPresets(data.permissions.presets) })
      .catch(() => undefined);
    return () => { disposed = true };
  }, []);
  async function choose(value: string) {
    if (busy || value === preset) return;
    setBusy(true);
    try {
      const next = await api.updateSettings({ permissionPreset: value });
      setPreset(next.permissions.preset);
      setPresets(next.permissions.presets);
      const name = next.permissions.presets.find(item => item.id === next.permissions.preset)?.name ?? value;
      onSaved?.(`Agent 权限已切换为「${name}」，新的回合生效。`);
    } catch (error) {
      onSaved?.(error instanceof Error ? `权限切换失败：${error.message}` : "权限切换失败");
    } finally { setBusy(false); }
  }
  return <Dropdown
    label="Agent 权限"
    className="composer-permission"
    value={preset}
    disabled={disabled || busy || presets.length === 0}
    options={presets.map(item => ({ value: item.id, label: `权限：${item.name}`, description: item.description }))}
    onChange={value => void choose(value)}
  />;
}
