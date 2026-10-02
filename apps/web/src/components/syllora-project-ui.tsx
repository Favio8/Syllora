"use client";
import { useEffect, useRef, useState } from 'react';
import { FileText, FolderOpen, LoaderCircle, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Modal from '../features/workbench/components/Modal';
import CourseIdentityPicker from '../features/workbench/components/CourseIdentityPicker';
import type { Course } from '../features/workbench/types';
import { api } from '../lib/api';
import type { CourseView } from '../types/syllora';
import type { FileCandidate, Lecture } from '../../../../packages/host/chat-service/src/syllora-project-types';

export { workbenchRpc as projectRpc } from '../features/workbench/services';
import { workbenchRpc as projectRpc } from '../features/workbench/services';
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
      const response=await fetch(url,{credentials:'same-origin',headers:token?{Authorization:`Bearer ${token}`}:{},signal:current.signal});
      if(!response.ok){const body=await response.json();throw new Error(body.error?.message??'原文件读取失败')}
      const data=await response.blob();if(current.signal.aborted)return;
      if(held.current)URL.revokeObjectURL(held.current);held.current=URL.createObjectURL(data);setBlob(held.current);
    } catch(e){if(!current.signal.aborted)setError(e instanceof Error?e.message:'预览失败')}finally{if(!current.signal.aborted)setBusy(false)}
  }}>{busy?'正在读取原文件…':'预览原文件'}</button>{error&&<p role="alert" className="sy-muted">{error}</p>}{blob&&<div className="sy-overlay"><section className="sy-modal sy-pdf-preview" role="dialog" aria-modal="true" aria-label="原文件预览"><header><h2>{name}</h2><button aria-label="关闭原文件预览" onClick={close}><X size={19}/></button></header><p className="sy-muted">若浏览器无法显示，可<a href={blob} download={name}>下载原文件</a>查看。</p><iframe src={blob} title="PDF 原文件"/></section></div>}</>;
}
export function ProjectDialog({onClose,onOpen,migrationName}:{onClose:()=>void;onOpen:(path:string,name?:string,icon?:string,color?:Course['color'])=>Promise<void>;migrationName?:string}) {
  const [name,setName]=useState(''),[icon,setIcon]=useState('notebook');
  const [color,setColor]=useState<Course['color']>('blue');
  const [path,setPath]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [browse,setBrowse]=useState<{path:string;parent:string|null;entries:Array<{name:string;path:string}>}|null>(null);
  const browseAt=async(value:string|null)=>{setBusy(true);setError('');try{const result=await api.browseDirectory(value);setBrowse(result);setPath(result.path)}catch(e){setError(e instanceof Error?e.message:'无法浏览文件夹')}finally{setBusy(false)}};
  return <Modal title={migrationName?`迁移「${migrationName}」`:'打开课程文件夹'} onClose={onClose} wide className="course-dialog" error={error}>
    <p>一门课程对应一个文件夹。课程信息、整理讲义和学习记录保存在其中的 .syllora 中。</p>
    {migrationName&&<p>迁移保留已有学习记录。旧资料只有提取片段，补充原文件后才能进行完整整理。</p>}
    {!migrationName&&<><label className="form-field">课程名称（留空使用文件夹名称）<input aria-label="课程名称" maxLength={60} value={name} onChange={event=>setName(event.target.value)} placeholder="给这门课起一个名字"/></label><CourseIdentityPicker icon={icon} color={color} name={name||path.split(/[\\/]/).pop()||''} onIcon={setIcon} onColor={setColor}/></>}
    <label className="form-field">课程文件夹路径<input autoFocus value={path} onChange={e=>setPath(e.target.value)} placeholder="选择已有的课程资料文件夹"/></label>
    <div className="folder-actions"><button className="button" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{const desktop=(window as unknown as {sylloraDesktop?:{pickDirectory?:()=>Promise<{path:string|null}>}}).sylloraDesktop;const result=await (desktop?.pickDirectory?desktop.pickDirectory():api.pickWorkspaceDirectory());if(result.path)setPath(result.path);else if(!desktop?.pickDirectory)await browseAt(path||null)}catch{await browseAt(path||null)}finally{setBusy(false)}}}><FolderOpen size={15}/>选择文件夹</button><button className="button" disabled={busy} onClick={()=>void browseAt(path||null)}>浏览目录</button></div>
    {browse&&<div className="sy-folder-browser"><p>{browse.path}</p>{browse.parent&&<button onClick={()=>void browseAt(browse.parent)}>上一级</button>}{browse.entries.map(e=><button key={e.path} onClick={()=>void browseAt(e.path)}><FolderOpen size={14}/>{e.name}</button>)}</div>}

    <div className="modal-actions"><button className="button" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={busy||!path.trim()||(!migrationName&&!icon)} onClick={async()=>{setBusy(true);setError('');try{await onOpen(path.trim(),name.trim()||undefined,icon||undefined,color)}catch(e){setError(e instanceof Error?e.message:'打开失败')}finally{setBusy(false)}}}>{busy?<LoaderCircle size={15} className="sy-spin"/>:null}{migrationName?'迁移到此文件夹':'打开此课程'}</button></div>
  </Modal>;
}
export function MaterialInitialization({course,epoch,busy,running,onRun}:{course:CourseView;epoch:number;busy:boolean;running:boolean;onRun:(action:string,payload:Record<string,unknown>)=>Promise<unknown>}) {
  const [files,setFiles]=useState<FileCandidate[]>([]),[selected,setSelected]=useState<string[]>([]),[missing,setMissing]=useState<string[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState(''),[partial,setPartial]=useState(false);
  const scan=async()=>{setLoading(true);setError('');try{const result=await projectRpc<{files:FileCandidate[];missing:string[]}>('scan',{courseId:course.id});setFiles(result.files);setMissing(result.missing);setSelected(result.files.filter(f=>f.status==='ready'&&course.materials.find(m=>m.path===f.path)?.active!==false).map(f=>f.path))}catch(e){setError(e instanceof Error?e.message:'扫描失败')}finally{setLoading(false)}};
  useEffect(()=>{void scan()},[course.id,epoch,course.revision]); // component is keyed by course; scans never cross project selection
  return <section className="sy-initialization"><h2>检查课程资料</h2><p className="sy-muted">先选择本轮资料，再初始化为可阅读的章节讲义。原文件保持原样。</p><button disabled={loading||running} onClick={()=>void scan()}>{loading?'正在扫描…':'重新扫描资料'}</button>
    {error&&<p role="alert">{error}</p>}{!loading&&!files.length&&<p>文件夹中没有可识别的资料（PDF、MD/TXT、DOCX、XLSX、HTML）。可以放入讲义，或在下方上传资料。</p>}
    {files.map(f=><label className="sy-file-candidate" key={f.path}><input type="checkbox" disabled={f.status!=='ready'||running||course.archived} checked={selected.includes(f.path)} onChange={e=>setSelected(e.target.checked?[...selected,f.path]:selected.filter(p=>p!==f.path))}/><span><strong>{f.path}</strong><small>{(f.size/1024).toFixed(1)} KiB · {f.status==='ready'?({added:'新增',changed:'内容已变化',unchanged:'未变化'}[f.change]):f.reason}</small></span></label>)}
    {missing.length>0&&<p className="sy-muted">原文件已缺失：{missing.join('、')}。已有学习记录仍保留。</p>}
    <label className="sy-consent"><input type="checkbox" checked={partial} onChange={e=>setPartial(e.target.checked)}/>解析部分失败时，接受明确列出的可用部分</label>
    <button className="sy-primary" disabled={!selected.length||busy||running||course.archived} onClick={()=>void onRun('initialize',{paths:selected,fingerprints:Object.fromEntries(files.filter(f=>selected.includes(f.path)).map(f=>[f.path,f.fingerprint])),acceptPartial:partial})}>{course.revision?'更新课程讲义':'初始化课程'} · {selected.length} 份资料</button>
  </section>;
}
const Markdown=({text}:{text:string})=><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{img:({alt})=><span>{alt?`[图片：${alt}]`:'[外部图片未加载]'}</span>,a:({children,href})=><a href={href} target="_blank" rel="noreferrer">{children}</a>}}>{text}</ReactMarkdown>;
export function LectureReader({course,onSource}:{course:CourseView;onSource:(id:string)=>void}) {
  const [lectures,setLectures]=useState<Lecture[]>([]),[selected,setSelected]=useState(''),[error,setError]=useState('');
  useEffect(()=>{let disposed=false;setLectures([]);setError('');void projectRpc<{lectures:Lecture[]}>('lectures',{courseId:course.id}).then(result=>{if(!disposed){const list=Array.isArray(result?.lectures)?result.lectures:[];setLectures(list);setSelected(list[0]?.id??'')}}).catch(e=>{if(!disposed)setError(e instanceof Error?e.message:'讲义读取失败')});return(()=>{disposed=true})},[course.id,course.revision]);
  const lecture=lectures.find(l=>l.id===selected);
  const citations=(ids:string[])=><div className="sy-citations">{ids.map((id,i)=><button key={id} onClick={()=>onSource(id)}><FileText size={13}/>原文 {i+1}</button>)}</div>;
  return <section className="sy-lecture-reader" aria-label="课程讲义"><header><h2>课程讲义</h2><p>整理解释与原文依据并列，学习记录由实际作答形成。</p></header>{error&&<p role="alert">{error}</p>}{!course.revision&&<p>检查资料并点击初始化后，在这里阅读整理后的课程。</p>}
    {lectures.length>0&&<label>选择章节<select value={selected} onChange={e=>setSelected(e.target.value)}>{lectures.map((l,i)=><option key={l.id} value={l.id}>{i+1}. {l.chapter}</option>)}</select></label>}
    {lecture&&<article><h2>{lecture.chapter}</h2><h3>章节导读</h3><Markdown text={lecture.intro.text}/>{citations(lecture.intro.sourceIds)}{lecture.concepts.map((c,i)=><section className="sy-lecture-concept" key={i}><h3>{c.name}</h3><h4>整理解释</h4><Markdown text={c.text}/><details><summary>原文依据</summary><blockquote>{c.quote}</blockquote></details>{citations(c.sourceIds)}</section>)}{lecture.examples.map((e,i)=><section className="sy-lecture-concept" key={i}><h3>资料例子：{e.title}</h3><Markdown text={e.text}/><blockquote>{e.quote}</blockquote>{citations(e.sourceIds)}</section>)}{lecture.connections.length>0&&<h3>知识联系</h3>}{lecture.connections.map((c,i)=><section key={i}><Markdown text={c.text}/>{citations(c.sourceIds)}</section>)}{lecture.analogies.length>0&&<h3>教学类比（整理生成）</h3>}{lecture.analogies.map((c,i)=><section key={i}><Markdown text={c.text}/>{citations(c.sourceIds)}</section>)}</article>}
  </section>;
}
