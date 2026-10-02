import { describe, expect, it } from "vitest";
import { buildNotesGraph, computeDegrees, computeNodeRender, computeLinkRender, matchedNoteIds } from "../src/lib/notesGraph";
import type { NoteMeta } from "../src/types/api";
import type { GraphOptions } from "../src/lib/notesGraph";

const note = (id: string, title: string, wikilinks: string[] = []): NoteMeta => ({
  id,
  title,
  wikilinks,
  images: [],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
});

const defaultOpts: GraphOptions = {
  query: "",
  highlightId: null,
  filterGroup: null,
  showOrphans: true,
  localDepth: 0,
  localCenterId: null,
};

describe("buildNotesGraph", () => {
  it("只连到本课程已有笔记标题，忽略不存在的目标、自链与重复链接", () => {
    const graph = buildNotesGraph([
      note("a", "笔记A"),
      note("b", "笔记B", ["笔记A", "笔记A", "笔记B", "不存在的笔记"]),
      note("c", "孤立笔记"),
    ]);
    expect(graph.nodes.map((node) => node.id)).toEqual(["a", "b", "c"]);
    expect(graph.edges).toEqual([{ from: "b", to: "a" }]);
  });

  it("没有 [[双链]] 时不产生任何边", () => {
    const graph = buildNotesGraph([note("a", "笔记A"), note("b", "笔记B")]);
    expect(graph.edges).toEqual([]);
  });

  it("同名笔记取先列出的那一篇", () => {
    const graph = buildNotesGraph([note("a1", "同名"), note("a2", "同名"), note("b", "笔记B", ["同名"])]);
    expect(graph.edges).toEqual([{ from: "b", to: "a1" }]);
  });
});

describe("computeDegrees", () => {
  it("计算每个节点的连接数", () => {
    const graph = buildNotesGraph([
      note("a", "A"),
      note("b", "B", ["A"]),
      note("c", "C", ["A"]),
    ]);
    const deg = computeDegrees(graph);
    expect(deg.get("a")).toBe(2);
    expect(deg.get("b")).toBe(1);
    expect(deg.get("c")).toBe(1);
  });
});

describe("computeNodeRender", () => {
  const g = buildNotesGraph([note("a", "笔记A"), note("b", "笔记B", ["笔记A"]), note("c", "孤岛")]);
  const deg = computeDegrees(g);

  it("搜索过滤：命中的可见，未命中的淡出", () => {
    const opts = { ...defaultOpts, query: "笔记A" };
    expect(computeNodeRender(g, "a", deg, opts).alpha).toBe(1);
    expect(computeNodeRender(g, "c", deg, opts).alpha).toBe(0.08);
  });

  it("孤岛隐藏：孤立节点不可见", () => {
    const opts = { ...defaultOpts, showOrphans: false };
    expect(computeNodeRender(g, "c", deg, opts).alpha).toBe(0);
    expect(computeNodeRender(g, "a", deg, opts).alpha).toBe(1);
  });

  it("悬停高亮：邻居保持不透明，其余淡出", () => {
    const opts = { ...defaultOpts, highlightId: "a" };
    expect(computeNodeRender(g, "a", deg, opts).alpha).toBe(1);
    expect(computeNodeRender(g, "b", deg, opts).alpha).toBe(1);
    expect(computeNodeRender(g, "c", deg, opts).alpha).toBe(0.08);
  });
});

describe("computeLinkRender", () => {
  const g = buildNotesGraph([note("a", "A"), note("b", "B", ["A"])]);
  const e = g.edges[0]!;

  it("默认可见", () => {
    expect(computeLinkRender(g, e, defaultOpts).alpha).toBeGreaterThan(0);
  });

  it("悬停高亮邻边", () => {
    const opts = { ...defaultOpts, highlightId: "a" };
    expect(computeLinkRender(g, e, opts).alpha).toBe(0.6);
    const opts2 = { ...defaultOpts, highlightId: "c" };
    expect(computeLinkRender(g, e, opts2).alpha).toBe(0.08);
  });
});

describe("matchedNoteIds", () => {
  const nodes = buildNotesGraph([note("a", "线性代数"), note("b", "概率论")]).nodes;

  it("未输入关键字时返回 null", () => {
    expect(matchedNoteIds(nodes, "")).toBeNull();
  });

  it("按标题匹配", () => {
    expect(matchedNoteIds(nodes, "概率")).toEqual(new Set(["b"]));
    expect(matchedNoteIds(nodes, "LINEAR")).toEqual(new Set());
  });

  it("没有命中时返回空集合", () => {
    expect(matchedNoteIds(nodes, "不存在")).toEqual(new Set());
  });
});