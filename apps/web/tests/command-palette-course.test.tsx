/**
 * 命令面板的「切换项目」动作：`setActiveCourse` 会清空消息与会话且没有恢复入口，
 * 所以只在课程真的变化时才能调用。commands.ts 与 LeftNav 的同类切换都有这个守卫，
 * 这里回归的是面板遗漏的那一处。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

const { abortActiveChatMock, sendMock } = vi.hoisted(() => ({
  abortActiveChatMock: vi.fn(),
  sendMock: vi.fn(async () => true),
}));

vi.mock("@/src/lib/chatStream", () => ({ abortActiveChat: abortActiveChatMock }));
vi.mock("@/src/hooks/useChatStream", () => ({ useChatStream: () => ({ send: sendMock }) }));
vi.mock("@/src/lib/api", () => ({ api: { models: vi.fn(async () => []), sessions: vi.fn(async () => ({ sessions: [] })) } }));

import CommandPalette from "../src/components/palette/CommandPalette";
import { useAppStore } from "../src/store/useAppStore";

const initialState = useAppStore.getState();

beforeEach(() => {
  useAppStore.setState(initialState, true);
  useAppStore.setState({
    activeCourseId: "高数",
    workspacePath: "D:\\courses\\高数",
    courses: [
      { id: "高数", title: "高等数学", overallMastery: 0, dueToday: 0, lastActiveAt: null },
      { id: "线性代数", title: "线性代数", overallMastery: 0, dueToday: 0, lastActiveAt: null },
    ],
    paletteOpen: true,
    messages: [],
    sessions: [],
    streaming: false,
  });
  abortActiveChatMock.mockClear();
  sendMock.mockClear();
});

/** 打开「切换项目」二级层并点选指定课程。 */
async function pickCourse(title: string) {
  render(<CommandPalette />);
  // `/switch-course` 是进入课程二级层的唯一入口（label 恰好等于该指令）
  const entry = await screen.findByText("/switch-course");
  act(() => entry.click());
  const matches = await screen.findAllByText(title);
  const target = matches.find((el) => el.tagName === "SPAN" && el.className.includes("truncate")) ?? matches[0]!;
  act(() => target.click());
}

describe("CommandPalette 切换项目", () => {
  it("选中当前课程不清空已有会话与消息", async () => {
    act(() =>
      useAppStore.setState({
        messages: [{ id: "m1", role: "user", content: "已有对话", createdAt: "2026-10-02T00:00:00.000Z" }],
        sessions: [{ sessionId: "s1", title: "旧对话", mode: "quick", turns: 1, createdAt: "2026-10-02T00:00:00.000Z", lastActiveAt: "2026-10-02T00:00:00.000Z" }],
        activeSessionId: "s1",
      }),
    );

    await pickCourse("高等数学");

    const store = useAppStore.getState();
    expect(store.activeSessionId).toBe("s1");
    expect(store.sessions).toHaveLength(1);
    expect(store.messages).toHaveLength(1);
    // 课程没变就不该中止正在进行的回答
    expect(abortActiveChatMock).not.toHaveBeenCalled();
  });

  it("切到另一门课程时才中止旧流并清 streaming", async () => {
    act(() => useAppStore.setState({ streaming: true }));

    await pickCourse("线性代数");

    expect(useAppStore.getState().activeCourseId).toBe("线性代数");
    expect(abortActiveChatMock).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().streaming).toBe(false);
  });
});
