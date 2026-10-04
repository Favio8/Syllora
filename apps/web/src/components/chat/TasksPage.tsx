'use client';

/**
 * 任务页（本项目新增，不属于主应用）：点击左栏通知入口后进入的整页视图，
 * 取代原来的通知小浮层。展示全部后台任务（进行中 / 失败 / 已完成 / 已取消），
 * 不再有「成功后 6 秒自动消失」，可在此查看进度、耗时、错误码并取消/查看失败页。
 * 布局复用资料库页的 catalog-scroll 容器与页面标题样式（catalog-intro）。
 */

import { AlertTriangle, Ban, CheckCircle2, ListChecks, LoaderCircle, Trash2 } from 'lucide-react';
import type { SylloraState } from '../../types/syllora';
import '@/src/features/workbench/notification.css';

type Job = SylloraState['jobs'][number];
type JobProgress = NonNullable<Job['progress']> & { etaMs?: number };

export interface TasksPageProps {
  jobs: Job[];
  /** 课程 id → 显示名（按课程标注，避免同名任务混在一起）。 */
  courseName: (courseId: string) => string;
  onCancel: (jobId: string) => void;
  /** 失败页明细入口（跳到该课程的「资料」分组）。 */
  onOpenFailures?: (courseId: string) => void;
  /** 清除历史任务（只清已结束的；进行中保留）。 */
  onClear?: () => void;
}

const STAGE: Record<string, string> = { organizing: '整理', parsing: '解析', scanning: '扫描' };
const STATE_LABEL: Record<string, string> = { running: '进行中', failed: '失败', succeeded: '已完成', cancelled: '已取消' };

function formatTime(value?: number | null): string {
  if (!value) return '';
  return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function formatElapsed(ms?: number | null): string {
  if (typeof ms !== 'number' || ms < 0) return '';
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export default function TasksPage({ jobs, courseName, onCancel, onOpenFailures, onClear }: TasksPageProps) {
  // 进行中的排最前，其余按创建时间倒序（最新的在上）。
  const sorted = [...jobs].sort((a, b) => {
    const ra = a.state === 'running' ? 0 : 1;
    const rb = b.state === 'running' ? 0 : 1;
    return ra - rb || (b.createdAt ?? 0) - (a.createdAt ?? 0);
  });
  const running = jobs.filter(job => job.state === 'running').length;
  const failed = jobs.filter(job => job.state === 'failed').length;

  return <div className="catalog-scroll tasks-page">
    <div className="catalog-intro">
      <div className="eyebrow">任务</div>
      <div className="tasks-head-row">
        <h1>{running > 0 ? `${running} 个任务进行中` : failed > 0 ? `${failed} 个任务需要处理` : jobs.length ? '所有任务已完成' : '暂无任务'}</h1>
        {onClear && jobs.some(job => job.state !== 'running') && <button type="button" className="button small" onClick={onClear}><Trash2 size={14} />清除历史任务</button>}
      </div>
    </div>

    {sorted.length === 0
      ? <div className="catalog-empty"><ListChecks size={34} /><h3>没有任务</h3><p>整理资料、生成大纲等后台任务会显示在这里。</p></div>
      : <div className="tasks-list">
        {sorted.map(job => {
          const progress = job.progress as JobProgress | undefined;
          const pct = progress && progress.total > 0 ? Math.min(100, Math.round(progress.done / progress.total * 100)) : null;
          const failures = job.state !== 'running' ? progress?.failures ?? [] : [];
          return <article className={`task-card ${job.state}`} key={job.id}>
            <span className="task-card-icon" aria-hidden>
              {job.state === 'running' ? <LoaderCircle size={20} className="spin" />
                : job.state === 'failed' ? <AlertTriangle size={20} />
                  : job.state === 'cancelled' ? <Ban size={20} /> : <CheckCircle2 size={20} />}
            </span>
            <div className="task-card-main">
              <div className="task-card-head">
                <strong>{courseName(job.courseId)}</strong>
                <span className={`task-state ${job.state}`}>{STATE_LABEL[job.state] ?? job.state}</span>
              </div>
              <p>{job.message || (job.state === 'running' ? '处理中…' : job.state === 'failed' ? '任务失败' : job.state === 'cancelled' ? '任务已取消' : '任务完成')}</p>
              {progress && job.state === 'running' && <div className="task-progress">
                <div className="task-progress-track" role="progressbar" aria-label="任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? 0}><span style={{ width: `${pct ?? 0}%` }} /></div>
                <small>
                  {STAGE[progress.stage] ?? '校验'} {progress.done}/{progress.total}
                  {typeof progress.etaMs === 'number' && progress.etaMs > 0 ? ` · 预计剩余约 ${Math.max(1, Math.round(progress.etaMs / 1000))} 秒` : ''}
                </small>
              </div>}
              <small className="task-meta">
                {[formatTime(job.createdAt), job.state !== 'running' && formatElapsed(job.elapsedMs) ? `耗时 ${formatElapsed(job.elapsedMs)}` : '', job.state === 'failed' && job.errorCode ? `错误代码 ${job.errorCode}` : ''].filter(Boolean).join(' · ')}
              </small>
              {failures.length > 0 && <ul className="notification-failures">
                {failures.slice(0, 8).map((failure, index) => <li key={index}>{failure}</li>)}
                {failures.length > 8 && <li>另有 {failures.length - 8} 条…</li>}
              </ul>}
            </div>
            <div className="task-card-actions">
              {job.state === 'running' && <button type="button" className="button" onClick={() => onCancel(job.id)}>取消</button>}
              {job.state === 'failed' && onOpenFailures && <button type="button" className="button" onClick={() => onOpenFailures(job.courseId)}>查看失败页</button>}
            </div>
          </article>;
        })}
      </div>}
  </div>;
}
