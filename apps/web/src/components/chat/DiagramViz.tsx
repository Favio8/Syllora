"use client";

/**
 * 规格化结构图块 DiagramViz（```diagram 围栏渲染器）。
 *
 * 输入是节点/边规格（OpenMAIC 的 diagram widget 配置：nodes/edges/revealOrder），
 * 布局与连线由本组件负责——模型只描述"有什么、连到哪里"，不画坐标。
 * 好处与 ChartViz 相同：规格可校验（id 唯一、边端点存在、节点数上限），
 * 布局稳定（同一份规格每次渲染位置一致），主题色自动跟随深浅色。
 *
 * revealOrder 存在时提供"逐步揭示"：教学顺序逐层展开，未揭示的节点压暗，
 * 适合讲算法步骤 / 因果链 / 知识结构。
 */

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { VizCodeFallback, VizFrame, VizGenerating, VizSpecError } from "./VizShell";

interface DiagramNode {
  id: string;
  label: string;
  details?: string;
  icon?: string;
}

interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

export interface DiagramSpec {
  diagramType?: "flowchart" | "hierarchy" | "mindmap" | "system";
  direction?: "vertical" | "horizontal";
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  revealOrder?: string[];
}

interface DiagramVizProps {
  code: string;
  closed: boolean;
  streaming?: boolean;
}

const MAX_NODES = 16;
const MAX_EDGES = 32;
const NODE_FONT = 12.5;
const NODE_PAD_X = 12;
const NODE_MIN_W = 90;
const NODE_MAX_W = 220;
const NODE_H = 38;
const NODE_H_DETAILS = 54;
const GAP_X = 22;
const GAP_Y = 46;
const PAD = 12;

type Parsed = { spec: DiagramSpec } | { error: string };

function parseDiagramSpec(code: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(code);
  } catch (error) {
    return { error: `不是合法 JSON（${error instanceof Error ? error.message : "解析失败"}）` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "顶层必须是一个对象" };
  const value = raw as Record<string, unknown>;
  const rawNodes = value["nodes"];
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) return { error: "nodes 必须是非空数组" };
  if (rawNodes.length > MAX_NODES) return { error: `节点最多 ${MAX_NODES} 个` };
  const nodes: DiagramNode[] = [];
  const seen = new Set<string>();
  for (const [index, item] of rawNodes.entries()) {
    if (typeof item !== "object" || item === null) return { error: `第 ${index + 1} 个节点不是对象` };
    const node = item as Record<string, unknown>;
    const id = typeof node["id"] === "string" ? node["id"].trim() : "";
    const label = typeof node["label"] === "string" ? node["label"].trim() : "";
    if (id === "") return { error: `第 ${index + 1} 个节点缺少 id` };
    if (seen.has(id)) return { error: `节点 id 重复：${id}` };
    if (label === "") return { error: `节点 ${id} 缺少 label` };
    seen.add(id);
    nodes.push({
      id,
      label,
      ...(typeof node["details"] === "string" && node["details"].trim() !== "" ? { details: node["details"].trim() } : {}),
      ...(typeof node["icon"] === "string" ? { icon: node["icon"] } : {}),
    });
  }
  const rawEdges = value["edges"];
  const edges: DiagramEdge[] = [];
  if (rawEdges !== undefined) {
    if (!Array.isArray(rawEdges)) return { error: "edges 必须是数组" };
    if (rawEdges.length > MAX_EDGES) return { error: `连线最多 ${MAX_EDGES} 条` };
    for (const [index, item] of rawEdges.entries()) {
      if (typeof item !== "object" || item === null) return { error: `第 ${index + 1} 条连线不是对象` };
      const edge = item as Record<string, unknown>;
      const from = typeof edge["from"] === "string" ? edge["from"].trim() : "";
      const to = typeof edge["to"] === "string" ? edge["to"].trim() : "";
      if (!seen.has(from) || !seen.has(to)) return { error: `连线 ${from || "?"} → ${to || "?"} 的端点不在 nodes 里` };
      if (from === to) return { error: `连线 ${from} → ${to} 指向自身` };
      edges.push({ from, to, ...(typeof edge["label"] === "string" && edge["label"].trim() !== "" ? { label: edge["label"].trim() } : {}) });
    }
  }
  let revealOrder: string[] | undefined;
  if (value["revealOrder"] !== undefined) {
    if (!Array.isArray(value["revealOrder"])) return { error: "revealOrder 必须是数组" };
    const order = value["revealOrder"].filter((item): item is string => typeof item === "string");
    if (order.length !== value["revealOrder"].length) return { error: "revealOrder 里只能放节点 id" };
    if (order.some(id => !seen.has(id))) return { error: "revealOrder 含有未声明的节点 id" };
    revealOrder = order;
  }
  const diagramType = typeof value["diagramType"] === "string" ? value["diagramType"] as DiagramSpec["diagramType"] : undefined;
  const direction = value["direction"] === "horizontal" || value["direction"] === "vertical" ? value["direction"] as DiagramSpec["direction"] : undefined;
  return { spec: { ...(diagramType ? { diagramType } : {}), ...(direction ? { direction } : {}), nodes, edges, ...(revealOrder ? { revealOrder } : {}) } };
}

function textWidth(text: string): number {
  // 粗略字宽：CJK 按字号计，ASCII 按 0.56 计。
  let width = 0;
  for (const char of text) width += /[\u3000-\u9fff\uff00-\uffef]/.test(char) ? NODE_FONT : NODE_FONT * 0.56;
  return width;
}

interface Placed {
  node: DiagramNode;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
}

/** 分层：按最长入边路径定层，层内按声明顺序排开；无入边的节点为第 0 层。 */
function layout(spec: DiagramSpec): { placed: Placed[]; width: number; height: number; horizontal: boolean; order: string[] } {
  const horizontal = spec.direction
    ? spec.direction === "horizontal"
    : spec.diagramType === "mindmap" || spec.diagramType === "hierarchy" || spec.diagramType === "system";
  const depth = new Map<string, number>();
  for (const node of spec.nodes) depth.set(node.id, 0);
  for (let pass = 0; pass < spec.nodes.length; pass++) {
    let changed = false;
    for (const edge of spec.edges) {
      const next = (depth.get(edge.from) ?? 0) + 1;
      if (next > (depth.get(edge.to) ?? 0)) {
        depth.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const layers = new Map<number, DiagramNode[]>();
  for (const node of spec.nodes) {
    const level = depth.get(node.id) ?? 0;
    layers.set(level, [...(layers.get(level) ?? []), node]);
  }
  const sortedLevels = [...layers.keys()].sort((a, b) => a - b);
  const placed: Placed[] = [];
  let main = PAD;
  let cross = PAD;
  for (const level of sortedLevels) {
    const nodes = layers.get(level)!;
    let offset = PAD;
    for (const node of nodes) {
      const w = Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, textWidth(node.label) + NODE_PAD_X * 2));
      const h = node.details ? NODE_H_DETAILS : NODE_H;
      placed.push(horizontal
        ? { node, x: main, y: offset, w, h, depth: level }
        : { node, x: offset, y: main, w, h, depth: level });
      offset += (horizontal ? h : w) + GAP_X;
    }
    cross = Math.max(cross, offset);
    main += (horizontal ? Math.max(...nodes.map(node => Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, textWidth(node.label) + NODE_PAD_X * 2)))) : Math.max(...nodes.map(node => (node.details ? NODE_H_DETAILS : NODE_H)))) + GAP_Y;
  }
  const width = (horizontal ? main : cross) - (GAP_Y - GAP_X) + PAD;
  const height = (horizontal ? cross : main) - (GAP_Y - GAP_X) + PAD;
  return { placed, width: Math.max(width, 200), height: Math.max(height, 120), horizontal, order: sortedLevels.flatMap(level => (layers.get(level) ?? []).map(node => node.id)) };
}

export default function DiagramViz({ code, closed, streaming }: DiagramVizProps) {
  const parsed = useMemo(() => (closed ? parseDiagramSpec(code) : null), [code, closed]);
  const [step, setStep] = useState<number | null>(null);
  if (!closed) {
    if (streaming) return <VizGenerating kind="diagram" />;
    return <VizCodeFallback kind="diagram" code={code} />;
  }
  if (parsed !== null && "error" in parsed) return <VizSpecError kind="diagram" reason={parsed.error} code={code} />;
  if (parsed === null || !("spec" in parsed)) return <VizSpecError kind="diagram" reason="规格为空" code={code} />;
  const spec = parsed.spec;
  const { placed, width, height, horizontal, order } = layout(spec);
  const byId = new Map(placed.map(item => [item.node.id, item]));
  const reveal = spec.revealOrder ?? null;
  const visibleCount = reveal === null ? order.length : (step ?? Math.min(1, reveal.length));
  const visible = new Set(reveal === null ? order : reveal.slice(0, visibleCount));
  const center = (item: Placed) => ({ x: item.x + item.w / 2, y: item.y + item.h / 2 });

  const edges = spec.edges.map((edge, index) => {
    const from = byId.get(edge.from)!;
    const to = byId.get(edge.to)!;
    const a = center(from);
    const b = center(to);
    const dim = !visible.has(edge.from) || !visible.has(edge.to);
    const [start, end] = horizontal
      ? [{ x: from.x + from.w, y: a.y }, { x: to.x - 6, y: b.y }]
      : [{ x: a.x, y: from.y + from.h }, { x: b.x, y: to.y - 6 }];
    const label = edge.label
      ? (() => {
          const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
          const w = textWidth(edge.label) + 8;
          return (
            <g key={`l${index}`} opacity={dim ? 0.2 : 1}>
              <rect x={mid.x - w / 2} y={mid.y - 9} width={w} height={16} rx={4} fill="var(--color-bg-panel)" />
              <text x={mid.x} y={mid.y + 3} fontSize={10.5} textAnchor="middle" fill="var(--color-text-faint)">{edge.label}</text>
            </g>
          );
        })()
      : null;
    const path = horizontal
      ? `M ${start.x} ${start.y} C ${start.x + 18} ${start.y}, ${end.x - 18} ${end.y}, ${end.x} ${end.y}`
      : `M ${start.x} ${start.y} C ${start.x} ${start.y + 18}, ${end.x} ${end.y - 18}, ${end.x} ${end.y}`;
    return (
      <g key={`e${index}`} opacity={dim ? 0.18 : 1}>
        <path d={path} fill="none" stroke="var(--color-border-strong)" strokeWidth={1.4} markerEnd="url(#diagram-arrow)" />
        {label}
      </g>
    );
  });

  const nodes = placed.map(item => {
    const on = visible.has(item.node.id);
    const c = center(item);
    return (
      <g key={item.node.id} opacity={on ? 1 : 0.16} data-node-id={item.node.id}>
        <rect x={item.x} y={item.y} width={item.w} height={item.h} rx={9} fill="var(--color-bg-card)" stroke="var(--color-border-line)" />
        {item.node.icon && <text x={item.x + 10} y={c.y - (item.node.details ? 8 : 0) + 4} fontSize={13} dominantBaseline="middle">{item.node.icon}</text>}
        <text
          x={item.node.icon ? item.x + 28 : item.x + item.w / 2}
          y={c.y - (item.node.details ? 8 : 0)}
          fontSize={NODE_FONT}
          textAnchor={item.node.icon ? "start" : "middle"}
          dominantBaseline="middle"
          fill="var(--color-text-primary)"
        >
          {item.node.label}
        </text>
        {item.node.details && (
          <text x={item.x + item.w / 2} y={c.y + 11} fontSize={10.5} textAnchor="middle" dominantBaseline="middle" fill="var(--color-text-muted)">
            {item.node.details.length > 18 ? `${[...item.node.details].slice(0, 17).join("")}…` : item.node.details}
          </text>
        )}
      </g>
    );
  });

  return (
    <VizFrame kind="diagram" title={spec.diagramType ? DIAGRAM_LABELS[spec.diagramType] ?? "结构图" : "结构图"}>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ maxHeight: 460 }} role="img" aria-label="结构图">
          <defs>
            <marker id="diagram-arrow" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={6} markerHeight={6} orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-border-strong)" />
            </marker>
          </defs>
          {edges}
          {nodes}
        </svg>
      </div>
      {reveal !== null && reveal.length > 1 && (
        <div className="mt-2 flex items-center gap-2 text-[12px] text-text-muted">
          <button type="button" aria-label="上一步" className="rounded-md border border-border-line px-2 py-1 disabled:opacity-40" disabled={visibleCount <= 0} onClick={() => setStep(Math.max(0, visibleCount - 1))}>
            <ChevronLeft size={13} aria-hidden />
          </button>
          <span className="tabular-nums">{visibleCount} / {reveal.length}</span>
          <button type="button" aria-label="下一步" className="rounded-md border border-border-line px-2 py-1 disabled:opacity-40" disabled={visibleCount >= reveal.length} onClick={() => setStep(Math.min(reveal.length, visibleCount + 1))}>
            <ChevronRight size={13} aria-hidden />
          </button>
          <button type="button" aria-label="重来" className="ml-auto flex items-center gap-1 rounded-md border border-border-line px-2 py-1" onClick={() => setStep(0)}>
            <RotateCcw size={12} aria-hidden />重来
          </button>
        </div>
      )}
    </VizFrame>
  );
}

const DIAGRAM_LABELS: Record<string, string> = {
  flowchart: "流程图",
  hierarchy: "层级图",
  mindmap: "思维导图",
  system: "系统结构图",
};
