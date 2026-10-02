/**
 * AgentChat 宿主：uuid 课程与「课程文件夹名」之间的桥接、设置弹窗转交与
 * 调色板条件挂载。WorkbenchChat 用探针替身，避免把整条 SSE 链路拖进单测。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

const { ensureCourseMock, abortActiveChatMock } = vi.hoisted(() => ({
  ensureCourseMock: vi.fn(async () => ({ ensured: true })),
  abortActiveChatMock: vi.fn(),
}));

vi.mock("@/src/lib/api", () => ({
  api: { ensureCourse: ensureCourseMock },
}));

vi.mock("@/src/lib/chatStream", () => ({
  abortActiveChat: abortActiveChatMock,
}));

vi.mock("@/src/components/chat/WorkbenchChat", () => ({
  default: () => <div data-testid="chat-area" />,
}));

vi.mock("@/src/components/palette/CommandPalette", () => ({
  default: () => <div data-testid="command-palette" />,
}));

import AgentChat, { chatCourseIdOf } from "../src/components/chat/AgentChat";
import { useAppStore } from "../src/store/useAppStore";

const initialState = useAppStore.getState();

beforeEach(() => {
  useAppStore.setState(initialState, true);
  useAppStore.setState({ activeCourseId: null, workspacePath: null, courses: [], settingsOpen: false, paletteOpen: false });
  ensureCourseMock.mockClear();
  abortActiveChatMock.mockClear();
});

describe("chatCourseIdOf", () => {
  it("takes the folder basename for both separators and drops trailing ones", () => {
    expect(chatCourseIdOf("D:\\courses\\高数")).toBe("高数");
    expect(chatCourseIdOf("/home/learner/algebra/")).toBe("algebra");
    expect(chatCourseIdOf("algebra")).toBe("algebra");
  });
});

describe("AgentChat", () => {
  it("bridges the course folder, course list and active course into the store", async () => {
    render(<AgentChat folder={"D:\\courses\\高数"} courseName="高等数学" />);

    expect(screen.getByTestId("chat-area")).toBeInTheDocument();
    await waitFor(() => expect(useAppStore.getState().workspacePath).toBe("D:\\courses\\高数"));
    expect(useAppStore.getState().activeCourseId).toBe("高数");
    expect(useAppStore.getState().courses).toEqual([
      { id: "高数", title: "高等数学", overallMastery: 0, dueToday: 0, lastActiveAt: null },
    ]);
    await waitFor(() => expect(ensureCourseMock).toHaveBeenCalledWith("高数"));
  });

  it("keeps the active session when re-rendering for the same course", async () => {
    render(<AgentChat folder={"D:\\courses\\高数"} courseName="高等数学" />);
    await waitFor(() => expect(useAppStore.getState().activeCourseId).toBe("高数"));
    act(() => useAppStore.getState().setActiveSession("20261002-120000", "旧对话"));

    // 工作台每 1.5s 轮询 state 会反复重渲染：同一课程不得清空会话/消息。
    const { rerender } = render(<AgentChat folder={"D:\\courses\\高数"} courseName="高等数学" />);
    rerender(<AgentChat folder={"D:\\courses\\高数"} courseName="高等数学" />);
    expect(useAppStore.getState().activeSessionId).toBe("20261002-120000");
  });

  it("forwards the chat model-settings entry and resets the flag", async () => {
    const onOpenSettings = vi.fn();
    render(<AgentChat folder={"D:\\courses\\高数"} courseName="高等数学" onOpenSettings={onOpenSettings} />);
    await waitFor(() => expect(ensureCourseMock).toHaveBeenCalled());

    act(() => useAppStore.getState().setSettingsOpen(true));
    await waitFor(() => expect(onOpenSettings).toHaveBeenCalledTimes(1));
    expect(useAppStore.getState().settingsOpen).toBe(false);

    act(() => useAppStore.getState().setSettingsOpen(true));
    await waitFor(() => expect(onOpenSettings).toHaveBeenCalledTimes(2));
  });

  it("aborts the previous chat stream before switching courses", async () => {
    const { rerender } = render(<AgentChat folder={"D:\\courses\\高数"} courseName="高等数学" />);
    await waitFor(() => expect(useAppStore.getState().activeCourseId).toBe("高数"));
    // 首次挂载只是接手课程，没有旧流可中止
    const initialAborts = abortActiveChatMock.mock.calls.length;

    // chatStream.ts 的约定：对话切换前必须先 abortActiveChat()，否则旧流的 meta/done
    // 帧会按新的 activeCourseId 落地，把上一门课的 sessionId 写进新课。
    act(() => useAppStore.getState().setStreaming(true));
    rerender(<AgentChat folder={"D:\\courses\\线性代数"} courseName="线性代数" />);
    await waitFor(() => expect(useAppStore.getState().activeCourseId).toBe("线性代数"));
    expect(abortActiveChatMock.mock.calls.length).toBe(initialAborts + 1);
    expect(useAppStore.getState().streaming).toBe(false);
  });

  it("does not abort the stream when re-rendering for the same course", async () => {
    render(<AgentChat folder={"D:\\courses\\高数"} courseName="高等数学" />);
    await waitFor(() => expect(useAppStore.getState().activeCourseId).toBe("高数"));
    const before = abortActiveChatMock.mock.calls.length;

    act(() => useAppStore.getState().setStreaming(true));
    const { rerender } = render(<AgentChat folder={"D:\\courses\\高数"} courseName="高等数学" />);
    rerender(<AgentChat folder={"D:\\courses\\高数"} courseName="高等数学" />);
    // 1.5s 轮询引起的常规重渲染不得打断正在进行的回答
    expect(abortActiveChatMock.mock.calls.length).toBe(before);
    expect(useAppStore.getState().streaming).toBe(true);
  });

  it("wires global shortcuts so Ctrl+K opens the command palette", async () => {
    // 此前 useKeyboardShortcuts 只挂在 Console 外壳上，而 app 渲染的是工作台、
    // Console 已无入口：ChatArea 写着 Ctrl+K，按下去却没有任何反应。
    render(<AgentChat folder={"D:\\courses\\高数"} courseName="高等数学" />);
    await waitFor(() => expect(useAppStore.getState().activeCourseId).toBe("高数"));
    expect(useAppStore.getState().paletteOpen).toBe(false);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    });

    expect(useAppStore.getState().paletteOpen).toBe(true);
    expect(await screen.findByTestId("command-palette")).toBeInTheDocument();
  });

  it("mounts the command palette only while it is open", async () => {
    render(<AgentChat folder={"D:\\courses\\高数"} courseName="高等数学" />);
    expect(screen.queryByTestId("command-palette")).not.toBeInTheDocument();
    act(() => useAppStore.getState().setPaletteOpen(true));
    expect(await screen.findByTestId("command-palette")).toBeInTheDocument();
  });
});

