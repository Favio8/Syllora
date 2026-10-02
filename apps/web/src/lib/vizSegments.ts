/**
 * 可视化围栏分段器（sc-interactive / chart / diagram）。
 *
 * 把 agent 回复正文按围栏切成 markdown 段与 viz 段，供 MarkdownView 在喂给
 * react-markdown 之前分流（围栏是行级构造，切分点永远落在块边界，不会切断
 * 段落/列表）。流式期间未闭合的围栏产出 closed:false 的 viz 段，渲染侧据此
 * 走占位/降级。
 *
 * 三种围栏：
 *  - ```sc-interactive 自包含 HTML（模型手写，沙箱 iframe 渲染）；
 *  - ```chart          规格化图表 JSON（结构化 → 由 ChartViz 画 SVG，比手写可靠）；
 *  - ```diagram        规格化结构图 JSON（节点/边 → 由 DiagramViz 分层布局）。
 */

/** viz 段的种类：决定由哪个渲染器接管。 */
export type VizKind = "interactive" | "chart" | "diagram";

export interface VizSegment {
  type: "md" | "viz";
  /** viz 段才有：渲染器种类 */
  kind?: VizKind;
  /** md 段 = markdown 文本；viz 段 = 围栏内的载荷（HTML 或 JSON） */
  code: string;
  closed: boolean;
  /** 稳定位置 key（种类-出现序号），流式增长过程中同一位置的段 key 不变 */
  key: string;
}

const FENCE_KINDS: Array<{ kind: VizKind; open: RegExp }> = [
  { kind: "interactive", open: /^ {0,3}```\s*sc-interactive\s*$/ },
  { kind: "chart", open: /^ {0,3}```\s*chart\s*$/ },
  { kind: "diagram", open: /^ {0,3}```\s*diagram\s*$/ },
];
const CLOSE_FENCE = /^ {0,3}```\s*$/;

export function splitVizSegments(content: string): VizSegment[] {
  const segments: VizSegment[] = [];
  let mdLines: string[] = [];
  let vizLines: string[] | null = null;
  let vizKind: VizKind = "interactive";
  let mdCount = 0;
  const kindCounts: Record<VizKind, number> = { interactive: 0, chart: 0, diagram: 0 };

  const flushMd = () => {
    const text = mdLines.join("\n");
    mdLines = [];
    if (text.trim().length === 0) return;
    segments.push({ type: "md", code: text, closed: true, key: `md-${mdCount}` });
    mdCount += 1;
  };

  const pushViz = (closed: boolean) => {
    segments.push({
      type: "viz",
      kind: vizKind,
      code: (vizLines ?? []).join("\n"),
      closed,
      key: `${vizKind}-${kindCounts[vizKind]}`,
    });
    kindCounts[vizKind] += 1;
  };

  for (const line of content.split(/\r?\n/)) {
    if (vizLines === null) {
      const opened = FENCE_KINDS.find(item => item.open.test(line));
      if (opened) {
        flushMd();
        vizKind = opened.kind;
        vizLines = [];
      } else {
        mdLines.push(line);
      }
    } else if (CLOSE_FENCE.test(line)) {
      pushViz(true);
      vizLines = null;
    } else {
      vizLines.push(line);
    }
  }

  if (vizLines !== null) pushViz(false);
  else flushMd();

  return segments;
}
