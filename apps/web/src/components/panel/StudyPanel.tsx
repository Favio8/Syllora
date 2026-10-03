'use client';

/**
 * 学习面板的结构化组件（PRD 需求三：5 个标签精简为 3 组）。
 *
 * 这里只提供「外壳」：卡片（PanelCard）、空状态（PanelEmpty）与三个分组的
 * 布局包裹（TodaySection / StudySection / MaterialsSection）。每组的本地内容
 * 由 `Syllora.tsx`（右栏，即 `.study-panel`）以 children 形式注入，外壳不接管
 * 任何本地逻辑，避免把本地的三标签内容搬进组件后再走样。
 */

import type { ReactNode } from 'react';

/** 面板卡片：统一的 1px 边框 + 圆角 + 内边距（视觉规范：无重阴影）。 */
export function PanelCard({ title, hint, children, className }: { title?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`panel-card ${className ?? ''}`}>
    {title !== undefined && <header className="panel-card-head"><h3>{title}</h3>{hint !== undefined && <span>{hint}</span>}</header>}
    {children}
  </section>;
}

/** 面板空状态：图标 + 一句标题 + 一句说明 + 主按钮（与中栏空状态一致）。 */
export function PanelEmpty({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <div className="panel-empty-state">{icon}<strong>{title}</strong><p>{description}</p>{action}</div>;
}

/** 今日：进度、计划管理与学习证据折叠——本地内容由调用方注入。 */
export function TodaySection({ children }: { children: ReactNode }) {
  return <div className="panel-body-section">{children}</div>;
}

/** 学习：确认学习范围与本地三张单列选项——本地内容由调用方注入。 */
export function StudySection({ children }: { children: ReactNode }) {
  return <div className="panel-body-section">{children}</div>;
}

/** 资料：MaterialInitialization 等——本地内容由调用方注入。 */
export function MaterialsSection({ children }: { children: ReactNode }) {
  return <div className="panel-body-section">{children}</div>;
}
