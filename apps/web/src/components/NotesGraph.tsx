"use client";

/**
 * 笔记知识图谱 — react-force-graph-2d Canvas 渲染。
 * 物理参数与视觉规则取自 Obsidian 图谱源码（sim.js / app.js）：
 * - d3-force：linkDistance 250 / linkStrength 1 / charge -1000 / center 0.1 /
 *   velocityDecay 0.6 / collide(60, 0.5)
 * - 节点半径 = max(8, min(3*sqrt(degree+1), 30))
 * - 悬停：自身与邻居保持不透明，其余淡出；悬停节点加外圈
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2, RotateCcw, Search, X } from "lucide-react";
import dynamic from "next/dynamic";
import { forceX, forceY } from "d3-force";
import { api } from "../lib/api";
import { buildNotesGraph, computeDegrees, matchedNoteIds } from "../lib/notesGraph";
import type { NoteMeta } from "../types/api";
import type { ForceGraphMethods } from "react-force-graph-2d";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

/** Obsidian 默认 8 色（亮色主题）。 */
const COLORS = ["#e93147", "#ec7500", "#e0ac00", "#08b94e", "#00bfbc", "#086ddd", "#7852ee", "#d53984"];
const BG = "#ffffff";
const NODE_FILL = "#2e7cf6";
const LINE = "#c8ccd4";
const TEXT = "#222222";
const FADE = 0.1;
/** 面板里画布比 Obsidian 主画布小，力参数按比例收紧，避免节点飞出视野。 */
const SCALE = 0.55;

/** 极小的持续「漂浮」力：每个未固定节点绕一条很慢的小圆弧摆动（周期约 15–30 秒），
 *  让图一直轻缓浮动而不是算到平衡就静止，也不是每帧随机抖动那种「发抖」。
 *  已固定（拖拽后 fx/fy）的节点不参与。 */
function makeDrift(amplitude: number) {
  type N = { vx?: number; vy?: number; fx?: number | null; fy?: number | null; __ph?: number; __w?: number };
  let nodes: N[] = [];
  let t = 0;
  const force = () => {
    t += 1;
    for (const n of nodes) {
      if (n.fx != null || n.fy != null) continue;
      if (n.__ph === undefined) { n.__ph = Math.random() * Math.PI * 2; n.__w = 0.004 + Math.random() * 0.004; }
      const a = t * (n.__w ?? 0.005) + (n.__ph ?? 0);
      n.vx = (n.vx ?? 0) + Math.cos(a) * amplitude;
      n.vy = (n.vy ?? 0) + Math.sin(a) * amplitude;
    }
  };
  (force as unknown as { initialize: (n: unknown) => void }).initialize = (n) => { nodes = n as N[]; };
  return force;
}

interface GraphNode {
  id: string;
  title: string;
  color: string;
  radius: number;
}

interface GraphLink {
  source: string;
  target: string;
}

export default function NotesGraph({ courseId, refreshKey, fill = false }: { courseId: string; refreshKey: number; fill?: boolean }) {
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const fgRef = useRef<ForceGraphMethods>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 300, h: 360 });

  // 加载笔记
  useEffect(() => {
    if (!courseId) { setNotes([]); return; }
    let alive = true;
    setLoading(true);
    setError("");
    api.notes.list(courseId).then((res) => { if (alive) setNotes(res.notes); })
      .catch((cause: unknown) => { if (!alive) return; setNotes([]); setError(cause instanceof Error ? cause.message : "无法读取笔记"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [courseId, refreshKey]);

  const graph = useMemo(() => buildNotesGraph(notes), [notes]);
  const degrees = useMemo(() => computeDegrees(graph), [graph]);
  const matched = useMemo(() => matchedNoteIds(graph.nodes, query), [graph.nodes, query]);

  // 悬停邻居集（含自身）
  const neighborSet = useMemo(() => {
    if (hoveredId === null) return null;
    const s = new Set<string>([hoveredId]);
    for (const e of graph.edges) {
      if (e.from === hoveredId) s.add(e.to);
      if (e.to === hoveredId) s.add(e.from);
    }
    return s;
  }, [hoveredId, graph.edges]);

  // graphData
  const graphData = useMemo(() => {
    const nodes: GraphNode[] = graph.nodes.map((n, i) => ({
      id: n.id,
      title: n.title,
      color: COLORS[i % COLORS.length],
      // Obsidian 公式：max(8, min(3*sqrt(degree+1), 30))，缩到面板尺度
      radius: Math.max(8, Math.min(3 * Math.sqrt((degrees.get(n.id) ?? 0) + 1), 30)) * 0.62,
    }));
    const links: GraphLink[] = graph.edges.map((e) => ({ source: e.from, target: e.to }));
    return { nodes, links };
  }, [graph, degrees]);

  // 配置 Obsidian 力参数（尺寸）
  const configForces = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const link = fg.d3Force("link");
    if (link) link.distance(250 * SCALE).strength(1);
    const charge = fg.d3Force("charge");
    if (charge) charge.strength(-1000 * SCALE);
    // Obsidian 的 centerStrength 作用于 forceX/forceY（0.1）
    fg.d3Force("x", forceX(0).strength(0.1));
    fg.d3Force("y", forceY(0).strength(0.1));
    fg.d3Force("drift", makeDrift(0.045) as never);
    fg.d3ReheatSimulation();
  }, []);

  // 数据变化后 zoomToFit + 重配力
  const dataKey = `${courseId}-${graph.nodes.length}-${fullscreen}`;
  useEffect(() => {
    if (graph.nodes.length === 0) return;
    const t1 = setTimeout(() => { configForces(); }, 60);
    const t2 = setTimeout(() => fgRef.current?.zoomToFit(400, 60), 200);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [dataKey, configForces, graph.nodes.length]);

  // 画布尺寸变化（含全屏切换）后重新适配——否则图会停在旧尺寸的中心、偏到一边。
  useEffect(() => {
    if (graph.nodes.length === 0) return;
    const t = setTimeout(() => fgRef.current?.zoomToFit(350, 60), 220);
    return () => clearTimeout(t);
  }, [dims.w, dims.h]); // eslint-disable-line react-hooks/exhaustive-deps

  // 选中节点后「观战跟随」：每帧把视口中心对到该节点，节点移动（拖拽/力导向）时镜头跟着走。
  useEffect(() => {
    if (selectedId === null) return;
    let raf = 0;
    const follow = () => {
      const fg = fgRef.current;
      const node = (graphData.nodes as unknown as Array<{ id: string; x?: number; y?: number }>)
        .find((n) => n.id === selectedId);
      if (fg && node && typeof node.x === "number" && typeof node.y === "number") {
        fg.centerAt(node.x, node.y, 0);
      }
      raf = requestAnimationFrame(follow);
    };
    // 先平滑移过去，再逐帧锁定
    const node = (graphData.nodes as unknown as Array<{ id: string; x?: number; y?: number }>).find((n) => n.id === selectedId);
    if (fgRef.current && node && typeof node.x === "number" && typeof node.y === "number") {
      fgRef.current.centerAt(node.x, node.y, 300);
    }
    const t = setTimeout(() => { raf = requestAnimationFrame(follow); }, 320);
    return () => { clearTimeout(t); cancelAnimationFrame(raf); };
  }, [selectedId, graphData]);

  // 容器尺寸
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setDims({ w: Math.round(width), h: Math.round(height) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fullscreen]);

  // 节点透明度：悬停时非邻居淡出；搜索时不命中淡出
  const nodeAlpha = useMemo(() => {
    const m = new Map<string, number>();
    for (const node of graph.nodes) {
      let a = 1;
      if (matched !== null) a = matched.has(node.id) ? 1 : FADE;
      if (hoveredId !== null && neighborSet !== null && a > FADE) {
        a = neighborSet.has(node.id) ? 1 : FADE;
      }
      m.set(node.id, a);
    }
    return m;
  }, [graph.nodes, matched, hoveredId, neighborSet]);

  const edgeAlpha = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of graph.edges) {
      let a = 0.5;
      if (hoveredId !== null && neighborSet !== null) {
        a = neighborSet.has(e.from) && neighborSet.has(e.to) ? 0.9 : FADE * 0.6;
      } else if (matched !== null) {
        a = matched.has(e.from) || matched.has(e.to) ? 0.6 : FADE * 0.6;
      }
      m.set(`${e.from}->${e.to}`, a);
    }
    return m;
  }, [graph.edges, hoveredId, neighborSet, matched]);

  // 节点渲染：圆点 + 悬停外圈 + 标签
  const nodeCanvasObject = useCallback(
    (node: Record<string, unknown>, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const n = node as unknown as GraphNode & { x: number; y: number };
      const alpha = nodeAlpha.get(n.id) ?? 1;
      if (alpha <= 0.001) return;
      const r = n.radius;
      const isHover = hoveredId === n.id;
      const isNeighbor = neighborSet !== null && neighborSet.has(n.id);

      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = isHover ? NODE_FILL : n.color;
      ctx.globalAlpha = alpha;
      ctx.fill();

      // 悬停外圈
      if (isHover) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 3 / globalScale, 0, 2 * Math.PI);
        ctx.strokeStyle = NODE_FILL;
        ctx.lineWidth = 1.5 / globalScale;
        ctx.stroke();
      }

      // 标签：缩放足够大、或悬停、或邻居时显示；屏幕上保持恒定字号
      const showLabel = isHover || globalScale >= 0.3 || (hoveredId !== null && isNeighbor);
      if (showLabel) {
        const fontSize = 12 / globalScale;
        ctx.font = `${fontSize}px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.globalAlpha = isHover ? 1 : alpha * 0.9;
        ctx.fillStyle = TEXT;
        const label = n.title.length > 18 ? n.title.slice(0, 17) + "…" : n.title;
        ctx.fillText(label, n.x, n.y + r + 3 / globalScale);
      }
      ctx.globalAlpha = 1;
    },
    [nodeAlpha, hoveredId, neighborSet],
  );

  const linkCanvasObject = useCallback(
    (link: Record<string, unknown>, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const l = link as unknown as { source: { x: number; y: number; id: string }; target: { x: number; y: number; id: string } };
      const alpha = edgeAlpha.get(`${l.source.id}->${l.target.id}`) ?? 0.5;
      if (alpha <= 0.001) return;
      ctx.beginPath();
      ctx.moveTo(l.source.x, l.source.y);
      ctx.lineTo(l.target.x, l.target.y);
      ctx.strokeStyle = LINE;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 1 / globalScale;
      ctx.stroke();
      ctx.globalAlpha = 1;
    },
    [edgeAlpha],
  );

  const nodePointerAreaPaint = useCallback(
    (node: Record<string, unknown>, color: string, ctx: CanvasRenderingContext2D) => {
      const n = node as unknown as GraphNode & { x: number; y: number };
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius + 4, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
    },
    [],
  );

  const selected = notes.find((n) => n.id === selectedId) ?? null;
  const w = dims.w || (fullscreen ? 800 : 300);
  const h = dims.h || (fullscreen ? 600 : 360);

  const graphEl = (
    <div className="sy-graph-canvas-wrap" ref={containerRef} onDoubleClick={() => setFullscreen(true)} title="双击放大图谱"
      style={fullscreen || fill ? { flex: 1, height: "100%", minHeight: 200 } : { flex: "0 1 auto", height: 360, minHeight: 200 }}>
      {graph.nodes.length > 0 && (
        <ForceGraph2D
          ref={fgRef}
          graphData={graphData}
          width={w}
          height={h}
          backgroundColor={BG}
          nodeRelSize={1}
          nodeVal={(node: unknown) => { const n = node as GraphNode; return n.radius * n.radius; }}
          nodeLabel={(node: unknown) => { const n = node as GraphNode; return n.title; }}
          nodeCanvasObject={nodeCanvasObject as never}
          nodePointerAreaPaint={nodePointerAreaPaint as never}
          linkCanvasObject={linkCanvasObject as never}
          linkPointerAreaPaint={() => {}}
          linkDirectionalArrowLength={0}
          linkDirectionalParticles={0}
          onNodeClick={(node: unknown) => { const n = node as GraphNode; setSelectedId((prev) => (prev === n.id ? null : n.id)); }}
          onNodeHover={(node: unknown) => { const n = node as GraphNode | null; setHoveredId(n?.id ?? null); }}
          onNodeDragEnd={(node: unknown) => {
            const n = node as GraphNode & { fx?: number; fy?: number; x: number; y: number };
            n.fx = n.x; n.fy = n.y;
          }}
          onBackgroundClick={() => {
            setSelectedId(null); setHoveredId(null);
            for (const n of graphData.nodes as unknown as Array<{ fx?: number; fy?: number }>) { n.fx = undefined as unknown as number; n.fy = undefined as unknown as number; }
            fgRef.current?.d3ReheatSimulation();
          }}
          d3AlphaDecay={0.0228}
          d3VelocityDecay={0.6}
          // 引擎不自动停（默认 15s 会停）+ 保持一点 alphaTarget → 图一直「微动」不会静止。
          cooldownTime={Infinity}
          {...{ d3AlphaTarget: 0.02 }}
          enableNodeDrag={true}
          enableZoomInteraction={true}
          enablePanInteraction={true}
          minZoom={0.2}
          maxZoom={8}
          showPointerCursor={(obj: unknown) => obj !== undefined}
        />
      )}
    </div>
  );

  const toolbar = (
    <div className="sy-graph-bar">
      <label className="sy-graph-search">
        <Search size={13} />
        <input aria-label="搜索节点" placeholder="搜索笔记标题…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {query && <button type="button" className="sy-graph-clear" aria-label="清除搜索" onClick={() => setQuery("")}><X size={12} /></button>}
      </label>
      <button type="button" aria-label="重置视图" title="重置视图" onClick={() => fgRef.current?.zoomToFit(400, 60)}><RotateCcw size={12} /></button>
      <button type="button" aria-label={fullscreen ? "退出放大" : "放大图谱"} title={fullscreen ? "退出放大" : "放大图谱（双击画布同样可以）"} onClick={() => setFullscreen(!fullscreen)}>
        {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
      </button>
    </div>
  );

  const body = (
    <div className="sy-graph" style={fullscreen || fill ? { flex: 1, display: "flex", flexDirection: "column", gap: 9, minHeight: 0 } : {}}>
      {toolbar}
      {error && <p className="sy-muted" role="alert">{error}</p>}
      {loading && notes.length === 0 && <p className="sy-muted">正在读取笔记…</p>}
      {!loading && notes.length === 0 && <p className="sy-muted">暂无笔记。打开左栏「笔记」新建第一篇，正文里用 <code>[[笔记标题]]</code> 就会连出线。</p>}
      {notes.length > 0 && graphEl}
      <p className="sy-graph-hint">{notes.length > 0 ? `${graph.nodes.length} 篇 · ${graph.edges.length} 条关联` : ""}</p>
      {selected && (
        <div className="sy-graph-detail" data-testid="notes-graph-detail" key={selected.id}>
          <div><strong>{selected.title}</strong><button type="button" aria-label="关闭详情" onClick={() => setSelectedId(null)}>×</button></div>
          <p>{selected.wikilinks.length > 0 ? `关联：${selected.wikilinks.join("、")}` : "关联：无"}</p>
          <small>{new Date(selected.updatedAt).toLocaleString("zh-CN", { hour12: false })} 更新</small>
          <small className="sy-graph-follow">视角跟随中 · 点空白处取消</small>
        </div>
      )}
    </div>
  );

  if (!courseId) return <p className="sy-muted">请先打开一门课程</p>;

  // 放大：弹窗叠在面板之上（面板里的图谱保持原样，关掉弹窗即回到原视图）。
  const enlarged = (
      <div className="sy-overlay" onClick={() => setFullscreen(false)}>
        <div className="sy-modal" style={{ width: "90vw", height: "85vh", maxWidth: 1100, display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
          <header><h2>笔记知识图谱</h2><button type="button" aria-label="退出放大" onClick={() => setFullscreen(false)}><Minimize2 size={19} /></button></header>
          <div style={{ flex: 1, minHeight: 0, padding: "0 24px 24px" }}>{body}</div>
        </div>
      </div>
  );

  return <>{body}{fullscreen ? enlarged : null}</>;
}