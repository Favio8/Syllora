import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// 幻灯片渲染器（@openmaic/renderer）依赖 ResizeObserver 量测画布；jsdom 不实现它。
// 这里给所有 web 用例一个最小桩，避免只有挂载幻灯片视图的用例才失败。
if (!("ResizeObserver" in globalThis)) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}

afterEach(() => cleanup());

// jsdom 没实现 scrollIntoView / matchMedia：下拉列表（Dropdown）展开时会用到。
// matchMedia 一律返回 matches=false —— 同 jsdom 的真实行为（无媒体特性匹配），
// 也避免把 prefers-reduced-motion 误判成"减少动效"而让动画类用例失效。
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = () => undefined;
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
