"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, FolderOpen, Settings, ArrowRight, Send, Upload, FileText, Check, Archive, RotateCcw, Trash2, X, LoaderCircle, PanelRight, Pencil, Menu, MessageSquareText, BookOpenText } from 'lucide-react';
import { api } from '../lib/api';
import ReactMarkdown from 'react-markdown';
import type { SylloraState, Task, CourseView } from '../types/syllora';
import { editDraft, hydrateCourse, markSaved, rememberServer, type DraftCache } from './syllora-drafts';
import { LectureReader, ProjectDialog } from './syllora-project-ui';
import { MaterialsSection, PanelEmpty, StudySection, TodaySection } from './panel/StudyPanel';
import { LearningJobDiagnostics, LearningMetrics, SessionControls, useLearningExposures } from './syllora-metrics';
import './syllora.css';

import StudySession from '../features/workbench/components/StudySession';
import Modal from '../features/workbench/components/Modal';
import CourseIdentityPicker from '../features/workbench/components/CourseIdentityPicker';
import { VectorDrawing } from '../features/workbench/components/LearningChat';
import { logicalRequest, workbenchRpc as rpc } from '../features/workbench/services';
import { projectWorkspace } from '../features/workbench/projection';
import Sidebar from '../features/workbench/components/Sidebar';
import Home from '../features/workbench/components/Home';
import Catalog from '../features/workbench/components/Catalog';
import ReadingWorkspace from '../features/workbench/components/ReadingWorkspace';
import UserDialogs from '../features/workbench/components/UserDialogs';
import SettingsPanel, { type SettingsTab } from '../features/workbench/components/SettingsPanel';
import type { View, LearningMode, Course as DisplayCourse } from '../features/workbench/types';
import type { CourseAction } from '../features/workbench/components/CourseMenu';
import '../features/workbench/workbench.css';
import '../features/workbench/appearance.css';
import '../features/workbench/integrated.css';
// agent-chat.css follows the workbench styles to preserve its scoped overrides.
import AgentChat from './chat/AgentChat';
import { recoverDrafts, saveDraftRecovery } from '../features/workbench/draftRecovery';
import '../features/workbench/restored.css';
import { useModalFocus } from '../features/workbench/useModalFocus';
const uuid = () => crypto.randomUUID();
const formatTime = (at:number,zone:string) => new Intl.DateTimeFormat('zh-CN',{timeZone:zone,month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(at);

/** 桌面壳经 contextBridge 暴露的桥。浏览器里整块不存在（undefined），
 *  所以所有调用点都必须先判空——「本机与诊断」在浏览器下退化为只显示提示。 */
type DesktopBridge = {
  isDesktop?: boolean;
  platform?: string;
  hostInfo?: () => Promise<{ dev?: boolean; port?: number|null; hostHome?: string; logsDir?: string; dataDir?: string }>;
  openPath?: (path:string) => Promise<{ ok:boolean; error?:string }>;
};
const desktopBridge = (): DesktopBridge|undefined => (window as unknown as { sylloraDesktop?: DesktopBridge }).sylloraDesktop;

/** 一份宿主日志文件（内容已按上限截断）。 */
type DiagFile = { name:string; bytes:number; text:string; truncated:boolean };

export default function Syllora() {
  useModalFocus();
  const [data,setData] = useState<SylloraState|null>(null);
  const [view,setView]=useState<View>('home');
  const [learningMode,setLearningMode]=useState<LearningMode>('chat');
  const [assistantOpen,setAssistantOpen]=useState(true);
  const [mobileNav,setMobileNav]=useState(false);
  const [userPage,setUserPage]=useState<'profile'|'guide'|'agreement'|null>(null);
  const [selected,setSelected] = useState('');
  const [tab,setTab] = useState<'today'|'study'|'materials'>('today');
  const [settings,setSettings] = useState(false);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [migration,setMigration] = useState<{id:string;name:string}|null>(null);
  const [fileEpoch,setFileEpoch] = useState(0);
  const [creating,setCreating] = useState(false);
  const [prompt,setPrompt] = useState('');
  const [draftConflict,setDraftConflict]=useState('');
  const savesInFlight=useRef(new Map<string,Promise<boolean>>());
  const [text,setText] = useState('');
  const [scope,setScope] = useState<string[]>([]);
  const [minutes,setMinutes] = useState(40);
  const minutesEdited=useRef(false);
  const [days,setDays] = useState(7);
  const [deadline,setDeadline] = useState('');
  const [estimates,setEstimates] = useState<Record<string,string>>({});
  const [restDays,setRestDays] = useState<number[]>([]);
  const [consent,setConsent] = useState(false);
  const [renaming,setRenaming] = useState(false);
  const [renameValue,setRenameValue] = useState('');
  const [renameIcon,setRenameIcon]=useState('notebook');
  const [renameColor,setRenameColor]=useState<DisplayCourse['color']>('blue');
  const [disputeTarget,setDisputeTarget] = useState<string|null>(null);
  const [disputeReason,setDisputeReason] = useState('');
  const [answerReport,setAnswerReport]=useState<string|null>(null);const [answerReason,setAnswerReason]=useState('');
  const [diagFiles,setDiagFiles] = useState<DiagFile[]|null>(null);
  const [diagLoading,setDiagLoading] = useState(false);
  const [sourceId,setSourceId] = useState<string|null>(null);
  const [recoveryPoint,setRecoveryPoint] = useState('');
  const [activeTask,setActiveTask] = useState<string|null>(null);
  const [explanationJob,setExplanationJob]=useState<{taskId:string;jobId:string}|null>(null);
  const [answers,setAnswers] = useState<Record<string,number>>({});
  const [showRight,setShowRight] = useState(true);
  /** 需求三：讲义阅读入口从面板移到中栏（「今日」卡的「阅读讲义」进入），
   *  中栏讲义能力与渲染不变。 */
  const [showLecture,setShowLecture] = useState(false);
  const [diffCourse,setDiffCourse] = useState<CourseView|null>(null);
  const [adjustNotice,setAdjustNotice] = useState<string|null>(null);
  const [editMinutes,setEditMinutes] = useState<Record<string,string>>({});
  const [settingsTab,setSettingsTab] = useState<SettingsTab>('models');
  const [hostPaths,setHostPaths] = useState<{hostHome?:string;logsDir?:string;dataDir?:string}|null>(null);
  const pollInFlight = useRef(false);
  const pollStartedAt = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);
  const selectedRef = useRef('');
  const promptRef = useRef('');
  const answersRef = useRef<Record<string,number>>({});
  const dataRef = useRef(data);
  const cacheRef = useRef<DraftCache>({});
  const saveTimer = useRef<number | null>(null);
  // 「继续」在导入资料这一步要直接唤起系统文件选择框。输入框必须常驻挂在
  // 组件顶层：放在「资料」标签页里时，setTab('materials') 之后 React 还没
  // 重渲染，ref 仍指向旧树上的节点，.click() 会落空——这正是原来「点了没反应」
  // 的成因之一。
  const fileInput = useRef<HTMLInputElement>(null);
  const course = data?.courses.find(c=>c.id===selected);
  useEffect(()=>{if(!minutesEdited.current&&!course?.plan)setMinutes(data?.uiPreferences?.dailyMinutes??40);},[data?.uiPreferences?.dailyMinutes,course?.id,course?.plan]);
  const refresh = useCallback(async()=>{
    if(pollInFlight.current)return;
    pollInFlight.current=true;
    const started=Date.now();
    try {const next=await rpc<SylloraState>('state');pollStartedAt.current=started;setData(next);setSelected(old=>next.courses.some(c=>c.id===old)?old:(next.courses[0]?.id??''));}
    catch(e){setError(e instanceof Error?e.message:'无法连接本地服务');}
    finally{pollInFlight.current=false;}
  },[]);
  useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),1500);return()=>clearInterval(timer)},[refresh]);
  useEffect(()=>{selectedRef.current=selected},[selected]);
  useEffect(()=>{dataRef.current=data},[data]);
  useEffect(()=>{
    if(!data)return;
    cacheRef.current=recoverDrafts(cacheRef.current,data.courses);
    for(const item of data.courses) cacheRef.current=rememberServer(cacheRef.current,item.id,item.drafts,pollStartedAt.current);
    const local=cacheRef.current[selectedRef.current];if(local){promptRef.current=local.prompt;answersRef.current=local.answers;setPrompt(local.prompt);setAnswers(local.answers);}
  },[data]);
  useEffect(()=>{
    minutesEdited.current=false;
    setDraftConflict('');setDisputeTarget(null);setAnswerReport(null);setAnswerReason('');setScope([]);setRecoveryPoint('');setActiveTask(null);setSourceId(null);setError('');setDeadline('');setEstimates({});setMinutes(dataRef.current?.uiPreferences?.dailyMinutes??40);setDays(7);setRestDays([]);setDiffCourse(null);setAdjustNotice(null);setEditMinutes({});setShowLecture(false);
    if(!selected)return;
    const server=dataRef.current?.courses.find(item=>item.id===selected)?.drafts??{prompt:'',answers:[]};
    if(!cacheRef.current[selected]) cacheRef.current=rememberServer(cacheRef.current,selected,server);
    const view=hydrateCourse(cacheRef.current,selected,server);
    promptRef.current=view.prompt;answersRef.current=view.answers;setPrompt(view.prompt);setAnswers(view.answers);
  },[selected]);
  // 「诊断日志」需要宿主目录事实（桌面桥提供）；浏览器里桥不存在，
  // 分区仍可用——日志内容来自宿主 RPC，与桌面桥无关。
  useEffect(()=>{
    if(!settings)return;
    let alive=true;
    void desktopBridge()?.hostInfo?.().then(info=>{if(alive)setHostPaths({hostHome:info.hostHome,logsDir:info.logsDir,dataDir:info.dataDir})},()=>{if(alive)setHostPaths(null)});
    return ()=>{alive=false};
  },[settings]);
  // 进入「诊断日志」分区时拉一次日志；切走再切回不重复拉（除非手动刷新）。
  useEffect(()=>{
    if(!settings||settingsTab!=='diag'||diagFiles!==null)return;
    let alive=true;
    setDiagLoading(true);
    void api.diagnosticsLogs().then(
      r=>{if(alive){setDiagFiles(r.files);setDiagLoading(false)}},
      ()=>{if(alive){setDiagFiles([]);setDiagLoading(false)}},
    );
    return ()=>{alive=false};
  },[settings,settingsTab,diagFiles]);
  useEffect(()=>{bottom.current?.scrollIntoView({behavior:'smooth'});},[course?.messages.length]);
  const persistDraft = async(courseId:string):Promise<boolean>=>{
    const existing=savesInFlight.current.get(courseId);
    if(existing){if(!(await existing))return false;return persistDraft(courseId);}
    const local=cacheRef.current[courseId];
    if(!local||local.revision===local.savedRevision||dataRef.current?.courses.find(item=>item.id===courseId)?.archived)return true;
    const revision=local.revision;
    const saving=(async()=>{try{
      const saved=await rpc<{version?:number}>('saveDraft',{courseId,baseVersion:local.baseVersion??0,prompt:local.prompt,answers:Object.entries(local.answers).map(([questionId,option])=>({questionId,option}))});
      cacheRef.current=markSaved(cacheRef.current,courseId,revision,Date.now(),saved.version);saveDraftRecovery(cacheRef.current);return true;
    }catch(e){if(e instanceof Error&&'code' in e&&e.code==='VERSION_CONFLICT')setDraftConflict(courseId);setError(e instanceof Error?`${e.message}。未提交输入已保留。`:'未提交草稿未能保存。');return false;}finally{savesInFlight.current.delete(courseId);}})();
    savesInFlight.current.set(courseId,saving);return saving;
  };
  const scheduleSave = (courseId:string)=>{
    if(saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current=window.setTimeout(()=>{saveTimer.current=null;void persistDraft(courseId)},400);
  };
  const flushDraft = async()=>{
    const courseId=selectedRef.current;
    if(!courseId) return true;
    if(saveTimer.current){window.clearTimeout(saveTimer.current);saveTimer.current=null}
    return persistDraft(courseId);
  };
  const selectCourse = async(id:string)=>{if(id===selectedRef.current)return true;if(!(await flushDraft()))return false;selectedRef.current=id;setSelected(id);return true};
  const rememberPrompt = (value:string)=>{
    promptRef.current=value;setPrompt(value);
    if(!selectedRef.current)return;
    cacheRef.current=editDraft(cacheRef.current,selectedRef.current,value,answersRef.current);
    if(!saveDraftRecovery(cacheRef.current))setError('浏览器恢复缓存未能写入；输入仍保留，正在尝试保存到本机服务。');
    scheduleSave(selectedRef.current);
  };
  const rememberAnswer = (questionId:string,option:number)=>{
    const next={...answersRef.current,[questionId]:option};
    answersRef.current=next;setAnswers(next);
    if(!selectedRef.current)return;
    cacheRef.current=editDraft(cacheRef.current,selectedRef.current,promptRef.current,next);
    if(!saveDraftRecovery(cacheRef.current))setError('浏览器恢复缓存未能写入；输入仍保留，正在尝试保存到本机服务。');
    scheduleSave(selectedRef.current);
  };
  const run = async(action:string,payload:Record<string,unknown>={})=>{
    setBusy(true);setError('');
    try{const input={courseId:selected,...payload};const result=await (action==='generate'||action==='initialize'||action==='submit'?logicalRequest(action,input):rpc(action,input));if(action==='import')setFileEpoch(v=>v+1);await refresh();return result;}
    catch(e){setError(e instanceof Error?e.message:'操作失败');return null;}
    finally{setBusy(false)}
  };
  const generate = async(kind:string,extra:Record<string,unknown>={})=>{if(!(await flushDraft()))return null;return run('generate',{kind,...extra});};
  const running = data?.jobs.find(j=>j.courseId===selected&&j.state==='running');
  const lastJob = data?.jobs.filter(j=>j.courseId===selected).at(-1);
  const coverageNote=lastJob?.state==='succeeded'&&lastJob.coverage?(()=>{
    const c=lastJob.coverage;
    return `本次使用 ${c.sourcesUsed} / ${c.sourcesTotal} 个候选片段（${c.charsUsed} / ${c.charsTotal} 字符）${c.materialsWithOmitted.length?`；尚有片段未使用：${c.materialsWithOmitted.join('、')}。未选入片段不参与本次回答。`:'。'}`;
  })():null;
  const task = course?.plan?.tasks.find(t=>t.id===activeTask) ?? course?.plan?.tasks.find(t=>t.status==='in_progress');
  const source = course?.materials.flatMap(m=>[...m.sources,...(m.history??[])]).find(s=>s.id===sourceId);
  const pointName = (id:string) => course?.points.find(p=>p.id===id)?.name??'知识点';
  /** 把拉到的日志拼成单个 .log 文件下载。Blob + a[download] 在浏览器与
   *  Electron 里行为一致，不依赖桌面桥。 */
  const exportDiagLogs = ()=>{
    const files = diagFiles ?? [];
    const stamp = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    const body = files.map(f=>`===== ${f.name} (${f.bytes} bytes${f.truncated?', 截断':''}) =====\n${f.text}`).join('\n\n');
    const blob = new Blob([body||'(无日志内容)\n'],{type:'text/plain;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `syllora-diag-${stamp}.log`;
    document.body.appendChild(a); a.click(); a.remove();
    // 释放对象 URL：延迟到点击处理结束之后，避免个别引擎提前回收。
    setTimeout(()=>URL.revokeObjectURL(url),10_000);
  };
  const startTask = async(t:Task)=>{setView('workspace');setLearningMode('chat');if(await run('start',{taskId:t.id}))setActiveTask(t.id)};
  const upload = async(file:File)=>{
    if(file.size>20*1024*1024){setError('单文件不能超过 20 MiB');return}
    const reader=new FileReader();
    reader.onload=()=>void run('import',{name:file.name,base64:String(reader.result).split(',')[1]});
    reader.onerror=()=>setError('无法读取文件');
    reader.readAsDataURL(file);
  };
  const proposeReview = async(pointId:string)=>{if(await run('review',{pointId})){setActiveTask(null);setTab('today')}};
  /** 唤起系统文件选择框。切到「资料」页是为了让用户选完就能看到结果。 */
  const pickMaterialFile = ()=>{setTab('materials');fileInput.current?.click()};
  const next = async()=>{
    if(!course)return;
    if(course.next.kind==='blocked'){setActiveTask(null);setTab('materials');return}
    if(course.next.kind==='waiting'){setTab('today');return}
    if(course.folder&&!course.revision){setTab('materials');return}
    if(course.next.taskId){
      const t=course.plan?.tasks.find(t=>t.id===course.next.taskId);
      if(t){await startTask(t);return}
      // 计划版本更替后旧任务 id 会失效，旧实现这里没有 else——静默什么都不做，
      // 用户看到的就是「点了继续没反应」。改为显式同步并说明。
      await refresh();setError('计划已更新，已同步最新状态，请再点一次「继续」');return;
    }
    if(course.next.pointId){await proposeReview(course.next.pointId);return}
    // 还没有可用资料 = 正处在「导入资料」这一步：直接打开文件选择框。
    if(!course.materials.some(m=>m.status!=='deleted')){pickMaterialFile();return}
    setTab('study');
  };
  useEffect(()=>{setEditMinutes({})},[course?.draft?.id]);
  const exposureError=useLearningExposures(course,rpc,tab);
  const uiData=data?projectWorkspace(data):null;
  const displayCourse=uiData?.courses.find(item=>item.id===selected);
  useEffect(()=>{const theme=data?.uiPreferences?.theme??'light';document.documentElement.dataset.theme=theme;},[data?.uiPreferences?.theme]);
  const openUiCourse=async(id:string,mode:LearningMode='chat')=>{setRenaming(false);if(!(await selectCourse(id)))return false;setView('workspace');setLearningMode(mode);setMobileNav(false);return true;};
  const manageUiCourse=async(item:DisplayCourse,action:CourseAction)=>{
    if(!(await selectCourse(item.id)))return;
    if(action==='rename'){setRenameValue(item.name);setRenameIcon(item.icon??'notebook');setRenameColor(item.color??'blue');setRenaming(true);return;}
    if(action==='delete'){if(window.confirm(`删除「${item.name}」的整理产物与学习记录？原始资料保留。`))await run('delete',{courseId:item.id,confirmed:true});}
    else await run('archive',{courseId:item.id,archived:action==='archive'});
  };
  const archiveDiscussion = Boolean(course?.folder && course.messages.length > 0);
  const DiscussionShell: 'details'|'div' = archiveDiscussion ? 'details' : 'div';
  /** 需求一：课程顺序 = 服务端 projects.json 的顺序（state.projects 原样透出）。
   *  无 projects 的快照（旧服务/测试替身）回落到 courses 顺序。乐观更新后由
   *  refresh 校正；失败时 refresh 会把顺序退回服务端事实。 */
  const projectOrder = data?.projects?.map(project=>project.id) ?? [];
  const railCourses = (() => {
    if (!uiData) return [];
    const indexed = new Map(uiData.courses.map((item, index) => [item.id, index]));
    return [...uiData.courses].sort((a, b) => {
      const ai = projectOrder.indexOf(a.id), bi = projectOrder.indexOf(b.id);
      if (ai === -1 && bi === -1) return (indexed.get(a.id) ?? 0) - (indexed.get(b.id) ?? 0);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  })();
  /** 落位后持久化；先本地乐观重排（拖拽即时反馈），再以服务端顺序校正。 */
  const reorderCourses = (ids: string[]) => {
    const seen = new Set(ids);
    setData(current => current ? { ...current, projects: [...ids.map(id => current.projects?.find(item => item.id === id) ?? { id, path: '', name: current.courses.find(c => c.id === id)?.name ?? '', error: null }), ...(current.projects ?? []).filter(item => !seen.has(item.id))] } : current);
    void rpc('reorderCourses', { courseIds: [...ids, ...projectOrder.filter(id => !seen.has(id))] }).then(() => refresh()).catch(error => { setError(error instanceof Error ? error.message : '课程顺序未能保存'); void refresh(); });
  };
  return <div className={`app-shell integrated-shell restored-workbench ${showRight&&view==='workspace'&&learningMode==='chat'?'':'sy-no-right without-panel'}`}>
    <input ref={fileInput} type="file" accept={course?.folder?'.pdf,.md,.txt,.docx,.xlsx,.html,.htm':'.pdf,.md,.txt'} aria-label="上传课程资料" style={{display:'none'}} disabled={!course||busy||course.archived} onChange={e=>{const file=e.target.files?.[0];if(file)void upload(file);e.target.value=''}}/>
    <Sidebar courses={railCourses.filter(item=>!item.archived)} selected={selected} view={view} mobileOpen={mobileNav} onClose={()=>setMobileNav(false)} onView={value=>{setView(value);setMobileNav(false);}} onCourse={id=>void openUiCourse(id)} onCreate={()=>{setMigration(null);setCreating(true)}} onReorder={reorderCourses} onUserAction={action=>{
      if(action==='settings'||action==='profile'){setSettings(true);setSettingsTab(action==='profile'?'prefs':'models');setConsent(data?.settings.consent??false);}
      else if(action==='logout'){if(course?.activeSession)void run('endSession',{sessionId:course.activeSession.id});else setError('当前没有进行中的学习会话');}
      else setUserPage(action);
    }}/>
    <main className="sy-main main-area">
      <header className="sy-top topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={()=>setMobileNav(true)}><Menu size={20}/></button><div><span>{view==='home'?'主页':view==='courses'?'我的课程':view==='materials'?'资料库':view==='review'?'复习与巩固':'课程学习'}</span><h1>{view==='workspace'?course?.name??'从一门课程开始':'Syllora'}</h1></div><div className="sy-actions">{view==='workspace'&&<div className="learning-mode-switch" role="group" aria-label="学习模式"><button aria-pressed={learningMode==='chat'} onClick={()=>setLearningMode('chat')}><MessageSquareText size={16}/>对话学习</button><button aria-pressed={learningMode==='reading'} onClick={()=>setLearningMode('reading')}><BookOpenText size={16}/>辅助阅读</button></div>}{view==='workspace'&&course&&<><button aria-label="重命名课程" title="重命名" onClick={()=>{setRenameValue(course.name);setRenameIcon(course.icon??'notebook');setRenameColor(course.color??'blue');setRenaming(true)}}><Pencil size={16}/></button><button aria-label={course.archived?'恢复课程':'归档课程'} title={course.archived?'恢复课程':'归档课程'} onClick={()=>void run('archive',{archived:!course.archived})}>{course.archived?<RotateCcw size={16}/>:<Archive size={16}/>}</button><button aria-label="删除课程" title="删除课程" onClick={()=>{if(window.confirm(`删除「${course.name}」的 Syllora 整理产物与学习记录？原始资料和课程文件夹保留。此操作不可撤销。`))void run('delete',{confirmed:true})}}><Trash2 size={16}/></button></>}<button aria-label="切换状态栏" onClick={()=>learningMode==='reading'?setAssistantOpen(value=>!value):setShowRight(!showRight)}><PanelRight size={18}/></button></div></header>
      {error&&<div className="sy-error" role="alert">{error}<button aria-label="关闭错误" onClick={()=>setError('')}><X size={14}/></button></div>}
    {view==='courses'&&data?.projects?.filter(project=>project.error).map(project=><div className="integrated-project-error" key={project.id}>{project.name}：{project.error}<small>{project.path}</small>{project.deletion&&<button onClick={()=>{if(window.confirm(`重试删除「${project.name}」的应用记录？原始资料保留。`))void run('delete',{courseId:project.id,confirmed:true})}}>重试删除课程</button>}</div>)}
    {view==='courses'&&data?.legacyCourses?.map(item=><button className="integrated-migration" key={item.id} onClick={()=>{setMigration(item);setCreating(true)}}>迁移旧课程：{item.name}</button>)}
      {draftConflict&&draftConflict===selected&&<div className="sy-notice" role="status">草稿版本冲突，当前输入已保留。<button onClick={async()=>{try{const latest=await rpc<SylloraState>('state'),server=latest.courses.find(item=>item.id===selected)?.drafts;if(server){delete cacheRef.current[selected];cacheRef.current=rememberServer(cacheRef.current,selected,server);const view=hydrateCourse(cacheRef.current,selected,server);promptRef.current=view.prompt;answersRef.current=view.answers;setPrompt(view.prompt);setAnswers(view.answers);setDraftConflict('');setError('');saveDraftRecovery(cacheRef.current);}}catch(error){setError(error instanceof Error?error.message:'加载草稿失败');}}}>放弃本页输入并加载最新草稿</button></div>}
      {!data?<div className="sy-empty"><LoaderCircle className="sy-spin"/><h2>正在连接本地服务</h2><p>请确认 Syllora 服务已启动。</p></div>:view==='home'&&uiData?<Home data={{...uiData,courses:railCourses.filter(item=>!item.archived)}} selected={selected} onCourse={(id,mode)=>void openUiCourse(id,mode)} onCreate={()=>setCreating(true)} onCourses={()=>setView('courses')} onMaterials={()=>setView('materials')} onStudy={(item,t)=>{void openUiCourse(item.id).then(ok=>{if(!ok)return;const task=data.courses.find(course=>course.id===item.id)?.plan?.tasks.find(task=>task.id===t.id);if(task)void run('start',{courseId:item.id,taskId:task.id}).then(ok=>{if(ok)setActiveTask(task.id)})})}}/>:view!=='workspace'&&uiData?<Catalog view={view as 'courses'|'materials'|'review'} courses={railCourses} onCourse={id=>void openUiCourse(id)} onCreate={()=>setCreating(true)} onUpload={id=>{void openUiCourse(id).then(ok=>{if(ok){setTab('materials');setShowRight(true)}})}} onDeleteMaterial={(courseId,materialId)=>{if(window.confirm('删除资料的应用记录？原件保留，相关证据重新计算。'))void run('deleteMaterial',{courseId,materialId,confirmed:true})}} onReview={(item,point)=>{void openUiCourse(item).then(ok=>{if(!ok)return;setTab('today');setShowRight(true);void run('review',{courseId:item,pointId:point.id})})}} onManage={(item,action)=>void manageUiCourse(item,action)}/>:!course?<div className="sy-empty"><BookOpen size={48}/><p className="sy-kicker">学习从这里开始</p><h2>把资料变成<br/>下一步行动。</h2><p>打开课程文件夹，整理讲义，按自己的节奏学习。<br/>每一次作答，都会留下可追溯的学习证据。</p><button className="sy-primary" onClick={()=>setCreating(true)}>打开课程文件夹 <ArrowRight size={16}/></button></div>:<>
      {learningMode==='reading'&&displayCourse?<ReadingWorkspace course={displayCourse} assistantOpen={assistantOpen} onToggleAssistant={()=>setAssistantOpen(value=>!value)} onExpandAssistant={()=>setAssistantOpen(true)} onUpload={()=>{setLearningMode('chat');setTab('materials');setShowRight(true)}} onActivity={()=>void refresh()} onSource={setSourceId}/>:<>
      <AgentChat draft={prompt} onDraft={rememberPrompt} folder={course.folder??''} courseId={course.id} courseName={course.name} name={data.uiPreferences?.name??'学习者'} disabled={course.archived} onUpload={pickMaterialFile} onPractice={()=>{setTab('today');setShowRight(true);}} onOpenSettings={()=>{setSettingsTab('models');setSettings(true);setConsent(data?.settings.consent??false)}}>
      <div className="study-context">

        <details className="learning-session-details"><summary>学习会话</summary><SessionControls key={course.id} course={course} task={task} busy={busy} onRun={run}/></details>{exposureError&&<p role="status">{exposureError}</p>}
        {showLecture&&<LectureReader key={course.id} course={course} onSource={setSourceId}/>}
        {course.notice&&<div className="sy-notice" role="status"><p>{course.notice.text}</p>{course.notice.kind==='restore'&&<button disabled={busy||course.archived} onClick={()=>void run('proposeRestore').then(ok=>{if(ok)setTab('today')})}>生成恢复日程草案</button>}</div>}
        <section className="next-step"><div className="next-copy"><span className="blue-eyebrow"><span className="tiny-blue-dot"/>今日下一步</span><h2>{course.next.text}</h2><p>{course.next.reason}</p>{course.next.pointId&&<p>{pointName(course.next.pointId)}</p>}<p>{course.next.availableAt===null?'现在可以执行':course.next.kind==='summary'?`下次复习：${formatTime(course.next.availableAt,course.timezone)}`:`可执行时间：${formatTime(course.next.availableAt,course.timezone)}`}</p>{course.next.kind==='summary'&&<button disabled={course.archived} onClick={()=>setTab('study')}>补充学习范围</button>}{course.next.practice&&<button className="sy-optional" disabled={busy||course.archived} onClick={()=>void proposeReview(course.next.practice!.pointId)}>{course.next.practice.text}</button>}<button className="button primary" disabled={busy||course.archived||course.next.kind==='waiting'} onClick={()=>void next()}>{course.next.kind==='blocked'?'补充资料':'继续'} <ArrowRight size={16}/></button></div><VectorDrawing/></section>
        {task&&(activeTask||!course.folder)&&displayCourse&&!(course.blockedPointIds??[]).includes(task.pointId)&&<StudySession inline={!course.folder} course={displayCourse} title={pointName(task.pointId)} minutes={task.minutes} onClose={()=>setActiveTask(null)}><section className="sy-task-study"><div className="sy-task-heading"><span>{task.immediate?'即时巩固':task.kind==='review'?'复习任务':'学习任务'} · {task.minutes} 分钟</span><span>{task.status==='completed'?'活动已完成':`${task.slots} 个题位`}</span></div><h2>{pointName(task.pointId)}</h2><div className="sy-row"><button disabled={busy||!!running||course.archived} onClick={async()=>{const result=await generate('answer',{taskId:task.id,prompt:`请讲解「${pointName(task.pointId)}」，用资料依据和一个明确标识的教学示例帮助理解。`}) as {jobId:string}|null;if(result)setExplanationJob({taskId:task.id,jobId:result.jobId});}}>获取资料讲解</button>{!task.explained&&<button disabled={busy||course.archived} onClick={()=>void run('explainDone',{taskId:task.id})}><Check size={15}/>我已完成讲解学习</button>}</div>
        {course.messages.filter(message=>explanationJob?.taskId===task.id&&message.id===data.jobs.find(job=>job.id===explanationJob.jobId)?.resultMessageId).map(message=><div className="session-tip" key={message.id}><div><ReactMarkdown skipHtml>{message.text}</ReactMarkdown><div className="sy-citations">{message.sourceIds.map((id,i)=><button key={id} onClick={()=>setSourceId(id)}>来源 {i+1}</button>)}</div></div></div>)}
        {Array.from({length:task.slots},(_,slot)=>{
          const q=course.questions.filter(q=>q.taskId===task.id&&q.slot===slot).at(-1);
          const attempt=q?course.attempts.find(a=>a.questionId===q.id):undefined;
          return <div className="sy-question" key={slot} data-learning-kind={q?.status==='valid'?'question':undefined} data-learning-id={q?.status==='valid'?q.id:undefined}><div className="sy-kicker">练习 {slot+1}</div>{!q||q.status!=='valid'?<><p>{q?'此题已暂停评估，原作答保留，请生成替代题。':'按当前知识点资料生成一道新题。'}</p><button disabled={busy||!!running||course.archived} onClick={()=>void generate('question',{taskId:task.id,slot})}>生成{q?'替代':''}题目</button></>:<><h3>{q.stem}</h3><div className="sy-options" role="group" aria-label={`练习 ${slot+1} 选项`}>{q.options.map((o,i)=><button key={i} disabled={!!attempt||busy||course.archived} className={(attempt?.option??answers[q.id])===i?'is-selected':''} onClick={()=>rememberAnswer(q.id,i)}><span>{String.fromCharCode(65+i)}</span>{o}</button>)}</div>{!attempt?<div className="sy-row"><button className="sy-primary" disabled={answers[q.id]===undefined||busy||course.archived} onClick={async()=>{setAdjustNotice(null);const r=await run('submit',{questionId:q.id,option:answers[q.id],}) as {correct?:boolean;planAdjustment?:{ok:boolean;code:string;message?:string;draftId:string|null}}|null;if(r&&!r.correct){if(r.planAdjustment?.ok)setAdjustNotice('已根据本次错答生成计划调整草案，可查看差异后决定是否接受');else if(r.planAdjustment?.code==='SKIPPED_EXISTING_DRAFT')setAdjustNotice('已有待确认草案，本次未重复生成');else if(r.planAdjustment?.code==='SKIPPED_EXISTING_REVIEW')setAdjustNotice('已有待开始或进行中的复习，本次保留该安排');else if(r.planAdjustment?.code==='FAILED')setAdjustNotice('本次错答未能生成调整建议，可稍后重试')}}}>提交答案</button><button disabled={busy||course.archived} onClick={()=>void run('reveal',{questionId:q.id})}>查看答案（记为辅助学习）</button></div>:<div className="sy-feedback"><strong>{attempt.correct?'回答正确':'回答错误'} · {attempt.assisted?'辅助学习，不计独立证据':'已保存独立作答'}</strong><p>{course.evidence[q.pointId]?.state} · {course.evidence[q.pointId]?.reason}</p></div>}{q.answer!==undefined&&<div className="sy-explanation"><p><strong>答案 {String.fromCharCode(65+q.answer)}</strong>　{q.explanation}</p><blockquote>{q.quote}</blockquote><div className="sy-row">{q.sourceIds.map(s=><button key={s} onClick={()=>setSourceId(s)}>查看依据</button>)}<button disabled={course.archived||busy} onClick={()=>{setDisputeTarget(q.id);setDisputeReason('')}}>题目报错并暂停计入</button></div></div>}</>}</div>
        })}</section></StudySession>}
        {course.next.kind==='blocked'&&<section className="sy-notice"><h2>恢复「{pointName(course.next.pointId!)}」的资料来源</h2><p>先补充并整理资料，再选择支持同一知识点的整理结果。关联只恢复新学习入口，不恢复已失效题目的评估证据。</p><label>补充资料中的知识点<select aria-label="补充资料中的知识点" value={recoveryPoint} onChange={e=>setRecoveryPoint(e.target.value)}><option value="">请选择已整理知识点</option>{course.points.filter(point=>!(course.blockedPointIds??[]).includes(point.id)).map(point=><option key={point.id} value={point.id}>{point.chapter} · {point.name}</option>)}</select></label><button disabled={!recoveryPoint||busy||course.archived} onClick={()=>void run('restorePointSources',{pointId:course.next.pointId,replacementPointId:recoveryPoint})}>确认关联并恢复学习</button></section>}
        {(!course.folder||course.messages.length>0)&&<DiscussionShell className={archiveDiscussion?'sy-discussion-archive':undefined}>
        {archiveDiscussion&&<summary>历史资料问答 · {course.messages.length} 条（对话学习已切换为学习助手，历史只读保留）</summary>}
        <section className="sy-discussion"><div className="sy-section-title">资料问答</div>{!course.messages.length&&<div className="sy-chat-empty"><FileText size={23}/><p>围绕你的课程资料提问。<br/><span>回答会附上可查看的来源；资料不足时会明确说明。</span></p></div>}{course.messages.map(m=><article className={`sy-message ${m.role}`} key={m.id} data-learning-kind={m.role==='assistant'&&m.sourceIds.length?'answer':undefined} data-learning-id={m.role==='assistant'&&m.sourceIds.length?m.id:undefined}><div className="sy-message-name">{m.role==='user'?'你':'Syllora'}<small>{formatTime(m.at,course.timezone)}</small></div><ReactMarkdown skipHtml components={{img:({alt})=><span>{alt ? `[图片：${alt}]` : '[外部图片未加载]'}</span>,a:({children,href})=><a href={href} target="_blank" rel="noreferrer">{children}</a>}}>{m.text}</ReactMarkdown>{m.sourceIds.length>0&&<div className="sy-citations">{m.sourceIds.map((s,i)=><button key={s} onClick={()=>setSourceId(s)}><FileText size={13}/>来源 {i+1}</button>)}{m.role==='assistant'&&<button disabled={course.archived||busy} onClick={()=>{setAnswerReport(m.id);setAnswerReason(m.report?.reason??'')}}>{m.report?'已报错，依据待核验':'报告回答来源问题'}</button>}</div>}</article>)}<div ref={bottom}/></section>
        </DiscussionShell>}
      </div>
      </AgentChat>
      {running?<div className="sy-job" role="status"><LoaderCircle size={16} className="sy-spin"/><span>{running.message}{running.createdAt&&Date.now()-running.createdAt>=60000?' · 已等待超过 60 秒，仍在查询原任务；可取消，不会自动重复生成。':''}</span><button onClick={()=>void run('cancel',{jobId:running.id})}>取消</button></div>:lastJob?.state==='failed'?<div className="sy-job sy-error" role="alert">{lastJob.message}{lastJob.errorCode?`（${lastJob.errorCode}）`:''}</div>:coverageNote?<div className="sy-job" role="status">{coverageNote}</div>:null}
      {!course.folder&&<form className="sy-composer" onSubmit={async e=>{e.preventDefault();const courseId=selected,submitted=cacheRef.current[courseId]?.revision??0;const accepted=await generate('answer',{prompt,...(task&&!(course.blockedPointIds??[]).includes(task.pointId)?{taskId:task.id}:{})}) as {draftVersion?:number}|null;if(accepted){const local=cacheRef.current[courseId];if(local&&accepted.draftVersion!==undefined)cacheRef.current={...cacheRef.current,[courseId]:{...local,baseVersion:accepted.draftVersion}};if((cacheRef.current[courseId]?.revision??0)===submitted){const revision=submitted+1;cacheRef.current={...cacheRef.current,[courseId]:{prompt:'',answers:cacheRef.current[courseId]?.answers??{},revision,savedRevision:revision,savedAt:Date.now(),baseVersion:accepted.draftVersion??cacheRef.current[courseId]?.baseVersion??0}};if(selectedRef.current===courseId){promptRef.current='';setPrompt('')}}saveDraftRecovery(cacheRef.current);}}}><input aria-label="向课程资料提问" placeholder={course.materials.some(m=>m.status!=='deleted')?'向课程资料提问，追问会带上本课程最近对话…':'先在右侧导入学习资料'} value={prompt} onChange={e=>rememberPrompt(e.target.value)} disabled={course.archived} maxLength={4000}/><button className="sy-primary" title="发送问题" aria-label="发送问题" disabled={!prompt.trim()||busy||!!running||course.archived}><Send size={18}/></button><small>未发送的问题按课程保存 · 依据只来自所选课程资料 · 模型生成内容需要核验</small></form>}
      </>}</>}
    </main>
    {showRight&&view==='workspace'&&learningMode==='chat'&&<aside className="study-panel panel-open restored-panel"><header className="panel-header"><h2>学习面板</h2><span className="panel-caption">一步一步，稳稳向前</span><button className="icon-button panel-close" aria-label="收起学习面板" onClick={()=>setShowRight(false)}><X size={18}/></button></header>
      {/* 需求三：5 个标签精简为 3 组（今日/学习/资料），分段控件与顶栏模式切换一致。 */}
      <div className="panel-tabs segment" role="tablist" aria-label="学习面板分组">{([['today','今日'],['study','学习'],['materials','资料']] as const).map(([id,label])=><button role="tab" aria-selected={tab===id} className={tab===id?'active':''} key={id} onClick={()=>setTab(id)}>{label}</button>)}</div>
      <div className="panel-body sy-panel" role="tabpanel">
      {!course?<PanelEmpty icon={<BookOpen size={22}/>} title="还没有打开的课程" description="打开课程文件夹后，在这里检查资料、阅读讲义与查看学习证据。"/>:tab==='materials'?<MaterialsSection course={course} busy={busy} running={!!running} epoch={fileEpoch} text={text} setText={setText} onRun={run} onPickFile={pickMaterialFile} onSource={setSourceId}/>:tab==='study'?<StudySection key={course.id} course={course} busy={busy} running={!!running} scope={scope} setScope={setScope} minutes={minutes} onMinutes={value=>{minutesEdited.current=true;setMinutes(value)}} days={days} setDays={setDays} deadline={deadline} setDeadline={setDeadline} restDays={restDays} setRestDays={setRestDays} estimates={estimates} setEstimates={setEstimates} pointName={pointName} formatTime={formatTime} jobs={data?.jobs.filter(job=>job.courseId===course.id)??[]} onOpenMaterials={()=>setTab('materials')} onGenerateOutline={()=>void generate('outline')} onGenerated={()=>setTab('today')} onApplyPlan={()=>{setScope(course.scope);setMinutes(course.plan!.dailyMinutes);setDays(Math.min(course.plan!.days,90));setRestDays(course.plan!.restDays);setDeadline(course.plan!.deadline??'');setEstimates({});}} onProposeReview={proposeReview} onRun={run} onSource={setSourceId} onDispute={questionId=>{setDisputeTarget(questionId);setDisputeReason('')}} setError={setError}/>:<TodaySection key={course.id} course={course} busy={busy} activeTask={activeTask} pointName={pointName} formatTime={formatTime} adjustNotice={adjustNotice} onReadLecture={()=>setShowLecture(true)} onOpenOutline={()=>setTab('study')} onOpenMaterials={()=>setTab('materials')} onStartTask={startTask} onOpenDiff={()=>setDiffCourse(structuredClone(course))} onRun={run} setError={setError}/>}
    </div></aside>}
    {userPage&&<UserDialogs page={userPage} name={data?.uiPreferences?.name??'学习者'} error={error} onClose={()=>setUserPage(null)} onSave={async()=>false}/>}
    {lastJob?.progress?.failures.length? <div className="sy-init-failures" role="status">{lastJob.progress.failures.map((f,i)=><p key={i}>{f}</p>)}</div>:null}
    {creating&&<ProjectDialog onClose={()=>{setCreating(false);setMigration(null)}} {...(migration?{migrationName:migration.name}:{})} onOpen={async (path,name,icon,color)=>{if(!(await flushDraft()))throw new Error('请先保存当前课程草稿');const result=await rpc<{id:string}>(migration?'migrateCourse':'openCourse',migration?{courseId:migration.id,path}:{path,...(name?{name}:{}),...(icon?{icon}:{}),...(color?{color}:{}),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone});await refresh();selectedRef.current=result.id;setSelected(result.id);setCreating(false);setMigration(null);setView('workspace');setTab('materials');setShowRight(true)}}/>}
    {sourceId&&<Modal title="资料来源" onClose={()=>setSourceId(null)} wide><button className="text-button" onClick={()=>setSourceId(null)}>关闭来源</button>{source?<><p className="sy-muted">{course?.materials.find(m=>m.id===source.materialId)?.name} · {source.anchor}</p><pre className="sy-source-text">{source.text}</pre></>:<p>此来源已删除或不属于当前课程。</p>}</Modal>}
    {diffCourse?.draft&&<DiffModal course={diffCourse} onClose={()=>setDiffCourse(null)} busy={busy} onConfirm={async()=>{if(await run('confirmPlan',{courseId:diffCourse.id,baseVersion:diffCourse.draft!.baseVersion,draftId:diffCourse.draft!.id})){setDiffCourse(null);setAdjustNotice(null)}}} onReject={async()=>{if(await run('rejectPlan',{courseId:diffCourse.id,draftId:diffCourse.draft!.id})){setDiffCourse(null);setAdjustNotice(null)}}}/>}
    {settings&&<SettingsPanel tab={settingsTab} onTab={setSettingsTab} onClose={()=>setSettings(false)} busy={busy} preferences={data?.uiPreferences??{name:'学习者',theme:'light',dailyMinutes:40,revision:0}} onPreferencesSaved={refresh} consent={consent} onConsent={setConsent} calls={data?.settings.calls??0} onSaveConsent={async()=>{if(await run('preferences',{consent}))setSettings(false)}} archived={(data?.courses.filter(c=>c.archived)??[]).map(c=>({id:c.id,name:c.name,points:c.points.length,materials:c.materials.length,attempts:c.attempts.length}))} onRestore={id=>void run('archive',{courseId:id,archived:false})} onDelete={c=>{if(window.confirm(`永久删除「${c.name}」的 Syllora 产物与学习记录？课程文件夹和原始资料保留，此操作不可撤销。`))void run('delete',{courseId:c.id,confirmed:true})}} diagFiles={diagFiles} diagLoading={diagLoading} onExportDiag={exportDiagLogs} onReloadDiag={()=>setDiagFiles(null)} onOpenLogs={hostPaths?.logsDir&&desktopBridge()?.openPath?()=>void desktopBridge()?.openPath?.(hostPaths.logsDir!):undefined}/>}
    {renaming&&course&&<Modal title="编辑课程" onClose={()=>setRenaming(false)} wide className="course-dialog"><form onSubmit={async e=>{e.preventDefault();if(await run('rename',{name:renameValue,icon:renameIcon,color:renameColor}))setRenaming(false)}}><label className="form-field">课程名称<input autoFocus value={renameValue} maxLength={60} onChange={e=>setRenameValue(e.target.value)} required/></label><CourseIdentityPicker icon={renameIcon} color={renameColor} name={renameValue} onIcon={setRenameIcon} onColor={setRenameColor}/><div className="modal-actions"><button className="button" type="button" disabled={busy} onClick={()=>setRenaming(false)}>取消</button><button className="button primary" disabled={busy||!renameValue.trim()}>保存课程</button></div></form></Modal>}
    {answerReport&&<div className="sy-overlay"><section className="sy-modal sy-create-modal" role="dialog" aria-modal="true" aria-label="回答来源报错"><header><h2>回答来源报错</h2><button aria-label="关闭回答报错" onClick={()=>setAnswerReport(null)}><X size={19}/></button></header><p>记录问题与原因，保留回答供核验。报错数量不等于已确认错误数量。</p><form onSubmit={async event=>{event.preventDefault();if(await run('reportAnswer',{messageId:answerReport,reason:answerReason})){setAnswerReport(null);setAnswerReason('')}}}><label>回答报错原因<textarea value={answerReason} maxLength={1000} onChange={event=>setAnswerReason(event.target.value)} required/></label><button disabled={busy||!answerReason.trim()}>保存回答报错</button></form></section></div>}
    {disputeTarget&&<Modal title="题目报错" onClose={()=>setDisputeTarget(null)} className="sy-modal"><p className="sy-muted">报错后该题版本暂停计入学习证据，你的原作答会保留，原题位可生成替代题。</p><form onSubmit={async e=>{e.preventDefault();const target=disputeTarget;if(target&&await run('dispute',{questionId:target,reason:disputeReason})){setDisputeTarget(null);setDisputeReason('')}}}><label>报错原因<textarea rows={3} autoFocus value={disputeReason} maxLength={400} onChange={e=>setDisputeReason(e.target.value)} placeholder="例如：歧义、来源不支持、答案错误" required/></label><div className="sy-row"><button className="sy-primary" disabled={busy||!disputeReason.trim()}>提交报错</button><button type="button" disabled={busy} onClick={()=>setDisputeTarget(null)}>取消</button></div></form></Modal>}

  </div>
}

function LearningPolicySettings({course,busy,onSave}:{course:CourseView;busy:boolean;onSave:(settings:{baseVersion:number;reviewHours:number[];sessionIdleMinutes:number})=>Promise<boolean>}) {
  const settings=course.learningSettings??{revision:0,reviewHours:[24,72,168],sessionIdleMinutes:30};
  const [baseline,setBaseline]=useState<{revision:number;reviewHours:number[];sessionIdleMinutes:number}>(settings),[dirty,setDirty]=useState(false);
  const [hours,setHours]=useState(settings.reviewHours.map(String)),[idle,setIdle]=useState(String(settings.sessionIdleMinutes)),[error,setError]=useState('');
  const loadLatest=()=>{setBaseline(settings);setHours(settings.reviewHours.map(String));setIdle(String(settings.sessionIdleMinutes));setDirty(false);setError('')};
  useEffect(()=>{if(!dirty&&settings.revision>baseline.revision){setBaseline(settings);setHours(settings.reviewHours.map(String));setIdle(String(settings.sessionIdleMinutes));setError('')}},[settings,baseline.revision,dirty]);
  const stale=settings.revision>baseline.revision;
  return <details><summary>复习间隔设置</summary><p className="sy-muted">默认 24、72、168 小时，按实际经过时长计算。修改只影响之后新建立的周期，已有到期时间与历史作答不变。</p>{stale&&<div role="status"><p>学习设置已被另一页面修改。你的未保存输入和原修订号已保留；请载入最新设置后重新编辑。</p><button disabled={busy||course.archived} onClick={loadLatest}>放弃草稿并载入最新设置</button></div>}{['首次补强与复测','复测通过后的间隔','后续复习间隔'].map((label,i)=><label key={label}>{label}（小时）<input aria-label={`${label}（小时）`} type="number" min={24} max={8760} step={1} value={hours[i]} disabled={busy||course.archived} onChange={event=>{setHours(hours.map((old,index)=>index===i?event.target.value:old));setDirty(true)}}/></label>)}<label>会话闲置关闭（分钟）<input aria-label="会话闲置关闭（分钟）" type="number" min={5} max={1440} value={idle} disabled={busy||course.archived} onChange={event=>{setIdle(event.target.value);setDirty(true)}}/></label><p>默认 30 分钟无学习操作后关闭，轮询与刷新不续期；修改只影响以后开始的会话。</p>{error&&<p role="alert">{error}</p>}<button disabled={busy||course.archived} onClick={async()=>{const values=hours.map(Number);if(!Number.isInteger(Number(idle))||Number(idle)<5||Number(idle)>1440){setError('闲置关闭请输入 5–1440 的整数分钟。');return}if(values.some(value=>!Number.isSafeInteger(value)||value<24||value>8760)||values[0]!>values[1]!||values[1]!>values[2]!){setError('请输入不递减的三个整数小时，范围 24–8760。');return}setError('');if(await onSave({baseVersion:baseline.revision,reviewHours:values,sessionIdleMinutes:Number(idle)})){setBaseline({revision:baseline.revision+1,reviewHours:values,sessionIdleMinutes:Number(idle)});setDirty(false)}}}>保存未来复习间隔</button></details>;
}

function WrongAnswerHistory({course,pointId,onSource,onDispute}:{course:CourseView;pointId:string;onSource:(id:string)=>void;onDispute:(id:string)=>void}) {
  const wrong=course.questions.filter(question=>question.pointId===pointId&&question.status==='valid'&&course.attempts.some(attempt=>attempt.questionId===question.id&&!attempt.correct));
  if(!wrong.length)return null;
  return <details><summary>错题记录 · {wrong.length} 题</summary>{wrong.map(question=>{
    const attempt=course.attempts.find(attempt=>attempt.questionId===question.id)!;
    return <article className="sy-question" key={question.id} data-learning-kind="question" data-learning-id={question.id}><h4>{question.stem}</h4><p>你的选项 {String.fromCharCode(65+attempt.option)}：{question.options[attempt.option]}</p><small>{attempt.assisted?'辅助学习，不计独立证据':'独立错答'} · {formatTime(attempt.at,course.timezone)}</small>{question.answer!==undefined&&<p>正确选项 {String.fromCharCode(65+question.answer)}：{question.options[question.answer]}</p>}<p>{question.explanation}</p><blockquote>{question.quote}</blockquote><div className="sy-row">{question.sourceIds.map(sourceId=><button key={sourceId} onClick={()=>onSource(sourceId)}>查看错题依据</button>)}<button disabled={course.archived} onClick={()=>onDispute(question.id)}>报告此题问题</button></div></article>;
  })}</details>;
}

function DiffModal({course,onClose,busy,onConfirm,onReject}:{course:CourseView;onClose:()=>void;busy:boolean;onConfirm:()=>Promise<void>;onReject:()=>Promise<void>}){
  const d = course.detailedDraftDiff;
  const pointName2 = (id:string) => course.points.find((p:{id:string;name:string}) => p.id === id)?.name??'知识点';
  return<div className="sy-overlay"><section className="sy-modal sy-diff" role="dialog" aria-modal="true" aria-label="计划差异" data-learning-kind={course.draft?'draft':undefined} data-learning-id={course.draft?.id}><header><h2>计划差异对比</h2><button aria-label="关闭" onClick={onClose}><X size={19}/></button></header>
  {!d?<p className="sy-diff-empty">无待对比草案</p>:<>
  <div className="sy-diff-summary"><span className="sy-diff-added">+{d.added.length} 新增</span><span className="sy-diff-removed">-{d.removed.length} 移除</span><span className="sy-diff-moved">~{d.moved.length} 移动</span><span className="sy-diff-moved">{d.changed.length>0?`±${d.changed.length} 调时`:''}</span><span>{d.unchanged.length} 不变</span></div>
  <div className="sy-diff-grid"><div className="sy-diff-col"><h3>当前计划</h3>{d.removed.map(t=><div className="sy-diff-item removed" key={t.id}><span className="sy-diff-tag removed">移</span>{pointName2(t.pointId)}<small>{course.plan?.tasks.find(old=>old.id===t.id)?.date??t.date} · {course.plan?.tasks.find(old=>old.id===t.id)?.minutes??t.minutes}分</small></div>)}{d.moved.map(t=><div className="sy-diff-item moved" key={t.id}><span className="sy-diff-tag moved">移</span>{pointName2(t.pointId)}<small>{course.plan?.tasks.find(old=>old.id===t.id)?.date??t.date} · {course.plan?.tasks.find(old=>old.id===t.id)?.minutes??t.minutes}分</small></div>)}{d.changed.map(c=><div className="sy-diff-item moved" key={c.to.id}><span className="sy-diff-tag moved">调</span>{pointName2(c.to.pointId)}<small>{c.from.date} · {c.from.minutes}分</small></div>)}{d.unchanged.map(t=><div className="sy-diff-item" key={t.id}>{pointName2(t.pointId)}<small>{course.plan?.tasks.find(old=>old.id===t.id)?.date??t.date} · {course.plan?.tasks.find(old=>old.id===t.id)?.minutes??t.minutes}分</small></div>)}</div>
  <div className="sy-diff-col"><h3>新草案</h3>{d.added.map(t=><div className="sy-diff-item added" key={t.id}><span className="sy-diff-tag added">新</span>{pointName2(t.pointId)}<small>{t.date} · {t.minutes}分</small></div>)}{d.moved.map(t=><div className="sy-diff-item moved" key={t.id}><span className="sy-diff-tag moved">移</span>{pointName2(t.pointId)}<small>{t.date} · {t.minutes}分</small></div>)}{d.changed.map(c=><div className="sy-diff-item moved" key={c.to.id}><span className="sy-diff-tag moved">调</span>{pointName2(c.to.pointId)}<small>{c.to.date} · {c.to.minutes}分</small></div>)}{d.unchanged.map(t=><div className="sy-diff-item" key={t.id}>{pointName2(t.pointId)}<small>{t.date} · {t.minutes}分</small></div>)}</div></div>
  <div className="sy-row"><button className="sy-primary" disabled={busy||!course.draft?.feasible} onClick={onConfirm}>确认生效</button><button onClick={onReject}>保留原计划</button></div>
  </>}</section></div>
}
