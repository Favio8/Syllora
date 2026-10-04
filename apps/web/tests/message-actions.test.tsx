import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import MessageActions from "../src/components/chat/MessageActions";

afterEach(cleanup);

describe("MessageActions 已取消的两个操作入口", () => {
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
