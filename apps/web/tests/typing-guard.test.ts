import { describe, expect, it, vi } from "vitest";
import { installTypingGuard, isTextComposing } from "../src/lib/typingGuard";

describe("输入法组合期守卫（需求一）", () => {
  it("组合开始时返回 true，组合结束后经宽限期回到 false", () => {
    vi.useFakeTimers();
    const uninstall = installTypingGuard();
    expect(isTextComposing()).toBe(false);

    document.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    expect(isTextComposing()).toBe(true);

    document.dispatchEvent(new Event("compositionend", { bubbles: true }));
    // 宽限期内仍视为"正在输入"，避免提交刚落地就被轮询重渲染打断。
    expect(isTextComposing()).toBe(true);

    vi.advanceTimersByTime(300);
    expect(isTextComposing()).toBe(false);

    uninstall();
    vi.useRealTimers();
  });

  it("卸载后状态复位", () => {
    const uninstall = installTypingGuard();
    document.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    expect(isTextComposing()).toBe(true);
    uninstall();
    expect(isTextComposing()).toBe(false);
  });
});
