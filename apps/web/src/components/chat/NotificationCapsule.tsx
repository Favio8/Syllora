'use client';

/**
 * 左栏「任务」入口（本项目改动）：常驻的纯图标按钮，外观与 `.rail-button` 导航项一致；
 * 悬停/聚焦时以侧栏同款 `.rail-tooltip` 显示当前状态文字，点击进入整页「任务」视图
 * （见 TasksPage），不再弹出浮层面板。
 *
 * 图标随状态变化：有进行中任务 → 蓝色旋转；有失败 → 红色三角；否则铃铛。
 * 状态来自后端已有的 job 轮询数据（无接口变更）。
 */

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Bell, LoaderCircle } from 'lucide-react';
import type { SylloraState } from '../../types/syllora';
import '@/src/features/workbench/notification.css';

type Job = SylloraState['jobs'][number];

export interface NotificationCapsuleProps {
  jobs: Job[];
  /** 当前是否正处于任务页（用于选中态）。 */
  active?: boolean;
  /** 点击：进入任务页。 */
  onOpen: () => void;
}

export default function NotificationCapsule({ jobs, active = false, onOpen }: NotificationCapsuleProps) {
  /** 悬停/聚焦时的文字气泡（与侧栏导航项的 .rail-tooltip 同款）。 */
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  const running = jobs.filter(job => job.state === 'running');
  const failed = jobs.filter(job => job.state === 'failed' && !job.dismissedAt);
  const first = running[0]?.progress;
  const summary = running.length > 0
    ? `${running.length > 1 ? `${running.length} 个任务进行中` : '整理中'}${first ? ` ${first.done}/${first.total}` : ''}`
    : failed.length > 0
      ? `${failed.length} 个任务失败`
      : '任务';
  const unread = running.length + failed.length;

  function show(event: React.MouseEvent<HTMLButtonElement> | React.FocusEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    setTip({ x: rect.right + 12, y: rect.top + rect.height / 2 });
  }

  return <div className="notification-dock" data-notification-dock="">
    {/* aria-live：进行中/失败条数变化时播报。 */}
    <p className="sr-only" role="status" aria-live="polite">{unread > 0 ? summary : ''}</p>
    <button
      type="button"
      className={`rail-button notification-capsule ${active ? 'active' : ''} ${running.length > 0 ? 'is-running' : failed.length > 0 ? 'is-failed' : 'is-done'}`}
      aria-label={summary}
      aria-current={active ? 'page' : undefined}
      onMouseEnter={show}
      onMouseLeave={() => setTip(null)}
      onFocus={show}
      onBlur={() => setTip(null)}
      onClick={() => { setTip(null); onOpen(); }}
    >
      <span className="notification-capsule-icon" aria-hidden>
        {running.length > 0 ? <LoaderCircle size={21} strokeWidth={1.65} className="spin" /> : failed.length > 0 ? <AlertTriangle size={21} strokeWidth={1.65} /> : <Bell size={21} strokeWidth={1.65} />}
      </span>
    </button>
    {tip && createPortal(<span className="rail-tooltip" role="tooltip" style={{ left: tip.x, top: tip.y }}>{summary}</span>, document.body)}
  </div>;
}
