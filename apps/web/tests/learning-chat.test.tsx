/**
 * LearningChat composer：send() 要等整轮流式回复才返回，输入框必须在提交时立即清空；
 * 消息没有进入对话（如提前返回）时才把原文放回。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("@/src/hooks/useChatStream", () => ({
  useChatStream: () => ({ send: sendMock, answer: vi.fn(async () => false), retryLast: vi.fn(), stop: vi.fn() }),
}));
vi.mock("@/src/hooks/useSessionActions", () => ({ useSessionActions: () => ({ createSession: vi.fn() }) }));
vi.mock("@/src/components/chat/ApprovalPanel", () => ({ default: () => null }));
vi.mock("@/src/components/chat/QueueDock", () => ({ default: () => null }));

import LearningChat from "../src/features/workbench/components/LearningChat";
import { useAppStore } from "../src/store/useAppStore";

const initialState = useAppStore.getState();

beforeEach(() => {
  useAppStore.setState(initialState, true);
  useAppStore.setState({ activeCourseId: "course", messages: [], streaming: false, pendingAsk: null });
  sendMock.mockReset();
  localStorage.clear();
});

function input() {
  return screen.getByLabelText("向 Syllora 提问") as HTMLTextAreaElement;
}

describe("LearningChat composer", () => {
  it("clears the input as soon as the message is submitted, before the turn finishes", async () => {
    let finish!: () => void;
    sendMock.mockImplementation((text: string) => {
      useAppStore.setState({ messages: [{ id: "u1", role: "user", content: text, createdAt: "" }] as never });
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    render(<LearningChat folder="/courses/algebra" courseName="代数" name="学习者" />);
    fireEvent.change(input(), { target: { value: "什么是向量？" } });
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(sendMock).toHaveBeenCalledWith("什么是向量？");
    expect(input().value).toBe("");
    await act(async () => finish());
    expect(input().value).toBe("");
  });

  it("restores the text when nothing reached the transcript", async () => {
    sendMock.mockResolvedValue(undefined);
    render(<LearningChat folder="/courses/algebra" courseName="代数" name="学习者" />);
    fireEvent.change(input(), { target: { value: "没发出去" } });
    await act(async () => { fireEvent.keyDown(input(), { key: "Enter" }); });
    expect(input().value).toBe("没发出去");
  });

  it("does not touch the draft when a suggestion chip is sent", async () => {
    sendMock.mockImplementation(async (text: string) => {
      useAppStore.setState({ messages: [{ id: "u1", role: "user", content: text, createdAt: "" }] as never });
    });
    render(<LearningChat folder="/courses/algebra" courseName="代数" name="学习者" />);
    fireEvent.change(input(), { target: { value: "我的草稿" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /用直观例子解释/ })); });
    expect(sendMock).toHaveBeenCalledWith("用直观例子解释");
    expect(input().value).toBe("我的草稿");
  });
});
