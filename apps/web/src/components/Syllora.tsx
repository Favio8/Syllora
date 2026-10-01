"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Plus, Settings, ArrowRight, Send, Upload, FileText, Check, Archive, RotateCcw, Trash2, X, LoaderCircle, PanelRight, Pencil } from 'lucide-react';
import ModelsSection from './settings/ModelsSection';
import ReactMarkdown from 'react-markdown';
import type { SylloraState, Task, CourseView, Material } from '../types/syllora';
import { editDraft, hydrateCourse, markSaved, rememberServer, type DraftCache } from './syllora-drafts';
import './syllora.css';

async function rpc<T = unknown>(action:string,payload:unknown={}):Promise<T> {
  const boot = (window as unknown as {__SYLLORA__?:{token?:string}}).__SYLLORA__;
  const response = await fetch(`/api/syllora/${action}`,{method:'POST',headers:{'Content-Type':'application/json',...(boot?.token?{Authorization:`Bearer ${boot.token}`}:{})},body:JSON.stringify({payload})});
  const body = await response.json();
  if(body.error) throw new Error(body.error.message);
  if(!response.ok) throw new Error(`请求失败 (${response.status})`);
  return body.result as T;
}
const uuid = () => crypto.randomUUID();
const formatTime = (at:number,zone:string) => new Intl.DateTimeFormat('zh-CN',{timeZone:zone,month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(at);
const pageIssueLabel = (reason:Material['pageIssues'][number]['reason']) => reason==='blank-page'?'空白页（无可提取文本）':reason==='unextracted-text'?'解析未返回该页':'该页解析失败';
const formatBytes = (bytes:number) => bytes>=1024*1024?`${(bytes/1024/1024).toFixed(1)} MiB`:`${Math.max(1,Math.round(bytes/1024))} KiB`;
/** PRD 6.2/6.3: status, version and original-file facts stay visible on one line. */
const materialStatus = (m:Material&{previewUrl:string|null}) => {
  const state = m.status==='deleted'?'已删除':m.status==='partial'?`部分可用${m.accepted?' · 已接受':' · 待确认'}`:'可用';
  const parts = [state,`v${m.version}`,`${m.sources.length} 个片段`];
  if (m.pages>0) parts.push(`${m.pages} 页`);
  if (m.file) parts.push(`原文件 ${formatBytes(m.file.bytes)}`);
  return parts.join(' · ');
};

export default function Syllora() {
  const [data,setData] = useState<SylloraState|null>(null);
  const [selected,setSelected] = useState('');
  const [tab,setTab] = useState<'today'|'outline'|'materials'|'review'>('today');
  const [settings,setSettings] = useState(false);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [newName,setNewName] = useState('');
  const [creating,setCreating] = useState(false);
  const [prompt,setPrompt] = useState('');
  const [text,setText] = useState('');
  const [scope,setScope] = useState<string[]>([]);
  const [minutes,setMinutes] = useState(40);
  const [days,setDays] = useState(7);
  const [deadline,setDeadline] = useState('');
  const [estimates,setEstimates] = useState<Record<string,string>>({});
  const [restDays,setRestDays] = useState<number[]>([]);
  const [consent,setConsent] = useState(false);
  const [limit,setLimit] = useState(0);
  const [sourceId,setSourceId] = useState<string|null>(null);
  const [activeTask,setActiveTask] = useState<string|null>(null);
  const [answers,setAnswers] = useState<Record<string,number>>({});
  const [showRight,setShowRight] = useState(true);
  const [diffCourse,setDiffCourse] = useState<CourseView|null>(null);
  const [adjustNotice,setAdjustNotice] = useState<string|null>(null);
  const [editMinutes,setEditMinutes] = useState<Record<string,string>>({});
  const pollInFlight = useRef(false);
  const pollStartedAt = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);
  const selectedRef = useRef('');
  const promptRef = useRef('');
  const answersRef = useRef<Record<string,number>>({});
  const dataRef = useRef(data);
  const cacheRef = useRef<DraftCache>({});
  const saveTimer = useRef<number | null>(null);
  const course = data?.courses.find(c=>c.id===selected);
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
    for(const item of data.courses) cacheRef.current=rememberServer(cacheRef.current,item.id,item.drafts,pollStartedAt.current);
  },[data]);
  useEffect(()=>{
    setScope([]);setActiveTask(null);setSourceId(null);setError('');setDeadline('');setEstimates({});setMinutes(40);setDays(7);setRestDays([]);setDiffCourse(null);setAdjustNotice(null);setEditMinutes({});
    if(!selected)return;
    const server=dataRef.current?.courses.find(item=>item.id===selected)?.drafts??{prompt:'',answers:[]};
    if(!cacheRef.current[selected]) cacheRef.current=rememberServer(cacheRef.current,selected,server);
    const view=hydrateCourse(cacheRef.current,selected,server);
    promptRef.current=view.prompt;answersRef.current=view.answers;setPrompt(view.prompt);setAnswers(view.answers);
  },[selected]);
  useEffect(()=>{bottom.current?.scrollIntoView({behavior:'smooth'});},[course?.messages.length]);
  const persistDraft = async(courseId:string)=>{
    const local=cacheRef.current[courseId];
    if(!local||local.revision===local.savedRevision) return true;
    const current=dataRef.current?.courses.find(item=>item.id===courseId);
    if(current?.archived) return true;
    const revision=local.revision;
    try{await rpc('saveDraft',{courseId,prompt:local.prompt,answers:Object.entries(local.answers).map(([questionId,option])=>({questionId,option}))});cacheRef.current=markSaved(cacheRef.current,courseId,revision);return true}
    catch(e){setError(e instanceof Error?`${e.message}。未提交草稿未能保存，已停留在当前课程。`:'未提交草稿未能保存，已停留在当前课程。');return false}
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
  const selectCourse = async(id:string)=>{if(id===selectedRef.current)return;if(!(await flushDraft()))return;selectedRef.current=id;setSelected(id)};
  const rememberPrompt = (value:string)=>{
    promptRef.current=value;setPrompt(value);
    if(!selectedRef.current)return;
    cacheRef.current=editDraft(cacheRef.current,selectedRef.current,value,answersRef.current);
    scheduleSave(selectedRef.current);
  };
  const rememberAnswer = (questionId:string,option:number)=>{
    const next={...answersRef.current,[questionId]:option};
    answersRef.current=next;setAnswers(next);
    if(!selectedRef.current)return;
    cacheRef.current=editDraft(cacheRef.current,selectedRef.current,promptRef.current,next);
    scheduleSave(selectedRef.current);
  };
  const run = async(action:string,payload:Record<string,unknown>={})=>{
    setBusy(true);setError('');
    try{const result=await rpc(action,{courseId:selected,...payload});await refresh();return result;}
    catch(e){setError(e instanceof Error?e.message:'操作失败');return null;}
    finally{setBusy(false)}
  };
  const generate = (kind:string,extra:Record<string,unknown>={})=>run('generate',{kind,requestId:uuid(),...extra});
  const running = data?.jobs.find(j=>j.courseId===selected&&j.state==='running');
  const lastJob = data?.jobs.filter(j=>j.courseId===selected).at(-1);
  // PRD 17.4: tell the user which fragment range was used and never imply full coverage.
  const coverageNote = lastJob?.state==='succeeded'&&lastJob.coverage?(()=>{
    const c = lastJob.coverage!;
    const base = `本次使用 ${c.sourcesUsed} / ${c.sourcesTotal} 个片段（约 ${c.charsUsed} 字符，未使用 ${Math.max(0,c.charsTotal-c.charsUsed)} 字符）`;
    return c.materialsWithOmitted.length?`${base}；未覆盖到：${c.materialsWithOmitted.join('、')}。未选入片段不参与本次回答。`:`${base}。`;
  })():null;
  const task = course?.plan?.tasks.find(t=>t.id===activeTask) ?? course?.plan?.tasks.find(t=>t.status==='in_progress');
  const source = course?.materials.flatMap(m=>m.sources).find(s=>s.id===sourceId);
  const pointName = (id:string) => course?.points.find(p=>p.id===id)?.name??'知识点';
  const startTask = async(t:Task)=>{if(await run('start',{taskId:t.id}))setActiveTask(t.id)};
  const upload = async(file:File)=>{
    if(file.size>20*1024*1024){setError('单文件不能超过 20 MiB');return}
    const reader=new FileReader();
    reader.onload=()=>void run('import',{name:file.name,base64:String(reader.result).split(',')[1]});
    reader.onerror=()=>setError('无法读取文件');
    reader.readAsDataURL(file);
  };
  const proposeReview = async(pointId:string)=>{if(await run('review',{pointId})){setActiveTask(null);setTab('today')}};
  const next = async()=>{
    if(!course)return;
    if(course.next.taskId){const t=course.plan?.tasks.find(t=>t.id===course.next.taskId);if(t)await startTask(t)}
    else if(course.next.pointId) await proposeReview(course.next.pointId);
    else setTab(course.materials.some(m=>m.status!=='deleted')?'outline':'materials');
  };
  useEffect(()=>{setEditMinutes({})},[course?.draft?.id]);
  const courseList = (archived:boolean)=>(data?.courses??[]).filter(c=>c.archived===archived).map(c=><button className={`sy-course ${c.id===selected?'is-selected':''}`} key={c.id} onClick={()=>void selectCourse(c.id)}><BookOpen size={17}/><span>{c.name}<small>{c.points.length} 个知识点{c.archived?' · 已归档':''}</small></span></button>);
  return <div className={`sy-app ${showRight?'':'sy-no-right'}`}>
    <aside className="sy-left">
      <div className="sy-brand"><div className="sy-mark"><BookOpen size={23}/></div><div><strong>Syllora</strong><small>你的课程，持续的学习</small></div></div>
      <button className="sy-new" onClick={()=>setCreating(!creating)}><Plus size={17}/>新建课程</button>
      {creating&&<form className="sy-create" onSubmit={async e=>{e.preventDefault();if(!(await flushDraft()))return;const result=await run('create',{name:newName,requestId:uuid(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone}) as {id:string}|null;if(result){selectedRef.current=result.id;setSelected(result.id);setNewName('');setCreating(false);setTab('materials')}}}><label>课程名称<input autoFocus value={newName} maxLength={60} onChange={e=>setNewName(e.target.value)} placeholder="例如：线性代数" required/></label><button className="sy-primary" disabled={busy}>创建课程</button></form>}
      <div className="sy-section-title">我的课程 <span>{data?.courses.filter(c=>!c.archived).length??0}</span></div>
      <nav className="sy-courses" aria-label="课程">{courseList(false)}{data&&!data.courses.length&&<p className="sy-muted sy-pad">创建第一门课程，把资料和学习记录放在一起。</p>}{data?.courses.some(c=>c.archived)&&<><div className="sy-section-title">已归档</div>{courseList(true)}</>}</nav>
      <div className="sy-left-bottom"><p>Turn every course into<br/>a learning system.</p><button onClick={()=>{setSettings(true);setConsent(data?.settings.consent??false);setLimit(data?.settings.callLimit??0)}}><Settings size={17}/>模型与设置</button><small>本机单用户 · 资料保存在本地</small></div>
    </aside>
    <main className="sy-main">
      <header className="sy-top"><div><span>学习工作台</span><h1>{course?.name??'从一门课程开始'}</h1></div><div className="sy-actions">{course&&<><button aria-label="重命名课程" title="重命名" onClick={()=>{const name=window.prompt('课程名称',course.name);if(name)void run('rename',{name})}}><Pencil size={16}/></button><button aria-label={course.archived?'恢复课程':'归档课程'} title={course.archived?'恢复课程':'归档课程'} onClick={()=>void run('archive',{archived:!course.archived})}>{course.archived?<RotateCcw size={16}/>:<Archive size={16}/>}</button><button aria-label="删除课程" title="删除课程" onClick={()=>{if(window.confirm(`删除「${course.name}」及全部资料、消息、题目和作答？此操作不可撤销。`))void run('delete',{confirmed:true})}}><Trash2 size={16}/></button></>}<button aria-label="切换状态栏" onClick={()=>setShowRight(!showRight)}><PanelRight size={18}/></button></div></header>
      {error&&<div className="sy-error" role="alert">{error}<button aria-label="关闭错误" onClick={()=>setError('')}><X size={14}/></button></div>}
      {!data?<div className="sy-empty"><LoaderCircle className="sy-spin"/><h2>正在连接本地服务</h2><p>请确认 Syllora 服务已启动。</p></div>:!course?<div className="sy-empty"><BookOpen size={48}/><p className="sy-kicker">学习从这里开始</p><h2>把资料变成<br/>下一步行动。</h2><p>创建课程，导入讲义，按自己的节奏学习。<br/>每一次作答，都会留下可追溯的学习证据。</p><button className="sy-primary" onClick={()=>setCreating(true)}>创建第一门课程 <ArrowRight size={16}/></button></div>:<>
      <div className="sy-content">
        {course.notice&&<div className="sy-notice" role="status"><p>{course.notice.text}</p>{course.notice.kind==='restore'&&<button disabled={busy||course.archived} onClick={()=>void run('proposeRestore').then(ok=>{if(ok)setTab('today')})}>生成恢复日程草案</button>}</div>}
        <section className="sy-next"><div><span className="sy-kicker">下一步</span><h2>{course.next.text}</h2><p>{course.next.reason}</p>{course.next.pointId&&<p>{pointName(course.next.pointId)}</p>}<p>{course.next.availableAt===null?'现在可以执行':course.next.kind==='summary'?`下次复习：${formatTime(course.next.availableAt,course.timezone)}`:`可执行时间：${formatTime(course.next.availableAt,course.timezone)}`}</p>{course.next.kind==='summary'&&<button disabled={course.archived} onClick={()=>setTab('outline')}>补充学习范围</button>}{course.next.practice&&<button className="sy-optional" disabled={busy||course.archived} onClick={()=>void proposeReview(course.next.practice!.pointId)}>{course.next.practice.text}</button>}</div><button className="sy-primary" disabled={busy||course.archived} onClick={()=>void next()}>继续 <ArrowRight size={16}/></button></section>
        {task&&<section className="sy-task-study"><div className="sy-task-heading"><span>{task.immediate?'即时巩固':task.kind==='review'?'复习任务':'学习任务'} · {task.minutes} 分钟</span><span>{task.status==='completed'?'活动已完成':`${task.slots} 个题位`}</span></div><h2>{pointName(task.pointId)}</h2><div className="sy-row"><button disabled={busy||!!running||course.archived} onClick={()=>void generate('answer',{taskId:task.id,prompt:`请讲解「${pointName(task.pointId)}」，用资料依据和一个明确标识的教学示例帮助理解。`})}>获取资料讲解</button>{!task.explained&&<button disabled={busy||course.archived} onClick={()=>void run('explainDone',{taskId:task.id})}><Check size={15}/>我已完成讲解学习</button>}</div>
        {Array.from({length:task.slots},(_,slot)=>{
          const q=course.questions.filter(q=>q.taskId===task.id&&q.slot===slot).at(-1);
          const attempt=q?course.attempts.find(a=>a.questionId===q.id):undefined;
          return <div className="sy-question" key={slot}><div className="sy-kicker">练习 {slot+1}</div>{!q||q.status!=='valid'?<><p>{q?'此题已暂停评估，原作答保留，请生成替代题。':'按当前知识点资料生成一道新题。'}</p><button disabled={busy||!!running||course.archived} onClick={()=>void generate('question',{taskId:task.id,slot})}>生成{q?'替代':''}题目</button></>:<><h3>{q.stem}</h3><div className="sy-options" role="group" aria-label={`练习 ${slot+1} 选项`}>{q.options.map((o,i)=><button key={i} disabled={!!attempt||busy||course.archived} className={(attempt?.option??answers[q.id])===i?'is-selected':''} onClick={()=>rememberAnswer(q.id,i)}><span>{String.fromCharCode(65+i)}</span>{o}</button>)}</div>{!attempt?<div className="sy-row"><button className="sy-primary" disabled={answers[q.id]===undefined||busy||course.archived} onClick={async()=>{setAdjustNotice(null);const r=await run('submit',{questionId:q.id,option:answers[q.id],requestId:uuid()}) as {correct?:boolean;planAdjustment?:{ok:boolean;code:string;message?:string;draftId:string|null}}|null;if(r&&!r.correct){if(r.planAdjustment?.ok)setAdjustNotice('已根据本次错答生成计划调整草案，可查看差异后决定是否接受');else if(r.planAdjustment?.code==='SKIPPED_EXISTING_DRAFT')setAdjustNotice('已有待确认草案，本次未重复生成');else if(r.planAdjustment?.code==='FAILED')setAdjustNotice('本次错答未能生成调整建议，可稍后重试')}}}>提交答案</button><button disabled={busy||course.archived} onClick={()=>void run('reveal',{questionId:q.id})}>查看答案（记为辅助学习）</button></div>:<div className="sy-feedback"><strong>{attempt.correct?'回答正确':'回答错误'} · {attempt.assisted?'辅助学习，不计独立证据':'已保存独立作答'}</strong><p>{course.evidence[q.pointId]?.state} · {course.evidence[q.pointId]?.reason}</p></div>}{q.answer!==undefined&&<div className="sy-explanation"><p><strong>答案 {String.fromCharCode(65+q.answer)}</strong>　{q.explanation}</p><blockquote>{q.quote}</blockquote><div className="sy-row">{q.sourceIds.map(s=><button key={s} onClick={()=>setSourceId(s)}>查看依据</button>)}<button disabled={course.archived||busy} onClick={()=>{const reason=window.prompt('报错原因：歧义、来源不支持或答案错误');if(reason)void run('dispute',{questionId:q.id,reason})}}>题目报错并暂停计入</button></div></div>}</>}</div>
        })}</section>}
        <section className="sy-discussion"><div className="sy-section-title">资料问答</div>{!course.messages.length&&<div className="sy-chat-empty"><FileText size={23}/><p>围绕你的课程资料提问。<br/><span>回答会附上可查看的来源；资料不足时会明确说明。</span></p></div>}{course.messages.map(m=><article className={`sy-message ${m.role}`} key={m.id}><div className="sy-message-name">{m.role==='user'?'你':'Syllora'}<small>{formatTime(m.at,course.timezone)}</small></div><ReactMarkdown skipHtml components={{img:({alt})=><span>{alt ? `[图片：${alt}]` : '[外部图片未加载]'}</span>,a:({children,href})=><a href={href} target="_blank" rel="noreferrer">{children}</a>}}>{m.text}</ReactMarkdown>{m.sourceIds.length>0&&<div className="sy-citations">{m.sourceIds.map((s,i)=><button key={s} onClick={()=>setSourceId(s)}><FileText size={13}/>来源 {i+1}</button>)}</div>}</article>)}<div ref={bottom}/></section>
      </div>
      {running?<div className="sy-job" role="status"><LoaderCircle size={16} className="sy-spin"/><span>{running.message}</span><button onClick={()=>void run('cancel',{jobId:running.id})}>取消</button></div>:lastJob?.state==='failed'?<div className="sy-job sy-error" role="alert">{lastJob.message}</div>:coverageNote?<div className="sy-job" role="status">{coverageNote}</div>:null}
      <form className="sy-composer" onSubmit={async e=>{e.preventDefault();if(await generate('answer',{prompt,...(task?{taskId:task.id}:{})})){const revision=(cacheRef.current[selected]?.revision??0)+1;cacheRef.current={...cacheRef.current,[selected]:{prompt:'',answers:answersRef.current,revision,savedRevision:revision,savedAt:Date.now()}};promptRef.current='';setPrompt('')}}}><input aria-label="向课程资料提问" placeholder={course.materials.some(m=>m.status!=='deleted')?'向课程资料提问，追问会带上本课程最近对话…':'先在右侧导入学习资料'} value={prompt} onChange={e=>rememberPrompt(e.target.value)} disabled={course.archived} maxLength={4000}/><button className="sy-primary" title="发送问题" aria-label="发送问题" disabled={!prompt.trim()||busy||!!running||course.archived}><Send size={18}/></button><small>未发送的问题按课程保存 · 依据只来自所选课程资料 · 模型生成内容需要核验</small></form>
      </>}
    </main>
    {showRight&&<aside className="sy-right"><div className="sy-right-title">学习状态 <span>{course?.timezone??'本地时间'}</span></div><div className="sy-tabs" role="tablist">{([['today','计划'],['outline','大纲'],['review','复习'],['materials','资料']] as const).map(([id,label])=><button role="tab" aria-selected={tab===id} className={tab===id?'is-selected':''} key={id} onClick={()=>setTab(id)}>{label}</button>)}</div><div className="sy-panel">
      {!course?<p className="sy-muted">创建课程后，在这里查看计划、资料与学习证据。</p>:tab==='materials'?<>
        <h2>课程资料</h2><p className="sy-muted">支持文本 PDF、MD、TXT。单份最多 20 MiB／50 页，课程合计 100 页 PDF／10 万字符。重复内容会复用已有资料；同名不同正文会新建一条资料线并递增版本。</p><label className="sy-upload"><Upload size={20}/><span>选择资料文件</span><input aria-label="上传课程资料" type="file" accept=".pdf,.md,.txt" disabled={busy||course.archived} onChange={e=>{const file=e.target.files?.[0];if(file)void upload(file);e.target.value=''}}/></label><label>或粘贴正文<textarea rows={4} value={text} onChange={e=>setText(e.target.value)} placeholder="粘贴有使用权限的学习资料"/></label><button disabled={!text.trim()||busy||course.archived} onClick={async()=>{if(await run('import',{name:'粘贴资料.txt',text}))setText('')}}>保存正文</button>
        {course.materials.map(m=><div className="sy-material" key={m.id}><FileText size={17}/><div><strong>{m.name}</strong><small>{materialStatus(m)}</small>{m.pageIssues.length>0&&<details className="sy-issues"><summary>列出失败范围（{m.pageIssues.length} 页）</summary><ul>{m.pageIssues.map(issue=><li key={`${issue.num}-${issue.reason}`}>第 {issue.num} 页 · {pageIssueLabel(issue.reason)}</li>)}</ul><p className="sy-muted">这些页没有可用正文，不会被用于生成；其余页仍可引用。</p></details>}{m.parseError&&<p className="sy-muted" role="alert">{m.parseError}</p>}{m.status==='partial'&&!m.accepted&&<button onClick={()=>void run('acceptMaterial',{materialId:m.id})}>接受可用部分</button>}{m.previewUrl&&<a className="sy-preview-link" href={m.previewUrl} target="_blank" rel="noreferrer">预览原文件</a>}{m.sources.map(s=><button className="sy-source-link" key={s.id} onClick={()=>setSourceId(s.id)}>{s.anchor}</button>)}</div>{m.status!=='deleted'&&<button aria-label={`删除资料 ${m.name}`} disabled={course.archived} onClick={()=>{if(window.confirm('删除此资料？关联题目将失效，证据会重新计算。'))void run('deleteMaterial',{materialId:m.id,confirmed:true})}}><Trash2 size={14}/></button>}</div>)}
      </>:tab==='outline'?<><h2>确认学习范围</h2><p className="sy-muted">大纲只反映已导入资料。勾选本轮知识点，再生成可执行计划。</p><button disabled={busy||!!running||course.archived} onClick={()=>void generate('outline')}>从资料生成／补充大纲</button>{course.points.map((p,i)=><div className="sy-point-row" key={p.id}><label className="sy-point"><input type="checkbox" checked={scope.includes(p.id)} onChange={e=>setScope(e.target.checked?[...scope,p.id]:scope.filter(x=>x!==p.id))}/><span><small>{p.chapter} · {String(i+1).padStart(2,'0')}</small>{p.name}<em>{course.evidence[p.id]?.state}</em></span></label><div className="sy-point-actions"><button aria-label={`${p.name} 重命名`} title="重命名" disabled={busy||course.archived} onClick={()=>{const n=window.prompt('知识点名称',p.name);if(n)void run('point',{pointId:p.id,name:n})}}>✏️</button><button aria-label={`${p.name} 上移`} title="上移" disabled={i===0||busy||course.archived} onClick={async()=>{const ids=course.points.map(x=>x.id);[ids[i-1],ids[i]]=[ids[i],ids[i-1]];await run('reorderPoints',{pointIds:ids})}}>↑</button><button aria-label={`${p.name} 下移`} title="下移" disabled={i===course.points.length-1||busy||course.archived} onClick={async()=>{const ids=course.points.map(x=>x.id);[ids[i],ids[i+1]]=[ids[i+1],ids[i]];await run('reorderPoints',{pointIds:ids})}}>↓</button></div><input className="sy-estimate" type="number" min={5} max={240} aria-label={`${p.name} 任务估时（分钟）`} placeholder="20" value={estimates[p.id]??''} onChange={e=>setEstimates({...estimates,[p.id]:e.target.value})} disabled={busy}/></div>)}{course.points.length>0&&<button onClick={()=>setScope(course.points.map(p=>p.id))}>选择全部知识点</button>}<div className="sy-plan-input"><label>每天可用分钟<input type="number" min={1} max={720} value={minutes} onChange={e=>setMinutes(Number(e.target.value))}/></label><label>未来天数（无目标日期时生效）<input type="number" min={1} max={90} value={days} onChange={e=>setDays(Number(e.target.value))}/></label><label>目标日期（可选，含当天）<input type="date" value={deadline} onChange={e=>setDeadline(e.target.value)} disabled={busy}/></label></div><div className="sy-rest"><span>休息日</span>{['日','一','二','三','四','五','六'].map((d,i)=><button key={i} aria-pressed={restDays.includes(i)} onClick={()=>setRestDays(restDays.includes(i)?restDays.filter(d=>d!==i):[...restDays,i])}>{d}</button>)}</div><button className="sy-primary" disabled={!scope.length||busy||course.archived} onClick={async()=>{const entered=Object.entries(estimates).filter(([id,value])=>scope.includes(id)&&value.trim()!=='');if(entered.some(([,value])=>!Number.isInteger(Number(value))||Number(value)<5||Number(value)>240)){setError('任务估时请输入 5–240 的整数分钟');return}const estimateInput=Object.fromEntries(entered.map(([id,value])=>[id,Number(value)]));if(await run('plan',{scope,dailyMinutes:minutes,days,restDays,baseVersion:course.plan?.version??0,...(deadline?{deadline}:{}),...(Object.keys(estimateInput).length?{estimates:estimateInput}:{})}))setTab('today')}}>生成计划草案 <ArrowRight size={15}/></button></>:tab==='review'?<><h2>知识点与复习</h2><p className="sy-muted">独立作答决定状态。复测至少间隔 24 小时；提前练习不会提前晋升复测。</p>{!course.scope.length&&<p>确认学习范围后展示复习状态。</p>}{course.scope.map(id=>{const e=course.evidence[id];return <div className="sy-review" key={id}><h3>{pointName(id)}</h3><span className="sy-badge">{e?.state}</span><p>{e?.reason}</p><small>{e?.dueAt?`下次复习：${formatTime(e.dueAt,course.timezone)}`:'尚未安排复习'}</small><button disabled={busy||course.archived} onClick={()=>void proposeReview(id)}>{e?.dueAt&&e.dueAt<=Date.now()?'生成到期复习草案':'生成即时巩固草案'}</button></div>})}</>:<>
        <div className="sy-progress"><div>{course.progress.activityLabel?<strong className="sy-empty-metric">{course.progress.activityLabel}</strong>:<strong>{course.progress.completed}<span> / {course.progress.total}</span></strong>}<small>活动完成{course.progress.skipped?` · 跳过 ${course.progress.skipped}`:''}</small></div><div>{course.progress.scopeLabel?<strong className="sy-empty-metric">{course.progress.scopeLabel}</strong>:<strong>{course.progress.covered}<span> / {course.progress.scope}</span></strong>}<small>有效评估覆盖</small></div></div>
        <ul className="sy-distribution" aria-label="证据状态分布">{(['未评估','待验证','待加强','初步掌握','复测通过'] as const).map(state=><li key={state}><span>{state}</span><strong>{course.progress.distribution[state]}</strong></li>)}</ul>
        {course.changes.length>0&&<div className="sy-trace"><h2>分母变化</h2>{[...course.changes].reverse().map(change=><p className="sy-change" key={change.id}>{change.text}</p>)}</div>}
        {course.actions.length>0&&<div className="sy-trace"><h2>下一行动记录</h2>{[...course.actions].reverse().map(action=><p className="sy-action" key={action.id}><strong>{action.text}</strong><small>{formatTime(action.at,course.timezone)} · {action.trigger} · {action.evidenceState??'无证据'} · {action.availableAt===null?'现在可以执行':`可执行 ${formatTime(action.availableAt,course.timezone)}`} · {action.reason}</small></p>)}</div>}
        {adjustNotice&&<div className="sy-adjust-notice" role="status"><p>{adjustNotice}</p></div>}{course.draft&&<div className="sy-draft" data-draft-id={course.draft.id}><span className="sy-kicker">待确认草案 · v{course.draft.version}{course.draft.deadline?` · 目标 ${course.draft.deadline}`:''}</span><h3>{course.draft.feasible?'计划可执行':'时间预算不足'}</h3><p>{course.draft.tasks.length} 个任务，每天最多 {course.draft.dailyMinutes} 分钟。确认后才替换尚未开始的安排。</p>{course.draftDiff&&<ul className="sy-diff">{course.draftDiff.scopeAdded.map(id=><li key={`in-${id}`}>新增范围：{pointName(id)}</li>)}{course.draftDiff.scopeRemoved.map(id=><li key={`out-${id}`}>移出范围：{pointName(id)}，作答仍保留</li>)}{course.draftDiff.tasksAdded.map(item=><li key={item.id}>新增{item.immediate?'即时巩固':'任务'}：{pointName(item.pointId)} · {item.date} · {item.minutes} 分钟</li>)}{course.draftDiff.tasksRemoved.map(item=><li key={item.id}>移出任务：{pointName(item.pointId)} · {item.date}</li>)}{course.draftDiff.tasksMoved.map(item=><li key={item.id}>移动：{pointName(item.pointId)} {item.from} → {item.to}</li>)}<li>估时 {course.draftDiff.minutesBefore} → {course.draftDiff.minutesAfter} 分钟</li></ul>}{course.draft.overflow.some(o=>o.reason==='task-too-large')&&<p role="alert">单任务超过每天可用分钟：{course.draft.overflow.filter(o=>o.reason==='task-too-large').map(o=>pointName(o.pointId)).join('、')}。请提高每天可用分钟，或调低对应任务的估时。</p>}{course.draft.overflow.some(o=>o.reason==='window-full')&&<p role="alert">时间窗口内放不下：{course.draft.overflow.filter(o=>o.reason==='window-full').map(o=>pointName(o.pointId)).join('、')}。请增加每天可用分钟、延长目标日期或天数，或缩小范围。</p>}<button disabled={busy||course.archived} onClick={()=>setDiffCourse(structuredClone(course))}>查看差异</button>{course.draft.tasks.filter(t=>t.status==='todo').map(t=><div className="sy-task-estimate" key={t.id}><label>{pointName(t.pointId)} · {t.kind==='review'?'复习':'学习'}估时<input type="number" min={1} max={720} aria-label={`${pointName(t.pointId)} 草案任务估时`} value={editMinutes[t.id]??String(t.minutes)} onChange={e=>setEditMinutes({...editMinutes,[t.id]:e.target.value})}/></label><button disabled={busy||course.archived} onClick={async()=>{const value=Number(editMinutes[t.id]??t.minutes);if(!Number.isInteger(value)||value<1||value>720){setError('草案任务估时请输入 1–720 的整数分钟');return}await run('adjustTaskMinutes',{draftId:course.draft!.id,taskId:t.id,minutes:value})}}>调整估时</button></div>)}<div className="sy-row"><button className="sy-primary" disabled={!course.draft.feasible||busy||course.archived} onClick={()=>void run('confirmPlan',{baseVersion:course.draft!.baseVersion,draftId:course.draft!.id})}>确认生效</button><button onClick={()=>void run('rejectPlan')}>保留原计划</button></div></div>}
        <h2>已确认计划{course.plan?` · v${course.plan.version}${course.plan.deadline?` · 目标 ${course.plan.deadline}`:''}`:''}</h2>{!course.plan?<div className="sy-panel-empty"><p>导入资料、生成大纲后，确认你的第一份计划。</p><button onClick={()=>setTab(course.materials.length?'outline':'materials')}>开始准备 <ArrowRight size={14}/></button></div>:course.plan.tasks.map(t=><button className={`sy-task ${task?.id===t.id?'is-selected':''}`} key={t.id} disabled={busy||course.archived} onClick={()=>void startTask(t)}><span className="sy-task-dot">{t.status==='completed'?<Check size={14}/>:<BookOpen size={14}/>}</span><span><strong>{pointName(t.pointId)}</strong><small>{t.date} · {t.minutes} 分钟 · {t.immediate?'即时巩固':t.kind==='review'?'复习':'学习'}</small><em>{t.status==='completed'?'活动完成':t.status==='in_progress'?'进行中':'待开始'}</em></span><ArrowRight size={14}/></button>)}{course.plan&&<button onClick={()=>{setScope(course.scope);setMinutes(course.plan!.dailyMinutes);setDays(Math.min(course.plan!.days,90));setRestDays(course.plan!.restDays);setDeadline(course.plan!.deadline??'');setEstimates({});setTab('outline')}}>调整范围与计划</button>}
      </>}
    </div></aside>}
    {sourceId&&<div className="sy-overlay" onClick={()=>setSourceId(null)}><section className="sy-modal" role="dialog" aria-modal="true" aria-label="资料来源" onClick={e=>e.stopPropagation()}><header><h2>资料来源</h2><button aria-label="关闭来源" onClick={()=>setSourceId(null)}><X size={19}/></button></header>{source?<><p className="sy-muted">{course?.materials.find(m=>m.id===source.materialId)?.name} · {source.anchor}</p><pre className="sy-source-text">{source.text}</pre></>:<p>此来源已删除或不属于当前课程。</p>}</section></div>}
    {diffCourse?.draft&&<DiffModal course={diffCourse} onClose={()=>setDiffCourse(null)} busy={busy} onConfirm={async()=>{if(await run('confirmPlan',{courseId:diffCourse.id,baseVersion:diffCourse.draft!.baseVersion,draftId:diffCourse.draft!.id})){setDiffCourse(null);setAdjustNotice(null)}}} onReject={async()=>{if(await run('rejectPlan',{courseId:diffCourse.id,draftId:diffCourse.draft!.id})){setDiffCourse(null);setAdjustNotice(null)}}}/>}
    {settings&&<div className="sy-overlay"><section className="sy-modal sy-settings" role="dialog" aria-modal="true" aria-label="模型与设置"><header><h2>模型与设置</h2><button aria-label="关闭设置" onClick={()=>setSettings(false)}><X size={19}/></button></header><p className="sy-muted">模型配置与加密凭据保存在本机。密钥仅保存在本机，不进入前端构建产物。</p><ModelsSection initial={null}/><hr/><h3>外部调用与配额</h3><p>生成大纲、回答和题目时，将向所选模型服务发送相关资料片段、问题和题目。供应商的数据留存规则以其实际政策为准。</p><label className="sy-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>允许向已配置模型发送以上内容</label><label>累计模型调用上限（0 表示暂停）<input type="number" min={0} max={10000} value={limit} onChange={e=>setLimit(Number(e.target.value))}/></label><p className="sy-muted">已调用 {data?.settings.calls??0} 次。每道题含生成与复核两次调用。金额费用未知；调用次数限制不等同于金额预算。</p><button className="sy-primary" disabled={busy} onClick={async()=>{if(await run('preferences',{consent,callLimit:limit}))setSettings(false)}}>保存授权与配额</button></section></div>}
  </div>
}

function DiffModal({course,onClose,busy,onConfirm,onReject}:{course:CourseView;onClose:()=>void;busy:boolean;onConfirm:()=>Promise<void>;onReject:()=>Promise<void>}){
  const d = course.detailedDraftDiff;
  const pointName2 = (id:string) => course.points.find((p:{id:string;name:string}) => p.id === id)?.name??'知识点';
  return<div className="sy-overlay"><section className="sy-modal sy-diff" role="dialog" aria-modal="true" aria-label="计划差异"><header><h2>计划差异对比</h2><button aria-label="关闭" onClick={onClose}><X size={19}/></button></header>
  {!d?<p className="sy-diff-empty">无待对比草案</p>:<>
  <div className="sy-diff-summary"><span className="sy-diff-added">+{d.added.length} 新增</span><span className="sy-diff-removed">-{d.removed.length} 移除</span><span className="sy-diff-moved">~{d.moved.length} 移动</span><span className="sy-diff-moved">{d.changed.length>0?`±${d.changed.length} 调时`:''}</span><span>{d.unchanged.length} 不变</span></div>
  <div className="sy-diff-grid"><div className="sy-diff-col"><h3>当前计划</h3>{d.removed.map(t=><div className="sy-diff-item removed" key={t.id}><span className="sy-diff-tag removed">移</span>{pointName2(t.pointId)}<small>{course.plan?.tasks.find(old=>old.id===t.id)?.date??t.date} · {course.plan?.tasks.find(old=>old.id===t.id)?.minutes??t.minutes}分</small></div>)}{d.moved.map(t=><div className="sy-diff-item moved" key={t.id}><span className="sy-diff-tag moved">移</span>{pointName2(t.pointId)}<small>{course.plan?.tasks.find(old=>old.id===t.id)?.date??t.date} · {course.plan?.tasks.find(old=>old.id===t.id)?.minutes??t.minutes}分</small></div>)}{d.changed.map(c=><div className="sy-diff-item moved" key={c.to.id}><span className="sy-diff-tag moved">调</span>{pointName2(c.to.pointId)}<small>{c.from.date} · {c.from.minutes}分</small></div>)}{d.unchanged.map(t=><div className="sy-diff-item" key={t.id}>{pointName2(t.pointId)}<small>{course.plan?.tasks.find(old=>old.id===t.id)?.date??t.date} · {course.plan?.tasks.find(old=>old.id===t.id)?.minutes??t.minutes}分</small></div>)}</div>
  <div className="sy-diff-col"><h3>新草案</h3>{d.added.map(t=><div className="sy-diff-item added" key={t.id}><span className="sy-diff-tag added">新</span>{pointName2(t.pointId)}<small>{t.date} · {t.minutes}分</small></div>)}{d.moved.map(t=><div className="sy-diff-item moved" key={t.id}><span className="sy-diff-tag moved">移</span>{pointName2(t.pointId)}<small>{t.date} · {t.minutes}分</small></div>)}{d.changed.map(c=><div className="sy-diff-item moved" key={c.to.id}><span className="sy-diff-tag moved">调</span>{pointName2(c.to.pointId)}<small>{c.to.date} · {c.to.minutes}分</small></div>)}{d.unchanged.map(t=><div className="sy-diff-item" key={t.id}>{pointName2(t.pointId)}<small>{t.date} · {t.minutes}分</small></div>)}</div></div>
  <div className="sy-row"><button className="sy-primary" disabled={busy||!course.draft?.feasible} onClick={onConfirm}>确认生效</button><button onClick={onReject}>保留原计划</button></div>
  </>}</section></div>
}
