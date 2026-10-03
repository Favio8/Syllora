/**
 * 需求四第二/三批（聊天链路）回归：
 *  - CR-11：pendingAsk 回答失败后重试必须走 answer() 通道并复用原 `ans_` requestId；
 *  - CR-12：answer() 终态写回带归属守卫（切课后旧流尾帧不写进新会话）；
 *  - CR-04：排队条目自带归属——同一会话内的条目照常 drain（带原 turnId），
 *    跨会话的条目在 drain 时丢弃并提示；setActiveSession 只保留新会话的条目；
 *  - CR-13：失败卡重试带的文本与记录里的答案不一致时，不能硬吃 ans_ 幂等键
 *    （渲染端「每张卡固化自己的文本」由 chat-area-retry-text.test.tsx 钉住）。
 * 注：PR 原文里还有一组 B4（LearningChat 的「正在切换课程…」占位）用例；
 * 本地没有 LearningChat / 课程同步占位这套实现，故整组不再移植。
 */

import { act, renderHook, waitFor } from "@testing-library/react";
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
    // 重试不重复追加用户消息：消息列里只有第一次 answer 追的那一条。
    expect(useAppStore.getState().messages.filter((message) => message.role === "user")).toHaveLength(1);
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

describe("CR-13：重试文本决定重试通道", () => {
  it("失败卡重试带的文本与记录里的答案不一致时走普通回合，不复用 ans_ 幂等键", async () => {
    // ChatArea 侧「每张失败卡固化自己的文本」由 chat-area-retry-text.test.tsx
    // 钉住；这里钉住消费端：文本不是那条 ask 的答案，就不能走 answer 通道。
    const requestIds: string[] = [];
    useAppStore.setState({ pendingAsk: { question: "问题", options: [] } } as never);
    streamAnswerMock.mockImplementation(async function* (_agent: string, _text: string, _signal: AbortSignal, requestId: string) {
      requestIds.push(requestId);
      throw new Error("network down");
    });
    streamChatMock.mockImplementation(async function* () {
      yield { event: "meta", data: { sessionId: "s-1", model: "m", provider: "p" } };
      yield { event: "done", data: { usage: {} } };
    });
    const { result } = renderHook(() => useChatStream());
    await act(async () => { await result.current.answer("答案 A"); });
    const failed = requestIds[0];
    await act(async () => { await result.current.retryLast("答案 B"); });
    expect(streamAnswerMock).toHaveBeenCalledTimes(1); // 没有再用 ans_ 通道
    expect(requestIds).toEqual([failed]);
    expect(streamChatMock).toHaveBeenCalledTimes(1); // 走了普通回合
    expect(streamChatMock.mock.calls[0]![0]).toMatchObject({ message: "答案 B" });
  });
});

describe("CR-04：排队条目的归属", () => {
  it("setActiveSession 只保留属于新会话的排队条目（旧会话与无归属条目都被丢弃）", () => {
    useAppStore.setState({
      activeCourseId: "course-1",
      activeSessionId: "s-1",
      queuedMessages: [
        { text: "同会话", owner: { courseId: "course-1", sessionId: "s-1" } },
        { text: "新会话", owner: { courseId: "course-1", sessionId: "s-2" } },
        { text: "旧课程", owner: { courseId: "course-0", sessionId: "s-2" } },
        { text: "无归属" },
      ],
    } as never);
    act(() => useAppStore.getState().setActiveSession("s-2"));
    expect(useAppStore.getState().queuedMessages.map((entry) => entry.text)).toEqual(["新会话"]);
  });

  it("同一会话的排队条目在上一回合结束后按原 turnId 发出", async () => {
    const seen: Array<{ message: string; turnId?: string | null }> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    streamChatMock.mockImplementation(async function* (input: { message: string; turnId?: string | null }) {
      seen.push({ message: input.message, turnId: input.turnId });
      if (seen.length === 1) {
        yield { event: "meta", data: { sessionId: "s-1", model: "m", provider: "p" } };
        await gate;
      }
      yield { event: "meta", data: { sessionId: "s-1", model: "m", provider: "p" } };
      yield { event: "done", data: { usage: {} } };
    });
    const { result } = renderHook(() => useChatStream());
    let first!: Promise<void>;
    await act(async () => { first = result.current.send("第一条"); await Promise.resolve(); });
    // 流未结束时的第二次 send 进队列，条目固化当时的归属（course-1 / s-1）。
    await act(async () => { await result.current.send("第二条"); });
    expect(useAppStore.getState().queuedMessages.map((entry) => entry.text)).toEqual(["第二条"]);
    release();
    await act(async () => { await first; });
    await waitFor(() => expect(seen.map((call) => call.message)).toEqual(["第一条", "第二条"]));
    expect(seen[1]!.turnId).toBe("t_x");
    expect(useAppStore.getState().queuedMessages).toEqual([]);
  });

  it("切会话后旧归属的排队条目在 drain 时被丢弃并提示，不静默串课", async () => {
    streamChatMock.mockImplementation(async function* () {
      yield { event: "meta", data: { sessionId: "s-1", model: "m", provider: "p" } };
      yield { event: "done", data: { usage: {} } };
    });
    useAppStore.setState({
      queuedMessages: [{ text: "旧会话排队", turnId: "t_old", owner: { courseId: "course-1", sessionId: "s-other" } }],
    } as never);
    const { result } = renderHook(() => useChatStream());
    await act(async () => { await result.current.send("第一条"); });
    // 旧归属条目不进新会话：只发出了一条，且给出横幅提示。
    expect(streamChatMock).toHaveBeenCalledTimes(1);
    expect(streamChatMock.mock.calls[0]![0]).toMatchObject({ message: "第一条", turnId: null });
    expect(useAppStore.getState().queuedMessages).toEqual([]);
    expect(useAppStore.getState().modeBanner).toContain("丢弃旧队列消息");
  });
});
