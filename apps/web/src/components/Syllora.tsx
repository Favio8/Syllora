"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BookOpen, FolderOpen, Settings, ArrowRight, Send, Upload, FileText, Check, Archive, RotateCcw, X, LoaderCircle, PanelRight, Pencil, Menu, ChevronRight, PanelRightOpen, UserRound, SlidersHorizontal, Monitor, Database, Clock, ArrowLeft } from 'lucide-react';
import ModelsSection from './settings/ModelsSection';
import NotesWorkspace from './NotesWorkspace';
import NotesGraph from './NotesGraph';
import { api } from '../lib/api';
import type { NotesGraph as NotesGraphData } from '../lib/notesGraph';
import ReactMarkdown from 'react-markdown';
import type { SylloraState, Task, CourseView } from '../types/syllora';
import type { SettingsPayload } from '../types/api';
import { editDraft, hydrateCourse, markSaved, rememberServer, type DraftCache } from './syllora-drafts';
import { MARKDOWN_REHYPE_PLUGINS, MARKDOWN_REMARK_PLUGINS } from '../lib/markdownPlugins';
import { CenteredErrorDialog, LectureReader, MaterialInitialization, ProjectDialog } from './syllora-project-ui';
import LearningModeSwitch from '../features/workbench/components/LearningModeSwitch';
import { LearningJobDiagnostics, LearningMetrics, useLearningExposures } from './syllora-metrics';
import './syllora.css';

import { courseIcons } from '../features/workbench/lib/courseIcons';
import { logicalRequest, workbenchRpc as rpc } from '../features/workbench/services';
import { projectWorkspace } from '../features/workbench/projection';
import Sidebar from '../features/workbench/components/Sidebar';
import Home from '../features/workbench/components/Home';
import Catalog from '../features/workbench/components/Catalog';
import ReadingWorkspace from '../features/workbench/components/ReadingWorkspace';
import UserDialogs from '../features/workbench/components/UserDialogs';
import PreferencesEditor from '../features/workbench/components/PreferencesEditor';
import ReviewDisclosure from '../features/workbench/components/ReviewDisclosure';
import type { View, LearningMode, Course as DisplayCourse } from '../features/workbench/types';
import Dropdown from '../features/workbench/components/Dropdown';
import Modal from '../features/workbench/components/Modal';
import CourseMenu from '../features/workbench/components/CourseMenu';
import CoursePicker from '../features/workbench/components/CoursePicker';
import IconPicker from '../features/workbench/components/IconPicker';
import ConfirmDialog, { type Confirmation } from '../features/workbench/components/ConfirmDialog';
import type { CourseAction } from '../features/workbench/components/CourseMenu';
import '../features/workbench/workbench.css';
import '../features/workbench/appearance.css';
import '../features/workbench/integrated.css';
// agent-chat.css follows the workbench styles to preserve its scoped overrides.
import AgentChat from './chat/AgentChat';
import { recoverDrafts, saveDraftRecovery } from '../features/workbench/draftRecovery';
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
  setWindowTheme?: (spec:{theme:'light'|'dark';color?:string;symbolColor?:string;height?:number}) => Promise<{ok:boolean}>;
};
const desktopBridge = (): DesktopBridge|undefined => (window as unknown as { sylloraDesktop?: DesktopBridge }).sylloraDesktop;

/**
 * 原生窗口按钮（最小化/最大化/关闭）的高度：Electron 按 overlay 高度画这三个按钮，
 * 之前推的是实测顶栏高度（70px），按钮跟着变得又高又大。这里固定成一个更小的常量；
 * 右侧预留的 154px 仍够放下 3×46，颜色/主题仍按实测合成色推。
 */
const WINDOW_CONTROL_HEIGHT = 46;

/** 设置弹窗的左侧分区。 */
type SettingsTab = 'models'|'archive'|'diag'|'display';

/** 一份宿主日志文件（内容已按上限截断）。 */
type DiagFile = { name:string; bytes:number; text:string; truncated:boolean };

/**
 * 来源弹层的标题：资料名 + 精确定位。直接拼 `name · anchor` 会在两者都从文件名派生时重复，
 * 例如 `sources/讲义.md · 讲义.md · 行 3–5 · 字符 45–120`。
 */
export function sourceLabel(source:{anchor:string}, materialName?:string):string {
  if(!materialName)return source.anchor;
  if(source.anchor===materialName||source.anchor.startsWith(`${materialName} · `))return source.anchor;
  return `${materialName} · ${source.anchor}`;
}

export default function Syllora() {
  useModalFocus();
  const [coursePicker,setCoursePicker]=useState(false);
  const [confirmation,setConfirmation]=useState<Confirmation|null>(null);
  const [practiceOpen,setPracticeOpen]=useState(false);
  const [pointRename,setPointRename]=useState<{id:string;name:string}|null>(null);
  const [desktop,setDesktop]=useState(false);
  const [signedOut,setSignedOut]=useState(false);
  useEffect(()=>{setDesktop(Boolean(desktopBridge()?.isDesktop));},[]);
  const [data,setData] = useState<SylloraState|null>(null);
  const [view,setView]=useState<View>('home');
  /** 独立整页的返回栈：管理类页面的「返回」只回上一级（如 管理课程资料 → 计划管理），
   *  直接进入时栈为空，回落到工作台。 */
  const [viewStack,setViewStack]=useState<View[]>([]);
  const navigate=(next:View)=>{setViewStack(stack=>[...stack,view]);setView(next);};
  const goBack=()=>setViewStack(stack=>{const target=stack.at(-1)??'workspace';setView(target);return stack.slice(0,-1);});
  const [learningMode,setLearningMode]=useState<LearningMode>('chat');
  const [assistantOpen,setAssistantOpen]=useState(true);
  const [mobileNav,setMobileNav]=useState(false);
  const [userPage,setUserPage]=useState<'profile'|'guide'|'agreement'|null>(null);
  const [selected,setSelected] = useState('');
  const [tab,setTab] = useState<'today'|'outline'|'materials'|'review'>('today');
  // 笔记整页工作区 + 「图谱」刷新计数：新建/保存/删除后 +1，右栏图谱据此重拉笔记。
  const [notesMode,setNotesMode] = useState(false);
  const [notesEpoch,setNotesEpoch] = useState(0);
  // ��课程知识图谱（章节+知识点，复用右栏 NotesGraph；agent 概念抽取见 buildGraph）。
  const [courseGraph,setCourseGraph] = useState<NotesGraphData|null>(null);
  const [graphNodesRaw,setGraphNodesRaw] = useState<Array<{id:string;label:string;kind:string;group?:string}>>([]);
  const [graphBooks,setGraphBooks] = useState<Array<{ebookId:string;fileName:string}>>([]);
  const [graphFocusId,setGraphFocusId] = useState<string|null>(null);
  const [graphFocusLabel,setGraphFocusLabel] = useState<string|null>(null);
  // 上下布局下章节条更省地方：每本书默认只显示前 8 章，展开状态记在这里。
  const [graphExpandedBooks,setGraphExpandedBooks] = useState<string[]>([]);
  const [graphBuilding,setGraphBuilding] = useState(false);
  const [graphJobId,setGraphJobId] = useState<string|null>(null);
  // 应用 course/graph 返回：图谱数据 + 章节清单元信息（分组标题用）。
  const applyGraph = useCallback((res: { nodes: Array<{id:string;label:string;kind:string;group?:string}>; edges: Array<{source:string;target:string}>; books?: Array<{ebookId:string;fileName:string}> }) => {
    setCourseGraph(res.nodes.length ? { nodes: res.nodes.map(n => ({ id: n.id, title: n.label, links: [], firstTag: n.kind })), edges: res.edges.map(e => ({ from: e.source, to: e.target })) } : null);
    setGraphNodesRaw([...res.nodes]);
    setGraphBooks(res.books ?? []);
  }, []);
  // 大纲 tab 的章节清单：按电子书分组（供「选章聚焦」）。
  const chaptersByGroup = useMemo(() => {
    const map = new Map<string, Array<{ id: string; label: string }>>();
    for (const n of graphNodesRaw) if (n.kind === 'chapter') {
      const list = map.get(n.group ?? '') ?? [];
      list.push({ id: n.id, label: n.label });
      map.set(n.group ?? '', list);
    }
    return map;
  }, [graphNodesRaw]);
  const [settings,setSettings] = useState(false);
  // 「Agent 管理」弹窗（聊天框下方入口）：预设 / 权限 / 插件 / 预设提示词。
  const [agentManage,setAgentManage] = useState(false);
  const [error,setError] = useState('');
  // 已手动关闭的失败作业 id：失败条必须能关掉，否则会一直挂在内容区上方。
  const [dismissedJob,setDismissedJob] = useState('');
  const [busy,setBusy] = useState(false);
  const [migration,setMigration] = useState<{id:string;name:string}|null>(null);
  const [fileEpoch,setFileEpoch] = useState(0);
  const [creating,setCreating] = useState(false);
  const [prompt,setPrompt] = useState('');
  const [draftConflict,setDraftConflict]=useState('');
  const savesInFlight=useRef(new Map<string,Promise<boolean>>());
  const [scope,setScope] = useState<string[]>([]);
  const [minutes,setMinutes] = useState(40);
  const minutesEdited=useRef(false);
  const [days,setDays] = useState(7);
  const [deadline,setDeadline] = useState('');
  const [estimates,setEstimates] = useState<Record<string,string>>({});
  const [restDays,setRestDays] = useState<number[]>([]);
  const [renaming,setRenaming] = useState(false);
  const [renameValue,setRenameValue] = useState('');
  const [renameIcon,setRenameIcon]=useState('notebook');
  const [disputeTarget,setDisputeTarget] = useState<string|null>(null);
  const [disputeReason,setDisputeReason] = useState('');
  const [answerReport,setAnswerReport]=useState<string|null>(null);const [answerReason,setAnswerReason]=useState('');
  const [diagFiles,setDiagFiles] = useState<DiagFile[]|null>(null);
  const [diagLoading,setDiagLoading] = useState(false);
  const [sourceId,setSourceId] = useState<string|null>(null);
  const [recoveryPoint,setRecoveryPoint] = useState('');
  const [activeTask,setActiveTask] = useState<string|null>(null);
  const [answers,setAnswers] = useState<Record<string,number>>({});
  const [showRight,setShowRight] = useState(true);
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
  // ��拉取课程图谱（章节+知识点），右栏「图谱」tab 展示；无数据时显示占位。
  useEffect(() => {
    if (!course) { setCourseGraph(null); return }
    let alive = true;
    api.graph(course.id).then(res => { if (!alive) return; applyGraph(res); }).catch(() => { if (alive) { setCourseGraph(null); setGraphNodesRaw([]); } });
    return () => { alive = false };
  }, [course?.id]);
  // M8 agent 建谱：提交任务 → 等它不再是 running → 重新拉图谱。
  const buildGraph = useCallback(async () => {
    if (!course || graphBuilding) return;
    setGraphBuilding(true);
    try {
      const res = await api.graphBuild(course.id);
      setGraphJobId(res.jobId);
    } catch (cause) {
      setGraphBuilding(false);
      setError(cause instanceof Error ? cause.message : '图谱生成提交失败');
    }
  }, [course, graphBuilding]);
  useEffect(() => {
    if (!graphJobId) return;
    const job = (data?.jobs ?? []).find(j => j.id === graphJobId);
    if (!job || job.state === 'running') return;
    setGraphBuilding(false);
    setGraphJobId(null);
    if (!course) return;
    api.graph(course.id).then(res => applyGraph(res)).catch(() => undefined);
  }, [graphJobId, data, course]);
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
    setDraftConflict('');setDisputeTarget(null);setAnswerReport(null);setAnswerReason('');setScope([]);setRecoveryPoint('');setActiveTask(null);setPracticeOpen(false);setSourceId(null);setError('');setDeadline('');setEstimates({});setMinutes(dataRef.current?.uiPreferences?.dailyMinutes??40);setDays(7);setRestDays([]);setDiffCourse(null);setAdjustNotice(null);setEditMinutes({});
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
    reader.onload=async()=>{
      const ok=await run('import',{name:file.name,base64:String(reader.result).split(',')[1]});
      // 上传成功即时反馈：切到「资料」页让用户/队友立刻看到新资料，避免「没反应」。
      if(ok&&typeof ok==='object'&&!(ok as {error?:unknown}).error){setTab('materials');setShowRight(true)}
    };
    reader.onerror=()=>setError('无法读取文件');
    reader.readAsDataURL(file);
  };
  const proposeReview = async(pointId:string)=>{if(await run('review',{pointId})){setActiveTask(null);setTab('today')}};
  /** 唤起系统文件选择框。切到「资料」页是为了让用户选完就能看到结果。 */
  const pickMaterialFile = ()=>{fileInput.current?.click()};
  const openPractice = ()=>{if(task)setPracticeOpen(true);else {setTab('review');setShowRight(true);}};
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
    setTab('outline');
  };
  useEffect(()=>{setEditMinutes({})},[course?.draft?.id]);
  const exposureError=useLearningExposures(course,rpc,tab);
  const uiData=data?projectWorkspace(data):null;
  const displayCourse=uiData?.courses.find(item=>item.id===selected);
  // 原生窗口按钮区（Electron titleBarOverlay）：底色不再"实测合成"。
  //  - 旧实现沿祖先找背景色、再把 .sy-overlay 遮罩按 alpha 合成，而观察器只监听
  //    body 的直接子节点（无 subtree），弹窗在应用树内开合时永不重算——一次灰色
  //    值就粘住，表现为顶栏明明是白的、三个按钮底下却是灰的。
  //  - 顶栏在两个外壳、两种主题下恒为 var(--white)（浅色 #fff / 深色 #171f2e），
  //    所以直接按主题推固定色 + 固定高度，不需要测量，也就不需要任何监听。
  // 高度固定成 WINDOW_CONTROL_HEIGHT：它决定原生按钮的大小，不跟顶栏高度走。
  useEffect(()=>{
    const theme=data?.uiPreferences?.theme??'light';
    document.documentElement.dataset.theme=theme;
    void desktopBridge()?.setWindowTheme?.({
      theme,
      color:theme==='dark'?'#171f2e':'#ffffff',
      symbolColor:theme==='dark'?'#b9cbe4':'#617796',
      height:WINDOW_CONTROL_HEIGHT,
    });
  },[data?.uiPreferences?.theme]);
  const openUiCourse=async(id:string,mode:LearningMode='chat')=>{setRenaming(false);if(!(await selectCourse(id)))return false;setViewStack([]);setView('workspace');setLearningMode(mode);setMobileNav(false);return true;};
  const manageUiCourse=async(item:DisplayCourse,action:CourseAction)=>{
    if(!(await selectCourse(item.id)))return;
    if(action==='rename'){setRenameValue(item.name);setRenameIcon(item.icon??'notebook');setRenaming(true);return;}
    setConfirmation({title:action==='delete'?'删除课程':action==='archive'?'归档课程':'恢复课程',message:action==='delete'?`删除「${item.name}」的整理产物与学习记录？课程文件夹和原始资料保留，此操作不可撤销。`:action==='archive'?`归档「${item.name}」后不再参与学习与复习，可以随时恢复。`:`恢复「${item.name}」到我的课程。`,confirmLabel:action==='delete'?'删除课程':action==='archive'?'归档课程':'恢复课程',danger:action==='delete',action:()=>run(action==='delete'?'delete':'archive',{courseId:item.id,...(action==='delete'?{confirmed:true}:{archived:action==='archive'})})});
  };
  const archiveDiscussion = Boolean(course?.folder && course.messages.length > 0);
  const DiscussionShell: 'details'|'div' = archiveDiscussion ? 'details' : 'div';
  // 笔记整页工作区：接管整个应用视图（三栏），带返回。
  // 笔记页是整页替换；套一层 desktop-shell 让原生窗口按钮的留白与拖动区与工作台一致。
  if(notesMode&&course) return <div className={desktop?'desktop-shell':''}><NotesWorkspace courseId={course.id} courseName={course.name} onClose={()=>setNotesMode(false)} onEpoch={()=>setNotesEpoch(epoch=>epoch+1)} onSwitchMode={mode=>{setNotesMode(false);setView('workspace');setLearningMode(mode);}}/></div>;
  return <div onClickCapture={event=>{const target=event.target as HTMLElement;const label=target.closest('label');if(label&&!label.querySelector('input,textarea,select')&&!target.closest('input,textarea,select,button,a'))event.preventDefault();}} className={`sy-app app-shell integrated-shell ${desktop?'desktop-shell':''} ${view==='workspace'&&learningMode==='chat'?(showRight?'':'task-collapsed'):'sy-no-right without-panel'}`}>
    <input ref={fileInput} type="file" accept=".pdf,.md,.txt" aria-label="上传课程资料" style={{display:'none'}} disabled={!course||busy||course.archived} onChange={e=>{const file=e.target.files?.[0];if(file)void upload(file);e.target.value=''}}/>
    <Sidebar courses={uiData?.courses.filter(item=>!item.archived)??[]} selected={selected} view={view} mobileOpen={mobileNav} onClose={()=>setMobileNav(false)} onView={value=>{setViewStack([]);setView(value);setMobileNav(false);}} onCourse={id=>void openUiCourse(id)} onCreate={()=>{setMigration(null);setCreating(true)}} onUserAction={action=>{
      if(action==='settings'){setSettings(true);setSettingsTab('models');}
      else if(action==='profile')setUserPage('profile');
      else if(action==='logout'){void flushDraft().then(ok=>{if(ok){setSignedOut(true);setView('home');}});}
      else setUserPage(action);
    }}/>
    <header className="sy-top topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={()=>setMobileNav(true)}><Menu size={20}/></button><div className="breadcrumbs">{view==='home'?<span className="home-breadcrumb">主页</span>:<><button className="breadcrumb-link" onClick={()=>setView('courses')}>我的课程</button><ChevronRight size={15}/><span>{view==='workspace'?course?.name??'学习工作台':view==='courses'?'课程管理':view==='materials'?'资料库':view==='lecture'?'课程讲义':view==='outline-manage'?'课程资料管理':view==='plan-manage'?'计划管理':'复习与巩固'}</span>{view==='workspace'&&displayCourse&&<CourseMenu course={displayCourse} variant="workspace" onAction={(item,action)=>void manageUiCourse(item,action)} onChangeCourse={()=>setCoursePicker(true)}/>}</>}</div><div className="sy-actions"><LearningModeSwitch disabled={!course} current={learningMode} onSelect={surface=>{if(!course){setError('请先打开一门课程');return}if(surface==='notes'){setNotesMode(true);return}setView('workspace');setLearningMode(surface);}}/></div></header>
    <main className="sy-main main-area view-stage" key={`${view}-${learningMode}`}>

      {error&&<div className="sy-error" role="alert">{error}<button aria-label="关闭错误" onClick={()=>setError('')}><X size={14}/></button></div>}
    {view==='courses'&&data?.projects?.filter(project=>project.error).map(project=><div className="integrated-project-error" key={project.id}>{project.name}：{project.error}<small>{project.path}</small>{project.deletion&&<button onClick={()=>setConfirmation({title:'重试删除课程',message:`重试删除「${project.name}」的应用记录？原始资料保留。`,confirmLabel:'重试删除',danger:true,action:()=>run('delete',{courseId:project.id,confirmed:true})})}>重试删除课程</button>}</div>)}
    {view==='courses'&&data?.legacyCourses?.map(item=><button className="integrated-migration" key={item.id} onClick={()=>{setMigration(item);setCreating(true)}}>迁移旧课程：{item.name}</button>)}
      {draftConflict&&draftConflict===selected&&<div className="sy-notice" role="status">草稿版本冲突，当前输入已保留。<button onClick={async()=>{try{const latest=await rpc<SylloraState>('state'),server=latest.courses.find(item=>item.id===selected)?.drafts;if(server){delete cacheRef.current[selected];cacheRef.current=rememberServer(cacheRef.current,selected,server);const view=hydrateCourse(cacheRef.current,selected,server);promptRef.current=view.prompt;answersRef.current=view.answers;setPrompt(view.prompt);setAnswers(view.answers);setDraftConflict('');setError('');saveDraftRecovery(cacheRef.current);}}catch(error){setError(error instanceof Error?error.message:'加载草稿失败');}}}>放弃本页输入并加载最新草稿</button></div>}
      {!data?<div className="sy-empty"><LoaderCircle className="sy-spin"/><h2>正在连接本地服务</h2><p>请确认 Syllora 服务已启动。</p></div>:view==='home'&&uiData?<Home data={{...uiData,courses:uiData.courses.filter(item=>!item.archived)}} selected={selected} onCourse={(id,mode)=>void openUiCourse(id,mode)} onCreate={()=>setCreating(true)} onCourses={()=>setView('courses')} onMaterials={()=>setView('materials')} onStudy={(item,t)=>{void openUiCourse(item.id).then(ok=>{if(!ok)return;const task=data.courses.find(course=>course.id===item.id)?.plan?.tasks.find(task=>task.id===t.id);if(task)void run('start',{courseId:item.id,taskId:task.id}).then(ok=>{if(ok){setActiveTask(task.id);setPracticeOpen(true)}})})}}/>:view==='lecture'?(course?<LecturePage course={course} onSource={setSourceId} onBack={goBack}/>:<div className="sy-empty"><h2>先打开一门课程</h2></div>):view==='outline-manage'?(course?<OutlineManagePage course={course} scope={scope} setScope={setScope} estimates={estimates} setEstimates={setEstimates} busy={busy} onRename={setPointRename} onRun={run} onBack={goBack}/>:<div className="sy-empty"><h2>先打开一门课程</h2></div>):view==='plan-manage'&&course?<><div className="sy-manage-page"><header className="sy-manage-head"><button className="sy-nw-back" onClick={goBack}><ArrowLeft size={16}/>返回</button><div className="sy-nw-title"><span>计划管理</span><small>{course.name}</small></div><div className="sy-manage-summary">已选 {scope.length} / 共 {course.points.length} 个知识点</div></header><div className="sy-manage-body"><h2>生成与调整计划</h2><div className="sy-row"><button onClick={()=>navigate('outline-manage')}>管理课程资料 · 已选 {scope.length} / 共 {course.points.length}</button></div><div className="sy-plan-input"><label><span>每天可用分钟</span><input type="number" min={1} max={720} value={minutes} onChange={e=>{minutesEdited.current=true;setMinutes(Number(e.target.value))}}/></label><label><span>未来天数</span><input type="number" min={1} max={90} value={days} onChange={e=>setDays(Number(e.target.value))}/></label><p className="sy-plan-help">未设置目标日期时，按未来天数规划。</p><label className="sy-plan-deadline"><span>目标日期 <small>可选，含当天</small></span><input type="date" value={deadline} onChange={e=>setDeadline(e.target.value)} disabled={busy}/></label></div><div className="sy-rest"><span>休息日</span><div className="sy-weekdays">{['日','一','二','三','四','五','六'].map((d,i)=><button key={i} aria-pressed={restDays.includes(i)} onClick={()=>setRestDays(restDays.includes(i)?restDays.filter(d=>d!==i):[...restDays,i])}>{d}</button>)}</div></div><button className="sy-primary sy-plan-submit" disabled={!scope.length||busy||course.archived} onClick={async()=>{const entered=Object.entries(estimates).filter(([id,value])=>scope.includes(id)&&value.trim()!=='');if(entered.some(([,value])=>!Number.isInteger(Number(value))||Number(value)<5||Number(value)>240)){setError('任务估时请输入 5–240 的整数分钟');return}const estimateInput=Object.fromEntries(entered.map(([id,value])=>[id,Number(value)]));if(await run('plan',{scope,dailyMinutes:minutes,days,restDays,baseVersion:course.plan?.version??0,...(deadline?{deadline}:{}),...(Object.keys(estimateInput).length?{estimates:estimateInput}:{})}))setView('plan-manage')}}>生成计划草案 <ArrowRight size={15}/></button><h2>待确认草案</h2>{course.draft&&<div className="sy-draft" data-draft-id={course.draft.id} data-learning-kind="draft" data-learning-id={course.draft.id}><span className="sy-kicker">待确认草案 · v{course.draft.version}{course.draft.deadline?` · 目标 ${course.draft.deadline}`:''}</span><h3>{course.draft.feasible?'计划可执行':'时间预算不足'}</h3><p>{course.draft.tasks.length} 个任务，每天最多 {course.draft.dailyMinutes} 分钟。确认后才替换尚未开始的安排。</p>{course.draftDiff&&<ul className="sy-diff">{course.draftDiff.scopeAdded.map(id=><li key={`in-${id}`}>新增范围：{pointName(id)}</li>)}{course.draftDiff.scopeRemoved.map(id=><li key={`out-${id}`}>移出范围：{pointName(id)}，作答仍保留</li>)}{course.draftDiff.tasksAdded.map(item=><li key={item.id}>新增{item.immediate?'即时巩固':'任务'}：{pointName(item.pointId)} · {item.date} · {item.minutes} 分钟</li>)}{course.draftDiff.tasksRemoved.map(item=><li key={item.id}>移出任务：{pointName(item.pointId)} · {item.date}</li>)}{course.draftDiff.tasksMoved.map(item=><li key={item.id}>移动：{pointName(item.pointId)} {item.from} → {item.to}</li>)}<li>估时 {course.draftDiff.minutesBefore} → {course.draftDiff.minutesAfter} 分钟</li></ul>}{course.draft.overflow.some(o=>o.reason==='task-too-large')&&<p role="alert">单任务超过每天可用分钟：{course.draft.overflow.filter(o=>o.reason==='task-too-large').map(o=>pointName(o.pointId)).join('、')}。请提高每天可用分钟，或调低对应任务的估时。</p>}{course.draft.overflow.some(o=>o.reason==='window-full')&&<p role="alert">时间窗口内放不下：{course.draft.overflow.filter(o=>o.reason==='window-full').map(o=>pointName(o.pointId)).join('、')}。请增加每天可用分钟、延长目标日期或天数，或缩小范围。</p>}<button disabled={busy||course.archived} onClick={()=>setDiffCourse(structuredClone(course))}>查看差异</button>{course.draft.tasks.filter(t=>t.status==='todo').map(t=><div className="sy-task-estimate" key={t.id}><label>{pointName(t.pointId)} · {t.kind==='review'?'复习':'学习'}估时<input type="number" min={1} max={720} aria-label={`${pointName(t.pointId)} 草案任务估时`} value={editMinutes[t.id]??String(t.minutes)} onChange={e=>setEditMinutes({...editMinutes,[t.id]:e.target.value})}/></label><button disabled={busy||course.archived} onClick={async()=>{const value=Number(editMinutes[t.id]??t.minutes);if(!Number.isInteger(value)||value<1||value>720){setError('草案任务估时请输入 1–720 的整数分钟');return}await run('adjustTaskMinutes',{draftId:course.draft!.id,taskId:t.id,minutes:value})}}>调整估时</button></div>)}<div className="sy-row"><button className="sy-primary" disabled={!course.draft.feasible||busy||course.archived} onClick={()=>void run('confirmPlan',{baseVersion:course.draft!.baseVersion,draftId:course.draft!.id})}>确认生效</button><button onClick={()=>void run('rejectPlan')}>保留原计划</button></div></div>}<h2>已确认计划{course.plan?` · v${course.plan.version}${course.plan.deadline?` · 目标 ${course.plan.deadline}`:''}`:''}</h2>{!course.plan?<div className="sy-panel-empty"><p>导入资料、生成大纲后，确认你的第一份计划。</p><button onClick={()=>setTab(course.materials.length?'outline':'materials')}>开始准备 <ArrowRight size={14}/></button></div>:course.plan.tasks.map(t=><button className={`sy-task ${task?.id===t.id?'is-selected':''}`} key={t.id} disabled={busy||course.archived||(t.status==='todo'&&t.date>new Intl.DateTimeFormat('en-CA',{timeZone:course.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.now()))||(course.blockedPointIds??[]).includes(t.pointId)} onClick={()=>{setPracticeOpen(true);void startTask(t)}}><span className="sy-task-dot">{t.status==='completed'?<Check size={14}/>:<BookOpen size={14}/>}</span><span><strong>{pointName(t.pointId)}</strong><small>{t.date} · {t.minutes} 分钟 · {t.immediate?'即时巩固':t.kind==='review'?'复习':'学习'}</small><em>{(course.blockedPointIds??[]).includes(t.pointId)&&t.status!=='completed'?'待补充资料':t.status==='completed'?'活动完成':t.status==='in_progress'?'进行中':'待开始'}</em></span><ArrowRight size={14}/></button>)}{course.plan&&<button onClick={()=>{setScope(course.scope);setMinutes(course.plan!.dailyMinutes);setDays(Math.min(course.plan!.days,90));setRestDays(course.plan!.restDays);setDeadline(course.plan!.deadline??'');setEstimates({});setView('plan-manage')}}>调整范围与计划</button>}</div></div></>:view!=='workspace'&&uiData?<Catalog view={view as 'courses'|'materials'|'review'} courses={uiData.courses} onCourse={id=>void openUiCourse(id)} onCreate={()=>setCreating(true)} onUpload={id=>{void openUiCourse(id).then(ok=>{if(ok){setTab('materials');setShowRight(true)}})}} onDeleteMaterial={(courseId,materialId)=>setConfirmation({title:'移除资料',message:'移除此资料的应用记录？原文件保留，关联证据将重新计算。',confirmLabel:'移除资料',danger:true,action:()=>run('deleteMaterial',{courseId,materialId,confirmed:true})})} onReview={(item,point)=>{void openUiCourse(item).then(ok=>{if(!ok)return;setTab('today');setShowRight(true);void run('review',{courseId:item,pointId:point.id})})}} onManage={(item,action)=>void manageUiCourse(item,action)}/>:!course?<div className="sy-empty"><BookOpen size={48}/><p className="sy-kicker">学习从这里开始</p><h2>把资料变成<br/>下一步行动。</h2><p>新建课程、上传资料并整理讲义，按自己的节奏学习。<br/>每一次作答，都会留下可追溯的学习证据。</p><button className="sy-primary" onClick={()=>setCreating(true)}>新建课程 <ArrowRight size={16}/></button></div>:<>
      {learningMode==='reading'&&displayCourse?<ReadingWorkspace course={displayCourse} assistantOpen={assistantOpen} onToggleAssistant={()=>setAssistantOpen(value=>!value)} onExpandAssistant={()=>setAssistantOpen(true)} onUpload={pickMaterialFile} onActivity={()=>void refresh()} onSource={setSourceId}/>:<>
      <ChatWorkspace folder={course.folder} courseName={course.name} onUpload={pickMaterialFile} onPractice={openPractice} disabled={course.archived} onOpenSettings={()=>{setSettingsTab('models');setSettings(true)}} onAgentManage={course.folder?()=>setAgentManage(true):undefined}>
      <div className="sy-content">
        {exposureError&&<p role="status">{exposureError}</p>}
        
        {course.notice&&<div className="sy-notice" role="status"><p>{course.notice.text}</p>{course.notice.kind==='restore'&&<button disabled={busy||course.archived} onClick={()=>void run('proposeRestore').then(ok=>{if(ok)setTab('today')})}>生成恢复日程草案</button>}</div>}
        <section className="sy-next"><div><span className="sy-kicker">下一步</span><h2>{course.next.text}</h2><p>{course.next.reason}</p>{course.next.pointId&&<p>{pointName(course.next.pointId)}</p>}<p>{course.next.availableAt===null?'现在可以执行':course.next.kind==='summary'?`下次复习：${formatTime(course.next.availableAt,course.timezone)}`:`可执行时间：${formatTime(course.next.availableAt,course.timezone)}`}</p>{course.next.kind==='summary'&&<button disabled={course.archived} onClick={()=>setTab('outline')}>补充学习范围</button>}{course.next.practice&&<button className="sy-optional" disabled={busy||course.archived} onClick={()=>void proposeReview(course.next.practice!.pointId)}>{course.next.practice.text}</button>}</div><button className="sy-primary" disabled={busy||course.archived||course.next.kind==='waiting'} onClick={()=>void next()}>{course.next.kind==='blocked'?'补充资料':'继续'} <ArrowRight size={16}/></button></section>
        {practiceOpen&&task&&!(course.blockedPointIds??[]).includes(task.pointId)&&<section className="sy-task-study"><div className="sy-task-heading"><span>{task.immediate?'即时巩固':task.kind==='review'?'复习任务':'学习任务'} · {task.minutes} 分钟</span><span>{task.status==='completed'?'活动已完成':`${task.slots} 个题位`}</span></div><h2>{pointName(task.pointId)}</h2><div className="sy-row"><button disabled={busy||!!running||course.archived} onClick={()=>void generate('answer',{taskId:task.id,prompt:`请讲解「${pointName(task.pointId)}」，用资料依据和一个明确标识的教学示例帮助理解。`})}>获取资料讲解</button>{!task.explained&&<button disabled={busy||course.archived} onClick={()=>void run('explainDone',{taskId:task.id})}><Check size={15}/>我已完成讲解学习</button>}</div>
        {Array.from({length:task.slots},(_,slot)=>{
          const q=course.questions.filter(q=>q.taskId===task.id&&q.slot===slot).at(-1);
          const attempt=q?course.attempts.find(a=>a.questionId===q.id):undefined;
          return <div className="sy-question" key={slot} data-learning-kind={q?.status==='valid'?'question':undefined} data-learning-id={q?.status==='valid'?q.id:undefined}><div className="sy-kicker">练习 {slot+1}</div>{!q||q.status!=='valid'?<><p>{q?'此题已暂停评估，原作答保留，请生成替代题。':'按当前知识点资料生成一道新题。'}</p><button disabled={busy||!!running||course.archived} onClick={()=>void generate('question',{taskId:task.id,slot})}>生成{q?'替代':''}题目</button></>:<><h3>{q.stem}</h3><div className="sy-options" role="group" aria-label={`练习 ${slot+1} 选项`}>{q.options.map((o,i)=><button key={i} disabled={!!attempt||busy||course.archived} className={(attempt?.option??answers[q.id])===i?'is-selected':''} onClick={()=>rememberAnswer(q.id,i)}><span>{String.fromCharCode(65+i)}</span>{o}</button>)}</div>{!attempt?<div className="sy-row"><button className="sy-primary" disabled={answers[q.id]===undefined||busy||course.archived} onClick={async()=>{setAdjustNotice(null);const r=await run('submit',{questionId:q.id,option:answers[q.id],}) as {correct?:boolean;planAdjustment?:{ok:boolean;code:string;message?:string;draftId:string|null}}|null;if(r&&!r.correct){if(r.planAdjustment?.ok)setAdjustNotice('已根据本次错答生成计划调整草案，可查看差异后决定是否接受');else if(r.planAdjustment?.code==='SKIPPED_EXISTING_DRAFT')setAdjustNotice('已有待确认草案，本次未重复生成');else if(r.planAdjustment?.code==='SKIPPED_EXISTING_REVIEW')setAdjustNotice('已有待开始或进行中的复习，本次保留该安排');else if(r.planAdjustment?.code==='FAILED')setAdjustNotice('本次错答未能生成调整建议，可稍后重试')}}}>提交答案</button><button disabled={busy||course.archived} onClick={()=>void run('reveal',{questionId:q.id})}>查看答案（记为辅助学习）</button></div>:<div className="sy-feedback"><strong>{attempt.correct?'回答正确':'回答错误'} · {attempt.assisted?'辅助学习，不计独立证据':'已保存独立作答'}</strong><p>{course.evidence[q.pointId]?.state} · {course.evidence[q.pointId]?.reason}</p></div>}{q.answer!==undefined&&<div className="sy-explanation"><p><strong>答案 {String.fromCharCode(65+q.answer)}</strong>　{q.explanation}</p><blockquote>{q.quote}</blockquote><div className="sy-row">{q.sourceIds.map(s=><button key={s} onClick={()=>setSourceId(s)}>查看依据</button>)}<button disabled={course.archived||busy} onClick={()=>{setDisputeTarget(q.id);setDisputeReason('')}}>题目报错并暂停计入</button></div></div>}</>}</div>
        })}</section>}
        {course.next.kind==='blocked'&&<section className="sy-notice"><h2>恢复「{pointName(course.next.pointId!)}」的资料来源</h2><p>先补充并整理资料，再选择支持同一知识点的整理结果。关联只恢复新学习入口，不恢复已失效题目的评估证据。</p><div className="form-field"><span>补充资料中的知识点</span><Dropdown label="补充资料中的知识点" value={recoveryPoint} onChange={setRecoveryPoint} placeholder="请选择已整理知识点" options={course.points.filter(point=>!(course.blockedPointIds??[]).includes(point.id)).map(point=>({value:point.id,label:`${point.chapter} · ${point.name}`}))}/></div><button disabled={!recoveryPoint||busy||course.archived} onClick={()=>void run('restorePointSources',{pointId:course.next.pointId,replacementPointId:recoveryPoint})}>确认关联并恢复学习</button></section>}
        {(!course.folder||course.messages.length>0)&&<DiscussionShell className={archiveDiscussion?'sy-discussion-archive':undefined}>
        {archiveDiscussion&&<summary>历史资料问答 · {course.messages.length} 条（对话学习已切换为学习助手，历史只读保留）</summary>}
        <section className="sy-discussion"><div className="sy-section-title">资料问答</div>{!course.messages.length&&<div className="sy-chat-empty"><FileText size={23}/><p>围绕你的课程资料提问。<br/><span>回答会附上可查看的来源；资料不足时会明确说明。</span></p></div>}{course.messages.map(m=><article className={`sy-message ${m.role}`} key={m.id} data-learning-kind={m.role==='assistant'&&m.sourceIds.length?'answer':undefined} data-learning-id={m.role==='assistant'&&m.sourceIds.length?m.id:undefined}><div className="sy-message-name">{m.role==='user'?'你':'Syllora'}<small>{formatTime(m.at,course.timezone)}</small></div><ReactMarkdown skipHtml remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={MARKDOWN_REHYPE_PLUGINS} components={{img:({alt})=><span>{alt ? `[图片：${alt}]` : '[外部图片未加载]'}</span>,a:({children,href})=><a href={href} target="_blank" rel="noreferrer">{children}</a>}}>{m.text}</ReactMarkdown>{m.sourceIds.length>0&&<div className="sy-citations">{m.sourceIds.map((s,i)=><button key={s} onClick={()=>setSourceId(s)}><FileText size={13}/>来源 {i+1}</button>)}{m.role==='assistant'&&<button disabled={course.archived||busy} onClick={()=>{setAnswerReport(m.id);setAnswerReason(m.report?.reason??'')}}>{m.report?'已报错，依据待核验':'报告回答来源问题'}</button>}</div>}</article>)}<div ref={bottom}/></section>
        </DiscussionShell>}
      </div>
      </ChatWorkspace>
      {running?<div className="sy-job" role="status"><LoaderCircle size={16} className="sy-spin"/><span>{running.message}{running.createdAt&&Date.now()-running.createdAt>=60000?' · 已等待超过 60 秒，仍在查询原任务；可取消，不会自动重复生成。':''}</span><button onClick={()=>void run('cancel',{jobId:running.id})}>取消</button></div>:lastJob?.state==='failed'&&lastJob.id!==dismissedJob?<CenteredErrorDialog title="操作未完成" message={`${lastJob.message}${lastJob.errorCode?`（${lastJob.errorCode}）`:''}`} onClose={()=>setDismissedJob(lastJob.id)}/>:coverageNote?<div className="sy-job" role="status">{coverageNote}</div>:null}
      {!course.folder&&<form className="sy-composer" onSubmit={async e=>{e.preventDefault();const courseId=selected,submitted=cacheRef.current[courseId]?.revision??0;const accepted=await generate('answer',{prompt,...(task&&!(course.blockedPointIds??[]).includes(task.pointId)?{taskId:task.id}:{})}) as {draftVersion?:number}|null;if(accepted){const local=cacheRef.current[courseId];if(local&&accepted.draftVersion!==undefined)cacheRef.current={...cacheRef.current,[courseId]:{...local,baseVersion:accepted.draftVersion}};if((cacheRef.current[courseId]?.revision??0)===submitted){const revision=submitted+1;cacheRef.current={...cacheRef.current,[courseId]:{prompt:'',answers:cacheRef.current[courseId]?.answers??{},revision,savedRevision:revision,savedAt:Date.now(),baseVersion:accepted.draftVersion??cacheRef.current[courseId]?.baseVersion??0}};if(selectedRef.current===courseId){promptRef.current='';setPrompt('')}}saveDraftRecovery(cacheRef.current);}}}><input aria-label="向课程资料提问" placeholder={course.materials.some(m=>m.status!=='deleted')?'向课程资料提问，追问会带上本课程最近对话…':'先在右侧导入学习资料'} value={prompt} onChange={e=>rememberPrompt(e.target.value)} disabled={course.archived} maxLength={4000}/><button className="sy-primary" title="发送问题" aria-label="发送问题" disabled={!prompt.trim()||busy||!!running||course.archived}><Send size={18}/></button><small>未发送的问题按课程保存 · 依据只来自所选课程资料 · 模型生成内容需要核验</small></form>}{!course.folder&&<div className="composer-actions legacy-composer-actions"><button className="button small" onClick={pickMaterialFile}><Upload size={16}/>上传资料</button><button className="button small" onClick={openPractice}><Pencil size={16}/>练习</button></div>}
      </>}</>}
    </main>
    {showRight&&view==='workspace'&&learningMode==='chat'&&<aside className="sy-right"><div className="sy-right-title"><div>学习面板 <span>一步一步，扎实掌握</span></div><button className="icon-button" aria-label="收起学习看板" onClick={()=>setShowRight(false)}><X size={17}/></button></div><div className="sy-tabs" role="tablist">{([['today','计划'],['outline','大纲'],['materials','资料'],['review','复习']] as const).map(([id,label])=><button role="tab" aria-selected={tab===id} className={tab===id?'is-selected':''} key={id} onClick={()=>setTab(id)}>{label}</button>)}</div><div className="sy-panel">
      {!course?<p className="sy-muted">新建课程后，在这里检查资料、阅读讲义与查看学习证据。</p>:tab==='materials'?<>
        {course.folder&&<MaterialInitialization key={course.id} course={course} epoch={fileEpoch} busy={busy} running={!!running} onRun={run} onUpload={pickMaterialFile}/>}
        {!course.folder&&<div className="sy-row"><button className="sy-upload" disabled={busy||course.archived} onClick={pickMaterialFile}><Upload size={20}/><span>上传资料</span></button></div>}
      </>:tab==='outline'?<div className="sy-outline-graph"><header className="sy-outline-graph-head"><h2>确认学习范围</h2><div className="sy-outline-actions"><button className="text-button" onClick={()=>navigate('lecture')}>阅读课程讲义</button><button disabled={busy||!!running||course.archived} onClick={()=>course.folder?setTab('materials'):void generate('outline')}>{course.folder?'检查资料并更新课程':'从资料生成／补充大纲'}</button><button onClick={()=>navigate('outline-manage')}>管理课程资料 · 已选 {scope.length} / 共 {course.points.length}</button><button type="button" className="sy-graph-rebuild" disabled={graphBuilding||busy} onClick={()=>void buildGraph()} title="投喂电子书完成结构化时会自动生成图谱；失败或改过内容可在此补建/重试">{graphBuilding?<><LoaderCircle size={12} className="sy-spin"/>正在生成…</>:<><SlidersHorizontal size={12}/>重新生成图谱</>}</button></div></header><div className="sy-outline-graph-body"><aside className="sy-outline-chapters"><h3>章节目录 <small>点章节聚焦图谱 · 每本书默认 8 章</small></h3>{graphBooks.length === 0?<p className="sy-muted">暂无结构化电子书，先投喂并完成结构化。</p>:graphBooks.map(book=>{const chapters=chaptersByGroup.get(book.ebookId)??[];if(!chapters.length)return null;const expanded=graphExpandedBooks.includes(book.ebookId);const shown=expanded?chapters:chapters.slice(0,8);return <div className="sy-outline-book" key={book.ebookId}><h4>{book.fileName}<span className="sy-outline-count">{chapters.length} 章</span></h4><div className="sy-outline-chips">{shown.map(ch=><button type="button" key={ch.id} className={graphFocusId===ch.id?'is-focus':''} onClick={()=>{const same=graphFocusId===ch.id;setGraphFocusId(same?null:ch.id);setGraphFocusLabel(same?null:ch.label);}}>{ch.label}</button>)}{chapters.length>8&&<button type="button" className="sy-outline-more" onClick={()=>setGraphExpandedBooks(list=>expanded?list.filter(x=>x!==book.ebookId):[...list,book.ebookId])}>{expanded?'收起':`展开其余 ${chapters.length-8} 章`}</button>}</div></div>;})}</aside><section className="sy-outline-graph-canvas">{graphFocusLabel?<div className="sy-graph-focusbar"><span>聚焦：{graphFocusLabel}</span><button type="button" onClick={()=>{setGraphFocusId(null);setGraphFocusLabel(null);}}>× 恢复全景</button></div>:null}{courseGraph?<NotesGraph key={graphFocusId??'all'} courseId={course.id} refreshKey={notesEpoch} overrideGraph={courseGraph} title="课程图谱" focusNodeId={graphFocusId}/>:<p className="sy-muted sy-outline-graph-empty">暂无可展示的课程图谱：投喂电子书完成结构化时会自动生成；失败或补建可点上方的「重新生成图谱」。</p>}</section></div></div>:tab==='review'?<><h2>知识点与复习</h2><LearningMetrics course={course}/><LearningJobDiagnostics jobs={data?.jobs.filter(job=>job.courseId===course.id)??[]}/><LearningPolicySettings key={course.id} course={course} busy={busy} onSave={async settings=>!!(await run('learningSettings',settings))}/><p className="sy-muted">独立作答决定状态。复测至少间隔 24 小时；提前练习不会提前晋升复测。</p>{!course.scope.length&&<p>确认学习范围后展示复习状态。</p>}{course.scope.map(id=>{const e=course.evidence[id];return <div className="sy-review" key={id}><h3>{pointName(id)}</h3><span className="sy-badge">{e?.state}</span><p>{e?.reason}</p><small>{e?.dueAt?`下次复习：${formatTime(e.dueAt,course.timezone)}`:'尚未安排复习'}</small>{course.plan?.deadline&&e?.dueAt&&new Intl.DateTimeFormat('en-CA',{timeZone:course.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(e.dueAt)>course.plan.deadline&&<p role="status">目标日期外：请调整目标日期、继续学习或归档课程。</p>}<WrongAnswerHistory course={course} pointId={id} onSource={setSourceId} onDispute={questionId=>{setDisputeTarget(questionId);setDisputeReason('')}}/><button disabled={busy||course.archived||(course.blockedPointIds??[]).includes(id)} onClick={()=>void proposeReview(id)}>{e?.dueAt&&e.dueAt<=Date.now()?'生成到期复习草案':'生成即时巩固草案'}</button></div>})}</>:<>
        <TodayProgress course={course} dailyMinutes={data?.uiPreferences?.dailyMinutes??40}/>
        <details className="workbench-evidence-details"><summary>查看学习证据与记录</summary>
        <div className="sy-progress"><div>{course.progress.activityLabel?<strong className="sy-empty-metric">{course.progress.activityLabel}</strong>:<strong>{course.progress.completed}<span> / {course.progress.total}</span></strong>}<small>活动完成{course.progress.skipped?` · 跳过 ${course.progress.skipped}`:''}</small></div><div>{course.progress.scopeLabel?<strong className="sy-empty-metric">{course.progress.scopeLabel}</strong>:<strong>{course.progress.covered}<span> / {course.progress.scope}</span></strong>}<small>有效评估覆盖</small></div></div>
        <ul className="sy-distribution" aria-label="证据状态分布">{(['未评估','待验证','待加强','初步掌握','复测通过'] as const).map(state=><li key={state}><span>{state}</span><strong>{course.progress.distribution[state]}</strong></li>)}</ul>
        {course.changes.length>0&&<div className="sy-trace"><h2>分母变化</h2>{[...course.changes].reverse().map(change=><p className="sy-change" key={change.id}>{change.text}</p>)}</div>}
        {course.actions.length>0&&<div className="sy-trace"><h2>下一行动记录</h2>{[...course.actions].reverse().map(action=><p className="sy-action" key={action.id}><strong>{action.text}</strong><small>{formatTime(action.at,course.timezone)} · {action.trigger} · {action.evidenceState??'无证据'} · {action.availableAt===null?'现在可以执行':`可执行 ${formatTime(action.availableAt,course.timezone)}`} · {action.reason}</small></p>)}</div>}
        </details>
        {adjustNotice&&<div className="sy-adjust-notice" role="status"><p>{adjustNotice}</p></div>}
        <h2>计划</h2><button className="sy-panel-empty-button" onClick={()=>navigate('plan-manage')}>计划管理{course.plan?` · v${course.plan.version} · ${course.plan.tasks.length} 个任务`:course.draft?' · 有待确认草案':''} <ArrowRight size={14}/></button>
      </>}
    </div>{course&&<footer className="workbench-panel-footer"><div><span>已验证知识点</span><strong>{course.scope.filter(id=>course.evidence[id]?.state==='复测通过').length} <small>/ {course.progress.scope}</small></strong></div><div><span>每日学习目标</span><strong>{data?.uiPreferences?.dailyMinutes??40} <small>分钟</small></strong></div></footer>}</aside>}
    {!showRight&&view==='workspace'&&learningMode==='chat'&&<aside className="panel-rail task-rail" aria-label="学习看板已收起"><button className="icon-button" aria-label="展开学习看板" onClick={()=>setShowRight(true)}><PanelRightOpen size={18}/></button></aside>}
    {coursePicker&&<CoursePicker courses={uiData?.courses.filter(item=>!item.archived)??[]} selected={selected} onClose={()=>setCoursePicker(false)} onChoose={id=>{void openUiCourse(id,learningMode).then(ok=>{if(ok)setCoursePicker(false)})}}/>}
    {pointRename&&<Modal title="重命名知识点" onClose={()=>setPointRename(null)}><form onSubmit={async e=>{e.preventDefault();if(await run('point',{pointId:pointRename.id,name:pointRename.name.trim()}))setPointRename(null)}}><div className="form-field"><span id="point-rename-label">知识点名称</span><input aria-labelledby="point-rename-label" autoFocus required value={pointRename.name} onChange={e=>setPointRename({...pointRename,name:e.target.value})}/></div><div className="modal-actions"><button type="button" className="button" onClick={()=>setPointRename(null)}>取消</button><button className="button primary" disabled={busy||!pointRename.name.trim()}>保存</button></div></form></Modal>}
    {confirmation&&<ConfirmDialog request={confirmation} onClose={()=>setConfirmation(null)}/>}
    {signedOut&&<div className="sy-logout-screen"><span className="brand-icon"><BookOpen size={26}/></span><h2>已退出学习空间</h2><p>你的课程与学习记录已保留在本机。</p><button className="button primary" onClick={()=>setSignedOut(false)}>进入学习空间</button></div>}
    {userPage&&<UserDialogs page={userPage} name={data?.uiPreferences?.name??'学习者'} preferences={data?.uiPreferences??{name:'学习者',theme:'light',dailyMinutes:40,revision:0}} onPreferencesSaved={refresh} error={error} onClose={()=>setUserPage(null)}/>}
    {lastJob?.progress?.failures.length? <div className="sy-init-failures" role="status">{lastJob.progress.failures.map((f,i)=><p key={i}>{f}</p>)}</div>:null}
    {creating&&<ProjectDialog onClose={()=>{setCreating(false);setMigration(null)}} {...(migration?{migrationName:migration.name}:{})} onOpen={async (name,icon)=>{if(!(await flushDraft()))throw new Error('请先保存当前课程草稿');const result=await logicalRequest<{id:string}>(migration?'migrateCourse':'createCourse',migration?{courseId:migration.id}:{name,...(icon?{icon}:{}),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone});await refresh();selectedRef.current=result.id;setSelected(result.id);setCreating(false);setMigration(null);setView('workspace');setTab('materials');setShowRight(true)}}/>}
    {sourceId&&<div className="sy-overlay" onClick={()=>setSourceId(null)}><section className="sy-modal" role="dialog" aria-modal="true" aria-label="资料来源" onClick={e=>e.stopPropagation()}><header><h2>资料来源</h2><button aria-label="关闭来源" onClick={()=>setSourceId(null)}><X size={19}/></button></header>{source?<><p className="sy-muted">{course?.materials.find(m=>m.id===source.materialId)?.name} · {source.anchor}</p><pre className="sy-source-text">{source.text}</pre></>:<p>此来源已删除或不属于当前课程。</p>}</section></div>}
    {diffCourse?.draft&&<DiffModal course={diffCourse} onClose={()=>setDiffCourse(null)} busy={busy} onConfirm={async()=>{if(await run('confirmPlan',{courseId:diffCourse.id,baseVersion:diffCourse.draft!.baseVersion,draftId:diffCourse.draft!.id})){setDiffCourse(null);setAdjustNotice(null)}}} onReject={async()=>{if(await run('rejectPlan',{courseId:diffCourse.id,draftId:diffCourse.draft!.id})){setDiffCourse(null);setAdjustNotice(null)}}}/>}
    {agentManage&&<AgentManageDialog onClose={()=>setAgentManage(false)}/>}
    {settings&&<Modal title="设置" className="settings-modal" onClose={()=>setSettings(false)}><div className="settings-layout"><nav className="settings-navigation" aria-label="设置分区"><span>个人学习空间</span>{([{id:'models',label:'模型配置',icon:SlidersHorizontal},{id:'display',label:'显示与交互',icon:Monitor},{id:'archive',label:'数据管理',icon:Database}] as const).map(({id,label,icon:Icon})=><button key={id} className={(settingsTab===id||(id==='archive'&&settingsTab==='diag'))?'active':''} aria-current={settingsTab===id||(id==='archive'&&settingsTab==='diag')?'page':undefined} onClick={()=>setSettingsTab(id)}><Icon size={17}/>{label}</button>)}<small>Syllora<br/>让学习更有自己的节奏</small></nav><div className="settings-content-column">
      {settingsTab==='display'?<PreferencesEditor page="display" onClose={()=>setSettings(false)} initial={data?.uiPreferences??{name:'学习者',theme:'light',dailyMinutes:40,revision:0}} onSaved={refresh}/>:settingsTab==='models'?<div className="settings-secondary-scroll"><ModelsSection initial={null}/></div>
      :settingsTab==='archive'?<div className="settings-secondary-scroll"><div className="settings-data-tabs"><button className="button small" aria-pressed="true">归档管理</button><button className="button small" onClick={()=>setSettingsTab('diag')}>诊断日志</button></div><h3>归档管理</h3>
        {!(data?.courses.some(c=>c.archived))?<div className="settings-empty" role="status"><Archive size={24}/><span>暂无归档</span></div>
        :(data?.courses.filter(c=>c.archived)??[]).map(c=><div className="sy-archive-row" key={c.id}><FileText size={17}/><div><strong>{c.name}</strong><small>{c.points.length} 个知识点 · {c.materials.length} 份资料 · {c.attempts.length} 次作答</small></div><div className="sy-row"><button disabled={busy} onClick={()=>void run('archive',{courseId:c.id,archived:false})}>恢复</button><button disabled={busy} onClick={()=>setConfirmation({title:'删除课程',message:`永久删除「${c.name}」的整理产物与学习记录？课程文件夹和原始资料保留，此操作不可撤销。`,confirmLabel:'永久删除',danger:true,action:()=>run('delete',{courseId:c.id,confirmed:true})})}>永久删除</button></div></div>)}</div>
      :<div className="settings-secondary-scroll"><div className="settings-data-tabs"><button className="button small" onClick={()=>setSettingsTab('archive')}>归档管理</button><button className="button small" aria-pressed="true">诊断日志</button></div><h3>诊断日志</h3>
        <div className="sy-row"><button className="sy-primary" disabled={diagLoading||!(diagFiles?.length)} onClick={exportDiagLogs}>导出诊断日志</button>{hostPaths?.logsDir&&desktopBridge()?.openPath&&<button onClick={()=>void desktopBridge()?.openPath?.(hostPaths.logsDir!)}>打开日志目录</button>}{diagFiles!==null&&!diagLoading&&<button onClick={()=>setDiagFiles(null)}>重新读取</button>}</div>
        {diagLoading?<p className="sy-muted">正在读取日志…</p>:!(diagFiles?.length)?<p className="sy-muted">暂无日志文件。</p>
        :diagFiles.map(f=><div className="sy-diag-file" key={f.name}><FileText size={15}/><div><strong>{f.name}</strong><small>{(f.bytes/1024).toFixed(1)} KiB{f.truncated?' · 已截断':''}</small></div></div>)}</div>}
      {settingsTab!=='display'&&<footer className="settings-page-footer"><div><button className="button" onClick={()=>setSettings(false)}>关闭</button></div></footer>}
    </div></div></Modal>}

    {renaming&&course&&<div className="sy-overlay" onClick={()=>setRenaming(false)}><section className="sy-modal sy-create-modal" role="dialog" aria-modal="true" aria-label="重命名课程" onClick={e=>e.stopPropagation()}><header><h2>重命名课程</h2><button aria-label="关闭重命名" onClick={()=>setRenaming(false)}><X size={19}/></button></header><form onSubmit={async e=>{e.preventDefault();if(await run('rename',{name:renameValue,icon:renameIcon})){setRenaming(false)}}}><label>课程名称<input autoFocus value={renameValue} maxLength={60} onChange={e=>setRenameValue(e.target.value)} required/></label><IconPicker value={renameIcon} onChange={setRenameIcon}/><div className="sy-row"><button className="sy-primary" disabled={busy||!renameValue.trim()||(renameValue.trim()===course.name&&renameIcon===(course.icon??'notebook'))}>保存</button><button type="button" disabled={busy} onClick={()=>setRenaming(false)}>取消</button></div></form></section></div>}
    {answerReport&&<div className="sy-overlay"><section className="sy-modal sy-create-modal" role="dialog" aria-modal="true" aria-label="回答来源报错"><header><h2>回答来源报错</h2><button aria-label="关闭回答报错" onClick={()=>setAnswerReport(null)}><X size={19}/></button></header><p>记录问题与原因，保留回答供核验。报错数量不等于已确认错误数量。</p><form onSubmit={async event=>{event.preventDefault();if(await run('reportAnswer',{messageId:answerReport,reason:answerReason})){setAnswerReport(null);setAnswerReason('')}}}><label>回答报错原因<textarea value={answerReason} maxLength={1000} onChange={event=>setAnswerReason(event.target.value)} required/></label><button disabled={busy||!answerReason.trim()}>保存回答报错</button></form></section></div>}
    {disputeTarget&&<div className="sy-overlay" onClick={()=>setDisputeTarget(null)}><section className="sy-modal sy-create-modal" role="dialog" aria-modal="true" aria-label="题目报错" onClick={e=>e.stopPropagation()}><header><h2>题目报错</h2><button aria-label="关闭报错" onClick={()=>setDisputeTarget(null)}><X size={19}/></button></header><p className="sy-muted">报错后该题版本暂停计入学习证据，你的原作答会保留，原题位可生成替代题。</p><form onSubmit={async e=>{e.preventDefault();const target=disputeTarget;if(target&&await run('dispute',{questionId:target,reason:disputeReason})){setDisputeTarget(null);setDisputeReason('')}}}><label>报错原因<textarea rows={3} autoFocus value={disputeReason} maxLength={400} onChange={e=>setDisputeReason(e.target.value)} placeholder="例如：歧义、来源不支持、答案错误" required/></label><div className="sy-row"><button className="sy-primary" disabled={busy||!disputeReason.trim()}>提交报错</button><button type="button" disabled={busy} onClick={()=>setDisputeTarget(null)}>取消</button></div></form></section></div>}
  </div>
}

function TodayProgress({course,dailyMinutes}:{course:CourseView;dailyMinutes:number}) {
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:course.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.now());
  const tasks=(course.plan?.tasks??[]).filter(task=>task.date===today&&task.status!=='skipped');
  const done=tasks.filter(task=>task.status==='completed').length;
  const percent=tasks.length?Math.round(done/tasks.length*100):0;
  return <><div className="section-heading"><h3>今天的学习</h3><span><Clock size={12}/>{dailyMinutes} 分钟</span></div><div className="progress-card"><div><span>活动完成</span><strong>{done} <small>/ {tasks.length}</small></strong></div><div className="progress-track" role="progressbar" aria-label="今天的学习进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{width:`${percent}%`}}/></div><p>{!tasks.length?'为课程安排下一步，按自己的节奏开始。':done===tasks.length?'今天的任务完成了，给自己一点掌声。':'每完成一步，都离目标更近一点。'}</p></div></>;
}

function ChatWorkspace({folder,children,...props}:{folder?:string|null;children:ReactNode;courseName:string;onUpload:()=>void;onPractice:()=>void;disabled:boolean;onOpenSettings:()=>void;onAgentManage?:()=>void}) {
  return folder?<AgentChat folder={folder} {...props}>{children}</AgentChat>:<div className="workbench-legacy-content">{children}</div>;
}

function LearningPolicySettings({course,busy,onSave}:{course:CourseView;busy:boolean;onSave:(settings:{baseVersion:number;reviewHours:number[];sessionIdleMinutes:number})=>Promise<boolean>}) {
  const settings=course.learningSettings??{revision:0,reviewHours:[24,72,168],sessionIdleMinutes:30};
  const [baseline,setBaseline]=useState<{revision:number;reviewHours:number[];sessionIdleMinutes:number}>(settings),[dirty,setDirty]=useState(false);
  const [hours,setHours]=useState(settings.reviewHours.map(String)),[idle,setIdle]=useState(String(settings.sessionIdleMinutes)),[error,setError]=useState('');
  const loadLatest=()=>{setBaseline(settings);setHours(settings.reviewHours.map(String));setIdle(String(settings.sessionIdleMinutes));setDirty(false);setError('')};
  useEffect(()=>{if(!dirty&&settings.revision>baseline.revision){setBaseline(settings);setHours(settings.reviewHours.map(String));setIdle(String(settings.sessionIdleMinutes));setError('')}},[settings,baseline.revision,dirty]);
  const stale=settings.revision>baseline.revision;
  return <ReviewDisclosure title="复习间隔设置" icon="settings"><p className="sy-muted">默认 24、72、168 小时，按实际经过时长计算。修改只影响之后新建立的周期，已有到期时间与历史作答不变。</p>{stale&&<div role="status"><p>学习设置已被另一页面修改。你的未保存输入和原修订号已保留；请载入最新设置后重新编辑。</p><button disabled={busy||course.archived} onClick={loadLatest}>放弃草稿并载入最新设置</button></div>}{['首次补强与复测','复测通过后的间隔','后续复习间隔'].map((label,i)=><label key={label}>{label}（小时）<input aria-label={`${label}（小时）`} type="number" min={24} max={8760} step={1} value={hours[i]} disabled={busy||course.archived} onChange={event=>{setHours(hours.map((old,index)=>index===i?event.target.value:old));setDirty(true)}}/></label>)}<label>会话闲置关闭（分钟）<input aria-label="会话闲置关闭（分钟）" type="number" min={5} max={1440} value={idle} disabled={busy||course.archived} onChange={event=>{setIdle(event.target.value);setDirty(true)}}/></label><p>默认 30 分钟无学习操作后关闭，轮询与刷新不续期；修改只影响以后开始的会话。</p>{error&&<p role="alert">{error}</p>}<button disabled={busy||course.archived} onClick={async()=>{const values=hours.map(Number);if(!Number.isInteger(Number(idle))||Number(idle)<5||Number(idle)>1440){setError('闲置关闭请输入 5–1440 的整数分钟。');return}if(values.some(value=>!Number.isSafeInteger(value)||value<24||value>8760)||values[0]!>values[1]!||values[1]!>values[2]!){setError('请输入不递减的三个整数小时，范围 24–8760。');return}setError('');if(await onSave({baseVersion:baseline.revision,reviewHours:values,sessionIdleMinutes:Number(idle)})){setBaseline({revision:baseline.revision+1,reviewHours:values,sessionIdleMinutes:Number(idle)});setDirty(false)}}}>保存未来复习间隔</button></ReviewDisclosure>;
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


/** 课程讲义整页：与课程管理、资料库同级的主内容页，不再是正文区里的一次替换。 */
function LecturePage({course,onSource,onBack}:{course:CourseView;onSource:(id:string)=>void;onBack:()=>void}) {
  return <div className="sy-manage-page">
    <header className="sy-manage-head">
      <button className="sy-nw-back" onClick={onBack}><ArrowLeft size={16}/>返回</button>
      <div className="sy-nw-title"><span>课程讲义</span><small>{course.name}</small></div>
    </header>
    <div className="sy-manage-body"><LectureReader key={course.id} course={course} onSource={onSource}/></div>
  </div>;
}

/** 课程资料管理：大纲章节的勾选与排序（学习范围、顺序、任务估时）。 */
function OutlineManagePage({course,scope,setScope,estimates,setEstimates,busy,onRename,onRun,onBack}:{
  course:CourseView; scope:string[]; setScope:(next:string[])=>void;
  estimates:Record<string,string>; setEstimates:(next:Record<string,string>)=>void;
  busy:boolean; onRename:(point:{id:string;name:string})=>void; onRun:(action:string,payload:Record<string,unknown>)=>Promise<unknown>; onBack:()=>void;
}) {
  const toggle=(id:string,checked:boolean)=>setScope(checked?[...scope,id]:scope.filter(value=>value!==id));
  const move=async(index:number,delta:number)=>{
    const ids=course.points.map(point=>point.id);
    const target=index+delta;
    if(target<0||target>=ids.length)return;
    [ids[index],ids[target]]=[ids[target]!,ids[index]!];
    await onRun('reorderPoints',{pointIds:ids});
  };
  return <div className="sy-manage-page">
    <header className="sy-manage-head">
      <button className="sy-nw-back" onClick={onBack}><ArrowLeft size={16}/>返回</button>
      <div className="sy-nw-title"><span>课程资料管理</span><small>{course.name}</small></div>
      <div className="sy-manage-summary">已选 {scope.length} / 共 {course.points.length}</div>
    </header>
    <div className="sy-manage-body">
      <h2>确认学习范围</h2>
      <p className="sy-muted">勾选本轮要学习与复习的章节，可调整顺序与任务估时。勾选与排序会用于生成学习计划。</p>
      <div className="sy-row">
        <button disabled={!course.points.length||busy} onClick={()=>setScope(course.points.map(point=>point.id))}>选择全部</button>
        <button disabled={!scope.length||busy} onClick={()=>setScope([])}>全不选</button>
      </div>
      {course.points.map((p,i)=><div className="sy-point-row" key={p.id}>
        <label className="sy-point"><input type="checkbox" checked={scope.includes(p.id)} onChange={e=>toggle(p.id,e.target.checked)}/><span><small>{p.chapter} · {String(i+1).padStart(2,'0')}</small>{p.name}<em>{course.evidence[p.id]?.state}</em></span></label>
        <div className="sy-point-actions">
          <button aria-label={`${p.name} 重命名`} title="重命名" disabled={busy||course.archived} onClick={()=>onRename({id:p.id,name:p.name})}>✏️</button>
          <button aria-label={`${p.name} 上移`} title="上移" disabled={i===0||busy||course.archived} onClick={()=>void move(i,-1)}>↑</button>
          <button aria-label={`${p.name} 下移`} title="下移" disabled={i===course.points.length-1||busy||course.archived} onClick={()=>void move(i,1)}>↓</button>
        </div>
        <input className="sy-estimate" type="number" min={5} max={240} aria-label={`${p.name} 任务估时（分钟）`} placeholder="20" value={estimates[p.id]??''} onChange={e=>setEstimates({...estimates,[p.id]:e.target.value})} disabled={busy}/>
      </div>)}
      {!course.points.length&&<p className="sy-muted">还没有章节。先在资料里检查资料并初始化课程讲义。</p>}
    </div>
  </div>;
}

/** 「Agent 管理」：复用宿主既有的 settings.get/update（agentPreset/permissionPreset/plugins/agentSystemPrompt）。 */
function AgentManageDialog({onClose}:{onClose:()=>void}) {
  const [payload,setPayload]=useState<SettingsPayload|null>(null);
  const [preset,setPreset]=useState('syllora-learning');
  const [permission,setPermission]=useState('workspace-write');
  const [plugins,setPlugins]=useState<Record<string,boolean>>({});
  const [systemPrompt,setSystemPrompt]=useState('');
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
  useEffect(()=>{let disposed=false;void api.settings().then(data=>{if(disposed)return;setPayload(data);setPreset(data.agent.preset);setPermission(data.permissions.preset);setPlugins(Object.fromEntries(data.plugins.inventory.map(item=>[item.id,item.enabled])));setSystemPrompt(data.agent.systemPrompt)}).catch(reason=>{if(!disposed)setError(reason instanceof Error?reason.message:'无法读取 Agent 配置')});return()=>{disposed=true}},[]);
  const current=payload?.agent.presets.find(item=>item.id===preset);
  const save=async()=>{setBusy(true);setError('');setNotice('');try{const next=await api.updateSettings({agentPreset:preset,permissionPreset:permission,plugins,agentSystemPrompt:systemPrompt});setPayload(next);setNotice('已保存。新的对话回合生效；进行中的回合不变。')}catch(reason){setError(reason instanceof Error?reason.message:'保存失败')}finally{setBusy(false)}};
  return <div className="sy-overlay" onClick={onClose}><section className="sy-modal sy-agent-manage" role="dialog" aria-modal="true" aria-label="Agent 管理" onClick={event=>event.stopPropagation()}>
    <header><h2>Agent 管理</h2><button aria-label="关闭 Agent 管理" onClick={onClose}><X size={19}/></button></header>
    {!payload?<p className="sy-muted">{error||'正在读取配置…'}</p>:<>
      <p className="sy-muted">配置对话所用的 Agent 预设、权限、插件与提示词。保存后对新的回合生效。</p>
      <label className="sy-agent-field"><span>Agent 预设</span><Dropdown label="Agent 预设" value={preset} onChange={setPreset} options={payload.agent.presets.map(item=>({value:item.id,label:`${item.name} · ${item.description}`}))}/></label>
      <div className="sy-agent-field"><span>权限</span><div className="sy-agent-radios">{payload.permissions.presets.map(item=><label key={item.id} className={"sy-agent-radio"+(permission===item.id?" is-selected":"")}><input type="radio" name="agent-permission" checked={permission===item.id} onChange={()=>setPermission(item.id)}/><span><strong>{item.name}</strong><small>{item.description}</small></span></label>)}</div></div>
      <div className="sy-agent-field"><span>插件</span><div className="sy-agent-plugins">{payload.plugins.inventory.map(item=><label key={item.id} className="sy-agent-plugin"><input type="checkbox" checked={plugins[item.id]??item.enabled} onChange={event=>setPlugins({...plugins,[item.id]:event.target.checked})}/><span><strong>{item.name}</strong><small>{item.source==='builtin'?'内置':item.reason||'工作区'}</small></span></label>)}</div></div>
      <label className="sy-agent-field"><span>预设提示词 <small>留空则使用所选预设自带的默认提示词</small></span><textarea rows={7} maxLength={payload.agent.maxPromptChars} value={systemPrompt} placeholder={current?.defaultPrompt??''} onChange={event=>setSystemPrompt(event.target.value)}/><small className="sy-muted">已用 {systemPrompt.length} / {payload.agent.maxPromptChars} 字符</small></label>
      {notice&&<p role="status" className="sy-muted">{notice}</p>}
      {error&&<p role="alert" className="sy-agent-error">{error}</p>}
      <div className="sy-row"><button className="sy-primary" disabled={busy} onClick={()=>void save()}>{busy?'保存中…':'保存'}</button><button disabled={busy} onClick={()=>{setSystemPrompt('');}}>清空提示词</button><button disabled={busy} onClick={onClose}>取消</button></div>
    </>}
  </section></div>;
}
