"use client";

/**
 * 规格化可视化块的外壳：生成中占位、终态降级代码块、规格解析失败提示。
 *
 * ChartViz / DiagramViz 共用：这两个渲染器吃的是**结构化 JSON**，
 * 所以失败模式比 sc-interactive 多一种——JSON 合法但规格不成立
 * （字段缺失、行列不对齐）；那种情况要把原因和原文都摆出来，
 * 学生看到的是"图没画出来"的明确原因，而不是一块空白。
 */

import type { ReactNode } from "react";
import { Activity, ChartColumn, TriangleAlert, Workflow } from "lucide-react";

export type VizShellKind = "chart" | "diagram";

const KIND_META: Record<VizShellKind, { label: string; icon: typeof ChartColumn }> = {
  chart: { label: "图表", icon: ChartColumn },
  diagram: { label: "结构图", icon: Workflow },
};

export function VizGenerating({ kind }: { kind: VizShellKind }) {
  const meta = KIND_META[kind];
  const Icon = meta.icon;
  return (
    <div
      data-viz-card=""
      data-viz-kind={kind}
      data-viz-state="generating"
      className="rounded-lg border border-border-line bg-bg-panel px-3 py-2"
    >
      <div className="flex h-6 items-center gap-1.5">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-faint">
          <Activity size={14} strokeWidth={1.7} aria-hidden />
        </span>
        <span className="text-shimmer text-sm text-text-muted">{meta.label}生成中…</span>
      </div>
    </div>
  );
}

/** 未闭合的终态：降级为普通代码块（与 MarkdownView 的 pre 壳同构）。 */
export function VizCodeFallback({ kind, code }: { kind: VizShellKind; code: string }) {
  const meta = KIND_META[kind];
  return (
    <div
      data-viz-card=""
      data-viz-kind={kind}
      data-viz-state="fallback"
      className="overflow-hidden rounded-xl bg-code-block"
    >
      <div className="px-3.5 py-2 text-[13px] leading-5 text-text-muted">{meta.label}块未闭合</div>
      <pre className="whitespace-pre-wrap break-all px-4 py-4 font-mono text-[13px] leading-[22px] text-text-primary">
        {code}
      </pre>
    </div>
  );
}

export function VizFrame({ kind, title, children }: { kind: VizShellKind; title?: string | undefined; children: ReactNode }) {
  const meta = KIND_META[kind];
  const Icon = meta.icon;
  return (
    <figure
      data-viz-card=""
      data-viz-kind={kind}
      data-viz-state="ready"
      className="overflow-hidden rounded-xl border border-border-line bg-bg-panel"
    >
      <figcaption className="flex items-center gap-2 border-b border-border-faint px-4 py-2.5 text-[13px] leading-5 text-text-muted">
        <Icon size={14} strokeWidth={1.7} className="shrink-0 text-text-faint" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{title && title.trim() !== "" ? title : meta.label}</span>
      </figcaption>
      <div className="px-3 py-3">{children}</div>
    </figure>
  );
}

/** 规格不成立：原因 + 原文，便于学生反馈给模型或人工核对。 */
export function VizSpecError({ kind, reason, code }: { kind: VizShellKind; reason: string; code: string }) {
  const meta = KIND_META[kind];
  return (
    <div
      data-viz-card=""
      data-viz-kind={kind}
      data-viz-state="invalid"
      className="overflow-hidden rounded-xl border border-border-line bg-code-block"
    >
      <div className="flex items-center gap-2 px-3.5 py-2 text-[13px] leading-5 text-accent-warn">
        <TriangleAlert size={14} strokeWidth={1.8} className="shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">{meta.label}规格不完整：{reason}</span>
      </div>
      <pre className="whitespace-pre-wrap break-all px-4 pb-4 font-mono text-[13px] leading-[22px] text-text-primary">
        {code}
      </pre>
    </div>
  );
}
