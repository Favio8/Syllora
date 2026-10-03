'use client';

import PptxGenJS from 'pptxgenjs';

/**
 * 把一张幻灯片导出成 PPTX。
 *
 * 与上游的取舍：OpenMAIC 在自己的应用层用约 52 KB 的 `use-export-pptx.ts` 做 HTML→PPTX，
 * 依赖它改造过的 `pptxgenjs` 分支与 HTML→OMML 公式链路。这里只做**布局保真**的聚焦实现：
 * 画布坐标是权威的（DSL 契约保证元素都在 1000×562 内），因此按坐标把元素映射成 PPT 形状，
 * 不试图还原 HTML 的行内样式细节。文本里保留换行与段落，内联标签做保守降级。
 *
 * DSL 的坐标系：`canvas.viewportSize` 是画布宽度（本仓库生成器固定 1000），元素
 * `left/top/width/height` 都在这个坐标系里。PPT 用英寸，因此按 `10 / viewportSize` 换算。
 */

/** PPT 版式宽度固定 10 英寸；高度按 `viewportRatio` 推导，保持原始比例。 */
const PPT_WIDTH_IN = 10;

interface SlideElement {
  type: string;
  id?: string;
  left: number;
  top: number;
  width: number;
  height: number;
  rotate?: number;
  [key: string]: unknown;
}

interface SlideCanvas {
  viewportSize: number;
  viewportRatio: number;
  theme?: { backgroundColor?: string; fontColor?: string; fontName?: string };
  background?: { color?: string; type?: string };
  elements: SlideElement[];
}

/** 保守的 HTML→纯文本：段落与 <br> 变行，其余标签去掉，实体做最小还原。 */
export function elementText(html: string): string {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '· ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** 从内联样式里取字号（px），取不到就退回传入的默认值。 */
export function elementFontSize(html: string, fallback: number): number {
  const match = /font-size\s*:\s*(\d+(?:\.\d+)?)px/i.exec(String(html ?? ''));
  const size = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(size) && size > 0 ? size : fallback;
}

/** 取一个有限数值，取不到就用 fallback。用于画布上可能缺失的坐标字段。 */
function finiteOr(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** 把 SVG path 包成 data URI 图，交给 pptxgenjs 作为图片插入（形状保真的最简单做法）。 */
function shapeDataUri(element: SlideElement): string | null {
  const path = typeof element.path === 'string' ? element.path : '';
  if (!path) return null;
  const viewBox = Array.isArray(element.viewBox) ? element.viewBox : [element.width, element.height];
  const fill = typeof element.fill === 'string' && element.fill ? element.fill : '#5b9bd5';
  const width = Number(viewBox[0]) || element.width;
  const height = Number(viewBox[1]) || element.height;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><path d="${path}" fill="${fill}"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

/** 把一张画布渲染进给定的 pptx 幻灯片。返回实际写入的元素数量，便于测试与诊断。 */
export function renderCanvas(slide: PptxGenJS.Slide, canvas: SlideCanvas): number {
  const scale = PPT_WIDTH_IN / (Number(canvas.viewportSize) || 1000);
  const theme = canvas.theme ?? {};
  let written = 0;

  for (const element of canvas.elements ?? []) {
    const box = {
      x: element.left * scale,
      y: element.top * scale,
      w: element.width * scale,
      h: element.height * scale,
    };
    try {
      if (element.type === 'text') {
        const content = elementText(String(element.content ?? ''));
        if (!content) continue;
        // pptxgenjs 的 addText 收 `TextProps[]`：每一段是对象而不是裸字符串，换行用 breakLine 表示。
        const runs = content.split('\n').map((line, index, all) => ({
          text: line,
          options: { breakLine: index < all.length - 1 },
        }));
        slide.addText(runs, {
          ...box,
          color: String(element.defaultColor ?? theme.fontColor ?? '#202128').replace('#', ''),
          fontFace: String(element.defaultFontName ?? theme.fontName ?? 'Microsoft YaHei'),
          fontSize: elementFontSize(String(element.content ?? ''), 24),
          valign: 'top',
          margin: 0,
        });
        written++;
      } else if (element.type === 'latex') {
        const content = String(element.latex ?? element.content ?? '').trim();
        if (!content) continue;
        // 公式不做 OMML 转换（那是上游那条约 52 KB 的链路）：以原文呈现，保证内容不丢。
        slide.addText([{ text: content, options: { breakLine: false } }], { ...box, color: '202128', fontFace: 'Consolas', fontSize: 18, margin: 0 });
        written++;
      } else if (element.type === 'image') {
        const src = typeof element.src === 'string' ? element.src : '';
        if (!src) continue;
        slide.addImage({ data: src, ...box });
        written++;
      } else if (element.type === 'shape') {
        const data = shapeDataUri(element);
        if (!data) continue;
        slide.addImage({ data, ...box });
        written++;
      } else if (element.type === 'line') {
        const start = Array.isArray(element.start) ? element.start : [0, 0];
        // 线段的 start 是元素内的偏移。取不到有限数值时退回 0，
        // 不能写 `Number(x) ?? fallback`——Number() 永不返回 nullish，那样兜底是死代码。
        slide.addShape('line', {
          x: (element.left + finiteOr(start[0], 0)) * scale,
          y: (element.top + finiteOr(start[1], 0)) * scale,
          w: Math.max(box.w, 0.01),
          h: Math.max(box.h, 0.01),
          line: { color: String((element as { color?: string }).color ?? '#202128').replace('#', ''), width: 1 },
        });
        written++;
      } else if (element.type === 'table') {
        const data = Array.isArray(element.data) ? element.data : [];
        const rows = data.map((row: unknown) => {
          const cells = Array.isArray(row) ? row : [];
          return cells.map((cell: unknown) => {
            const value = cell && typeof cell === 'object' ? (cell as { text?: unknown }).text : cell;
            return { text: elementText(String(value ?? '')) };
          });
        }).filter((row: unknown[]) => row.length > 0);
        if (rows.length === 0) continue;
        slide.addTable(rows as never, { ...box, fontSize: 12, border: { type: 'solid', color: 'D0D5DD', pt: 1 } });
        written++;
      }
      // chart / video / audio：需要额外的数据与媒体链路，本轮不写，避免产出坏形状。
    } catch (error) {
      // 单个元素失败不该让整份导出失败。但必须留痕：完全静默会把"API 用错"这类错误藏起来。
      console.warn('幻灯片元素导出失败，已跳过', element.type, error instanceof Error ? error.message : String(error));
    }
  }
  return written;
}

/** 组装一份包含全部章节的 PPTX。每个章节一张幻灯片（画布本身就是一页）。 */
export function buildPptx(decks: Array<{ chapter: string; scenes: Array<{ title: string; content: { canvas: unknown } }> }>): PptxGenJS {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'SYLLORA_16_9', width: PPT_WIDTH_IN, height: PPT_WIDTH_IN * 0.5625 });
  pptx.layout = 'SYLLORA_16_9';
  for (const deck of decks) {
    for (const scene of deck.scenes ?? []) {
      const canvas = scene.content?.canvas as SlideCanvas | undefined;
      if (!canvas) continue;
      const slide = pptx.addSlide();
      slide.addNotes(`${deck.chapter} · ${scene.title}`);
      const background = canvas.background?.color ?? canvas.theme?.backgroundColor;
      if (background) slide.background = { color: String(background).replace('#', '') };
      const written = renderCanvas(slide, canvas);
      if (written === 0) {
        // 整页没有任何元素写进去，多半是上游产出的画布形状超出本导出器的支持范围。
        // 不静默：导出结果里少一页是用户能看见的问题，应当留下痕迹。
        console.warn(`幻灯片页「${deck.chapter} · ${scene.title}」没有可导出的元素，已跳过`);
      }
    }
  }
  return pptx;
}

/** 触发浏览器下载。文件名带章节数，便于区分多次导出。 */
export async function exportDecksToPptx(
  decks: Array<{ chapter: string; scenes: Array<{ title: string; content: { canvas: unknown } }> }>,
  fileName = 'syllora-slides.pptx',
): Promise<number> {
  const scenes = decks.reduce((total, deck) => total + (deck.scenes?.length ?? 0), 0);
  if (scenes === 0) throw new Error('没有可导出的幻灯片');
  const blob = await buildPptx(decks).write({ outputType: 'blob' });
  const url = URL.createObjectURL(blob as Blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return scenes;
}
