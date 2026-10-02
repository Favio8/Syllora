import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ChartViz from "../src/components/chat/ChartViz";
import DiagramViz from "../src/components/chat/DiagramViz";
import MarkdownView from "../src/components/chat/MarkdownView";

afterEach(() => { cleanup(); });

const chartJson = (value: unknown) => JSON.stringify(value);
const column = { chartType: "column", title: "月度销量", unit: "件", data: { labels: ["一月", "二月", "三月"], legends: ["甲店", "乙店"], series: [[3, 5, 4], [2, 6, 5]] } };

describe("ChartViz 规格化图表", () => {
  it("合法规格渲染成 SVG：柱数与行列一致、标题进外壳、数值进悬停 title", () => {
    const { container } = render(<ChartViz code={chartJson(column)} closed />);
    const bars = container.querySelectorAll('svg[role="img"] rect');
    // 2 个系列 × 3 个标签 = 6 根柱（外加图例色块 2 个）
    expect(bars.length).toBe(8);
    expect(screen.getByText("月度销量")).toBeInTheDocument();
    expect(container.querySelector("title")?.textContent).toContain("一月 · 甲店：3件");
    expect(container.querySelectorAll("svg text").length).toBeGreaterThan(0);
  });

  it("饼图按占比画扇区，只有一组数据", () => {
    const { container } = render(<ChartViz code={chartJson({ chartType: "ring", data: { labels: ["A", "B"], legends: ["占比"], series: [[75, 25]] } })} closed />);
    const paths = container.querySelectorAll('svg[role="img"] path');
    expect(paths.length).toBe(2);
    expect(screen.getByText("A 75%")).toBeInTheDocument();
    expect(screen.getByText("B 25%")).toBeInTheDocument();
  });

  it("行列不对齐 / 非数字 / 饼图多系列 → 规格错误卡（不渲染图，给出原因与原文）", () => {
    const mismatch = render(<ChartViz code={chartJson({ chartType: "column", data: { labels: ["A", "B"], legends: ["S"], series: [[1]] } })} closed />);
    expect(mismatch.container.querySelector('[data-viz-state="invalid"]')).not.toBeNull();
    expect(screen.getByText(/第 1 组数据有 1 个值/)).toBeInTheDocument();
    cleanup();
    const text = render(<ChartViz code={chartJson({ chartType: "line", data: { labels: ["A"], legends: ["S"], series: [["3%"]] } })} closed />);
    expect(text.container.querySelector('[data-viz-state="invalid"]')).not.toBeNull();
    expect(screen.getByText(/非数字/)).toBeInTheDocument();
    cleanup();
    const pie = render(<ChartViz code={chartJson({ chartType: "pie", data: { labels: ["A"], legends: ["S1", "S2"], series: [[1], [2]] } })} closed />);
    expect(pie.container.querySelector('[data-viz-state="invalid"]')).not.toBeNull();
    expect(screen.getByText(/饼图 \/ 环图只能有一组数据/)).toBeInTheDocument();
  });

  it("未闭合：流式中显示生成中，终态降级为代码块", () => {
    const streaming = render(<ChartViz code='{"chartType":"col' closed={false} streaming />);
    expect(streaming.container.querySelector('[data-viz-state="generating"]')).not.toBeNull();
    cleanup();
    const done = render(<ChartViz code='{"chartType":"col' closed={false} />);
    expect(done.container.querySelector('[data-viz-state="fallback"]')).not.toBeNull();
  });
});

describe("DiagramViz 规格化结构图", () => {
  const flow = {
    diagramType: "flowchart",
    nodes: [{ id: "n1", label: "读取输入" }, { id: "n2", label: "排序", details: "升序" }, { id: "n3", label: "输出" }],
    edges: [{ from: "n1", to: "n2", label: "数据" }, { from: "n2", to: "n3" }],
  };

  it("节点与连线都画出来，边标签与节点补充说明可见", () => {
    const { container } = render(<DiagramViz code={chartJson(flow)} closed />);
    expect(container.querySelectorAll("[data-node-id]").length).toBe(3);
    expect(container.querySelectorAll('svg[role="img"] path').length).toBe(3); // 2 条连线 + 箭头 marker 定义
    expect(screen.getByText("排序")).toBeInTheDocument();
    expect(screen.getByText("升序")).toBeInTheDocument();
    expect(screen.getByText("数据")).toBeInTheDocument();
  });

  it("revealOrder 逐步揭示：默认只显第一步，步进后逐个展开并可重来", () => {
    const { container } = render(<DiagramViz code={chartJson({ ...flow, revealOrder: ["n1", "n2", "n3"] })} closed />);
    const opacityOf = (id: string) => container.querySelector(`[data-node-id="${id}"]`)?.getAttribute("opacity");
    expect(opacityOf("n1")).toBe("1");
    expect(opacityOf("n2")).toBe("0.16");
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(opacityOf("n2")).toBe("1");
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重来" }));
    expect(opacityOf("n2")).toBe("0.16");
    expect(screen.getByText("0 / 3")).toBeInTheDocument();
  });

  it("边端点未声明 / id 重复 → 规格错误卡", () => {
    const bad = render(<DiagramViz code={chartJson({ nodes: [{ id: "n1", label: "A" }], edges: [{ from: "n1", to: "n9" }] })} closed />);
    expect(bad.container.querySelector('[data-viz-state="invalid"]')).not.toBeNull();
    expect(screen.getByText(/端点不在 nodes 里/)).toBeInTheDocument();
    cleanup();
    const dup = render(<DiagramViz code={chartJson({ nodes: [{ id: "n1", label: "A" }, { id: "n1", label: "B" }], edges: [] })} closed />);
    expect(dup.container.querySelector('[data-viz-state="invalid"]')).not.toBeNull();
    expect(screen.getByText(/id 重复/)).toBeInTheDocument();
  });
});

describe("MarkdownView 按围栏种类分发", () => {
  it("chart 与 diagram 围栏都交给对应渲染器，正文照常渲染", () => {
    const content = [
      "先看数据：",
      "```chart",
      chartJson(column),
      "```",
      "再看流程：",
      "```diagram",
      chartJson({ nodes: [{ id: "n1", label: "开始" }], edges: [] }),
      "```",
    ].join("\n");
    const { container } = render(<MarkdownView content={content} />);
    expect(container.querySelectorAll('[data-viz-kind="chart"][data-viz-state="ready"]').length).toBe(1);
    expect(container.querySelectorAll('[data-viz-kind="diagram"][data-viz-state="ready"]').length).toBe(1);
    expect(screen.getByText("先看数据：")).toBeInTheDocument();
    expect(screen.getByText("再看流程：")).toBeInTheDocument();
  });
});
