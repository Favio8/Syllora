"use client";

/**
 * 规格化图表块 ChartViz（```chart 围栏渲染器）。
 *
 * 为什么不让模型手写 SVG：结构化的图表规格能被**校验**（行列对齐、数值有限、
 * 系列数与图例数一致），画错会在测试台被拒；手写 SVG 只能靠肉眼。
 * 规格来自 OpenMAIC 的 chart 元素（chartType + labels/legends/series），
 * 渲染不引入图表库：与应用内既有的统计趋势图一致，用 SVG 直接画，
 * 颜色取主题变量，深浅色自动跟随。
 *
 * 支持：column/bar/line/area/pie/ring/scatter（radar 不支持，走规格错误提示）。
 */

import { useMemo } from "react";
import { VizCodeFallback, VizFrame, VizGenerating, VizSpecError } from "./VizShell";

export interface ChartSpec {
  chartType: "column" | "bar" | "line" | "area" | "pie" | "ring" | "scatter";
  title?: string;
  unit?: string;
  data: { labels: string[]; legends: string[]; series: number[][] };
}

interface ChartVizProps {
  code: string;
  closed: boolean;
  streaming?: boolean;
}

const CHART_TYPES = ["column", "bar", "line", "area", "pie", "ring", "scatter"] as const;
const MAX_LABELS = 24;
const MAX_SERIES = 6;
/** 主题色轮（前 5 个取应用强调色，后两个补位；深色下同样成立）。 */
const PALETTE = [
  "var(--color-accent-focus)",
  "var(--color-accent-alt)",
  "var(--color-accent-warn)",
  "var(--color-accent-pass)",
  "var(--color-accent-fail)",
  "#8b5cf6",
  "#0891b2",
];
const VIEW_W = 680;
const PLOT_TOP = 26;
const AXIS_H = 26;
const LEGEND_H = 26;

type Parsed = { spec: ChartSpec } | { error: string };

/** 逐字段校验：宁可给出明确原因，也不要画一张错图。 */
function parseChartSpec(code: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(code);
  } catch (error) {
    return { error: `不是合法 JSON（${error instanceof Error ? error.message : "解析失败"}）` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "顶层必须是一个对象" };
  const value = raw as Record<string, unknown>;
  const chartType = String(value["chartType"] ?? "");
  if (!(CHART_TYPES as readonly string[]).includes(chartType)) {
    return { error: `chartType 必须是 ${CHART_TYPES.join(" / ")} 之一` };
  }
  const data = value["data"];
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { error: "缺少 data 对象" };
  const { labels, legends, series } = data as Record<string, unknown>;
  if (!Array.isArray(labels) || labels.length === 0) return { error: "data.labels 必须是非空数组" };
  if (labels.length > MAX_LABELS) return { error: `data.labels 最多 ${MAX_LABELS} 项` };
  if (!labels.every(item => typeof item === "string" && item.trim() !== "")) return { error: "data.labels 只能是非空字符串" };
  if (!Array.isArray(legends) || legends.length === 0) return { error: "data.legends 必须是非空数组" };
  if (legends.length > MAX_SERIES) return { error: `data.legends 最多 ${MAX_SERIES} 项` };
  if (!legends.every(item => typeof item === "string" && item.trim() !== "")) return { error: "data.legends 只能是非空字符串" };
  if (!Array.isArray(series) || series.length === 0) return { error: "data.series 必须是非空数组" };
  if (series.length !== legends.length) return { error: `series 有 ${series.length} 组，与 legends 的 ${legends.length} 项不一致` };
  for (const [index, row] of series.entries()) {
    if (!Array.isArray(row) || row.length !== labels.length) {
      return { error: `第 ${index + 1} 组数据有 ${Array.isArray(row) ? row.length : 0} 个值，与 labels 的 ${labels.length} 项不一致` };
    }
    if (!row.every(item => typeof item === "number" && Number.isFinite(item))) {
      return { error: `第 ${index + 1} 组数据含有非数字（数值只能是数字，不要带单位或百分号）` };
    }
  }
  if ((chartType === "pie" || chartType === "ring") && series.length !== 1) {
    return { error: "饼图 / 环图只能有一组数据" };
  }
  return {
    spec: {
      chartType: chartType as ChartSpec["chartType"],
      ...(typeof value["title"] === "string" ? { title: value["title"] as string } : {}),
      ...(typeof value["unit"] === "string" ? { unit: value["unit"] as string } : {}),
      data: {
        labels: labels as string[],
        legends: legends as string[],
        series: series as number[][],
      },
    },
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 轴刻度的整齐步长（1/2/5×10^n）。 */
function niceStep(span: number): number {
  if (span <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(span));
  const normalized = span / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function Legend({ legends, x, y }: { legends: string[]; x: number; y: number }) {
  let offset = 0;
  return (
    <g>
      {legends.map((legend, index) => {
        const item = (
          <g key={legend + index} transform={`translate(${x + offset}, ${y})`}>
            <rect width={9} height={9} rx={2} y={-8} fill={PALETTE[index % PALETTE.length]} />
            <text x={13} y={0} fontSize={11} fill="var(--color-text-muted)">{clip(legend, 12)}</text>
          </g>
        );
        offset += 20 + clip(legend, 12).length * 12;
        return item;
      })}
    </g>
  );
}

export default function ChartViz({ code, closed, streaming }: ChartVizProps) {
  const parsed = useMemo(() => (closed ? parseChartSpec(code) : null), [code, closed]);
  if (!closed) {
    if (streaming) return <VizGenerating kind="chart" />;
    return <VizCodeFallback kind="chart" code={code} />;
  }
  if (parsed !== null && "error" in parsed) return <VizSpecError kind="chart" reason={parsed.error} code={code} />;
  if (parsed === null || !("spec" in parsed)) return <VizSpecError kind="chart" reason="规格为空" code={code} />;
  return <VizFrame kind="chart" title={parsed.spec.title}>{renderChart(parsed.spec)}</VizFrame>;
}

function renderChart(spec: ChartSpec): React.ReactNode {
  const { labels, legends, series } = spec.data;
  const unit = spec.unit ?? "";
  const all = series.flat();
  const rawMax = Math.max(0, ...all);
  const rawMin = Math.min(0, ...all);
  const step = niceStep((rawMax - rawMin || 1) / 4);
  const max = Math.ceil((rawMax === 0 ? step : rawMax) / step) * step;
  const min = Math.floor(rawMin / step) * step;
  const isPie = spec.chartType === "pie" || spec.chartType === "ring";
  const height = isPie ? 240 + LEGEND_H : 240 + AXIS_H + LEGEND_H;
  const plotW = isPie ? VIEW_W - 200 : VIEW_W - 64;
  const plotH = 240 - PLOT_TOP;
  const x0 = isPie ? 100 : 56;
  const baseY = PLOT_TOP + plotH;
  const span = max - min || 1;
  const yOf = (value: number) => baseY - ((value - min) / span) * plotH;
  const groupW = plotW / labels.length;
  const bandW = groupW * 0.72;
  const barW = bandW / series.length;

  if (isPie) {
    const total = series[0]!.reduce((sum, value) => sum + Math.max(0, value), 0);
    const cx = VIEW_W / 2 - 40;
    const cy = PLOT_TOP + plotH / 2;
    const outer = Math.min(plotH / 2, 104);
    const inner = spec.chartType === "ring" ? outer * 0.55 : 0;
    let angle = -Math.PI / 2;
    const slices = labels.map((label, index) => {
      const value = Math.max(0, series[0]![index]!);
      const sweep = total === 0 ? 0 : (value / total) * Math.PI * 2;
      const start = angle;
      const end = angle + sweep;
      angle = end;
      const large = sweep > Math.PI ? 1 : 0;
      const p = (radius: number, at: number) => [cx + radius * Math.cos(at), cy + radius * Math.sin(at)] as const;
      const [sx, sy] = p(outer, start);
      const [ex, ey] = p(outer, end);
      const [isx, isy] = p(inner, end);
      const [ix, iy] = p(inner, start);
      const path = inner === 0
        ? `M ${cx} ${cy} L ${sx} ${sy} A ${outer} ${outer} 0 ${large} 1 ${ex} ${ey} Z`
        : `M ${sx} ${sy} A ${outer} ${outer} 0 ${large} 1 ${ex} ${ey} L ${isx} ${isy} A ${inner} ${inner} 0 ${large} 0 ${ix} ${iy} Z`;
      const mid = start + sweep / 2;
      const [lx, ly] = p(outer + 14, mid);
      const share = total === 0 ? 0 : Math.round((value / total) * 100);
      return (
        <g key={label}>
          <path d={path} fill={PALETTE[index % PALETTE.length]} stroke="var(--color-bg-panel)" strokeWidth={1.5}>
            <title>{`${label}：${round(value)}${unit}（${share}%）`}</title>
          </path>
          {sweep > 0.35 && (
            <text x={lx} y={ly} fontSize={11} textAnchor={lx > cx ? "start" : "end"} dominantBaseline="middle" fill="var(--color-text-muted)">
              {clip(label, 6)} {share}%
            </text>
          )}
        </g>
      );
    });
    return (
      <svg viewBox={`0 0 ${VIEW_W} ${height}`} width="100%" role="img" aria-label={spec.title ?? "图表"}>
        {slices}
        <Legend legends={labels} x={56} y={height - 8} />
      </svg>
    );
  }

  const ticks: number[] = [];
  for (let value = min; value <= max + step / 2; value += step) ticks.push(round(value));
  const axis = (
    <g>
      {ticks.map(value => (
        <g key={value}>
          <line x1={x0} x2={x0 + plotW} y1={yOf(value)} y2={yOf(value)} stroke={value === 0 ? "var(--color-border-strong)" : "var(--color-border-faint)"} strokeWidth={1} />
          <text x={x0 - 8} y={yOf(value)} fontSize={11} textAnchor="end" dominantBaseline="middle" fill="var(--color-text-faint)">
            {round(value)}
          </text>
        </g>
      ))}
      {labels.map((label, index) => (
        <text key={label + index} x={x0 + groupW * index + groupW / 2} y={baseY + 16} fontSize={11} textAnchor="middle" fill="var(--color-text-muted)">
          {clip(label, 6)}
        </text>
      ))}
    </g>
  );

  let plot: React.ReactNode = null;
  if (spec.chartType === "column" || spec.chartType === "bar") {
    plot = series.map((row, seriesIndex) =>
      row.map((value, index) => {
        const center = x0 + groupW * index + groupW / 2;
        const left = center - bandW / 2 + barW * seriesIndex;
        const top = Math.min(yOf(value), yOf(0));
        const size = Math.max(1, Math.abs(yOf(value) - yOf(0)));
        return (
          <rect key={`${seriesIndex}-${index}`} x={left} y={top} width={barW - 2} height={size} rx={2} fill={PALETTE[seriesIndex % PALETTE.length]}>
            <title>{`${labels[index]} · ${legends[seriesIndex]}：${round(value)}${unit}`}</title>
          </rect>
        );
      }),
    );
  } else if (spec.chartType === "line" || spec.chartType === "area") {
    plot = series.map((row, seriesIndex) => {
      const points = row.map((value, index) => `${x0 + groupW * index + groupW / 2},${yOf(value)}`).join(" ");
      const color = PALETTE[seriesIndex % PALETTE.length];
      const areaPath = `M ${x0 + groupW / 2} ${yOf(0)} L ${row.map((value, index) => `${x0 + groupW * index + groupW / 2} ${yOf(value)}`).join(" L ")} L ${x0 + groupW * (row.length - 1) + groupW / 2} ${yOf(0)} Z`;
      return (
        <g key={seriesIndex}>
          {spec.chartType === "area" && <path d={areaPath} fill={color} fillOpacity={0.14} />}
          <polyline points={points} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {row.map((value, index) => (
            <circle key={index} cx={x0 + groupW * index + groupW / 2} cy={yOf(value)} r={3} fill={color}>
              <title>{`${labels[index]} · ${legends[seriesIndex]}：${round(value)}${unit}`}</title>
            </circle>
          ))}
        </g>
      );
    });
  } else {
    // scatter：x 为标签序号，y 为数值；每个系列一组点。
    plot = series.map((row, seriesIndex) =>
      row.map((value, index) => (
        <circle key={`${seriesIndex}-${index}`} cx={x0 + groupW * index + groupW / 2} cy={yOf(value)} r={4} fill={PALETTE[seriesIndex % PALETTE.length]} fillOpacity={0.85}>
          <title>{`${labels[index]} · ${legends[seriesIndex]}：${round(value)}${unit}`}</title>
        </circle>
      )),
    );
  }

  return (
    <svg viewBox={`0 0 ${VIEW_W} ${height}`} width="100%" role="img" aria-label={spec.title ?? "图表"}>
      {axis}
      {plot}
      <Legend legends={legends} x={x0} y={height - 8} />
    </svg>
  );
}
