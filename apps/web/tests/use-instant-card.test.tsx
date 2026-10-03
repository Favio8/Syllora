import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";

const { storeState, apiMocks } = vi.hoisted(() => {
  class MockApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status = 400) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }
  return {
    storeState: {
      activeCourseId: "course-1",
      flashStatusBanner: vi.fn(),
    },
    apiMocks: {
      ApiError: MockApiError,
      createCard: vi.fn(),
    },
  };
});

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));
vi.mock("../src/lib/api", () => ({
  ApiError: apiMocks.ApiError,
  api: apiMocks,
}));

import MessageActions from "../src/components/chat/MessageActions";
import useInstantCard from "../src/hooks/useInstantCard";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function CardHarness() {
  const { create, feedback } = useInstantCard();
  return (
    <div>
      <button type="button" onClick={() => void create("注意力的缩放点积公式 QK^T/√d", "注意力")}>
        生成
      </button>
      <span data-testid="feedback">{feedback.message}</span>
      <span data-testid="ok">{feedback.ok ? "ok" : "no"}</span>
    </div>
  );
}

describe("useInstantCard（F4 对话即出题）", () => {
  it("生成成功：调用 createCard 并反馈卡片信息", async () => {
    apiMocks.createCard.mockResolvedValue({
      courseId: "course-1",
      tasks: [
        {
          taskId: "attention_001",
          conceptId: "c_attention",
          type: "concept",
          difficulty: 3,
          question: "缩放点积注意力的核心？",
          evaluationCriteria: { rubric: ["a", "b"], keywords: [], minScoreToPass: 0.8 },
        },
      ],
    });
    render(<CardHarness />);
    fireEvent.click(screen.getByRole("button", { name: "生成" }));

    await waitFor(() => {
      expect(apiMocks.createCard).toHaveBeenCalledWith("course-1", {
        content: "注意力的缩放点积公式 QK^T/√d",
        title: "注意力",
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId("ok").textContent).toBe("ok");
    });
    expect(screen.getByTestId("feedback").textContent).toContain("attention_001");
  });

  it("LLM 不可用：返回明确降级提示、不抛未捕获异常", async () => {
    apiMocks.createCard.mockRejectedValue(
      new apiMocks.ApiError("LLM_UNAVAILABLE", "请检查模型配置", 502),
    );
    render(<CardHarness />);
    fireEvent.click(screen.getByRole("button", { name: "生成" }));

    await waitFor(() => {
      expect(screen.getByTestId("feedback").textContent).toContain("LLM 不可用");
    });
    expect(screen.getByTestId("ok").textContent).toBe("no");
  });
});

describe("MessageActions 已取消的两个操作入口", () => {
  // 需求：主界面取消「转复习卡」与「从此处创建分支」——操作区只保留时间与复制。
  it("不再渲染转复习卡与创建分支入口", () => {
    render(<MessageActions text="划选段落" />);
    expect(screen.queryByRole("button", { name: /转为复习卡片/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /创建分支/ })).not.toBeInTheDocument();
  });

  it("保留复制按钮", () => {
    render(<MessageActions text="复制我" />);
    expect(screen.getByRole("button", { name: "复制" })).toBeInTheDocument();
  });
});
