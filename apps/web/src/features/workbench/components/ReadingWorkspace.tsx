'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, FileText, Sparkles, Search, Plus, MousePointer2, X, LoaderCircle, Quote, ArrowUpRight, PanelRightOpen } from 'lucide-react';
import Dropdown from './Dropdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MaterialPreview } from '../../../components/syllora-project-ui';
import type { Course, ReadingAssistance, ReadingDocument } from '@/src/features/workbench/types';
import { readingService } from '@/src/features/workbench/services';
import { remarkSoftBreaks, splitFence } from '@/src/features/workbench/reading-format';

/**
 * B11：按后端给出的 `kind` 分支渲染正文。
 * 旧实现对所有非 heading 源统一走 ReactMarkdown（无 remark-breaks），
 * Markdown 会把段内软换行折叠成空格，代码块/表格/列表/多行段落全部 run-on。
 *  - code → `<pre><code>` 原样，保留换行与缩进；
 *  - table → remarkGfm（表格按行解析，不受折叠影响）；
 *  - list / paragraph → remarkSoftBreaks（软换行提升为硬换行）；
 *  - heading → h2（保持现状，由外层渲染）。
 * XSS 口径不变：仍然 `skipHtml`、不引 rehype-raw，markdown 里的事件属性照旧被过滤。
 */
function SourceBody({ text, kind }: { text: string; kind?: string }) {
  if (kind === 'code') {
    const { language, code } = splitFence(text);
    return <pre className="reading-code"><code className={language ? `language-${language}` : undefined}>{code}</code></pre>;
  }
  if (kind === 'table') return <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{ img: () => null }}>{text}</ReactMarkdown>;
  return <ReactMarkdown skipHtml remarkPlugins={[remarkSoftBreaks]} components={{ img: () => null }}>{text}</ReactMarkdown>;
}

export default function ReadingWorkspace({ course, onUpload, assistantOpen, onToggleAssistant, onExpandAssistant, onActivity, onSource }: { course: Course; onUpload: () => void; assistantOpen: boolean; onToggleAssistant: () => void; onExpandAssistant: () => void; onActivity: () => void;onSource:(id:string)=>void }) {
  const [selectedId, setSelectedId] = useState(course.materials[0]?.id ?? '');
  const material = course.materials.find(m => m.id === selectedId) ?? course.materials[0];
  const [readingDoc, setReadingDoc] = useState<ReadingDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  /** B5：等待超过 60 秒时的提示（不自动重复提交，只说明仍在查询原任务）。 */
  const [waitingNote, setWaitingNote] = useState('');
  const [retrySelection, setRetrySelection] = useState<{ text: string; mode: 'explain' | 'search' } | null>(null);
  const [toolbar, setToolbar] = useState<{ text: string; x: number; y: number } | null>(null);
  const [result, setResult] = useState<ReadingAssistance | null>(null);
  const [pending, setPending] = useState<{ text: string; mode: 'explain' | 'search' } | null>(null);
  const jumpTarget=useRef<string|null>(null);
  const [highlight,setHighlight]=useState('');
  const articleRef = useRef<HTMLElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const requestVersion = useRef(0);
  const controller=useRef<AbortController|null>(null);

  const loadDocument = useCallback(async () => {
    controller.current?.abort();
    const version = ++requestVersion.current;
    setToolbar(null); setResult(null); setPending(null);setHighlight(''); setError(''); setWaitingNote(''); setReadingDoc(null); setRetrySelection(null);
    if (!material) { setLoading(false); return; }
    setLoading(true);
    try {
      const next = await readingService.document(course.id, material.id);
      if (version === requestVersion.current) setReadingDoc(next);
    } catch (e) {
      if (version === requestVersion.current) setError(e instanceof Error ? e.message : '资料正文加载失败，请重试。');
    } finally { if (version === requestVersion.current) setLoading(false); }
  }, [course.id, material?.id, course.revision]);

  useEffect(() => { void loadDocument(); return () => { requestVersion.current++;controller.current?.abort(); }; }, [loadDocument]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function captureSelection() {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) { setToolbar(null); return; }
      const range = selection.getRangeAt(0);
      if (!articleRef.current?.contains(range.startContainer) || !articleRef.current.contains(range.endContainer)) { setToolbar(null); return; }
      const text = selection.toString().trim();
      if (!text) { setToolbar(null); return; }
      const rect = range.getBoundingClientRect();
      if (rect.bottom < 60 || rect.top > window.innerHeight) { setToolbar(null); return; }
      const x = Math.max(12, Math.min(rect.left + rect.width / 2 - 108, window.innerWidth - 228));
      const y = Math.max(66, Math.min(rect.top >= 120 ? rect.top - 49 : rect.bottom + 10, window.innerHeight - 58));
      setToolbar({ text, x, y });
    }
    function changed() { clearTimeout(timer); timer = setTimeout(captureSelection, 100); }
    function pointer(e: PointerEvent) { if (!toolsRef.current?.contains(e.target as Node)) changed(); }
    function dismiss() { clearTimeout(timer); setToolbar(null); }
    function key(e: KeyboardEvent) { if (e.key === 'Escape') dismiss(); }
    document.addEventListener('selectionchange', changed);
    document.addEventListener('pointerup', pointer);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => { clearTimeout(timer); document.removeEventListener('selectionchange', changed); document.removeEventListener('pointerup', pointer); document.removeEventListener('keydown', key); window.removeEventListener('scroll', dismiss, true); window.removeEventListener('resize', dismiss); };
  }, []);

  function locate(match:ReadingAssistance['matches'][number]) {
    jumpTarget.current=match.sourceId;
    if(match.materialId&&match.materialId!==material?.id)setSelectedId(match.materialId);
    else {articleRef.current?.querySelector<HTMLElement>(`[data-source-id="${CSS.escape(match.sourceId)}"]`)?.scrollIntoView({behavior:'smooth',block:'center'});setHighlight(match.sourceId);jumpTarget.current=null;}
  }
  useEffect(()=>{if(readingDoc&&jumpTarget.current){const id=jumpTarget.current;articleRef.current?.querySelector<HTMLElement>(`[data-source-id="${CSS.escape(id)}"]`)?.scrollIntoView({behavior:'smooth',block:'center'});setHighlight(id);jumpTarget.current=null;}},[readingDoc]);

  async function assist(mode: 'explain' | 'search', text = toolbar?.text) {
    if (!text || !readingDoc) return;
    onExpandAssistant();
    const version = ++requestVersion.current;
    setToolbar(null); setResult(null); setError(''); setWaitingNote(''); setRetrySelection(null); setPending({ text, mode });
    try {
      controller.current?.abort();controller.current=new AbortController();
      const answer = await readingService.assist(readingDoc, text, mode,controller.current.signal,{onWaiting:message=>{if(version===requestVersion.current)setWaitingNote(message);}});
      if (version === requestVersion.current) { setResult(answer); onActivity(); }
    } catch (e) { if (version === requestVersion.current) { setError(e instanceof Error?e.message:'阅读助手未完成，请重试。'); setRetrySelection({ text, mode }); } }
    finally { if (version === requestVersion.current) setPending(null); }
  }

  return <div className={`reader-layout ${assistantOpen ? 'assistant-open' : 'assistant-collapsed'}`}><section className="reader-document-column" aria-label="资料阅读区"><div className="reader-toolbar"><div><FileText size={16} /><Dropdown label="选择阅读资料" value={material?.id ?? ''} onChange={value => { window.getSelection()?.removeAllRanges(); setSelectedId(value); }} disabled={!course.materials.length} placeholder="暂无资料" options={course.materials.map(m => ({ value: m.id, label: m.name, description: m.name.toLowerCase().endsWith('.pdf') ? 'PDF 学习资料' : '文本学习资料' }))} /></div><button className="button small" onClick={onUpload}><Plus size={14} /><span>添加资料</span></button>{readingDoc?.previewUrl&&<MaterialPreview url={readingDoc.previewUrl} name={readingDoc.name} version={readingDoc.revision??'unpublished'}/>} {!assistantOpen && <button className="icon-button reader-mobile-expand" aria-label="展开阅读助手" onClick={onToggleAssistant}><PanelRightOpen size={18} /></button>}</div><div className="reader-scroll"><div className="reading-intro"><span className="blue-eyebrow"><BookOpen size={14} />辅助阅读</span><p>选中不理解的文字，让思路在这里展开。</p></div>
      {loading ? <div className="reader-empty" role="status"><LoaderCircle className="spin" size={25} /><p>正在打开资料…</p></div> : readingDoc?.content ? <article className="reading-paper" ref={articleRef} aria-label="资料正文"><header className="paper-meta"><span>{course.name}</span><span>{'已发布正文'}</span></header>{readingDoc.sources.map(source=><div data-source-id={source.id} className={highlight===source.id?'reading-source highlighted':'reading-source'} key={source.id}>{source.kind==='heading'?<h2>{source.text.replace(/^#+\s*/, '')}</h2>:<SourceBody text={source.text} kind={source.kind}/>}</div>)}<footer className="paper-end"><span />读到这里，不妨用自己的话再说一遍。<span /></footer></article> : <div className="reader-empty"><FileText size={35} /><h2>{!material ? '添加一份资料，开始阅读' : readingDoc?.source === 'unavailable' ? '这份资料还没有可阅读的正文' : '这份资料的正文为空'}</h2><p>{!material ? '你可以添加 TXT、Markdown，或文本 PDF。' : material.name.toLowerCase().endsWith('.pdf') ? '请先在资料面板检查文件并初始化课程。' : '资料初始化后可读取已发布的版本。'}</p><button className="button" onClick={onUpload}><Plus size={15} />添加资料</button></div>}
      {error && <div className="reading-error" role="alert">{error}{retrySelection&&<button className="text-button" onClick={()=>void assist(retrySelection.mode,retrySelection.text)}>重试阅读任务</button>}<button className="text-button" onClick={() => void loadDocument()}>重新打开资料</button></div>}
    </div><footer className="reader-bottom-hint"><MousePointer2 size={13} />选中文字，即可使用 AI解释、AI搜索</footer></section>
    {assistantOpen ? <aside className={`reader-assistant is-open ${pending || result ? 'has-answer' : ''}`} aria-label="阅读助手"><header><span><Sparkles size={16} />阅读助手</span><button className="icon-button" aria-label="收起阅读助手" title="收起阅读助手" onClick={onToggleAssistant}><X size={17} /></button></header><div className="reading-assistant-content">{!result && !pending ? <div className="reading-assistant-empty"><span><MousePointer2 size={25} /></span><h3>从一个疑问开始</h3><p>在正文中选中一个概念或一段话，选择你需要的帮助。</p><div><Sparkles size={16} /><span><strong>AI解释</strong><small>换一种方式理解选中的内容</small></span></div><div><Search size={16} /><span><strong>AI搜索</strong><small>找到资料中相关的段落</small></span></div></div> : <><span className="reading-result-label">{(pending?.mode ?? result?.mode) === 'explain' ? 'AI解释' : 'AI搜索'}<small>课程资料</small></span><blockquote className="reading-quote"><Quote size={15} /><p>{pending?.text ?? result?.selection}</p></blockquote>{pending ? <div className="reading-pending" role="status"><LoaderCircle size={16} className="spin" />{waitingNote || (pending.mode === 'explain' ? '正在准备解释…' : '正在查找相关段落…')}<button className="text-button" onClick={()=>controller.current?.abort()}>取消阅读任务</button></div> : result?.mode === 'explain' ? <div className="reading-explanation"><ReactMarkdown components={{img:()=>null}}>{result.explanation}</ReactMarkdown>{result.matches.map(match=><button className="text-button" key={match.sourceId} onClick={()=>onSource(match.sourceId)}>来源：{match.title}</button>)}</div> : <div className="reading-search-results"><ReactMarkdown components={{img:()=>null}}>{result?.explanation??''}</ReactMarkdown><p>在课程资料中找到 {result?.matches.length ?? 0} 个相关段落</p>{result?.matches.map((match, i) => <article key={i} id={match.sourceId}><button className="text-button" onClick={()=>onSource(match.sourceId)}>查看资料来源</button><button className="text-button" onClick={()=>locate(match)}>定位段落</button><h3>{match.title}<ArrowUpRight size={13} /></h3><p>{match.excerpt}</p></article>)}</div>}</> }</div><footer>回答基于当前课程资料；点击来源可核对原文。</footer></aside> : <aside className="panel-rail reader-rail" aria-label="阅读助手已收起"><button className="icon-button" aria-label="展开阅读助手" onClick={onToggleAssistant}><PanelRightOpen size={18} /></button></aside>}
    {toolbar && createPortal(<div ref={toolsRef} className="selection-tools" role="toolbar" aria-label="选中文字操作" style={{ left: toolbar.x, top: toolbar.y }} onPointerDown={e => e.preventDefault()}><button onClick={() => void assist('explain')}><Sparkles size={15} />AI解释</button><span /><button onClick={() => void assist('search')}><Search size={15} />AI搜索</button></div>, document.body)}
  </div>;
}
