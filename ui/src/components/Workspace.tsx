'use client';

import { useEffect, useRef, useState } from 'react';
import { BookOpen, ChevronRight, PanelRightOpen, Menu, Plus, ArrowUpRight, X, LoaderCircle, MessageSquareText, BookOpenText, Archive, Trash2 } from 'lucide-react';
import Sidebar from './Sidebar';
import StudyPanel from './StudyPanel';
import LearningChat from './LearningChat';
import Catalog from './Catalog';
import Modal from './Modal';
import StudySession from './StudySession';
import ReadingWorkspace from './ReadingWorkspace';
import UserDialogs from './UserDialogs';
import Home from './Home';
import CourseDialog from './CourseDialog';
import SettingsDialog from './SettingsDialog';
import CourseMenu, { type CourseAction } from './CourseMenu';
import CoursePicker from './CoursePicker';
import { useChatDrafts } from '@/hooks/useChatDrafts';
import { useWorkspace } from '@/hooks/useWorkspace';
import { workspaceService } from '@/services';
import type { Course, LearningMode, PanelTab, Task, View } from '@/types';

export default function Workspace() {
  const { data, error, loading, load, run, clearError } = useWorkspace();
  const drafts = useChatDrafts();
  const [selected, setSelected] = useState('linear-algebra');
  const [view, setView] = useState<View>('home');
  const [learningMode, setLearningMode] = useState<LearningMode>('chat');
  const [signedOut, setSignedOut] = useState(false);
  const [tab, setTab] = useState<PanelTab>('plan');
  const [mobileNav, setMobileNav] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [taskCollapsed, setTaskCollapsed] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [narrowLayout, setNarrowLayout] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Course | null>(null);
  const [courseAction, setCourseAction] = useState<{ course: Course; action: 'archive' | 'delete' } | null>(null);
  const [modal, setModal] = useState<'change-course' | 'create' | 'rename' | 'settings' | 'reset' | 'profile' | 'guide' | 'agreement' | null>(null);
  const [profileBase, setProfileBase] = useState(0);
  const [sending, setSending] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [study, setStudy] = useState<{ courseId: string; task: Task } | null>(null);
  const [toast, setToast] = useState('');
  const [deleteMaterial, setDeleteMaterial] = useState<{ courseId: string; materialId: string } | null>(null);
  const uploadTarget = useRef('linear-algebra');
  const upload = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeCourses = data?.courses.filter(c => !c.archived) ?? [];
  const course = activeCourses.find(c => c.id === selected) ?? activeCourses[0];
  const studyCourse = data?.courses.find(c => c.id === study?.courseId);

  useEffect(() => {
    try { setSignedOut(sessionStorage.getItem('syllora-ui.signed-out') === '1'); } catch { /* 受限浏览器中仅使用当前页面状态。 */ }
    if (window.matchMedia('(max-width: 850px)').matches) setAssistantOpen(false);
    const query = window.matchMedia('(max-width: 1050px)');
    const update = () => setNarrowLayout(query.matches);
    update(); query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (data) document.documentElement.dataset.theme = data.preferences.theme === 'dark' ? 'dark' : 'light';
  }, [data?.preferences.theme, Boolean(data)]);

  function changeMode(mode: LearningMode) {
    window.getSelection()?.removeAllRanges();
    if (mode === 'reading' && learningMode !== 'reading' && window.matchMedia('(max-width: 850px)').matches) setAssistantOpen(false);
    setLearningMode(mode); setPanelOpen(false);
    if (course) setView('workspace');
  }

  function notify(message: string) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3200);
  }
  function chooseCourse(id: string, mode?: LearningMode) { setSelected(id); setView('workspace'); if (mode) { setLearningMode(mode); if (mode === 'reading' && window.matchMedia('(max-width: 850px)').matches) setAssistantOpen(false); } setMobileNav(false); setPanelOpen(false); }
  function openCreate() { clearError(); setModal('create'); setMobileNav(false); }
  function closePanel() {
    setPanelOpen(false);
    if (!window.matchMedia('(max-width: 1050px)').matches) setTaskCollapsed(true);
  }
  async function manageCourse(target: Course, action: CourseAction) {
    clearError();
    if (sending === target.id) { notify('请等当前回复完成后再管理这门课程'); return; }
    if (action === 'rename') { setRenameTarget(target); setModal('rename'); }
    else if (action === 'restore') { if (await run(() => workspaceService.setCourseArchived(target.id, false))) notify('课程已恢复'); }
    else setCourseAction({ course: target, action });
  }
  function openUpload(courseId = course?.id) {
    if (!courseId) { openCreate(); return; }
    uploadTarget.current = courseId;
    upload.current?.click();
  }
  async function send(content: string) {
    if (!course || sending) return;
    const courseId = course.id;
    setSending(courseId);
    if (await run(() => workspaceService.appendMessage(courseId, content))) {
      drafts.clearAccepted(courseId, content);
      await run(() => workspaceService.reply(courseId, content));
    }
    setSending(null);
  }

  const labels: Record<View, string> = { home: '主页', workspace: '学习工作台', courses: '我的课程', materials: '资料库', review: '复习与巩固' };
  if (loading || !data) return <div className="app-loading"><span className="brand-icon"><BookOpen size={25} /></span><h1>Syllora.</h1>{error ? <><p role="alert">{error}</p><button className="button primary" onClick={() => void load()}>重新打开</button></> : <p><LoaderCircle size={15} className="spin" />正在打开你的学习空间…</p>}</div>;

  if (signedOut) return <div className="app-loading signed-out"><span className="brand-icon"><BookOpen size={25} /></span><h1>Syllora.</h1><h2>已退出学习空间</h2><p>你的本地课程与学习资料仍然保留。</p><button className="button primary" onClick={() => { try { sessionStorage.removeItem('syllora-ui.signed-out'); } catch {} setSignedOut(false); setView('home'); }}>进入学习空间<ArrowUpRight size={15} /></button><small>本地界面预览 · 未接入账号认证</small></div>;

  return <div className={`app-shell ${view !== 'workspace' || !course || learningMode === 'reading' ? 'without-panel' : taskCollapsed ? 'task-collapsed' : ''}`}>
    <input className="sr-only" type="file" accept=".pdf,.md,.txt" multiple ref={upload} aria-label="选择学习资料" onChange={async e => {
      const files = Array.from(e.target.files ?? []);
      const targetCourseId = uploadTarget.current;
      e.target.value = '';
      if (!files.length) return;
      if (files.some(f => !/\.(pdf|md|txt)$/i.test(f.name))) { notify('请选择 PDF、Markdown 或 TXT 文件'); return; }
      if (files.some(f => f.size > 20 * 1024 * 1024)) { notify('单个文件请控制在 20 MB 以内'); return; }
      if (files.some(f => /\.(md|txt)$/i.test(f.name) && f.size > 1024 * 1024)) { notify('本地阅读的 TXT、Markdown 文件请控制在 1 MB 以内'); return; }
      try {
        const documents = await Promise.all(files.map(async f => ({ name: f.name, size: f.size, ...(/\.(md|txt)$/i.test(f.name) ? { content: await f.text() } : {}) })));
        const result = await run(() => workspaceService.addMaterials(targetCourseId, documents));
        if (result) { setTab('materials'); notify(`已添加 ${files.length} 份资料`); }
      } catch { notify('资料读取失败，请重新选择文件'); }
    }} />
    <Sidebar courses={activeCourses} selected={course?.id ?? ''} view={view} mobileOpen={mobileNav} onClose={() => setMobileNav(false)} onView={v => { setView(v); setMobileNav(false); }} onCourse={chooseCourse} onCreate={openCreate} onUserAction={action => { clearError(); if (action === 'logout') { try { sessionStorage.setItem('syllora-ui.signed-out', '1'); } catch {} setSignedOut(true); return; } if (action === 'profile') setProfileBase(data.preferencesVersion ?? 0); setModal(action); }} />
    <main className="main-area"><header className="topbar"><nav className="breadcrumbs" aria-label="当前位置"><button className="icon-button mobile-only" onClick={() => setMobileNav(true)} aria-label="打开导航"><Menu size={20} /></button>{view === 'home' ? <span className="home-breadcrumb">主页</span> : <><button className={`breadcrumb-link ${view === 'courses' ? 'current' : ''}`} onClick={() => setView('courses')} aria-current={view === 'courses' ? 'page' : undefined}>我的课程</button>{view !== 'courses' && <><ChevronRight className="breadcrumb-chevron" size={13} /><span>{view === 'workspace' ? course?.name ?? '学习工作台' : labels[view]}</span></>}{view === 'workspace' && course && <CourseMenu course={course} variant="workspace" onChangeCourse={() => { clearError(); setModal('change-course'); }} onAction={(target, action) => void manageCourse(target, action)} />}</>}</nav><div className="topbar-actions">{view === 'home' && <><span className="home-date">{new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())}</span><button className="button small home-top-create" onClick={openCreate}><Plus size={14} />新建课程</button></>}<div className="learning-mode-switch" role="group" aria-label="学习模式"><button disabled={!course} aria-pressed={view === 'workspace' && learningMode === 'chat'} className={view === 'workspace' && learningMode === 'chat' ? 'active' : ''} onClick={() => changeMode('chat')}><MessageSquareText size={15} />对话学习</button><button disabled={!course} aria-pressed={view === 'workspace' && learningMode === 'reading'} className={view === 'workspace' && learningMode === 'reading' ? 'active' : ''} onClick={() => changeMode('reading')}><BookOpenText size={15} />辅助阅读</button></div></div></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={clearError}><X size={16} /></button></div>}
      <div className="view-stage" key={`${view}:${view === 'workspace' ? course?.id : ''}:${learningMode}`}>{view === 'home' ? <Home data={{ ...data, courses: activeCourses }} selected={course?.id ?? ''} onCourse={chooseCourse} onCreate={openCreate} onCourses={() => setView('courses')} onMaterials={() => setView('materials')} onStudy={(course, task) => setStudy({ courseId: course.id, task })} /> : view === 'workspace' && course ? learningMode === 'reading' ? <ReadingWorkspace key={course.id} course={course} onUpload={() => openUpload()} assistantOpen={assistantOpen} onToggleAssistant={() => setAssistantOpen(!assistantOpen)} onExpandAssistant={() => setAssistantOpen(true)} onActivity={() => void run(() => workspaceService.recordActivity(course.id, 'reading'))} /> : <LearningChat key={course.id} input={drafts.get(course.id)} onInput={value => { if (!drafts.set(course.id, value)) notify("草稿保留在当前页面；浏览器未允许保存，刷新后可能丢失。"); }} course={course} name={data.preferences.name} sending={sending === course.id} busy={Boolean(sending)} onPractice={() => setStudy({ courseId: course.id, task: { id: 'practice-demo', title: `${course.name} · 随堂练习`, kind: '复习', minutes: 10, completed: false } })} onSend={send} onStudy={task => setStudy({ courseId: course.id, task })} onUpload={() => openUpload()} /> : view === 'workspace' ? <div className="catalog-empty"><BookOpen size={35} /><h1>创建你的第一门课程</h1><p>把学习资料、计划和问题放在同一个地方。</p><button className="button primary" onClick={openCreate}><Plus size={16} />新建课程</button></div> : <Catalog key={view} onManage={(target, action) => void manageCourse(target, action)} view={view} courses={data.courses} onCourse={chooseCourse} onCreate={openCreate} onUpload={id => openUpload(id)} onDeleteMaterial={(courseId, materialId) => setDeleteMaterial({ courseId, materialId })} onReview={(courseId, point) => setStudy({ courseId, task: { id: point.id, title: point.title, kind: '复习', minutes: 10, completed: false } })} />}{view === 'workspace' && course && learningMode === 'chat' && narrowLayout && !panelOpen && <button className="icon-button mobile-task-expand" aria-label="展开学习面板" onClick={() => setPanelOpen(true)}><PanelRightOpen size={18} /></button>}</div>
    </main>
    {view === 'workspace' && course && learningMode === 'chat' && <>{panelOpen && <button className="panel-backdrop" aria-label="收起学习面板" onClick={() => setPanelOpen(false)} />}{taskCollapsed && !panelOpen ? <aside className="panel-rail task-rail" aria-label="任务看板已收起"><button className="icon-button" aria-label="展开学习面板" onClick={() => setTaskCollapsed(false)}><PanelRightOpen size={18} /></button></aside> : <StudyPanel course={course} tab={tab} open={panelOpen} dailyMinutes={data.preferences.dailyMinutes} onTab={setTab} onClose={closePanel} onToggle={task => void run(() => workspaceService.toggleTask(course.id, task.id))} onStudy={task => setStudy({ courseId: course.id, task })} onUpload={() => openUpload()} />}</>}
    {modal === 'change-course' && <CoursePicker courses={activeCourses} selected={course?.id ?? ''} onClose={() => setModal(null)} onChoose={id => { chooseCourse(id); setModal(null); }} />}
    {(modal === 'create' || modal === 'rename') && <CourseDialog key={modal} mode={modal} course={modal === 'rename' ? renameTarget ?? course : course} error={error} onClose={() => setModal(null)} onSave={async (name, icon) => { if (modal === 'create' && !icon) return false; const result = await run(() => modal === 'create' ? workspaceService.createCourse(name, icon!) : workspaceService.renameCourse((renameTarget ?? course)!.id, name)); if (result) { if (modal === 'create') { chooseCourse(result.courses.at(-1)!.id, 'chat'); setTab('materials'); } setModal(null); notify(modal === 'create' ? '新课程已创建' : '课程名称已更新'); } return Boolean(result); }} />}
    {modal === 'settings' && <SettingsDialog data={data} error={error} onClose={() => setModal(null)} onReset={() => setModal('reset')} onPreferences={async (preferences, baseVersion) => Boolean(await run(() => workspaceService.savePreferences({ ...preferences, name: preferences.name.trim() || '同学' }, baseVersion)))} onApi={async (config, baseVersion) => Boolean(await run(() => workspaceService.saveApiConfig(config, baseVersion)))} />}
    {modal === 'reset' && <Modal error={error} title="恢复演示数据" onClose={() => setModal(null)}><p className="modal-description">这会清除当前浏览器里的新增课程、资料信息、聊天记录和偏好，恢复初始的三门演示课程。</p><div className="modal-actions"><button className="button" onClick={() => setModal(null)}>取消</button><button className="button primary" disabled={saving || Boolean(sending)} onClick={async () => { setSaving(true); if (await run(() => workspaceService.reset())) { drafts.reset(); chooseCourse('linear-algebra'); setTab('plan'); setModal(null); notify('已恢复初始演示数据'); } setSaving(false); }}>确认恢复</button></div></Modal>}
    {courseAction && <Modal title={courseAction.action === 'archive' ? '归档课程' : '删除课程'} error={error} onClose={() => setCourseAction(null)}><div className="course-confirm-heading">{courseAction.action === 'archive' ? <Archive size={24} /> : <Trash2 size={24} />}<h3>{courseAction.course.name}</h3></div><p className="modal-description">{courseAction.action === 'archive' ? '课程会从正在学习与侧栏中收起，资料、消息和学习记录全部保留。你可以在“已归档”中恢复课程。' : '将删除这门课程及其本地资料、消息与学习记录。此操作无法撤销，原始文件不会被删除。'}</p><div className="modal-actions"><button className="button" onClick={() => setCourseAction(null)}>取消</button><button className={`button ${courseAction.action === 'delete' ? 'danger-button' : 'primary'}`} disabled={saving || Boolean(sending)} onClick={async () => { setSaving(true); try { const result = await run(() => courseAction.action === 'archive' ? workspaceService.setCourseArchived(courseAction.course.id, true) : workspaceService.deleteCourse(courseAction.course.id)); if (result) { setCourseAction(null); notify(courseAction.action === 'archive' ? '课程已归档，可随时恢复' : '课程已删除'); } } finally { setSaving(false); } }}>{courseAction.action === 'archive' ? '确认归档' : '确认删除课程'}</button></div></Modal>}
    {deleteMaterial && <Modal error={error} title="移除资料" onClose={() => setDeleteMaterial(null)}><p className="modal-description">将从本地演示列表中移除这份资料的信息。你的原始文件不会受影响。</p><div className="modal-actions"><button className="button" onClick={() => setDeleteMaterial(null)}>取消</button><button className="button primary" onClick={async () => { if (await run(() => workspaceService.removeMaterial(deleteMaterial.courseId, deleteMaterial.materialId))) { setDeleteMaterial(null); notify('资料信息已移除'); } }}>确认移除</button></div></Modal>}
    {study && studyCourse && <StudySession error={error} course={studyCourse} task={study.task} onClose={() => setStudy(null)} onComplete={async () => { const exists = studyCourse.tasks.find(t => t.id === study.task.id); if (exists && !exists.completed) { if (!await run(() => workspaceService.toggleTask(study.courseId, study.task.id))) return; } else if (!exists) { if (!await run(() => workspaceService.recordActivity(study.courseId, 'practice', study.task.minutes))) return; } setStudy(null); notify(exists ? '本次学习活动已记录' : '本次巩固练习已结束'); }} />}
    {(modal === 'profile' || modal === 'guide' || modal === 'agreement') && <UserDialogs page={modal} name={data.preferences.name} error={error} onClose={() => setModal(null)} onSave={async name => { const result = await run(() => workspaceService.savePreferences({ ...data.preferences, name }, profileBase)); if (result) notify('用户资料已保存'); return Boolean(result); }} />}
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}
