'use client';

/**
 * 学习面板的结构化组件（PRD 需求三：5 个标签精简为 3 组）。
 *
 * 面板原本是 `Syllora.tsx` 里一整个 `tab === ... ? ... :` 的三元链，五个标签的
 * 内容混在单行 JSX 里。这里按「今日 / 学习 / 资料」三组拆成各自可读的组件，
 * 内容逐项搬运（不丢信息），只调整分组、标题层级与样式类。
 */

import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, Check, FileText, Trash2, Upload } from 'lucide-react';
import type { Task, CourseView, SylloraState } from '../../types/syllora';
import { LearningJobDiagnostics, LearningMetrics } from '../syllora-metrics';
import { MaterialInitialization, MaterialPreview } from '../syllora-project-ui';

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

export interface TodaySectionProps {
  course: CourseView;
  busy: boolean;
  activeTask: string | null;
  pointName: (id: string) => string;
  formatTime: (at: number, zone: string) => string;
  onReadLecture: () => void;
  onOpenOutline: () => void;
  onOpenMaterials: () => void;
  onStartTask: (task: Task) => void;
  onOpenDiff: () => void;
  onRun: (action: string, payload?: Record<string, unknown>) => Promise<unknown>;
  setError: (message: string) => void;
  /** 错答后「已生成计划调整草案」的提示（中栏提交后回流到这里）。 */
  adjustNotice: string | null;
}

/** 今日：下一步、进度、证据分布、待确认草案、已确认计划；记录收入折叠区。 */
export function TodaySection({ course, busy, activeTask, pointName, formatTime, onReadLecture, onOpenOutline, onOpenMaterials, onStartTask, onOpenDiff, onRun, setError, adjustNotice }: TodaySectionProps) {
  const [editMinutes, setEditMinutes] = useState<Record<string, string>>({});
  const task = course.plan?.tasks.find(item => item.id === activeTask) ?? course.plan?.tasks.find(item => item.status === 'in_progress');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: course.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now());

  return <>
    {adjustNotice && <div className="sy-adjust-notice" role="status"><p>{adjustNotice}</p></div>}
    <PanelCard title="进度" hint={`活动完成 · 有效评估覆盖`}>
      <div className="sy-progress"><div>{course.progress.activityLabel ? <strong className="sy-empty-metric">{course.progress.activityLabel}</strong> : <strong>{course.progress.completed}<span> / {course.progress.total}</span></strong>}<small>活动完成{course.progress.skipped ? ` · 跳过 ${course.progress.skipped}` : ''}</small></div><div>{course.progress.scopeLabel ? <strong className="sy-empty-metric">{course.progress.scopeLabel}</strong> : <strong>{course.progress.covered}<span> / {course.progress.scope}</span></strong>}<small>有效评估覆盖</small></div></div>
      <ul className="sy-distribution" aria-label="证据状态分布">{(['未评估', '待验证', '待加强', '初步掌握', '复测通过'] as const).map(state => <li key={state}><span>{state}</span><strong>{course.progress.distribution[state]}</strong></li>)}</ul>
    </PanelCard>

    <PanelCard className="panel-card-quiet">
      <button className="panel-inline-action" onClick={onReadLecture}><FileText size={14} />阅读讲义<ArrowRight size={13} /></button>
      <p className="sy-muted">{course.revision ? '讲义已发布，在左侧阅读章节导读、概念解释与原文依据。' : '先在资料页检查文件并点击初始化。'}</p>
    </PanelCard>

    {course.draft && <PanelCard className="sy-draft" title={`待确认草案 · v${course.draft.version}`} hint={course.draft.deadline ? `目标 ${course.draft.deadline}` : undefined}>
      <div data-draft-id={course.draft.id} data-learning-kind="draft" data-learning-id={course.draft.id}>
        <h4>{course.draft.feasible ? '计划可执行' : '时间预算不足'}</h4>
        <p>{course.draft.tasks.length} 个任务，每天最多 {course.draft.dailyMinutes} 分钟。确认后才替换尚未开始的安排。</p>
        {course.draftDiff && <ul className="sy-diff">{course.draftDiff.scopeAdded.map(id => <li key={`in-${id}`}>新增范围：{pointName(id)}</li>)}{course.draftDiff.scopeRemoved.map(id => <li key={`out-${id}`}>移出范围：{pointName(id)}，作答仍保留</li>)}{course.draftDiff.tasksAdded.map(item => <li key={item.id}>新增{item.immediate ? '即时巩固' : '任务'}：{pointName(item.pointId)} · {item.date} · {item.minutes} 分钟</li>)}{course.draftDiff.tasksRemoved.map(item => <li key={item.id}>移出任务：{pointName(item.pointId)} · {item.date}</li>)}{course.draftDiff.tasksMoved.map(item => <li key={item.id}>移动：{pointName(item.pointId)} {item.from} → {item.to}</li>)}<li>估时 {course.draftDiff.minutesBefore} → {course.draftDiff.minutesAfter} 分钟</li></ul>}
        {course.draft.overflow.some(o => o.reason === 'task-too-large') && <p role="alert">单任务超过每天可用分钟：{course.draft.overflow.filter(o => o.reason === 'task-too-large').map(o => pointName(o.pointId)).join('、')}。请提高每天可用分钟，或调低对应任务的估时。</p>}
        {course.draft.overflow.some(o => o.reason === 'window-full') && <p role="alert">时间窗口内放不下：{course.draft.overflow.filter(o => o.reason === 'window-full').map(o => pointName(o.pointId)).join('、')}。请增加每天可用分钟、延长目标日期或天数，或缩小范围。</p>}
        <button onClick={onOpenDiff}>查看差异</button>
        {course.draft.tasks.filter(item => item.status === 'todo').map(item => <div className="sy-task-estimate" key={item.id}><label>{pointName(item.pointId)} · {item.kind === 'review' ? '复习' : '学习'}估时<input type="number" min={1} max={720} aria-label={`${pointName(item.pointId)} 草案任务估时`} value={editMinutes[item.id] ?? String(item.minutes)} onChange={e => setEditMinutes({ ...editMinutes, [item.id]: e.target.value })} /></label><button disabled={busy || course.archived} onClick={async () => { const value = Number(editMinutes[item.id] ?? item.minutes); if (!Number.isInteger(value) || value < 1 || value > 720) { setError('草案任务估时请输入 1–720 的整数分钟'); return } await onRun('adjustTaskMinutes', { draftId: course.draft!.id, taskId: item.id, minutes: value }) }}>调整估时</button></div>)}
        <div className="sy-row"><button className="sy-primary" disabled={!course.draft.feasible || busy || course.archived} onClick={() => void onRun('confirmPlan', { baseVersion: course.draft!.baseVersion, draftId: course.draft!.id })}>确认生效</button><button onClick={() => void onRun('rejectPlan')}>保留原计划</button></div>
      </div>
    </PanelCard>}

    <PanelCard title={`已确认计划${course.plan ? ` · v${course.plan.version}${course.plan.deadline ? ` · 目标 ${course.plan.deadline}` : ''}` : ''}`}>
      {!course.plan
        ? <PanelEmpty icon={<Check size={22} />} title="还没有已确认的计划" description="导入资料、生成大纲后，确认你的第一份计划。" action={<button className="button primary small" onClick={() => (course.materials.length > 0 ? onOpenOutline() : onOpenMaterials())}>开始准备 <ArrowRight size={14} /></button>} />
        : <div className="panel-plan-list">{course.plan.tasks.map(item => <button className={`task-item sy-task ${task?.id === item.id ? 'is-selected' : ''}`} key={item.id} disabled={busy || course.archived || (item.status === 'todo' && item.date > today) || (course.blockedPointIds ?? []).includes(item.pointId)} onClick={() => onStartTask(item)}><span className="sy-task-dot">{item.status === 'completed' ? <Check size={14} /> : <FileText size={14} />}</span><span><strong>{pointName(item.pointId)}</strong><small>{item.date} · {item.minutes} 分钟 · {item.immediate ? '即时巩固' : item.kind === 'review' ? '复习' : '学习'}</small><em>{(course.blockedPointIds ?? []).includes(item.pointId) && item.status !== 'completed' ? '待补充资料' : item.status === 'completed' ? '活动完成' : item.status === 'in_progress' ? '进行中' : '待开始'}</em></span><ArrowRight size={14} /></button>)}</div>}
    </PanelCard>

    {(course.changes.length > 0 || course.actions.length > 0) && <details className="panel-fold">
      <summary>分母变化与下一行动记录{course.changes.length > 0 ? ` · ${course.changes.length} 条分母变化` : ''}{course.actions.length > 0 ? ` · ${course.actions.length} 条行动` : ''}</summary>
      {course.changes.length > 0 && <div className="sy-trace"><h4>分母变化</h4>{[...course.changes].reverse().map(change => <p className="sy-change" key={change.id}>{change.text}</p>)}</div>}
      {course.actions.length > 0 && <div className="sy-trace"><h4>下一行动记录</h4>{[...course.actions].reverse().map(action => <p className="sy-action" key={action.id}><strong>{action.text}</strong><small>{formatTime(action.at, course.timezone)} · {action.trigger} · {action.evidenceState ?? '无证据'} · {action.availableAt === null ? '现在可以执行' : `可执行 ${formatTime(action.availableAt, course.timezone)}`} · {action.reason}</small></p>)}</div>}
    </details>}
  </>;
}

export interface StudySectionProps {
  course: CourseView;
  busy: boolean;
  running: boolean;
  scope: string[];
  setScope: (scope: string[]) => void;
  minutes: number;
  onMinutes: (value: number) => void;
  days: number;
  setDays: (value: number) => void;
  deadline: string;
  setDeadline: (value: string) => void;
  restDays: number[];
  setRestDays: (value: number[]) => void;
  estimates: Record<string, string>;
  setEstimates: (value: Record<string, string>) => void;
  pointName: (id: string) => string;
  formatTime: (at: number, zone: string) => string;
  jobs: SylloraState['jobs'];
  onOpenMaterials: () => void;
  onGenerateOutline: () => void;
  onGenerated: () => void;
  /** 「调整范围与计划」：把已确认计划的参数回填到本页表单。 */
  onApplyPlan: () => void;
  onProposeReview: (pointId: string) => Promise<void>;
  onRun: (action: string, payload?: Record<string, unknown>) => Promise<unknown>;
  onSource: (id: string) => void;
  onDispute: (questionId: string) => void;
  setError: (message: string) => void;
}

/** 学习：大纲（勾选/重命名/排序/估时）+ 计划参数 + 生成草案 + 复习；诊断折叠。 */
export function StudySection(props: StudySectionProps) {
  const { course, busy, running, scope, setScope, minutes, onMinutes, days, setDays, deadline, setDeadline, restDays, setRestDays, estimates, setEstimates, pointName, formatTime, jobs, onOpenMaterials, onGenerateOutline, onGenerated, onApplyPlan, onProposeReview, onRun, onSource, onDispute, setError } = props;
  return <>
    <PanelCard title="学习范围" hint={`${course.points.length} 个知识点`}>
      <p className="sy-muted">大纲来自已发布的资料整理结果。勾选本轮知识点，再生成可执行计划。</p>
      <button disabled={busy || running || course.archived} onClick={() => (course.folder ? onOpenMaterials() : onGenerateOutline())}>{course.folder ? '检查资料并更新课程' : '从资料生成／补充大纲'}</button>
      {course.points.length === 0 && <p className="sy-muted">还没有知识点。先在「资料」里初始化课程。</p>}
      {course.points.map((point, index) => <div className="sy-point-row" key={point.id}><label className="sy-point"><input type="checkbox" checked={scope.includes(point.id)} onChange={e => setScope(e.target.checked ? [...scope, point.id] : scope.filter(id => id !== point.id))} /><span><small>{point.chapter} · {String(index + 1).padStart(2, '0')}</small>{point.name}<em>{course.evidence[point.id]?.state}</em></span></label><div className="sy-point-actions"><button aria-label={`${point.name} 重命名`} title="重命名" disabled={busy || course.archived} onClick={() => { const name = window.prompt('知识点名称', point.name); if (name) void onRun('point', { pointId: point.id, name }) }}>✏️</button><button aria-label={`${point.name} 上移`} title="上移" disabled={index === 0 || busy || course.archived} onClick={async () => { const ids = course.points.map(item => item.id);[ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!]; await onRun('reorderPoints', { pointIds: ids }) }}>↑</button><button aria-label={`${point.name} 下移`} title="下移" disabled={index === course.points.length - 1 || busy || course.archived} onClick={async () => { const ids = course.points.map(item => item.id);[ids[index], ids[index + 1]] = [ids[index + 1]!, ids[index]!]; await onRun('reorderPoints', { pointIds: ids }) }}>↓</button></div><input className="sy-estimate" type="number" min={5} max={240} aria-label={`${point.name} 任务估时（分钟）`} placeholder="20" value={estimates[point.id] ?? ''} onChange={e => setEstimates({ ...estimates, [point.id]: e.target.value })} disabled={busy} /></div>)}
      {course.points.length > 0 && <button onClick={() => setScope(course.points.map(point => point.id))}>选择全部知识点</button>}
    </PanelCard>

    <PanelCard title="计划参数">
      <div className="sy-plan-input"><label>每天可用分钟<input type="number" min={1} max={720} value={minutes} onChange={e => onMinutes(Number(e.target.value))} /></label><label>未来天数（无目标日期时生效）<input type="number" min={1} max={90} value={days} onChange={e => setDays(Number(e.target.value))} /></label><label>目标日期（可选，含当天）<input type="date" value={deadline} onChange={e => setDeadline(e.target.value)} disabled={busy} /></label></div>
      <div className="sy-rest"><span>休息日</span>{['日', '一', '二', '三', '四', '五', '六'].map((label, index) => <button key={index} aria-pressed={restDays.includes(index)} onClick={() => setRestDays(restDays.includes(index) ? restDays.filter(day => day !== index) : [...restDays, index])}>{label}</button>)}</div>
      <button className="button primary" disabled={!scope.length || busy || course.archived} onClick={async () => {
        const entered = Object.entries(estimates).filter(([id, value]) => scope.includes(id) && value.trim() !== '');
        if (entered.some(([, value]) => !Number.isInteger(Number(value)) || Number(value) < 5 || Number(value) > 240)) { setError('任务估时请输入 5–240 的整数分钟'); return }
        const estimateInput = Object.fromEntries(entered.map(([id, value]) => [id, Number(value)]));
        if (await onRun('plan', { scope, dailyMinutes: minutes, days, restDays, baseVersion: course.plan?.version ?? 0, ...(deadline ? { deadline } : {}), ...(Object.keys(estimateInput).length ? { estimates: estimateInput } : {}) })) onGenerated();
      }}>生成计划草案 <ArrowRight size={15} /></button>
    </PanelCard>

    <PanelCard title="复习" hint={`${course.scope.length} 个已确认知识点`}>
      <p className="sy-muted">独立作答决定状态。复测至少间隔 24 小时；提前练习不会提前晋升复测。</p>
      {!course.scope.length && <p className="sy-muted">确认学习范围后展示复习状态。</p>}
      {course.scope.map(id => { const item = course.evidence[id]; return <div className="sy-review" key={id}><h4>{pointName(id)}</h4><span className="sy-badge">{item?.state}</span><p>{item?.reason}</p><small>{item?.dueAt ? `下次复习：${formatTime(item.dueAt, course.timezone)}` : '尚未安排复习'}</small>{course.plan?.deadline && item?.dueAt && new Intl.DateTimeFormat('en-CA', { timeZone: course.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(item.dueAt) > course.plan.deadline && <p role="status">目标日期外：请调整目标日期、继续学习或归档课程。</p>}<WrongAnswerHistory course={course} pointId={id} onSource={onSource} onDispute={onDispute} formatTime={formatTime} /><button disabled={busy || course.archived || (course.blockedPointIds ?? []).includes(id)} onClick={() => void onProposeReview(id)}>{item?.dueAt && item.dueAt <= Date.now() ? '生成到期复习草案' : '生成即时巩固草案'}</button></div> })}
    </PanelCard>

    {course.plan && <button onClick={() => onApplyPlan()}>调整范围与计划</button>}

    <details className="panel-fold"><summary>复习间隔设置与学习诊断</summary>
      <LearningMetrics course={course} />
      <LearningJobDiagnostics jobs={jobs} />
      <LearningPolicySettings course={course} busy={busy} onSave={async settings => !!(await onRun('learningSettings', settings))} />
    </details>
  </>;
}

export interface MaterialsSectionProps {
  course: CourseView;
  busy: boolean;
  running: boolean;
  epoch: number;
  text: string;
  setText: (value: string) => void;
  onRun: (action: string, payload?: Record<string, unknown>) => Promise<unknown>;
  onPickFile: () => void;
  onSource: (id: string) => void;
}

/** 资料：初始化、上传/粘贴、资料列表与来源锚点。 */
export function MaterialsSection({ course, busy, running, epoch, text, setText, onRun, onPickFile, onSource }: MaterialsSectionProps) {
  return <>
    {course.folder && <PanelCard title="初始化课程"><MaterialInitialization course={course} epoch={epoch} busy={busy} running={running} onRun={onRun} /></PanelCard>}
    <PanelCard title="课程资料">
      <p className="sy-muted">{course.folder ? '支持 PDF、MD/TXT、DOCX、XLSX、HTML' : '支持文本 PDF、MD、TXT'}。单份最多 20 MiB／50 页，课程合计 100 页 PDF／10 万字符。</p>
      <button className="upload-zone" disabled={busy || course.archived} onClick={onPickFile}><Upload size={20} /><span>选择资料文件</span></button>
      <label>或粘贴正文<textarea rows={4} value={text} onChange={e => setText(e.target.value)} placeholder="粘贴有使用权限的学习资料" /></label>
      <button disabled={!text.trim() || busy || course.archived} onClick={async () => { if (await onRun('import', { name: '粘贴资料.txt', text })) setText('') }}>保存正文</button>
      {course.materials.length === 0 && <PanelEmpty icon={<Upload size={22} />} title="还没有学习资料" description="添加一份讲义或笔记，初始化后就能阅读正文与追问。" />}
      {course.materials.map(material => <div className="panel-file sy-material" key={material.id}><FileText size={17} /><div>
        <strong>{material.name}</strong><small>{material.missingOriginal ? '缺少原文件 · ' : ''}{material.status === 'deleted' ? '已删除' : material.status === 'partial' ? `部分可用${material.accepted ? ' · 已接受' : ' · 待确认'}` : '可用'} · v{material.revisionNumber ?? 1} · {material.sources.length} 个片段{material.pages > 0 ? ` · ${material.pages} 页` : ''}</small>
        {material.warnings?.map((warning, index) => <small key={index}>{warning}</small>)}
        {!!material.pageIssues?.length && <details className="sy-issues"><summary>失败范围（{material.pageIssues.length} 页）</summary><ul>{material.pageIssues.map(issue => <li key={issue.num}>第 {issue.num} 页 · {issue.reason === 'blank-page' ? '无可提取文本' : issue.reason === 'unextracted-text' ? '解析未返回该页' : '解析失败'}</li>)}</ul><small>这些页没有可用正文，不参与生成。</small></details>}
        {material.parseError && <p role="alert" className="sy-muted">{material.parseError}</p>}
        {material.active === false && material.status !== 'deleted' && <small>未纳入本轮资料；历史依据保留</small>}
        {material.status === 'partial' && !material.accepted && <button onClick={() => void onRun('acceptMaterial', { materialId: material.id })}>接受可用部分</button>}
        {material.previewUrl && <MaterialPreview url={material.previewUrl} name={material.name} version={material.version} />}
        {material.sources.map(source => <button className="sy-source-link" key={source.id} onClick={() => onSource(source.id)}>{source.anchor}</button>)}</div>
        {material.status !== 'deleted' && <button aria-label={`删除资料 ${material.name}`} disabled={course.archived} onClick={() => { if (window.confirm('删除此资料？关联题目将失效，证据会重新计算。原文件仍留在课程目录。')) void onRun('deleteMaterial', { materialId: material.id, confirmed: true }) }}><Trash2 size={14} /></button>}</div>)}
    </PanelCard>
  </>;
}

/** 复习状态里的错题记录（自 `Syllora.tsx` 平移，仅补齐按钮禁用态与相对时间）。 */
function WrongAnswerHistory({course,pointId,onSource,onDispute,formatTime}:{course:CourseView;pointId:string;onSource:(id:string)=>void;onDispute:(id:string)=>void;formatTime:(at:number,zone:string)=>string}) {
  const wrong=course.questions.filter(question=>question.pointId===pointId&&question.status==='valid'&&course.attempts.some(attempt=>attempt.questionId===question.id&&!attempt.correct));
  if(!wrong.length)return null;
  return <details><summary>错题记录 · {wrong.length} 题</summary>{wrong.map(question=>{
    const attempt=course.attempts.find(attempt=>attempt.questionId===question.id)!;
    return <article className="sy-question" key={question.id} data-learning-kind="question" data-learning-id={question.id}><h4>{question.stem}</h4><p>你的选项 {String.fromCharCode(65+attempt.option)}：{question.options[attempt.option]}</p><small>{attempt.assisted?'辅助学习，不计独立证据':'独立错答'} · {formatTime(attempt.at,course.timezone)}</small>{question.answer!==undefined&&<p>正确选项 {String.fromCharCode(65+question.answer)}：{question.options[question.answer]}</p>}<p>{question.explanation}</p><blockquote>{question.quote}</blockquote><div className="sy-row">{question.sourceIds.map(sourceId=><button key={sourceId} onClick={()=>onSource(sourceId)}>查看错题依据</button>)}<button disabled={course.archived} onClick={()=>onDispute(question.id)}>报告此题问题</button></div></article>;
  })}</details>;
}

/** 复习间隔设置（自 `Syllora.tsx` 平移，行为不变）。 */
function LearningPolicySettings({course,busy,onSave}:{course:CourseView;busy:boolean;onSave:(settings:{baseVersion:number;reviewHours:number[];sessionIdleMinutes:number})=>Promise<boolean>}) {
  const settings=course.learningSettings??{revision:0,reviewHours:[24,72,168],sessionIdleMinutes:30};
  const [baseline,setBaseline]=useState<{revision:number;reviewHours:number[];sessionIdleMinutes:number}>(settings),[dirty,setDirty]=useState(false);
  const [hours,setHours]=useState(settings.reviewHours.map(String)),[idle,setIdle]=useState(String(settings.sessionIdleMinutes)),[error,setError]=useState('');
  const loadLatest=()=>{setBaseline(settings);setHours(settings.reviewHours.map(String));setIdle(String(settings.sessionIdleMinutes));setDirty(false);setError('')};
  useEffect(()=>{if(!dirty&&settings.revision>baseline.revision){setBaseline(settings);setHours(settings.reviewHours.map(String));setIdle(String(settings.sessionIdleMinutes));setError('')}},[settings,baseline.revision,dirty]);
  const stale=settings.revision>baseline.revision;
  return <div className="panel-subsection"><h4>复习间隔设置</h4><p className="sy-muted">默认 24、72、168 小时，按实际经过时长计算。修改只影响之后新建立的周期，已有到期时间与历史作答不变。</p>{stale&&<div role="status"><p>学习设置已被另一页面修改。你的未保存输入和原修订号已保留；请载入最新设置后重新编辑。</p><button disabled={busy||course.archived} onClick={loadLatest}>放弃草稿并载入最新设置</button></div>}{['首次补强与复测','复测通过后的间隔','后续复习间隔'].map((label,index)=><label key={label}>{label}（小时）<input aria-label={`${label}（小时）`} type="number" min={24} max={8760} step={1} value={hours[index]} disabled={busy||course.archived} onChange={event=>{setHours(hours.map((old,i)=>i===index?event.target.value:old));setDirty(true)}}/></label>)}<label>会话闲置关闭（分钟）<input aria-label="会话闲置关闭（分钟）" type="number" min={5} max={1440} value={idle} disabled={busy||course.archived} onChange={event=>{setIdle(event.target.value);setDirty(true)}}/></label><p>默认 30 分钟无学习操作后关闭，轮询与刷新不续期；修改只影响以后开始的会话。</p>{error&&<p role="alert">{error}</p>}<button disabled={busy||course.archived} onClick={async()=>{const values=hours.map(Number);if(!Number.isInteger(Number(idle))||Number(idle)<5||Number(idle)>1440){setError('闲置关闭请输入 5–1440 的整数分钟。');return}if(values.some(value=>!Number.isSafeInteger(value)||value<24||value>8760)||values[0]!>values[1]!||values[1]!>values[2]!){setError('请输入不递减的三个整数小时，范围 24–8760。');return}setError('');if(await onSave({baseVersion:baseline.revision,reviewHours:values,sessionIdleMinutes:Number(idle)})){setBaseline({revision:baseline.revision+1,reviewHours:values,sessionIdleMinutes:Number(idle)});setDirty(false)}}}>保存未来复习间隔</button></div>;
}
