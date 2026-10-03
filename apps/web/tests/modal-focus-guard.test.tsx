import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useModalFocus } from "../src/features/workbench/useModalFocus";

/** 需求一：自动聚焦/焦点还原不得从正在输入的元素上抢焦点——旧实现无条件
 *  previous.focus()，弹层关掉之后任何一次 DOM 变动都会把光标从输入框拽走。 */
describe("useModalFocus 不抢输入焦点", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("弹层关闭后不从输入框抢焦点", async () => {
    renderHook(() => useModalFocus());
    const outside = document.createElement("input");
    document.body.appendChild(outside);

    const dialog = document.createElement("section");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    await Promise.resolve();

    // 用户把焦点放进弹层外的输入框（弹层仍在 DOM 里）→ 弹层被移除
    outside.focus();
    outside.value = "打字中";
    dialog.remove();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(document.activeElement).toBe(outside);
    expect(outside.value).toBe("打字中");
  });

  it("也没有弹层时不会乱聚焦", async () => {
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
    renderHook(() => useModalFocus());
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const before = focusSpy.mock.calls.length;
    // 触发一次 DOM 变动（等价于轮询重渲染）
    const node = document.createElement("span");
    document.body.appendChild(node);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(input);
    expect(focusSpy.mock.calls.length).toBe(before);
    focusSpy.mockRestore();
  });
});
