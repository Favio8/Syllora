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
