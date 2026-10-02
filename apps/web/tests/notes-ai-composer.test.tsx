import { useEffect, useMemo } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { apiMocks } = vi.hoisted(() => ({
  apiMocks: {
    list: vi.fn(),
    read: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    suggest: vi.fn(),
    uploadImage: vi.fn(),
  },
}));

vi.mock("../src/lib/api", () => ({ api: { notes: apiMocks }, ApiError: class ApiError extends Error {} }));
// 图谱用 canvas 力导向库，jsdom 里没有意义：本用例只测笔记 AI 输入框。
vi.mock("../src/components/NotesGraph", () => ({ default: () => null }));
// 假编辑器：只需提供 NotesWorkspace 用到的那几个 Editor 表面（state/on/chain）。
vi.mock("../src/components/NotesEditor", () => ({
  default: ({ onChange, onEditor }: { onChange: (value: string) => void; onEditor: (editor: unknown) => void }) => {
    const editor = useMemo(() => {
      const doc = { content: { size: 12 }, textBetween: () => "矩阵的秩。" };
      const state = { doc, selection: { from: 0, to: 0, empty: true } };
      const chain = () => {
        const api: Record<string, unknown> = {};
        api.focus = () => api;
        api.insertContent = () => api;
        api.insertContentAt = () => api;
        api.run = () => true;
        return api;
      };
      return { state, on: () => undefined, off: () => undefined, chain };
    }, []);
    useEffect(() => { onEditor(editor); }, [editor, onEditor]);
    return <textarea aria-label="正文（测试替身）" onChange={(event) => onChange(event.target.value)} />;
  },
}));

import NotesWorkspace from "../src/components/NotesWorkspace";

const noteMeta = { id: "n1", title: "线性代数复习", wikilinks: [], images: [], createdAt: 1, updatedAt: 2 };

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("笔记底部 AI 输入框", () => {
  it("功能键按动作调用 notes/suggest，结果先出卡片、可插入或丢弃", async () => {
    apiMocks.list.mockResolvedValue({ notes: [noteMeta] });
    apiMocks.read.mockResolvedValue({ meta: noteMeta, content: "# 线性代数复习\n\n矩阵的秩。" });
    apiMocks.suggest.mockResolvedValue({ text: "第一段要点。\n\n- 要点一\n- 要点二", sourceIds: ["s1"], action: "summarize" });
    render(<NotesWorkspace courseId="c1" courseName="合成课程" onClose={() => {}} onSwitchMode={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "打开笔记 线性代数复习" }));
    expect(await screen.findByLabelText("笔记 AI 指令")).toBeInTheDocument();
    // 功能键：总结
    fireEvent.click(screen.getByRole("button", { name: "AI 总结" }));
    await waitFor(() => expect(apiMocks.suggest).toHaveBeenCalledTimes(1));
    const payload = apiMocks.suggest.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload).toMatchObject({ title: "线性代数复习", action: "summarize", selection: "", instruction: "" });
    expect(String(payload.body)).toContain("矩阵的秩");
    const card = await screen.findByTestId("notes-ai-result");
    expect(card).toHaveTextContent("AI 总结");
    expect(card).toHaveTextContent("依据 1 个资料片段");
    expect(screen.getByRole("button", { name: "插入到光标处" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "丢弃" }));
    expect(screen.queryByTestId("notes-ai-result")).toBeNull();
  });

  it("输入提示词发送 = 自定义指令；不带选区时提示词作用于整篇笔记", async () => {
    apiMocks.list.mockResolvedValue({ notes: [noteMeta] });
    apiMocks.read.mockResolvedValue({ meta: noteMeta, content: "# 线性代数复习\n\n矩阵的秩。" });
    apiMocks.suggest.mockResolvedValue({ text: "扩展后的正文。", sourceIds: [], action: "custom" });
    render(<NotesWorkspace courseId="c1" courseName="合成课程" onClose={() => {}} onSwitchMode={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "打开笔记 线性代数复习" }));
    const input = await screen.findByLabelText("笔记 AI 指令");
    fireEvent.change(input, { target: { value: "把笔记改写成提纲" } });
    fireEvent.click(screen.getByRole("button", { name: "发送给 AI" }));
    await waitFor(() => expect(apiMocks.suggest).toHaveBeenCalledTimes(1));
    expect(apiMocks.suggest.mock.calls[0]![1]).toMatchObject({ action: "custom", instruction: "把笔记改写成提纲" });
    expect(await screen.findByTestId("notes-ai-result")).toHaveTextContent("AI 处理");
  });

  it("选段类动作没有选区时给出提示且不发请求", async () => {
    apiMocks.list.mockResolvedValue({ notes: [noteMeta] });
    apiMocks.read.mockResolvedValue({ meta: noteMeta, content: "# 线性代数复习\n\n矩阵的秩。" });
    render(<NotesWorkspace courseId="c1" courseName="合成课程" onClose={() => {}} onSwitchMode={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "打开笔记 线性代数复习" }));
    fireEvent.click(await screen.findByRole("button", { name: "扩写" }));
    expect(await screen.findByText("请先在正文中选中要处理的内容")).toBeVisible();
    expect(apiMocks.suggest).not.toHaveBeenCalled();
  });
});
