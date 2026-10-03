import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NotesWorkspace from "../src/components/NotesWorkspace";

const { apiMocks } = vi.hoisted(() => ({
  apiMocks: {
    list: vi.fn(async () => ({ notes: [{ id: "n1", title: "第一篇", updatedAt: Date.now(), wikilinks: [] }] })),
    read: vi.fn(async () => ({ meta: { id: "n1", title: "第一篇", updatedAt: Date.now(), wikilinks: [] }, content: "正文" })),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(async () => ({ deleted: true })),
    suggest: vi.fn(),
    uploadImage: vi.fn(),
  },
}));

vi.mock("../src/lib/api", () => ({ api: { notes: apiMocks }, ApiError: class ApiError extends Error {} }));
vi.mock("../src/components/NotesGraph", () => ({ default: () => null }));
vi.mock("../src/components/NotesEditor", () => ({
  default: ({ onChange, onEditor }: { onChange: (value: string) => void; onEditor: (editor: unknown) => void }) => {
    const editor = {
      state: { doc: { content: { size: 4 }, textBetween: () => "正文" }, selection: { from: 0, to: 0, empty: true } },
      on: () => undefined,
      off: () => undefined,
      chain: () => ({ focus: () => ({ insertContent: () => ({ run: () => true }), insertContentAt: () => ({ run: () => true }), run: () => true }) }),
    };
    setTimeout(() => onEditor(editor), 0);
    return <textarea aria-label="正文（测试替身）" onChange={(event) => onChange(event.target.value)} />;
  },
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const baseProps = {
  courseId: "c1",
  courseName: "电路分析基础",
  onClose: vi.fn(),
  onSwitchMode: vi.fn(),
};

describe("笔记页课程切换（需求七）", () => {
  it("左栏渲染课程下拉，选择其他课程后回调切课", async () => {
    const onSwitchCourse = vi.fn();
    render(<NotesWorkspace {...baseProps} courses={[{ id: "c1", name: "电路分析基础" }, { id: "c2", name: "线性代数入门" }]} onSwitchCourse={onSwitchCourse} />);
    const trigger = await screen.findByRole("combobox", { name: "选择课程" });
    expect(trigger).toHaveTextContent("电路分析基础");

    fireEvent.click(trigger);
    const option = await screen.findByRole("option", { name: /线性代数入门/ });
    fireEvent.click(option);

    await waitFor(() => expect(onSwitchCourse).toHaveBeenCalledWith("c2"));
  });

  it("只有一门课程时下拉仍可用（当前课程）", async () => {
    render(<NotesWorkspace {...baseProps} courses={[{ id: "c1", name: "电路分析基础" }]} onSwitchCourse={vi.fn()} />);
    expect(await screen.findByRole("combobox", { name: "选择课程" })).toHaveTextContent("电路分析基础");
  });
});

describe("笔记页不再使用阻塞式 window.confirm（需求一）", () => {
  it("删除笔记走应用内确认框，而不是原生 confirm", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    render(<NotesWorkspace {...baseProps} courses={[]} />);
    const del = await screen.findByRole("button", { name: "删除笔记 第一篇" });
    fireEvent.click(del);

    expect(confirmSpy).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog", { name: "需要确认" });
    expect(dialog).toHaveTextContent("删除这篇笔记？");

    fireEvent.click(screen.getByRole("button", { name: "删除笔记" }));
    await waitFor(() => expect(apiMocks.delete).toHaveBeenCalledWith("c1", "n1"));
    confirmSpy.mockRestore();
  });

  it("返回工作台时若有未保存修改，弹应用内确认框", async () => {
    const onClose = vi.fn();
    render(<NotesWorkspace {...baseProps} onClose={onClose} courses={[]} />);
    // 打开笔记 → 改标题 → 返回
    fireEvent.click(await screen.findByRole("button", { name: "打开笔记 第一篇" }));
    const title = await screen.findByRole("textbox", { name: "笔记标题" });
    await waitFor(() => expect((title as HTMLInputElement).value).toBe("第一篇"));
    fireEvent.change(title, { target: { value: "改过的标题" } });

    fireEvent.click(screen.getByRole("button", { name: /返回工作台/ }));
    expect(await screen.findByRole("alertdialog", { name: "需要确认" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "放弃修改并返回" }));
    expect(onClose).toHaveBeenCalled();
  });
});
