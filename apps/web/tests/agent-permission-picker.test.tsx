import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { apiMocks } = vi.hoisted(() => ({
  apiMocks: { settings: vi.fn(), updateSettings: vi.fn() },
}));
vi.mock("../src/lib/api", () => ({ api: apiMocks, ApiError: class ApiError extends Error {} }));

import AgentPermissionPicker from "../src/components/chat/AgentPermissionPicker";

const payload = {
  version: 1,
  activeProviderId: "mimo",
  llm: { provider: "mimo", model: "mimo-v2.6-flash", apiKeyEnv: null, apiBase: null, temperature: 0.3, maxConcurrency: 3, apiKeyConfigured: true },
  providers: [],
  ui: { defaultMode: "quick" as const },
  agent: { preset: "syllora-learning", systemPrompt: "", maxPromptChars: 8000, presets: [] },
  permissions: {
    preset: "workspace-write",
    presets: [
      { id: "read-only", name: "只读", sandboxMode: "read-only" as const, approvalPolicy: "deny" as const, description: "读取和搜索自动执行，所有写入拒绝" },
      { id: "workspace-write", name: "工作区写入", sandboxMode: "workspace-write" as const, approvalPolicy: "ask" as const, description: "写入、命令和网络操作需要审批" },
      { id: "danger-full-access", name: "完全访问", sandboxMode: "danger-full-access" as const, approvalPolicy: "never" as const, description: "仅适用于受信任的隔离部署" },
    ],
  },
  plugins: { inventory: [] },
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("工具条里的 Agent 权限选择", () => {
  it("触发键显示当前档位，展开后列出三档（说明小字已按 UI 需求移除）", async () => {
    apiMocks.settings.mockResolvedValue(payload);
    render(<AgentPermissionPicker />);
    expect(await screen.findByRole("combobox", { name: "Agent 权限" })).toHaveTextContent("权限：工作区写入");
    fireEvent.click(screen.getByRole("combobox", { name: "Agent 权限" }));
    const list = await screen.findByRole("listbox", { name: "Agent 权限" });
    expect(list).toHaveTextContent("权限：只读");
    expect(list).toHaveTextContent("权限：完全访问");
    // 选项不再传 description：说明文字不应出现在下拉里。
    expect(list).not.toHaveTextContent("读取和搜索自动执行，所有写入拒绝");
  });

  it("选中即保存（settings.update permissionPreset）并回显新档位", async () => {
    apiMocks.settings.mockResolvedValue(payload);
    apiMocks.updateSettings.mockResolvedValue({ ...payload, permissions: { ...payload.permissions, preset: "read-only" } });
    const onSaved = vi.fn();
    render(<AgentPermissionPicker onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole("combobox", { name: "Agent 权限" }));
    fireEvent.click(await screen.findByRole("option", { name: /权限：只读/ }));
    await waitFor(() => expect(apiMocks.updateSettings).toHaveBeenCalledWith({ permissionPreset: "read-only" }));
    expect(await screen.findByRole("combobox", { name: "Agent 权限" })).toHaveTextContent("权限：只读");
    expect(onSaved).toHaveBeenCalledWith(expect.stringContaining("只读"));
  });
});
