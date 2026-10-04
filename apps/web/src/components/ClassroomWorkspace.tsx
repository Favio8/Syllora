'use client';

/**
 * 虚拟课堂（主应用新增）。
 *
 * 三块界面，全部走本项目信封（点号方法 + syllora 专线），生成在云端 OpenMAIC：
 *  1. 输入卡片：昵称与人设、课堂角色（AI 教师必选 + 学生多选 + 音色）、资料与附件、需求 → 进入课堂；
 *  2. 生成进度：轮询 classroom.job（5 秒、容忍抖动），步骤轨迹 + 已生成场景数 + 取消；
 *  3. 课堂页：场景侧栏 + 课件区（slide 用 @openmaic/renderer 画布、quiz 作答、interactive 沙箱 iframe）
 *     + 讲解台词 + 本机播放进度（classroom.progress，只记阅读状态，不计学习证据）。
 *
 * 隐私：开启即把所选资料上传到设置里配置的云端服务器；未配置连接时页面只给引导，不发请求。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, ArrowRight, BookOpen, Check, ClipboardCheck, FileText, Layers,
  ListChecks, LoaderCircle, PlugZap, Plus, Play, RotateCcw, Sparkles, Square, Trash2, Upload, Users,
} from 'lucide-react';
import { api, ApiError, type ClassroomCapabilities, type ClassroomDocument, type ClassroomJobState, type ClassroomMeta, type ClassroomRole, type ClassroomScene } from '@/src/lib/api';
import { classroomService, workbenchRpc } from '../features/workbench/services';
import { SlideCanvas } from '@openmaic/renderer';
import './classroom.css';

/** 默认角色（AI 教师必选，其余为可多选的学生）；音色写成请求里的角色设定交给云端。 */
const DEFAULT_ROLES: ClassroomRole[] = [
  { id: 'teacher', name: '小艾老师', kind: 'teacher', persona: '耐心讲解，多用生活例子' },
  { id: 'assistant', name: '助教', kind: 'student', persona: '补充思路、提醒易错点' },
  { id: 'curious', name: '好奇宝宝', kind: 'student', persona: '不断追问为什么' },
  { id: 'skeptic', name: '思考者', kind: 'student', persona: '提出反例与质疑' },
  { id: 'note', name: '笔记员', kind: 'student', persona: '把结论整理成条目' },
];
const EXAMPLES = [
  '用勾股定理讲清直角三角形的三边关系',
  '把这一章的知识点串成一节课，配两道练习',
  '用白板演示傅里叶变换的直观含义',
];
const SCENE_LABEL: Record<string, string> = { slide: '幻灯片', quiz: '测验', interactive: '互动演示' };
/** 云端作业的步骤轨迹（实测：queued → generating_outlines → generating_scenes → completed）。 */
const STEPS: Array<{ id: string; label: string }> = [
  { id: 'uploaded', label: '资料上传' },
  { id: 'queued', label: '云端排队' },
  { id: 'generating_outlines', label: '生成大纲' },
  { id: 'generating_scenes', label: '生成场景' },
  { id: 'fetching', label: '取回课堂' },
  { id: 'completed', label: '完成' },
];

export interface ClassroomWorkspaceProps {
  /** 当前打开的课程（虚拟课堂按课程生成与播放；没有课程时只给引导）。 */
  course: { id: string; name: string; materials?: Array<{ id: string; name: string; status?: string }> } | null;
  /** 打开设置（未配置云端连接时的引导按钮）。 */
  onOpenSettings?: () => void;
  /** 需要刷新课程数据时调用（作业也会出现在「任务」页）。 */
  onActivity?: () => void;
}

interface Attachment { attachmentId: string; name: string; bytes: number }

export default function ClassroomWorkspace({ course, onOpenSettings, onActivity }: ClassroomWorkspaceProps) {
  const [capabilities, setCapabilities] = useState<ClassroomCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [classrooms, setClassrooms] = useState<ClassroomMeta[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [open, setOpen] = useState<ClassroomDocument | null>(null);
  const [loadingClassroom, setLoadingClassroom] = useState(false);
  const [job, setJob] = useState<ClassroomJobState | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  /** 生成中先进入课堂：云端当前已生成的场景（每 5 秒追加）。 */
  const [live, setLive] = useState<{ classroomId: string | null; scenes: ClassroomScene[]; generating: boolean } | null>(null);
  /** 正在播放「生成中的课堂」而不是本地已保存的那份。 */
  const [liveView, setLiveView] = useState(false);
  const pollAbort = useRef<AbortController | null>(null);
  const courseId = course?.id;

  const refreshCapabilities = useCallback(async () => {
    setCapabilityError(null);
    try { setCapabilities(await api.classroomCapabilities(courseId)); }
    catch (error) {
      // 能力探测失败不挡页面：退回「未配置」姿态，让用户看到引导而不是一片空白。
      setCapabilities({ configured: false, baseUrl: null, capabilities: {}, materials: { maxCount: 5, maxTotalBytes: 157_286_400, maxDocumentBytes: 52_428_800, formats: ['pdf', 'txt', 'markdown'] } });
      setCapabilityError(error instanceof Error ? error.message : '无法读取云端能力');
    }
  }, [courseId]);

  /**
   * 生成过程中的增量取场景：云端作业只有在结束时才给 classroomId，
   * 所以先由宿主按「课堂列表 + 作业开始时间」认领正在生成的那一份，再按 manifest 取已生成页。
   */
  useEffect(() => {
    if (courseId === undefined || job === null || job.done) return
    let alive = true
    const pull = async () => {
      try {
        const next = await api.classroomLive(courseId, job.classroomId ? { classroomId: job.classroomId } : { jobId: job.jobId })
        if (alive && next.classroomId !== null) setLive({ classroomId: next.classroomId, scenes: next.scenes, generating: next.generating })
      } catch { /* 生成中偶发失败不打断：下一轮再试。 */ }
    }
    void pull()
    const timer = setInterval(() => void pull(), 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [courseId, job?.jobId, job?.done, job?.classroomId]);

  const refreshList = useCallback(async () => {
    if (courseId === undefined) { setClassrooms([]); return; }
    setListError(null);
    try { setClassrooms((await api.classroomList(courseId)).classrooms); }
    catch (error) { setListError(error instanceof Error ? error.message : '无法读取课堂列表'); }
  }, [courseId]);

  useEffect(() => { void refreshCapabilities(); }, [refreshCapabilities]);
  useEffect(() => { void refreshList(); setOpen(null); setJob(null); setJobError(null); }, [refreshList]);

  const loadClassroom = useCallback(async (classroomId: string) => {
    if (courseId === undefined) return;
    setLoadingClassroom(true);
    try { setOpen(await api.classroomGet(courseId, classroomId)); }
    catch (error) { setJobError(error instanceof Error ? error.message : '无法读取这份课堂'); }
    finally { setLoadingClassroom(false); }
  }, [courseId]);

  /** 生成成功后自动打开：作业里带回的 classroomId 指向刚下载到本地的课堂。 */
  const startPolling = useCallback((jobId: string) => {
    if (courseId === undefined) return;
    pollAbort.current?.abort();
    const controller = new AbortController();
    pollAbort.current = controller;
    void classroomService.poll(courseId, jobId, { signal: controller.signal, onProgress: next => { setJob(next); onActivity?.(); } })
      .then(async finished => {
        setJob(finished);
        onActivity?.();
        if (finished.status === 'succeeded') {
          await refreshList();
          if (finished.classroomId) await loadClassroom(finished.classroomId);
        } else if (finished.status === 'failed') {
          setJobError(finished.error ?? '课堂生成未完成，未保存半成品。');
        }
      })
      .catch(error => { if (!controller.signal.aborted) setJobError(error instanceof Error ? error.message : '等待生成失败'); });
  }, [courseId, loadClassroom, onActivity, refreshList]);

  useEffect(() => () => pollAbort.current?.abort(), []);

  if (!course) {
    return <section className="sy-classroom" aria-label="虚拟课堂">
      <div className="cl-empty">
        <BookOpen size={34} />
        <h2>先打开一门课程</h2>
        <p>虚拟课堂按课程生成与保存：课堂产物写进课程目录的 <code>classrooms/</code>，播放进度也留在本机。</p>
      </div>
    </section>;
  }

  const configured = capabilities?.configured === true;

  return <section className="sy-classroom" aria-label="虚拟课堂">
    <header className="cl-head">
      <div className="cl-head-main">
        <span className="cl-eyebrow"><Sparkles size={13} />虚拟课堂</span>
        <h1>{course.name}</h1>
      </div>
      <div className="cl-head-actions">
        <span className={`cl-status ${configured ? 'is-ok' : 'is-off'}`}>{capabilities === null ? '读取中…' : configured ? `已连接 ${capabilities.baseUrl}` : '未配置云端连接'}</span>
        {!configured && onOpenSettings && <button type="button" className="button small" onClick={onOpenSettings}><PlugZap size={14} />去设置</button>}
        {configured && <button type="button" className="button small" onClick={() => { void refreshCapabilities(); void refreshList(); }}><RotateCcw size={14} />刷新</button>}
      </div>
    </header>

    {capabilityError && <p className="cl-error" role="alert">{capabilityError}</p>}

    {/* 进行中、或结束但失败/取消（没成功就不会自动进入播放器）时停留在进度页：
        失败要留下可读原因与返回入口，而不是把用户丢回输入卡片。 */}
    {liveView && live !== null
      ? <ClassroomPlayer
        courseId={course.id}
        document={open}
        live={{ scenes: live.scenes, sceneTypes: countSceneTypes(live.scenes), generating: !(job?.done === true) }}
        progressLabel={job === null ? '生成中' : `${job.step || job.status}${typeof job.scenesGenerated === 'number' && typeof job.totalScenes === 'number' ? ` · 已生成 ${job.scenesGenerated}/${job.totalScenes}` : ''}`}
        onClose={() => { setLiveView(false); setLive(null); }}
      />
      : starting || (job !== null && (!job.done || (job.status !== 'succeeded' && job.status !== 'cancelled')))
      ? <GenerationProgress
        job={job}
        error={jobError}
        canEnter={live !== null && live.scenes.length > 0}
        onEnter={() => setLiveView(true)}
        onCancel={() => { void cancelClassroomJob(course.id, job?.jobId, setJob, setJobError, pollAbort.current); }}
        onDismiss={() => { setJob(null); setJobError(null); setLive(null); }}
      />
      : open
        ? <ClassroomPlayer courseId={course.id} document={open} live={null} onClose={() => { setOpen(null); setLiveView(false); setLive(null); }} />
        : <div className="cl-grid">
          <ComposeCard
            courseId={course.id}
            courseMaterials={(course.materials ?? []).filter(material => material.status !== 'deleted')}
            capabilities={capabilities}
            configured={configured}
            busy={starting}
            onStart={async input => {
              setStarting(true); setJobError(null);
              try {
                const started = await classroomService.generate({ courseId: course.id, requirement: input.requirement, materialIds: input.materialIds, attachmentIds: input.attachmentIds, roles: input.roles });
                onActivity?.();
                setJob({ jobId: started.jobId, courseId: course.id, status: 'queued', step: 'queued', done: false, updatedAt: Date.now() });
                startPolling(started.jobId);
              } catch (error) { setJobError(error instanceof Error ? error.message : '无法发起生成'); }
              finally { setStarting(false); }
            }}
          />
          {jobError && <p className="cl-error" role="alert">{jobError}</p>}
          <ClassroomList
            classrooms={classrooms}
            error={listError}
            loading={loadingClassroom}
            onOpen={classroomId => void loadClassroom(classroomId)}
            onDelete={classroomId => void deleteClassroom(course.id, classroomId, setClassrooms, setListError)}
          />
        </div>}
  </section>;
}

/**
 * 删除一份课堂：本地删掉（必成功才算删）；同时通知云端删除（云端失败只提示，不回滚本地）。
 */
async function deleteClassroom(courseId: string, classroomId: string, setClassrooms: (next: ClassroomMeta[]) => void, setError: (message: string | null) => void) {
  setError(null)
  try {
    const result = await api.classroomDelete(courseId, classroomId, true)
    if (result.cloud === 'failed') setError('本地课堂已删除；云端删除失败（可能是网络或口令问题），云端副本仍会占用云端空间。')
    setClassrooms((await api.classroomList(courseId)).classrooms)
  } catch (error) {
    setError(error instanceof Error ? error.message : '删除课堂失败，请重试')
  }
}

/** 取消：宿主已有的 cancel 动作会中止后台 worker 与云端等待，不保存半成品。 */
async function cancelClassroomJob(courseId: string, jobId: string | undefined, setJob: (job: ClassroomJobState | null) => void, setError: (message: string | null) => void, abort: AbortController | null) {
  if (jobId === undefined) return;
  try {
    await workbenchRpc('cancel', { courseId, jobId });
    abort?.abort();
    setJob({ jobId, courseId, status: 'cancelled', step: 'cancelled', done: true, updatedAt: Date.now(), error: '已取消；未保存半成品。' });
  } catch (error) { setError(error instanceof Error ? error.message : '取消失败，可稍后重试'); }
}

// ---------------------------------------------------------------------------
// 输入卡片
// ---------------------------------------------------------------------------

function ComposeCard({ courseId, courseMaterials, capabilities, configured, busy, onStart }: {
  courseId: string;
  courseMaterials: Array<{ id: string; name: string }>;
  capabilities: ClassroomCapabilities | null;
  configured: boolean;
  busy: boolean;
  onStart: (input: { requirement: string; materialIds: string[]; attachmentIds: string[]; roles: ClassroomRole[] }) => Promise<void>;
}) {
  const [nickname, setNickname] = useState('同学');
  const [persona, setPersona] = useState('');
  const [requirement, setRequirement] = useState('');
  const [materialIds, setMaterialIds] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maxAttachmentMb = capabilities === null ? 50 : Math.round(capabilities.materials.maxDocumentBytes / 1024 / 1024);

  async function attach(file: File) {
    setError(null); setUploading(true);
    try {
      const staged = await classroomService.uploadAttachment(courseId, file);
      setAttachments(current => [...current.filter(item => item.attachmentId !== staged.attachmentId), { attachmentId: staged.attachmentId, name: staged.name, bytes: staged.bytes }]);
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : '附件上传失败'); }
    finally { setUploading(false); }
  }

  // 课堂角色暂时不给选择：一切默认（主讲教师 + 助教），云端按需求文本自行取舍。
  const roles: ClassroomRole[] = DEFAULT_ROLES.filter(role => role.id === 'teacher' || role.id === 'assistant');

  function composedRequirement(): string {
    const lines = [requirement.trim()];
    lines.push(`\n\n我的昵称：${nickname.trim() || '同学'}${persona.trim() ? `（身份：${persona.trim()}）` : ''}`);
    return lines.join('');
  }

  return <section className="cl-card" aria-label="生成新课堂">
    <div className="cl-card-top">
      <span className="cl-avatar" aria-hidden><Users size={20} /></span>
      <label className="cl-nick">
        <span className="sr-only">课堂昵称</span>
        <input value={nickname} maxLength={20} onChange={event => setNickname(event.target.value)} placeholder="嗨，同学" />
      </label>
      <label className="cl-persona">
        <span className="sr-only">人设（可选）</span>
        <input value={persona} maxLength={60} onChange={event => setPersona(event.target.value)} placeholder="人设（可选，如：大一学生）" />
      </label>
    </div>

    <label className="cl-field">
      <span className="sr-only">想学什么</span>
      <textarea
        rows={4}
        value={requirement}
        maxLength={2000}
        onChange={event => setRequirement(event.target.value)}
        placeholder="输入你想学的任何内容，例如："
        aria-label="课堂需求"
      />
    </label>
    {requirement === '' && <div className="cl-examples">{EXAMPLES.map(example => <button type="button" key={example} className="cl-example" onClick={() => setRequirement(example)}>「{example}」</button>)}</div>}

    <div className="cl-materials">
      <span className="cl-roles-label"><FileText size={14} />课程资料</span>
      <div className="cl-chips">
        {courseMaterials.length === 0 && <span className="cl-muted">这门课程还没有可用资料，可以只用附件生成。</span>}
        {courseMaterials.map(material => <button
          type="button"
          key={material.id}
          aria-pressed={materialIds.includes(material.id)}
          className={`cl-chip ${materialIds.includes(material.id) ? 'is-on' : ''}`}
          onClick={() => setMaterialIds(current => current.includes(material.id) ? current.filter(id => id !== material.id) : [...current, material.id])}
        >{material.name}</button>)}
        {courseMaterials.length > 0 && materialIds.length > 0 && <button type="button" className="cl-chip is-ghost" onClick={() => setMaterialIds([])}>全部资料</button>}
      </div>
    </div>

    <div className="cl-footer">
      <div className="cl-tools">
        <label className="cl-tool" title={`附加资料（PDF / TXT / Markdown，最多 4 份，单份 ≤ ${maxAttachmentMb} MB）`}>
          <input
            type="file" accept=".pdf,.txt,.md,.markdown" style={{ display: 'none' }}
            disabled={uploading || busy || attachments.length >= 4}
            aria-label="添加附件"
            onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void attach(file); }}
          />
          {uploading ? <LoaderCircle size={16} className="spin" /> : <Upload size={16} />}
          <span>{attachments.length > 0 ? `附件 ${attachments.length}` : '附件'}</span>
        </label>
        {attachments.map(item => <button type="button" key={item.attachmentId} className="cl-chip is-on" title="移除附件" onClick={() => setAttachments(current => current.filter(entry => entry.attachmentId !== item.attachmentId))}>
          {item.name}<Trash2 size={12} />
        </button>)}
      </div>
      <button
        type="button"
        className="button primary"
        disabled={!configured || busy || requirement.trim().length < 4}
        onClick={() => void onStart({ requirement: composedRequirement(), materialIds, attachmentIds: attachments.map(item => item.attachmentId), roles })}
      >
        {busy ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}进入课堂
      </button>
    </div>
    {error && <p className="cl-error" role="alert">{error}</p>}
  </section>;
}

// ---------------------------------------------------------------------------
// 生成进度
// ---------------------------------------------------------------------------

function GenerationProgress({ job, error, canEnter, onEnter, onCancel, onDismiss }: {
  job: ClassroomJobState | null;
  error: string | null;
  /** 云端已经产出至少一页：可以先进入课堂，边学边生成后面的。 */
  canEnter: boolean;
  onEnter: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const step = job?.step ?? 'queued';
  const found = STEPS.findIndex(item => item.id === step);
  const activeIndex = found >= 0 ? found : 1;
  const progress = job?.progress ?? (step === 'uploaded' ? 5 : 10);
  return <section className="cl-progress" aria-label="生成进度" role="status">
    <header>
      <span className="cl-eyebrow"><LoaderCircle size={13} className="spin" />正在云端生成课堂</span>
      <h2>{job === null ? '正在提交…' : `第 ${activeIndex + 1} / ${STEPS.length} 步 · ${STEPS[activeIndex]?.label ?? step}`}</h2>
      <div className="cl-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
      <p className="cl-sub">
        {typeof job?.scenesGenerated === 'number' && typeof job?.totalScenes === 'number'
          ? `已生成场景 ${job.scenesGenerated}/${job.totalScenes}`
          : '一次生成通常要几分钟到几十分钟；离开本页不会中断云端任务。'}
      </p>
    </header>
    <ol className="cl-steps">
      {STEPS.map((item, index) => <li key={item.id} className={index < activeIndex ? 'is-done' : index === activeIndex ? 'is-active' : ''}>
        <span className="cl-step-dot" aria-hidden>{index < activeIndex ? <Check size={12} /> : index + 1}</span>{item.label}
      </li>)}
    </ol>
    {error && <p className="cl-error" role="alert"><AlertTriangle size={14} />{error}</p>}
    <div className="cl-progress-actions">
      {canEnter && <button type="button" className="button primary" onClick={onEnter}><ArrowRight size={15} />先进入课堂（已生成 {job?.scenesGenerated ?? '若干'} 页）</button>}
      {job !== null && !job.done && <button type="button" className="button small" onClick={onCancel}>取消生成</button>}
      {job?.done && <button type="button" className="button small" onClick={onDismiss}>返回课堂列表</button>}
      {job?.status === 'succeeded' && <span className="cl-ok"><Check size={14} />已保存到本地</span>}
    </div>
  </section>;
}

// ---------------------------------------------------------------------------
// 课堂列表 / 播放器
// ---------------------------------------------------------------------------

function ClassroomList({ classrooms, error, onOpen, onDelete, loading }: {
  classrooms: ClassroomMeta[];
  error: string | null;
  onOpen: (classroomId: string) => void;
  /** 删除这份课堂（本地 + 云端）。两步确认，避免误删。 */
  onDelete: (classroomId: string) => void;
  loading: boolean;
}) {
  // 两步确认：第一次点变成「确认删除」，4 秒没再点就复原。
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    if (pending === null) return;
    const timer = setTimeout(() => setPending(null), 4000);
    return () => clearTimeout(timer);
  }, [pending]);
  return <aside className="cl-list" aria-label="我的课堂">
    <header><h2><BookOpen size={15} />我的课堂</h2><span className="cl-muted">{classrooms.length} 份</span></header>
    {error !== null && <p className="cl-error" role="alert">{error}</p>}
    {loading && <p className="cl-muted"><LoaderCircle size={13} className="spin" />正在打开…</p>}
    {error === null && classrooms.length === 0 && <p className="cl-muted">这门课程还没有本地课堂；用左侧输入卡片生成第一份。</p>}
    <ul>
      {classrooms.map(item => <li key={item.classroomId} className="cl-item">
        <button type="button" className="cl-item-open" onClick={() => onOpen(item.classroomId)}>
          <strong>{item.title}</strong>
          <small>{item.sceneCount} 个场景 · {describeSceneTypes(item.sceneTypes)}</small>
          <small>{new Date(item.fetchedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>
        </button>
        <button
          type="button"
          className={`cl-item-delete ${pending === item.classroomId ? 'is-confirming' : ''}`}
          aria-label={pending === item.classroomId ? `确认删除课堂「${item.title}」` : `删除课堂「${item.title}」`}
          title={pending === item.classroomId ? '再点一次即删除（本地与云端）' : '删除这份课堂（本地与云端）'}
          onClick={() => { if (pending === item.classroomId) { setPending(null); onDelete(item.classroomId); } else setPending(item.classroomId); }}
        >{pending === item.classroomId ? '确认删除' : <Trash2 size={13} />}</button>
      </li>)}
    </ul>
  </aside>;
}

/** 场景类型统计（与宿主 sceneTypeCounts 同口径；生成中的增量场景也能统计）。 */
function countSceneTypes(scenes: ClassroomScene[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const scene of scenes) {
    const type = typeof scene.type === 'string' ? scene.type : typeof scene.content?.type === 'string' ? scene.content.type : 'unknown';
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

function describeSceneTypes(counts: Record<string, number>): string {
  return Object.entries(counts).map(([type, count]) => `${SCENE_LABEL[type] ?? type}×${count}`).join(' · ');
}

function ClassroomPlayer({ courseId, document, live, progressLabel, onClose }: {
  courseId: string;
  /** 本地已保存的整份课堂（任务完成后）。生成中还没保存时为空。 */
  document: ClassroomDocument | null;
  /** 生成中的增量来源：云端当前已生成的场景 + 是否仍在生成。 */
  live: { scenes: ClassroomScene[]; sceneTypes: Record<string, number>; generating: boolean } | null;
  /** 生成中的进度文字（对象为空时不显示）。 */
  progressLabel?: string;
  onClose: () => void;
}) {
  // 播放来源：生成中看云端已产出的页（每 5 秒追加），完成后看本地保存的那一份。
  const scenes = live !== null ? live.scenes : (document?.scenes ?? []);
  const meta = document?.meta ?? null;
  const classroomId = meta?.classroomId ?? null;
  const sceneTypes = meta?.sceneTypes ?? live?.sceneTypes ?? {};
  const title = meta?.title ?? '正在生成中的课堂';
  const initialIndex = Math.max(0, scenes.findIndex(scene => scene.id === document?.progress.sceneId));
  const [index, setIndex] = useState(initialIndex);
  const [answers, setAnswers] = useState<Record<string, string[]>>(document?.progress.answers ?? {});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const scene = scenes[index];
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 动作播放：按 scene.actions 逐步走（讲解台词 + 聚光灯/高亮/缩放），与官网「一页里逐条讲」一致。
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);

  const persist = useCallback((sceneId: string | null, nextAnswers: Record<string, string[]>) => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      // 进度只是本机阅读状态：生成中的课堂还没有本地记录，保存失败也不打断上课。
      if (classroomId === null || live !== null) return;
      void api.classroomProgress(courseId, classroomId, sceneId, nextAnswers).catch(() => undefined);
    }, 400);
  }, [courseId, classroomId, live]);

  useEffect(() => () => { if (saveTimer.current !== null) clearTimeout(saveTimer.current); }, []);

  const actions = useMemo(() => (scene?.actions ?? []).filter(action => action !== null && typeof action === 'object'), [scene]);
  // 换页时回到动作第一步。
  useEffect(() => { setStep(0); setPlaying(false); }, [scene?.id]);

  /** 走到第 N 步时应该已经说过的台词（逐步累积，最新一条高亮）。 */
  const spoken = useMemo(() => actions.slice(0, step + 1).flatMap(action => typeof action.text === 'string' && action.text.trim() !== '' ? [action.text.trim()] : []), [actions, step]);

  // 自动播放：每 4 秒推进一步，走完停在最后一步（翻页交给用户）。
  useEffect(() => {
    if (!playing || actions.length === 0) return;
    if (step >= actions.length - 1) { setPlaying(false); return }
    const timer = setTimeout(() => setStep(current => Math.min(current + 1, actions.length - 1)), 4000);
    return () => clearTimeout(timer);
  }, [playing, step, actions.length]);

  const go = (nextIndex: number) => {
    const bounded = Math.min(Math.max(nextIndex, 0), Math.max(scenes.length - 1, 0));
    setIndex(bounded);
    setStep(0); setPlaying(false);
    persist(scenes[bounded]?.id ?? null, answers);
  };
  const answer = (questionId: string, values: string[]) => {
    const next = { ...answers, [questionId]: values };
    setAnswers(next);
    persist(scene?.id ?? null, next);
  };
  const resetAnswers = () => {
    setAnswers({});
    setRevealed({});
    persist(scene?.id ?? null, {});
  };

  if (scene === undefined) {
    return <section className="cl-player">
      <header className="cl-player-head">
        <button type="button" className="button small" onClick={onClose}><ArrowLeft size={14} />返回</button>
        <h2>{title}</h2>
      </header>
      <p className="cl-error" role="alert">{live?.generating === true ? '云端还在生成第一页；这一页每 5 秒自动刷新，生成出来就会显示。' : '这份课堂没有可播放的场景（云端可能只返回了非幻灯片内容）。'}</p>
    </section>;
  }

  return <section className="cl-player" aria-label="课堂播放器">
    <header className="cl-player-head">
      <button type="button" className="button small" onClick={onClose}><ArrowLeft size={14} />返回</button>
      <div className="cl-player-title">
        <h2>{title}{live?.generating === true && <span className="cl-live-badge" role="status">生成中{progressLabel ? ` · ${progressLabel}` : ''}</span>}</h2>
        <small>{describeSceneTypes(sceneTypes)} · {live !== null ? `已取回 ${scenes.length} 页（边生成边更新）` : `保存在本机（来自 ${meta?.cloudBase ?? '云端'}）`}</small>
      </div>
      <div className="cl-player-nav">
        <button type="button" className="button small" disabled={index === 0} onClick={() => go(index - 1)}><ArrowLeft size={14} />上一页</button>
        <span className="cl-muted">{index + 1} / {scenes.length}</span>
        <button type="button" className="button small" disabled={index >= scenes.length - 1} onClick={() => go(index + 1)}>下一页<ArrowRight size={14} /></button>
      </div>
    </header>
    <div className="cl-player-body">
      <ol className="cl-scene-rail" aria-label="场景列表">
        {scenes.map((item, itemIndex) => <li key={item.id}>
          <button type="button" aria-current={itemIndex === index ? 'true' : undefined} className={itemIndex === index ? 'is-active' : ''} onClick={() => go(itemIndex)}>
            <span className="cl-scene-no">{itemIndex + 1}</span>
            <span className="cl-scene-title">{item.title || SCENE_LABEL[item.type ?? item.content?.type ?? ''] || '场景'}</span>
            <small>{SCENE_LABEL[item.type ?? item.content?.type ?? ''] ?? item.type ?? ''}</small>
          </button>
        </li>)}
        {live?.generating === true && <li className="cl-scene-pending"><p className="cl-muted"><LoaderCircle size={13} className="spin" />后续页面生成中…</p></li>}
      </ol>
      <div className="cl-stage">
        <SceneView scene={scene} answers={answers} revealed={revealed} effects={effectsForStep(actions, step)}
          onAnswer={answer} onReveal={questionId => setRevealed(current => ({ ...current, [questionId]: true }))} />
        {actions.length > 0 && <div className="cl-actions" aria-label="讲解台词">
          <div className="cl-actions-bar">
            <button type="button" className="button small" disabled={step === 0} onClick={() => { setPlaying(false); setStep(current => Math.max(0, current - 1)); }}><ArrowLeft size={13} />上一步</button>
            <button type="button" className="button small" onClick={() => { if (step >= actions.length - 1) setStep(0); setPlaying(value => !value); }}>
              {playing ? <><Square size={13} />暂停</> : step >= actions.length - 1 ? <><RotateCcw size={13} />重播</> : <><Play size={13} />播放讲解</>}
            </button>
            <button type="button" className="button small" disabled={step >= actions.length - 1} onClick={() => { setPlaying(false); setStep(current => Math.min(actions.length - 1, current + 1)); }}>下一步<ArrowRight size={13} /></button>
            <span className="cl-muted">第 {step + 1} / {actions.length} 步</span>
          </div>
          {spoken.length > 0
            ? spoken.map((text, spokenIndex) => <p key={spokenIndex} className={spokenIndex === spoken.length - 1 ? 'is-current' : ''}>{text}</p>)
            : <p className="cl-muted">这一步没有台词（可能只是舞台效果）。</p>}
        </div>}
      </div>
    </div>
    <footer className="cl-player-foot">
      <span className="cl-muted">{live !== null ? '生成中的播放进度不保存；本地保存后继续从上次的位置开始。' : '播放进度与测验作答只保存在本机，不计入学习证据。'}</span>
      {Object.keys(answers).length > 0 && <button type="button" className="button small" onClick={resetAnswers}><RotateCcw size={13} />清空本次作答</button>}
    </footer>
  </section>;
}

type SceneEffects = { spotlight?: { elementId: string }; highlights?: Array<{ elementId: string; animated?: boolean }>; laser?: { elementId: string }; zoom?: { elementId: string; scale: number } }

/**
 * 走到第 N 步时应有的舞台效果：**累积**而不是只看当前一步。
 * 高亮会一直保留（老师指过的都留着），聚光灯/激光/缩放取最近一次——与官网播放器一致。
 */
function effectsForStep(actions: Array<NonNullable<ClassroomScene['actions']>[number]>, step: number): SceneEffects | undefined {
  const highlights: SceneEffects['highlights'] = []
  let latest: SceneEffects | undefined
  for (let index = 0; index <= step && index < actions.length; index++) {
    const effect = effectsForAction(actions[index])
    if (effect === undefined) continue
    if (effect.highlights) highlights.push(...effect.highlights)
    const { highlights: _drop, ...rest } = effect
    latest = Object.keys(rest).length > 0 ? rest as SceneEffects : latest
  }
  const merged: SceneEffects = { ...(latest ?? {}), ...(highlights.length > 0 ? { highlights } : {}) }
  return Object.keys(merged).length > 0 ? merged : undefined
}

/** 单步动作 → 渲染器效果（spotlight/highlight/laser/zoom 都以 elementId 为目标）。
 *  spotlight 只映射为 spotlight：官网的聚光灯本身就是「压暗 + 镂空 + 白描边」，
 *  再叠加一个粉色高亮框会与镂空口径（数据盒 vs .element-content）对不齐、反而显得错位。 */
function effectsForAction(action: NonNullable<ClassroomScene['actions']>[number] | undefined): SceneEffects | undefined {
  if (action === undefined) return undefined
  const elementId = typeof action.elementId === 'string' && action.elementId !== '' ? action.elementId : null
  if (elementId === null) return undefined
  const type = typeof action.type === 'string' ? action.type : ''
  if (type === 'spotlight') return { spotlight: { elementId } }
  if (type === 'highlight') return { highlights: [{ elementId, animated: true }] }
  if (type === 'laser') return { laser: { elementId } }
  if (type === 'zoom') {
    const scale = typeof action.scale === 'number' && action.scale > 0 ? Math.min(Math.max(action.scale, 1), 3) : 1.6
    return { zoom: { elementId, scale } }
  }
  return undefined
}function SceneView({ scene, answers, revealed, effects, onAnswer, onReveal }: {
  scene: ClassroomScene;
  answers: Record<string, string[]>;
  revealed: Record<string, boolean>;
  /** 累计后的舞台效果（聚光灯/高亮/激光/缩放），交给渲染器执行。 */
  effects?: SceneEffects;
  onAnswer: (questionId: string, values: string[]) => void;
  onReveal: (questionId: string) => void;
}) {
  const type = scene.type ?? scene.content?.type;
  if (type === 'slide' && scene.content?.canvas) {
    return <div className="cl-canvas"><SlideCanvas slide={scene.content.canvas as never} {...(effects ? { effects: effects as never } : {})} /></div>;
  }
  if (type === 'quiz') {
    const questions = scene.content?.questions ?? [];
    if (questions.length === 0) return <p className="cl-muted"><ClipboardCheck size={14} />这一页没有题目。</p>;
    return <div className="cl-quiz">
      {questions.map((question, questionIndex) => {
        const id = question.id ?? `q${questionIndex}`;
        const picked = answers[id] ?? [];
        const showAnswer = revealed[id] === true;
        // 云端/官方 DSL 的选项形状：value 是代号（"A"），label 是显示文本；answer 存的是代号数组。
        // 判分、选中态、正确项标记全部以代号为准——曾经把 label 当标识，导致整段文本去比 "A"，全判错。
        const options = question.options ?? [];
        const expected = question.answer ?? [];
        const gradable = question.hasAnswer !== false && expected.length > 0 && options.length > 0;
        const correct = gradable && [...new Set(picked)].sort().join('|') === [...new Set(expected)].sort().join('|');
        return <article key={id} className="cl-question">
          <h3>第 {questionIndex + 1} 题{question.type === 'multiple' ? '（多选）' : question.type === 'short_answer' ? '（简答）' : ''}</h3>
          <p>{question.question}</p>
          {options.length === 0 ? (
            // 简答题：云端没有标准答案（hasAnswer=false），只收集作答、查看时给参考要点，不判对错。
            <div className="cl-short">
              <textarea
                aria-label={`第 ${questionIndex + 1} 题作答`}
                placeholder="在这里作答（只保存在本机）"
                value={picked[0] ?? ''}
                onChange={event => onAnswer(id, event.target.value === '' ? [] : [event.target.value])}
              />
            </div>
          ) : (
            <div className="cl-options" role="group" aria-label={`第 ${questionIndex + 1} 题选项`}>
              {options.map(option => {
                const key = option.value ?? option.label ?? '';
                const text = option.label ?? option.value ?? '';
                const isPicked = picked.includes(key);
                return <button
                  key={key}
                  type="button"
                  className={`${isPicked ? 'is-picked' : ''} ${showAnswer && expected.includes(key) ? 'is-answer' : ''}`}
                  aria-pressed={isPicked}
                  onClick={() => onAnswer(id, question.type === 'multiple' ? (isPicked ? picked.filter(item => item !== key) : [...picked, key]) : [key])}
                ><span className="cl-option-key">{key}</span>{text !== key ? <>{' '}{text}</> : null}</button>;
              })}
            </div>
          )}
          <div className="cl-quiz-actions">
            <button type="button" className="button small" onClick={() => onReveal(id)}>查看答案</button>
            {showAnswer && (gradable
              ? <span className={correct ? 'cl-ok' : 'cl-bad'}>{picked.length === 0 ? '未作答' : correct ? '回答正确' : '回答错误'}{question.analysis ? ` · ${question.analysis}` : ''}</span>
              : <span className="cl-quiz-ref">{question.analysis ? `参考要点：${question.analysis}` : '这一题没有标准答案，请对照资料自评。'}</span>)}
          </div>
        </article>;
      })}
    </div>;
  }
  if (type === 'interactive') {
    const url = typeof scene.content?.url === 'string' ? scene.content.url : '';
    const html = typeof scene.content?.html === 'string' ? scene.content.html : '';
    const src = url !== '' ? url : html !== '' ? `data:text/html;charset=utf-8,${encodeURIComponent(html)}` : '';
    if (src === '') return <p className="cl-muted"><Layers size={14} />这一页没有可运行的互动内容。</p>;
    return <div className="cl-interactive">
      <iframe title={scene.title || '互动演示'} src={src} sandbox="allow-scripts allow-forms allow-popups" referrerPolicy="no-referrer" loading="lazy" />
      <p className="cl-muted">互动内容由云端生成{scene.content?.widgetType === undefined ? '' : `（类型 ${String(scene.content.widgetType)}）`}，在沙箱里运行、不能访问本机数据。</p>
    </div>;
  }
  return <p className="cl-muted"><Layers size={14} />暂不支持直接播放这一页（类型 {String(type ?? '未知')}），可继续翻页。</p>;
}