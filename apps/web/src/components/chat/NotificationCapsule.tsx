'use client';

/**
 * 需求五：右下角通知胶囊（任务进行中常驻，终态才消失）。
 *
 * 旧实现把任务进度作为横条钉在中栏底部（`sy-job`），另有 `sy-init-failures`
 * 失败列表与 `coverageNote` 覆盖提示分散在别处，中栏被横条占据且四处不统一。
 * 这里把「进行中任务 / 刚结束结果 / 初始化失败明细」收到一个常驻胶囊 + 可展开
 * 的通知面板里：
 *  - 胶囊从任务开始出现，**直到任务终态才消失**；失败或需用户处理的条目保留
 *    到手动关闭（已读/未读有区分）；
 *  - 同一课程多任务不互相覆盖，按课程标注名称；
 *  - 键盘可达（按钮 + Esc 收起），状态变化用 aria-live 播报；
 *  - 顶部错误 banner 保持现状（这里不接管）。
 *
 * 状态来自后端已有的 job 轮询数据（无接口变更），因此切课、切视图、刷新后
 * 仍能正确恢复（后端仍有 running job 时胶囊会重新出现）。
 */

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bell, CheckCircle2, LoaderCircle, X } from 'lucide-react';
import type { SylloraState } from '../../types/syllora';
import '@/src/features/workbench/notification.css';

type Job = SylloraState['jobs'][number];
/** 本地 job 类型尚未声明 etaMs（那处类型改动不属本次移植范围），按可选字段收窄。 */
type JobProgress = NonNullable<Job['progress']> & { etaMs?: number };

export interface NotificationCapsuleProps {
  jobs: Job[];
  /** 课程 id → 显示名（面板按课程标注，避免同名任务混在一起）。 */
  courseName: (courseId: string) => string;
  /** 取消进行中任务。 */
  onCancel: (jobId: string) => void;
  /** 重试失败任务（可选：没有可重试动作时不显示）。 */
  onRetry?: (job: Job) => void;
  /** 失败页明细入口（跳到该课程的「资料」分组）。 */
  onOpenFailures?: (courseId: string) => void;
}

/** 已读集合只存在本会话内存里：刷新后再次提示比静默丢掉更安全。 */
const dismissed = new Set<string>()
/** 测试用：清空已读集合（生产代码不调用）。 */
export function resetDismissedNotifications(): void { dismissed.clear() };
/** 成功后自动消失的停留时间（待确认事项 6 的建议值：停留数秒后消失）。 */
const SUCCESS_LINGER_MS = 6000;

interface Entry {
  job: Job;
  kind: 'running' | 'failed' | 'succeeded';
  /** 成功条目在停留期结束后自动移出面板。 */
  readonly: boolean;
}

export default function NotificationCapsule({ jobs, courseName, onCancel, onRetry, onOpenFailures }: NotificationCapsuleProps) {
  const [open, setOpen] = useState(false);
  const [closedSuccesses, setClosedSuccesses] = useState<ReadonlySet<string>>(new Set());
  /** 成功条目进入停留计时；到点后从面板移出（胶囊随之消失）。 */
  const [expired, setExpired] = useState<ReadonlySet<string>>(new Set());
  const panelRef = useRef<HTMLDivElement>(null);
  const capsuleRef = useRef<HTMLButtonElement>(null);

  const entries: Entry[] = jobs
    .filter(job => job.state === 'running' || job.state === 'failed' || job.state === 'succeeded')
    .filter(job => !dismissed.has(job.id))
    .filter(job => !(job.state === 'succeeded' && (closedSuccesses.has(job.id) || expired.has(job.id))))
    .map(job => ({ job, kind: job.state === 'running' ? 'running' : job.state === 'failed' ? 'failed' : 'succeeded', readonly: job.state === 'succeeded' }));

  const running = entries.filter(entry => entry.kind === 'running');
  const needsAttention = entries.filter(entry => entry.kind === 'failed');

  // 成功条目停留数秒后自动消失（失败与进行中不自动消失，见需求 3）。
  useEffect(() => {
    const timers = entries
      .filter(entry => entry.kind === 'succeeded')
      .map(entry => window.setTimeout(() => setExpired(current => new Set([...current, entry.job.id])), SUCCESS_LINGER_MS));
    return () => { for (const timer of timers) window.clearTimeout(timer); };
  }, [entries.map(entry => `${entry.job.id}:${entry.job.state}`).join(',')]);

  // Esc 收起面板并把焦点交还胶囊（键盘可达）。
  useEffect(() => {
    if (!open) return;
    function key(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      capsuleRef.current?.focus();
    }
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open]);

  if (entries.length === 0) return null;

  const unread = needsAttention.length + running.length;
  const summary = running.length > 0
    ? `${running.length > 1 ? `${running.length} 个任务进行中` : '整理中'}${running[0]!.job.progress ? ` ${running[0]!.job.progress!.done}/${running[0]!.job.progress!.total}` : ''}`
    : needsAttention.length > 0
      ? `${needsAttention.length} 个任务失败`
      : '任务已完成';

  function dismiss(id: string) {
    dismissed.add(id);
    setClosedSuccesses(current => new Set([...current, id]));
    setExpired(current => new Set([...current, id]));
  }

  return <div className="notification-dock" data-notification-dock="">
    {/* aria-live：进行中/失败条数变化时播报（需求 6 可访问性）。 */}
    <p className="sr-only" role="status" aria-live="polite">{summary}</p>

    {open && <div className="notification-panel" ref={panelRef} role="dialog" aria-label="通知面板">
      <header>
        <h3>通知</h3>
        <span>{running.length > 0 ? `${running.length} 进行中` : needsAttention.length > 0 ? `${needsAttention.length} 待处理` : '已结束'}</span>
        <button type="button" aria-label="收起通知面板" onClick={() => { setOpen(false); capsuleRef.current?.focus(); }}><X size={15} /></button>
      </header>
      <div className="notification-list">
        {entries.map(entry => {
          const progress = entry.job.progress as JobProgress | undefined;
          return <article className={`notification-item ${entry.kind}`} key={entry.job.id}>
            <span className="notification-icon" aria-hidden>
              {entry.kind === 'running' ? <LoaderCircle size={15} className="spin" /> : entry.kind === 'failed' ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
            </span>
            <div className="notification-copy">
              <strong>{courseName(entry.job.courseId)}</strong>
              <p>{entry.job.message || (entry.kind === 'running' ? '处理中…' : entry.kind === 'failed' ? '任务失败' : '任务完成')}</p>
              {progress && <small>
                {progress.stage === 'organizing' ? '整理' : progress.stage === 'parsing' ? '解析' : progress.stage === 'scanning' ? '扫描' : '校验'}
                {' '}{progress.done}/{progress.total}
                {typeof progress.etaMs === 'number' && progress.etaMs > 0 ? ` · 预计剩余约 ${Math.max(1, Math.round(progress.etaMs / 1000))} 秒` : ''}
              </small>}
              {entry.kind === 'failed' && entry.job.errorCode && <small>错误代码 {entry.job.errorCode}</small>}
            </div>
            <div className="notification-actions">
              {entry.kind === 'running' && <button type="button" onClick={() => onCancel(entry.job.id)}>取消</button>}
              {entry.kind === 'failed' && onRetry && <button type="button" onClick={() => onRetry(entry.job)}>重试</button>}
              {entry.kind === 'failed' && onOpenFailures && <button type="button" onClick={() => onOpenFailures(entry.job.courseId)}>查看失败页</button>}
              {entry.kind !== 'running' && <button type="button" onClick={() => dismiss(entry.job.id)}>关闭</button>}
            </div>
            {entry.kind !== 'running' && progress?.failures?.length ? <ul className="notification-failures">
              {progress.failures.slice(0, 8).map((failure, index) => <li key={index}>{failure}</li>)}
              {progress.failures.length > 8 && <li>另有 {progress.failures.length - 8} 条…</li>}
            </ul> : null}
          </article>;
        })}
      </div>
    </div>}

    <button
      type="button"
      ref={capsuleRef}
      className={`notification-capsule ${running.length > 0 ? 'is-running' : needsAttention.length > 0 ? 'is-failed' : 'is-done'}`}
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={() => setOpen(value => !value)}
    >
      <span className="notification-capsule-icon" aria-hidden>
        {running.length > 0 ? <LoaderCircle size={15} className="spin" /> : needsAttention.length > 0 ? <AlertTriangle size={15} /> : <Bell size={15} />}
      </span>
      <span className="notification-capsule-text">{summary}</span>
      {unread > 0 && <span className="notification-capsule-badge" aria-label={`${unread} 条未读`}>{unread}</span>}
    </button>
  </div>;
}
