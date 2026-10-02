import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

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
