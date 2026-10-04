"use client";
import { useEffect, useRef, useState } from 'react';
import { FileText, LoaderCircle, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { MARKDOWN_REHYPE_PLUGINS, MARKDOWN_REMARK_PLUGINS, normalizeMathDelimiters } from '../lib/markdownPlugins';
import IconPicker from '../features/workbench/components/IconPicker';
import Dropdown from '../features/workbench/components/Dropdown';
import { api } from '../lib/api';
import { reviewFetch } from '../lib/review-transport';
import type { CourseView } from '../types/syllora';
import type { FileCandidate, Lecture } from '../../../../packages/host/chat-service/src/syllora-project-types';

export { workbenchRpc as projectRpc } from '../features/workbench/services';
import { workbenchRpc as projectRpc } from '../features/workbench/services';
import SlideDeckReader from './syllora-slides';
/** Fetch the protected original with a header; preview URLs never contain credentials. */
export function MaterialPreview({url,name,version}:{url:string;name:string;version:string|number|undefined}) {
  const [blob,setBlob]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const held=useRef(''),controller=useRef<AbortController|null>(null);
  const close=()=>{if(held.current)URL.revokeObjectURL(held.current);held.current='';setBlob('')};
  useEffect(()=>{setError('');setBusy(false);setBlob('');return()=>{controller.current?.abort();if(held.current)URL.revokeObjectURL(held.current);held.current=''}},[url,version]);
  return <><button className="sy-preview-link" disabled={busy} onClick={async()=>{
    const current=new AbortController();controller.current=current;setBusy(true);setError('');
    try {
      const token=(window as unknown as {__SYLLORA__?:{token?:string}}).__SYLLORA__?.token;
      const response=await reviewFetch(url,{headers:token?{Authorization:`Bearer ${token}`}:{},signal:current.signal});
      if(!response.ok){const body=await response.json();throw new Error(body.error?.message??'原文件读取失败')}
      const data=await response.blob();if(current.signal.aborted)return;
      if(held.current)URL.revokeObjectURL(held.current);held.current=URL.createObjectURL(data);setBlob(held.current);
    } catch(e){if(!current.signal.aborted)setError(e instanceof Error?e.message:'预览失败')}finally{if(!current.signal.aborted)setBusy(false)}
  }}>{busy?'正在读取原文件…':'预览原文件'}</button>{error&&<p role="alert" className="sy-muted">{error}</p>}{blob&&<div className="sy-overlay"><section className="sy-modal sy-pdf-preview" role="dialog" aria-modal="true" aria-label="原文件预览"><header><h2>{name}</h2><button aria-label="关闭原文件预览" onClick={close}><X size={19}/></button></header><p className="sy-muted">若浏览器无法显示，可<a href={blob} download={name}>下载原文件</a>查看。</p><iframe src={blob} title="PDF 原文件"/></section></div>}</>;
}
export function ProjectDialog({onClose,onOpen,migrationName}:{onClose:()=>void;onOpen:(name:string,icon?:string)=>Promise<void>;migrationName?:string}) {
  const [name,setName]=useState(migrationName??''),[icon,setIcon]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  return <div className="sy-overlay"><section className="sy-modal sy-project-dialog" role="dialog" aria-modal="true" aria-label={migrationName?'迁移旧课程':'新建课程'}><header><h2>{migrationName?`迁移「${migrationName}」`:'新建课程'}</h2><button aria-label="关闭课程创建" disabled={busy} onClick={onClose}><X size={19}/></button></header>
    <p className="sy-muted">资料会自动保存在本机，按课程分别整理。</p>
    {migrationName?<p>迁移保留资料和学习记录。</p>:<><div className="form-field"><span id="new-course-name-label">课程名称</span><input aria-labelledby="new-course-name-label" autoFocus maxLength={60} value={name} onChange={event=>setName(event.target.value)} placeholder="例如：线性代数"/></div><IconPicker value={icon} onChange={setIcon}/></>}
    {error&&<p role="alert" className="sy-project-error">{error}</p>}
    <div className="sy-row"><button disabled={busy} onClick={onClose}>取消</button><button className="sy-primary" disabled={busy||!name.trim()||(!migrationName&&!icon)} onClick={async()=>{setBusy(true);setError('');try{await onOpen(name.trim(),icon||undefined)}catch(e){setError(e instanceof Error?e.message:'创建失败')}finally{setBusy(false)}}}>{busy?<LoaderCircle size={15} className="sy-spin"/>:null}{migrationName?'迁移课程':'创建课程'}</button></div>
  </section></div>;
}
/**
 * 资料页的三个按钮：上传资料 / 重新扫描资料 / 更新课程讲义。
 * 勾选清单已移除——扫描后自动纳入所有可用文件（缓存按内容命中，重复整理不重算）。
 */
export function MaterialInitialization({course,epoch,busy,running,onRun,onUpload}:{course:CourseView;epoch:number;busy:boolean;running:boolean;onRun:(action:string,payload:Record<string,unknown>)=>Promise<unknown>;onUpload:()=>void}) {
  const [files,setFiles]=useState<FileCandidate[]>([]),[loading,setLoading]=useState(false),[failure,setFailure]=useState<{title:string;message:string}|null>(null);
  const scan=async()=>{setLoading(true);setFailure(null);try{const result=await projectRpc<{files:FileCandidate[];missing:string[]}>('scan',{courseId:course.id});setFiles(result.files)}catch(e){setFailure({title:'资料扫描失败',message:e instanceof Error?e.message:'扫描失败'})}finally{setLoading(false)}};
  useEffect(()=>{void scan()},[course.id,epoch,course.revision]); // component is keyed by course; scans never cross project selection
  // 失败一律走居中弹窗：旧实现只有行内一行提示，初始化失败后没有可关闭的出口。
  const initialize=async(payload:Record<string,unknown>)=>{try{await onRun('initialize',payload)}catch(e){setFailure({title:'初始化失败',message:e instanceof Error?e.message:'初始化未完成。已归档的资料与学习记录不受影响，可检查资料后重试。'})}};
  const ready=files.filter(f=>f.status==='ready'&&course.materials.find(m=>m.path===f.path)?.active!==false);
  return <><section className="sy-initialization"><div className="sy-row">
    <button className="button small" disabled={busy||running||course.archived} onClick={onUpload}>上传资料</button>
    <button className="button small" disabled={loading||running} onClick={()=>void scan()}>{loading?'正在扫描…':'重新扫描资料'}</button>
    <button className="button small primary" disabled={!ready.length||busy||running||course.archived} onClick={()=>void initialize({paths:ready.map(f=>f.path),fingerprints:Object.fromEntries(ready.map(f=>[f.path,f.fingerprint])),acceptPartial:true})}>更新课程讲义</button>
  </div></section>
  {failure&&<CenteredErrorDialog title={failure.title} message={failure.message} onClose={()=>setFailure(null)}/>}
  </>;
}

/** 居中错误弹窗：遮罩点击 / 右上角按钮 / 底部按钮 / Esc 四条路都能关闭。 */
export function CenteredErrorDialog({title,message,onClose}:{title:string;message:string;onClose:()=>void}) {
  const closeRef=useRef<HTMLButtonElement>(null);
  useEffect(()=>{closeRef.current?.focus();const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')onClose()};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey)},[onClose]);
  return <div className="sy-overlay" onClick={onClose}><section className="sy-modal sy-error-dialog" role="alertdialog" aria-modal="true" aria-labelledby="sy-error-dialog-title" aria-describedby="sy-error-dialog-message" onClick={event=>event.stopPropagation()}>
    <header><h2 id="sy-error-dialog-title">{title}</h2><button aria-label="关闭错误提示" onClick={onClose}><X size={19}/></button></header>
    <p id="sy-error-dialog-message" className="sy-error-dialog-message" role="alert">{message}</p>
    <div className="sy-row"><button className="sy-primary" ref={closeRef} onClick={onClose}>关闭</button></div>
  </section></div>;
}
const Markdown=({text}:{text:string})=><ReactMarkdown skipHtml remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={MARKDOWN_REHYPE_PLUGINS} components={{img:({alt})=><span>{alt?`[图片：${alt}]`:'[外部图片未加载]'}</span>,a:({children,href})=><a href={href} target="_blank" rel="noreferrer">{children}</a>}}>{normalizeMathDelimiters(text)}</ReactMarkdown>;
export function LectureReader({course,onSource}:{course:CourseView;onSource:(id:string)=>void}) {
  const [lectures,setLectures]=useState<Lecture[]>([]),[selected,setSelected]=useState(''),[error,setError]=useState(''),[view,setView]=useState<'lecture'|'slides'>('lecture');
  // 幻灯片视图需要锚点表：把来源 id 映射回"资料 · 页码/行"的定位文案。
  const sources=course.materials.flatMap(m=>[...m.sources,...(m.history??[])]).map(s=>({id:s.id,anchor:s.anchor}));
  useEffect(()=>{let disposed=false;setLectures([]);setError('');void projectRpc<{lectures:Lecture[]}>('lectures',{courseId:course.id}).then(result=>{if(!disposed){setLectures(result.lectures);setSelected(result.lectures[0]?.id??'')}}).catch(e=>{if(!disposed)setError(e instanceof Error?e.message:'讲义读取失败')});return()=>{disposed=true}},[course.id,course.revision]);
  const lecture=lectures.find(l=>l.id===selected);
  const citations=(ids:string[])=><div className="sy-citations">{ids.map((id,i)=><button key={id} onClick={()=>onSource(id)}><FileText size={13}/>原文 {i+1}</button>)}</div>;
  return <section className="sy-lecture-reader" aria-label="课程讲义"><header><h2>课程讲义</h2></header>{error&&<p role="alert">{error}</p>}{!course.revision&&<p>检查资料并点击初始化后，在这里阅读整理后的课程。</p>}
    {course.revision&&<div className="sy-view-switch" role="tablist" aria-label="讲义视图">
      <button role="tab" aria-selected={view==='lecture'} className={view==='lecture'?'is-selected':''} onClick={()=>setView('lecture')}>文字讲义</button>
      <button role="tab" aria-selected={view==='slides'} className={view==='slides'?'is-selected':''} onClick={()=>setView('slides')}>幻灯片</button>
    </div>}
    {view==='slides'
      ? course.revision ? <SlideDeckReader courseId={course.id} sources={sources}/> : null
      : <>
        {lectures.length>0&&<div className="form-field"><span>选择章节</span><Dropdown label="选择章节" value={selected} onChange={setSelected} options={lectures.map((l,i)=>({value:l.id,label:`${i+1}. ${l.chapter}`}))}/></div>}
        {lecture&&<article><h2>{lecture.chapter}</h2><h3>章节导读</h3><Markdown text={lecture.intro.text}/>{citations(lecture.intro.sourceIds)}{lecture.concepts.map((c,i)=><section className="sy-lecture-concept" key={i}><h3>{c.name}</h3><h4>整理解释</h4><Markdown text={c.text}/><details><summary>原文依据</summary><blockquote>{c.quote}</blockquote></details>{citations(c.sourceIds)}</section>)}{lecture.examples.map((e,i)=><section className="sy-lecture-concept" key={i}><h3>资料例子：{e.title}</h3><Markdown text={e.text}/><blockquote>{e.quote}</blockquote>{citations(e.sourceIds)}</section>)}{lecture.connections.length>0&&<h3>知识联系</h3>}{lecture.connections.map((c,i)=><section key={i}><Markdown text={c.text}/>{citations(c.sourceIds)}</section>)}{lecture.analogies.length>0&&<h3>教学类比（整理生成）</h3>}{lecture.analogies.map((c,i)=><section key={i}><Markdown text={c.text}/>{citations(c.sourceIds)}</section>)}</article>}
      </>}
  </section>;
}
