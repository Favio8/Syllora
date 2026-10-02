/**
 * AgentChat 宿主：uuid 课程与「课程文件夹名」之间的桥接、设置弹窗转交与
 * 调色板条件挂载。LearningChat 用探针替身，避免把整条 SSE 链路拖进单测。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

const { ensureCourseMock } = vi.hoisted(() => ({
  ensureCourseMock: vi.fn(async () => ({ ensured: true })),
}));

vi.mock("@/src/lib/api", () => ({
  api: { ensureCourse: ensureCourseMock },
}));

vi.mock("@/src/features/workbench/components/LearningChat", () => ({
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
});

describe("chatCourseIdOf", () => {
  it("prefers the course UUID so two same-named folders cannot share one chat course", () => {
    const uuid = "8f14e45f-ceea-467a-9a1e-3ed7e1f6d7c5";
    expect(chatCourseIdOf("D:\\courses\\高数", uuid)).toBe(uuid);
    expect(chatCourseIdOf("/home/learner/algebra/", uuid)).toBe(uuid);
    // 空值仍回落到文件夹名，兼容旧调用方与旧历史。
    expect(chatCourseIdOf("D:\\courses\\高数", "")).toBe("高数");
    expect(chatCourseIdOf("D:\\courses\\高数", null)).toBe("高数");
    expect(chatCourseIdOf("D:\\courses\\高数", "   ")).toBe("高数");
  });

  it("takes the folder basename for both separators and drops trailing ones", () => {
    expect(chatCourseIdOf("D:\\courses\\高数")).toBe("高数");
    expect(chatCourseIdOf("/home/learner/algebra/")).toBe("algebra");
    expect(chatCourseIdOf("algebra")).toBe("algebra");
  });
});

describe("AgentChat", () => {
  it("bridges the course UUID (not the folder name) into the store", async () => {
    const uuid = "8f14e45f-ceea-467a-9a1e-3ed7e1f6d7c5";
    render(<AgentChat folder={"D:\\courses\\高数"} courseId={uuid} courseName="高等数学" />);

    await waitFor(() => expect(useAppStore.getState().activeCourseId).toBe(uuid));
    expect(useAppStore.getState().courses).toEqual([
      { id: uuid, title: "高等数学", overallMastery: 0, dueToday: 0, lastActiveAt: null },
    ]);
    await waitFor(() => expect(ensureCourseMock).toHaveBeenCalledWith(uuid));
  });

  it("falls back to the folder name for callers without a course identity", async () => {
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

  it("mounts the command palette only while it is open", async () => {
    render(<AgentChat folder={"D:\\courses\\高数"} courseName="高等数学" />);
    expect(screen.queryByTestId("command-palette")).not.toBeInTheDocument();
    act(() => useAppStore.getState().setPaletteOpen(true));
    expect(await screen.findByTestId("command-palette")).toBeInTheDocument();
  });
});
