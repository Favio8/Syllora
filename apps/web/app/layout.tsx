import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Syllora · AI 学习工作台",
  description:
    "Turn every course into a learning system. 把每一门课程，变成一个会持续进化的学习系统。",
};

/**
 * CR-16：不再向页面注入任何访问凭据（旧实现把宿主 token 写进
 * `window.__SYLLORA__`，任意本机进程 `curl /` 即可提取 token 并调用全部
 * `/api/*`）。生产路径由宿主静态托管交付票据页，页面用本地发现文件里的
 * token 向 `/api/session` 换取 HttpOnly 会话 Cookie；开发模式（`next dev`）
 * 跨端口，README 记录了带 token 的开发调用方式。
 */
const BOOTSTRAP = 'window.__SYLLORA__={hostConfigUrl:"/api/host-config"};'

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <head>
        {/* 只放发现文件桥，不放凭据。 */}
        <script dangerouslySetInnerHTML={{ __html: BOOTSTRAP }} />
      </head>
      <body className="h-full overflow-hidden">
        {children}
        {/* P1-③：动态 favicon（状态角标；客户端组件，SSR 输出为 null 不影响水合） */}
      </body>
    </html>
  );
}
