/**
 * CR-13：重试闭包捕获 map 里共享的 `let lastUserText`，点击时读到的是全表
 * 最后一条用户消息——旧失败卡点重试会重发错误的文本并持久化。修复后渲染时
 * 把本卡对应的文本固化成常量（ChatArea 内 `const retryText = lastUserText`）。
 *
 * 本文件只钉「点击重试时传出的文本」；重试走哪条通道（answer / send）与
 * 并发下的归属守卫由 batch7-chat-regressions.test.tsx 覆盖。
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { retryLast } = vi.hoisted(() => ({ retryLast: vi.fn() }));

vi.mock("@/src/hooks/useChatStream", () => ({
  useChatStream: () => ({ send: vi.fn(), answer: vi.fn(), retryLast, stop: vi.fn() }),
}));
vi.mock("@/src/hooks/useSessionActions", () => ({ useSessionActions: () => ({ forkSession: vi.fn() }) }));
vi.mock("@/src/components/chat/ChatInput", () => ({ default: () => null }));
vi.mock("@/src/components/chat/StatsLine", () => ({ default: () => null }));
vi.mock("@/src/components/chat/WakeupCard", () => ({ default: () => null }));
vi.mock("@/src/components/chat/ApprovalPanel", () => ({ default: () => null }));
vi.mock("@/src/components/chat/QueueDock", () => ({ default: () => null }));
vi.mock("@/src/components/mascot", () => ({ Clawzy: () => null }));
vi.mock("@/src/components/chat/MessageCard", () => ({
  default: ({ message, onRetry }: { message: { id: string; error?: string }; onRetry?: () => void }) => (
    <div data-testid={`card-${message.id}`}>
      {onRetry ? <button onClick={onRetry}>retry-{message.id}</button> : null}
    </div>
  ),
}));

import ChatArea from "../src/components/chat/ChatArea";
import { useAppStore } from "../src/store/useAppStore";

beforeEach(() => {
  retryLast.mockReset();
  useAppStore.setState({
    activeCourseId: "c1",
    activeSessionId: "s1",
    courses: [{ id: "c1", title: "课程", overallMastery: 0, dueToday: 0, lastActiveAt: null }],
    messages: [
      { id: "u1", role: "user", content: "第一个问题", createdAt: "" },
      { id: "a1", role: "agent", content: "", createdAt: "", error: "第一次失败" },
      { id: "u2", role: "user", content: "第二个问题", createdAt: "" },
      { id: "a2", role: "agent", content: "", createdAt: "", error: "第二次失败" },
    ],
    streaming: false,
  } as never);
});

describe("CR-13", () => {
  it("旧失败卡重试重发它自己之前那条用户消息，而不是全表最后一条", () => {
    render(<ChatArea />);
    fireEvent.click(screen.getByText("retry-a1"));
    expect(retryLast).toHaveBeenLastCalledWith("第一个问题");
    fireEvent.click(screen.getByText("retry-a2"));
    expect(retryLast).toHaveBeenLastCalledWith("第二个问题");
  });

  it("失败卡之后新增用户消息也不会改写旧卡的固化文本", () => {
    // 渲染后再追加一条用户消息：旧失败卡的闭包仍持有渲染时固化的文本，
    // 不会被后来者（或共享 let 绑定）覆盖。
    const { rerender } = render(<ChatArea />);
    useAppStore.setState({
      messages: [
        ...useAppStore.getState().messages,
        { id: "u3", role: "user", content: "第三个问题", createdAt: "" },
      ],
    } as never);
    rerender(<ChatArea />);
    fireEvent.click(screen.getByText("retry-a2"));
    expect(retryLast).toHaveBeenLastCalledWith("第二个问题");
  });
});
