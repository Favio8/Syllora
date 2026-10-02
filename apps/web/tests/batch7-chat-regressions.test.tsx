/**
 * 需求四第二/三批（聊天链路）回归：
 *  - CR-11：pendingAsk 回答失败后重试必须走 answer() 通道并复用原 `ans_` requestId；
 *  - CR-12：answer() 终态写回带归属守卫（切课后旧流尾帧不写进新会话）；
 *  - B4：store 课程与展示课程不一致时输入框禁用，且提交被拒绝。
 */

import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { streamChatMock, streamAnswerMock } = vi.hoisted(() => ({
  streamChatMock: vi.fn(),
  streamAnswerMock: vi.fn(),
}));

vi.mock("../src/lib/chatStream", () => ({
  isAbortError: (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  registerActiveChat: vi.fn(),
  unregisterActiveChat: vi.fn(),
  abortActiveChat: vi.fn(),
  streamAgentAnswer: streamAnswerMock,
  streamChat: streamChatMock,
}));
vi.mock("../src/lib/api", () => ({
  api: {
    sessions: vi.fn(async () => ({ sessions: [] })),
    enqueueAgent: vi.fn(async () => ({ turnId: "t_x" })),
  },
}));
vi.mock("../src/hooks/usePanelData", () => ({ usePanelData: () => ({ refresh: vi.fn(async () => {}) }) }));
vi.mock("../src/lib/panelData", () => ({ notifyPanelChanged: vi.fn(), refreshCourseList: vi.fn(async () => {}) }));

import LearningChat from "../src/features/workbench/components/LearningChat";
import { useChatStream } from "../src/hooks/useChatStream";
import { initialQuiz, useAppStore } from "../src/store/useAppStore";

const baseState = () => ({
  activeCourseId: "course-1",
  activeSessionId: "s-1",
  activeSessionTitle: "",
  messages: [],
  streaming: false,
  streamPhase: null,
  queuedMessages: [],
  pendingAsk: null,
  quiz: { ...initialQuiz },
});

beforeEach(() => {
  useAppStore.setState(baseState() as never);
  streamChatMock.mockReset();
  streamAnswerMock.mockReset();
  localStorage.clear();
});

describe("CR-11：ask 应答重试走 answer 通道", () => {
  it("retryLast 在 pendingAsk 仍在时调用 streamAgentAnswer 并复用同一个 ans_ requestId", async () => {
    const ask = { question: "你的学习目标是什么？", options: [] };
    useAppStore.setState({ pendingAsk: ask } as never);
    const requestIds: string[] = [];
    streamAnswerMock.mockImplementation(async function* (_agent: string, _text: string, _signal: AbortSignal, requestId: string) {
      requestIds.push(requestId);
      // 第一次：网络断开，没有 meta 帧——pendingAsk 保留。
      throw new Error("network down");
    });
    const { result } = renderHook(() => useChatStream());
    await act(async () => { await result.current.answer("准备考研"); });
    expect(useAppStore.getState().pendingAsk).not.toBeNull();

    streamAnswerMock.mockImplementation(async function* (_agent: string, _text: string, _signal: AbortSignal, requestId: string) {
      requestIds.push(requestId);
      yield { event: "meta", data: {} };
      yield { event: "done", data: { usage: {} } };
    });
    await act(async () => { await result.current.retryLast("准备考研"); });

    expect(streamChatMock).not.toHaveBeenCalled(); // 没有掉进普通回合通道
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toMatch(/^ans_/);
    expect(requestIds[1]).toBe(requestIds[0]);
    expect(useAppStore.getState().pendingAsk).toBeNull();
  });

  it("没有对应的 ask 应答记录时仍走普通回合", async () => {
    streamChatMock.mockImplementation(async function* () {
      yield { event: "meta", data: { sessionId: "s-1", model: "m", provider: "p" } };
      yield { event: "done", data: { usage: {} } };
    });
    const { result } = renderHook(() => useChatStream());
    await act(async () => { await result.current.retryLast("普通消息"); });
    expect(streamChatMock).toHaveBeenCalledTimes(1);
    expect(streamAnswerMock).not.toHaveBeenCalled();
  });
});

describe("CR-12：answer 终态写回归属守卫", () => {
  it.each([false, true])("旧流成功或失败都不改写新会话状态（失败=%s）", async (fail) => {
    useAppStore.setState({ pendingAsk: { question: "旧问题", options: [] } } as never);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    streamAnswerMock.mockImplementation(async function* () {
      yield { event: "meta", data: {} };
      await gate;
      if (fail) throw new Error("旧流错误");
      yield { event: "token", data: { delta: "旧流内容" } };
      yield { event: "done", data: { usage: {} } };
    });
    const { result } = renderHook(() => useChatStream());
    let pending!: Promise<boolean>;
    await act(async () => { pending = result.current.answer("旧答案"); await Promise.resolve(); });
    const messages = [{ id: "new", role: "agent", content: "新内容", createdAt: "", streaming: true }];
    const ask = { question: "新问题", options: [] };
    act(() => useAppStore.setState({ activeCourseId: "course-2", activeSessionId: "s-2", messages, pendingAsk: ask, streaming: true, streamPhase: "writing", toolRunning: 2 } as never));
    release();
    await act(async () => { await pending; });
    expect(useAppStore.getState()).toMatchObject({ messages, pendingAsk: ask, streaming: true, streamPhase: "writing", toolRunning: 2 });
  });

  it("相同问题与答案在不同会话使用不同的 ans_ 幂等键", async () => {
    const ask = { question: "相同问题", options: [] };
    streamAnswerMock.mockImplementation(async function* () { throw new Error("network down"); });
    const { result } = renderHook(() => useChatStream());
    useAppStore.setState({ pendingAsk: ask } as never);
    await act(async () => { await result.current.answer("相同答案"); });
    useAppStore.setState({ activeSessionId: "s-2", pendingAsk: ask, messages: [] } as never);
    await act(async () => { await result.current.answer("相同答案"); });
    expect(streamAnswerMock.mock.calls[0]![3]).not.toBe(streamAnswerMock.mock.calls[1]![3]);
  });

  it("流进行中切到另一课程后，旧流收尾不改写新会话的最后一条 agent 消息", async () => {
    useAppStore.setState({ pendingAsk: { question: "Q？", options: [] } } as never);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    streamAnswerMock.mockImplementation(async function* () {
      yield { event: "meta", data: {} };
      await gate;
      yield { event: "done", data: { usage: {} } };
    });
    const { result } = renderHook(() => useChatStream());
    let pending!: Promise<boolean>;
    await act(async () => { pending = result.current.answer("答案"); await Promise.resolve(); });

    // 用户在流未结束时切到另一门课的新会话，并有一条属于新会话的 agent 消息。
    act(() => {
      useAppStore.setState({
        activeCourseId: "course-2",
        activeSessionId: "s-2",
        messages: [{ id: "new-agent", role: "agent", content: "新会话内容", createdAt: "", streaming: true }],
      } as never);
    });
    release();
    await act(async () => { await pending; });

    const last = useAppStore.getState().messages.at(-1);
    expect(last?.id).toBe("new-agent");
    expect(last?.content).toBe("新会话内容");
  });
});

describe("B4：切课窗口期禁用输入", () => {
  it("store 的 activeCourseId 与展示课程不一致时，输入框禁用并提示切换中", () => {
    useAppStore.setState({ activeCourseId: "old-course" } as never);
    render(<LearningChat courseName="新课程" name="我" folder="/new" syncId="new-course" />);
    const input = screen.getByLabelText("向 Syllora 提问") as HTMLTextAreaElement;
    expect(input).toBeDisabled();
    expect(input.placeholder).toBe("正在切换课程…");
  });

  it("一致后恢复可输入，并在提交瞬间再次核对 store", async () => {
    useAppStore.setState({ activeCourseId: "new-course" } as never);
    render(<LearningChat courseName="新课程" name="我" folder="/new" syncId="new-course" />);
    const input = screen.getByLabelText("向 Syllora 提问") as HTMLTextAreaElement;
    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: "你好" } });
    expect(input.value).toBe("你好");
  });
});
