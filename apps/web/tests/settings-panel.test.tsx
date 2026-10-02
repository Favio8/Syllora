import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/src/components/settings/ModelsSection", () => ({ default: () => <div data-testid="models-section" /> }));

import SettingsPanel, { type SettingsTab } from "../src/features/workbench/components/SettingsPanel";

function setup(tab: SettingsTab, overrides: Partial<Parameters<typeof SettingsPanel>[0]> = {}) {
  const props = {
    tab, onTab: vi.fn(), onClose: vi.fn(), busy: false,
    preferences: { name: "学习者", theme: "light" as const, dailyMinutes: 40, revision: 0 }, onPreferencesSaved: async () => {},
    consent: false, onConsent: vi.fn(), calls: 3, onSaveConsent: vi.fn(),
    archived: [{ id: "c1", name: "线性代数", points: 4, materials: 2, attempts: 9 }], onRestore: vi.fn(), onDelete: vi.fn(),
    diagFiles: null, diagLoading: false, onExportDiag: vi.fn(), onReloadDiag: vi.fn(),
    ...overrides,
  };
  render(<SettingsPanel {...props} />);
  return props;
}

describe("SettingsPanel", () => {
  it("renders the dialog shell with section navigation and a close button", () => {
    const props = setup("models");
    expect(screen.getByRole("dialog", { name: "模型与设置" })).toBeInTheDocument();
    expect(screen.getByTestId("models-section")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "模型配置" })).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("button", { name: "诊断日志" }));
    expect(props.onTab).toHaveBeenCalledWith("diag");
    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    expect(props.onClose).toHaveBeenCalled();
  });

  it("keeps consent as a labelled switch with its own save action", () => {
    const props = setup("privacy");
    fireEvent.click(screen.getByRole("switch", { name: /允许向已配置模型发送以上内容/ }));
    expect(props.onConsent).toHaveBeenCalledWith(true);
    expect(screen.getByText("3 次")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存授权" }));
    expect(props.onSaveConsent).toHaveBeenCalled();
  });

  it("lists archived courses with restore and delete actions", () => {
    const props = setup("archive");
    expect(screen.getByText("4 个知识点 · 2 份资料 · 9 次作答")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    expect(props.onRestore).toHaveBeenCalledWith("c1");
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    expect(props.onDelete).toHaveBeenCalledWith(props.archived[0]);
  });
});
