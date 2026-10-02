/**
 * 笔记知识图谱 — 纯函数层。
 * 包括数据构建，以及各种筛选/过滤/局部图的计算逻辑，便于测试。
 */

import type { NoteMeta } from "@/src/types/api";

export interface NotesGraphNode {
  id: string;
  title: string;
  links: string[];
  /** 第一个标签（如果有），用于按标签着色 */
  firstTag?: string;
}

export interface NotesGraphEdge {
  from: string;
  to: string;
}

export interface NotesGraph {
  nodes: NotesGraphNode[];
  edges: NotesGraphEdge[];
}

/** 图谱筛选与显示选项 */
export interface GraphOptions {
  query: string;
  highlightId: string | null;
  filterGroup: string | null;
  showOrphans: boolean;
  localDepth: number; // 0 = 全局, 1~3 = 局部深度
  localCenterId: string | null; // 局部图的中心节点
}

/** 节点显示信息：长什么样、透明度多少 */
export interface NodeRender {
  alpha: number;
  /** 是否可见（visibility 级别，false = 彻底不渲染） */
  visible: boolean;
}

/** 边显示信息 */
export interface LinkRender {
  alpha: number;
  visible: boolean;
}

export function buildNotesGraph(notes: NoteMeta[]): NotesGraph {
  const nodes: NotesGraphNode[] = notes.map((note) => ({
    id: note.id,
    title: note.title,
    links: Array.isArray(note.wikilinks) ? note.wikilinks : [],
  }));
  const idByTitle = new Map<string, string>();
  for (const node of nodes) if (!idByTitle.has(node.title)) idByTitle.set(node.title, node.id);
  const edges: NotesGraphEdge[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    for (const link of node.links) {
      const target = idByTitle.get(link);
      if (target === undefined || target === node.id) continue;
      const fp = `${node.id}->${target}`;
      if (seen.has(fp)) continue;
      seen.add(fp);
      edges.push({ from: node.id, to: target });
    }
  }
  return { nodes, edges };
}

/** 收集所有组标签（按笔记标题首字母/首个#标签） */
export function collectGroups(graph: NotesGraph): string[] {
  const groups = new Set<string>();
  for (const node of graph.nodes) {
    if (node.firstTag) groups.add(node.firstTag);
  }
  return [...groups].sort();
}

/** 计算图上每个节点的度数 */
export function computeDegrees(graph: NotesGraph): Map<string, number> {
  const deg = new Map<string, number>();
  for (const n of graph.nodes) deg.set(n.id, 0);
  for (const e of graph.edges) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  return deg;
}

/** 局部图：从中心节点向外 N 度可达的节点集 */
function localNodeSet(
  graph: NotesGraph,
  centerId: string,
  depth: number,
): Set<string> {
  const visited = new Set<string>([centerId]);
  if (depth <= 0) return visited;

  // 邻接表
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const e of graph.edges) {
    adj.get(e.from)?.push(e.to);
    adj.get(e.to)?.push(e.from);
  }

  let frontier = [centerId];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adj.get(id) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return visited;
}

/** 根据当前选项计算每个节点的渲染参数 */
export function computeNodeRender(
  graph: NotesGraph,
  nodeId: string,
  degrees: Map<string, number>,
  opts: GraphOptions,
): NodeRender {
  // 局部图
  if (opts.localCenterId && opts.localDepth > 0) {
    const local = localNodeSet(graph, opts.localCenterId, opts.localDepth);
    if (!local.has(nodeId)) return { alpha: 0, visible: false };
  }

  // 孤岛隐藏
  if (!opts.showOrphans && (degrees.get(nodeId) ?? 0) === 0) {
    return { alpha: 0, visible: false };
  }

  // 搜索
  let alpha = 1;
  if (opts.query) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    const match = node && node.title.toLowerCase().includes(opts.query.toLowerCase().trim());
    if (!match) alpha = 0.08;
  }

  // 悬停高亮
  if (opts.highlightId && opts.highlightId !== nodeId) {
    // 检查是否是邻居
    const isNeighbor = graph.edges.some(
      (e) =>
        (e.from === opts.highlightId && e.to === nodeId) ||
        (e.to === opts.highlightId && e.from === nodeId),
    );
    if (!isNeighbor) alpha = Math.min(alpha, 0.08);
  }

  return { alpha, visible: alpha > 0.005 };
}

/** 根据当前选项计算每条边的渲染参数 */
export function computeLinkRender(
  graph: NotesGraph,
  edge: NotesGraphEdge,
  opts: GraphOptions,
): LinkRender {
  // 局部图
  if (opts.localCenterId && opts.localDepth > 0) {
    const local = localNodeSet(graph, opts.localCenterId, opts.localDepth);
    if (!local.has(edge.from) || !local.has(edge.to)) return { alpha: 0, visible: false };
  }

  // 搜索/悬停时边跟随两端节点的最低透明度
  let alpha = 0.3;

  if (opts.highlightId) {
    const linked =
      edge.from === opts.highlightId || edge.to === opts.highlightId;
    alpha = linked ? 0.6 : 0.08;
  } else if (opts.query) {
    const nodeFrom = graph.nodes.find((n) => n.id === edge.from);
    const nodeTo = graph.nodes.find((n) => n.id === edge.to);
    const fromMatch = nodeFrom?.title.toLowerCase().includes(opts.query.toLowerCase().trim());
    const toMatch = nodeTo?.title.toLowerCase().includes(opts.query.toLowerCase().trim());
    alpha = fromMatch || toMatch ? 0.4 : 0.08;
  }

  return { alpha, visible: alpha > 0.005 };
}

export function matchedNoteIds(nodes: NotesGraphNode[], query: string): Set<string> | null {
  const needle = query.trim().toLowerCase();
  if (needle === "") return null;
  const matched = new Set<string>();
  for (const node of nodes) if (node.title.toLowerCase().includes(needle)) matched.add(node.id);
  return matched;
}