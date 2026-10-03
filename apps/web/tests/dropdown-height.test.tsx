import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Dropdown from "../src/features/workbench/components/Dropdown";

/** 需求五：权限这类「标题 + 说明」的下拉项要能完整显示，不能再被固定行高截断。 */
afterEach(cleanup);

describe("Dropdown 高度按内容估算（需求五）", () => {
  it("带说明的选项按更高行高估算，列表高度足够放下全部档位", () => {
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    const options = [
      { value: "read-only", label: "权限：只读", description: "只能读取资料，不写入任何文件" },
      { value: "workspace-write", label: "权限：工作区写入", description: "可在课程工作区内创建与修改文件" },
      { value: "danger-full-access", label: "权限：完全访问", description: "可执行任意本机操作，请谨慎选择" },
    ];
    render(<Dropdown label="Agent 权限" value="read-only" options={options} onChange={() => undefined} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Agent 权限" }));

    const list = screen.getByRole("listbox", { name: "Agent 权限" });
    // 3 行 × 66px + 16px 内边距 = 214px（旧实现按 48px/行算只给 160px）
    expect(Number.parseInt((list as HTMLElement).style.maxHeight, 10)).toBeGreaterThanOrEqual(214);
    expect(list.querySelectorAll('[role="option"]')).toHaveLength(3);
  });

  it("无说明的短列表按 48px/行估算", () => {
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    render(<Dropdown label="阅读资料" value="a" options={[{ value: "a", label: "甲" }, { value: "b", label: "乙" }]} onChange={() => undefined} />);
    fireEvent.click(screen.getByRole("combobox", { name: "阅读资料" }));
    const list = screen.getByRole("listbox", { name: "阅读资料" });
    expect(Number.parseInt((list as HTMLElement).style.maxHeight, 10)).toBe(2 * 48 + 16);
  });
});
