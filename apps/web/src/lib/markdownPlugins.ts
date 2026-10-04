/**
 * 共享的 markdown 插件集：GFM + 数学公式（KaTeX）。
 *
 * 模型回复里常见 `$…$` 与 `$$…$$`，桌面端离线运行，所以渲染器与字体必须本地
 * 打包：KaTeX 样式随本模块导入一次，字体由 Next 静态导出到 /_next/static/media，
 * 宿主静态服务已支持 woff2 并对其长缓存。
 */
import type { ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

type MarkdownPluginProps = ComponentProps<typeof ReactMarkdown>;

export const MARKDOWN_REMARK_PLUGINS: MarkdownPluginProps['remarkPlugins'] = [remarkGfm, remarkMath];

/** throwOnError=false：模型偶尔写错公式时显示原文，而不是让整条消息渲染失败。 */
export const MARKDOWN_REHYPE_PLUGINS: MarkdownPluginProps['rehypePlugins'] = [[rehypeKatex, { throwOnError: false, strict: false }]];

/**
 * 把模型常见的几种公式写法归一成 remark-math 认得的写法。
 *
 * remark-math 只在「$$ 独占一行、内容另起一行」时当块级公式；单行 `$$x$$` 会被
 * 解析成行内公式，用户看到的就是一行小公式而不是居中大公式。这里在送进
 * react-markdown 之前改写：
 *   - 独占一段的 `$$…$$` / `\[…\]` → 折成多行 `$$`（块级）；
 *   - 行内 `\(…\)` → `$…$`。
 * 代码围栏内的行原样保留（那里面的 $$ 是示例文本，不该被改写）。
 */
export function normalizeMathDelimiters(markdown: string): string {
  if (!markdown.includes('$$') && !markdown.includes('\\(') && !markdown.includes('\\[')) return markdown;
  const out: string[] = [];
  let fence: { char: string; size: number } | null = null;
  for (const line of markdown.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      out.push(line);
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.size && marker[2]!.trim() === '') fence = null;
      continue;
    }
    if (marker) { fence = { char: marker[1]![0]!, size: marker[1]!.length }; out.push(line); continue }
    if (/^\s*\\[\[\]]\s*$/.test(line)) { out.push('$$'); continue }
    const single = /^\s*\$\$(.+?)\$\$\s*$/.exec(line) ?? /^\s*\\\[(.+?)\\\]\s*$/.exec(line);
    if (single) { out.push('$$', single[1]!, '$$'); continue }
    // Backtick spans are literal examples, including math-looking text inside them.
    const spans = line.split(/(`+[^`]*`+)/g);
    out.push(spans.map(part => part.startsWith('`') ? part : part.replace(/\\\((.+?)\\\)/g, (_whole, body: string) => `$${body}$`)).join(''));
  }
  return out.join('\n');
}
