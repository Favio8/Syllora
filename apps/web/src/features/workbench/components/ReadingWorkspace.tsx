'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Sparkles, Search, Plus, MousePointer2, X, LoaderCircle, Quote, ArrowUpRight, PanelRightOpen, Upload, ListTree, NotebookPen, ClipboardCheck, GraduationCap, LayoutTemplate } from 'lucide-react';
import Dropdown from './Dropdown';
import ReactMarkdown from 'react-markdown';
import { MARKDOWN_REHYPE_PLUGINS, MARKDOWN_REMARK_PLUGINS, normalizeMathDelimiters } from '@/src/lib/markdownPlugins';
import { MaterialPreview } from '../../../components/syllora-project-ui';
import type { Course, ReadingAssistance, ReadingDocument } from '@/src/features/workbench/types';
import { readingService } from '@/src/features/workbench/services';
import { api, materialDocumentUrl } from '@/src/lib/api';
import { remarkSoftBreaks, splitFence } from '@/src/features/workbench/reading-format';

/**
 * B11：按后端给出的 `kind` 分支渲染正文。
 * 旧实现对所有非 heading 源统一走 ReactMarkdown（无 remark-breaks），
 * Markdown 会把段内软换行折叠成空格，代码块/表格/列表/多行段落全部 run-on。
 *  - code → `<pre><code>` 原样，保留换行与缩进；
 *  - table → GFM（表格按行解析，不受折叠影响）；
 *  - list / paragraph → 追加软换行提升（软换行按硬换行渲染）；
 *  - heading → h2（保持现状，由外层渲染）。
 * 本地增量：每个分支都并入本项目的公式渲染插件（remark-math + rehype-katex
 * 与 `normalizeMathDelimiters`），否则资料里的公式会退化成原文。
 * XSS 口径不变：仍然 `skipHtml`、不引 rehype-raw，markdown 里的事件属性照旧被过滤。
 */
const READING_REMARK_PLUGINS = [...(MARKDOWN_REMARK_PLUGINS ?? []), remarkSoftBreaks];

function SourceBody({ text, kind }: { text: string; kind?: string }) {
  if (kind === 'code') {
    const { language, code } = splitFence(text);
    return <pre className="reading-code"><code className={language ? `language-${language}` : undefined}>{code}</code></pre>;
  }
  if (kind === 'table') return <ReactMarkdown skipHtml remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={MARKDOWN_REHYPE_PLUGINS} components={{ img: () => null }}>{normalizeMathDelimiters(text)}</ReactMarkdown>;
  return <ReactMarkdown skipHtml remarkPlugins={READING_REMARK_PLUGINS} rehypePlugins={MARKDOWN_REHYPE_PLUGINS} components={{ img: () => null }}>{normalizeMathDelimiters(text)}</ReactMarkdown>;
}

const MARK_ORDER: Array<'mastered' | 'learning' | 'weak' | null> = [null, 'mastered', 'learning', 'weak'];
const MARK_LABEL: Record<string, string> = { mastered: '已掌握', learning: '学习中', weak: '薄弱' };

/**
 * 辅助阅读（统一成「资料」一种来源）。
 *
 * 上传的资料统一由 DocMind 解析（见 syllora-extract.ts）：正文与引证仍走**来源片段**
 * （页码锚点、字符区间、失败页全部沿用老口径），DocMind 的 markdown 作为「版式视图」
 * 与章节大纲（`document.outline`）的来源。章节大纲 / 阅读标记 / 章节回顾 / 自测外壳
 * 都挂在当前资料上，标记只做自评、不计学习证据。
 */
export default function ReadingWorkspace({ course, onUpload, assistantOpen, onToggleAssistant, onExpandAssistant, onActivity, onSource }: { course: Course; onUpload: () => void; assistantOpen: boolean; onToggleAssistant: () => void; onExpandAssistant: () => void; onActivity: () => void;onSource:(id:string)=>void }) {
  const [selectedId, setSelectedId] = useState(course.materials[0]?.id ?? '');
  const material = course.materials.find(m => m.id === selectedId) ?? course.materials[0];
  const [readingDoc, setReadingDoc] = useState<ReadingDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  /** B5：等待超过 60 秒时的提示（不自动重复提交，只说明仍在查询原任务）。 */
  const [waitingNote, setWaitingNote] = useState('');
  const [retrySelection, setRetrySelection] = useState<{ text: string; mode: 'explain' | 'search'; sourceIds?:string[] } | null>(null);
  const [toolbar, setToolbar] = useState<{ text: string; x: number; y: number; sourceIds:string[] } | null>(null);
  const [result, setResult] = useState<ReadingAssistance | null>(null);
  const [pending, setPending] = useState<{ text: string; mode: 'explain' | 'search' } | null>(null);
  /** 需求六：AI 直答（不参考知识库、不标注来源）的提示词草稿与流式回答状态。 */
  const [askDraft, setAskDraft] = useState('');
  const [ask, setAsk] = useState<{ prompt: string; selection: string; text: string; streaming: boolean; cancelled: boolean; error: string } | null>(null);
  const jumpTarget=useRef<string|null>(null);
  const [highlight,setHighlight]=useState('');
  const articleRef = useRef<HTMLElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const requestVersion = useRef(0);
  const controller=useRef<AbortController|null>(null);
  // 章节大纲 / 阅读标记 / 回顾 / 自测（统一挂在当前资料上；标记是自评，不进证据）。
  const [showOutline, setShowOutline] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [examOpen, setExamOpen] = useState(false);
  const [examDone, setExamDone] = useState(false);
  const [marks, setMarks] = useState<Record<string, 'mastered' | 'learning' | 'weak'>>({});
  // 版式视图：渲染 DocMind 的 markdown（表格/公式/图片）。正文与引证以来源片段为准，
  // 这个视图只用于阅读，所以在这里禁用「选中提问」（两套文本对不上会误判选区）。
  const [layoutView, setLayoutView] = useState(false);
  const [layoutText, setLayoutText] = useState<string | null>(null);
  const [layoutError, setLayoutError] = useState('');

  const loadDocument = useCallback(async () => {
    controller.current?.abort();
    const version = ++requestVersion.current;
    setToolbar(null); setResult(null); setPending(null);setHighlight(''); setError(''); setWaitingNote(''); setReadingDoc(null); setRetrySelection(null); setAsk(null);
    setLayoutView(false); setLayoutText(null); setLayoutError('');
    if (!material) { setLoading(false); return; }
    setLoading(true);
    try {
      const next = await readingService.document(course.id, material.id);
      if (version === requestVersion.current) { setReadingDoc(next); setMarks(next.marks ?? {}); }
    } catch (e) {
      if (version === requestVersion.current) setError(e instanceof Error ? e.message : '资料正文加载失败，请重试。');
    } finally { if (version === requestVersion.current) setLoading(false); }
  }, [course.id, material?.id, course.revision]);

  useEffect(() => { void loadDocument(); return () => { requestVersion.current++;controller.current?.abort(); }; }, [loadDocument]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function captureSelection() {
      // 需求六：工具栏内的提示词输入框获得焦点会让页面选区塌缩，此时不能关闭
      // 工具栏——否则用户刚点进输入框，工具条就消失了。
      if (toolsRef.current?.contains(document.activeElement)) return;
      // 版式视图的文本不是引证口径的正文，选中提问在这里会误判选区，直接不弹工具条。
      if (layoutView) { setToolbar(null); return; }
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) { setToolbar(null); return; }
      const range = selection.getRangeAt(0);
      const host = articleRef.current;
      if (!host?.contains(range.startContainer) || !host.contains(range.endContainer)) { setToolbar(null); return; }
      const text = selection.toString().trim();
      if (!text) { setToolbar(null); return; }
      const rect = range.getBoundingClientRect();
      if (rect.bottom < 60 || rect.top > window.innerHeight) { setToolbar(null); return; }
      const x = Math.max(12, Math.min(rect.left + rect.width / 2 - 108, window.innerWidth - 228));
      const y = Math.max(66, Math.min(rect.top >= 120 ? rect.top - 49 : rect.bottom + 10, window.innerHeight - 58));
      const sourceIds = Array.from(host.querySelectorAll<HTMLElement>('[data-source-id]')).filter(node => range.intersectsNode(node)).map(node => node.dataset.sourceId!).filter(Boolean);
      setToolbar({ text, x, y, sourceIds });
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
  }, [layoutView]);

  function locate(match:ReadingAssistance['matches'][number]) {
    jumpTarget.current=match.sourceId;
    if(match.materialId&&match.materialId!==material?.id)setSelectedId(match.materialId);
    else {articleRef.current?.querySelector<HTMLElement>(`[data-source-id="${CSS.escape(match.sourceId)}"]`)?.scrollIntoView({behavior:'smooth',block:'center'});setHighlight(match.sourceId);jumpTarget.current=null;}
  }
  useEffect(()=>{if(readingDoc&&jumpTarget.current){const id=jumpTarget.current;articleRef.current?.querySelector<HTMLElement>(`[data-source-id="${CSS.escape(id)}"]`)?.scrollIntoView({behavior:'smooth',block:'center'});setHighlight(id);jumpTarget.current=null;}},[readingDoc]);

  async function assist(assistMode: 'explain' | 'search', text = toolbar?.text, sourceIds = toolbar?.sourceIds) {
    if (!text || !readingDoc) return;
    onExpandAssistant();
    const version = ++requestVersion.current;
    setToolbar(null); setResult(null); setError(''); setWaitingNote(''); setRetrySelection(null); setPending({ text, mode: assistMode }); setAsk(null);
    try {
      controller.current?.abort();controller.current=new AbortController();
      const answer = await readingService.assist(readingDoc, text, assistMode,controller.current.signal,{...(sourceIds?.length?{sourceIds}:{}),onWaiting:message=>{if(version===requestVersion.current)setWaitingNote(message);}});
      if (version === requestVersion.current) { setResult(answer); onActivity(); }
    } catch (e) { if (version === requestVersion.current) { setError(e instanceof Error?e.message:'阅读助手未完成，请重试。'); setRetrySelection({ text, mode: assistMode, sourceIds }); } }
    finally { if (version === requestVersion.current) setPending(null); }
  }

  /** 需求六：选中文字 + 自定义提示词的流式直答。不走知识库检索、不落任何记录，
   *  回答里也不给来源；失败时保留提示词与选区，就地重试。 */
  async function runAsk(prompt: string, selection: string) {
    const question = prompt.trim();
    if (question === '' || !readingDoc) return;
    onExpandAssistant();
    const version = ++requestVersion.current;
    setToolbar(null); setResult(null); setPending(null); setError(''); setWaitingNote(''); setRetrySelection(null); setAskDraft('');
    setAsk({ prompt: question, selection, text: '', streaming: true, cancelled: false, error: '' });
    try {
      controller.current?.abort();controller.current=new AbortController();
      const answer = await readingService.ask(readingDoc, selection, question, controller.current.signal, { onDelta: delta => { if (version === requestVersion.current) setAsk(current => current === null ? current : { ...current, text: current.text + delta }); } });
      if (version === requestVersion.current) { setAsk(current => current === null ? current : { ...current, text: answer.text, streaming: false }); onActivity(); }
    } catch (e) {
      if (version !== requestVersion.current) return;
      // 用户点「取消直答」时信号已中止：保留半截回答、只标记已取消，不算错误。
      const cancelled = controller.current?.signal.aborted === true;
      setAsk(current => current === null ? current : { ...current, streaming: false, cancelled, error: cancelled ? '' : (e instanceof Error ? e.message : 'AI 直答未完成，请重试。') });
    }
  }

  /** 打开版式视图：按需拉取该资料的 DocMind markdown（整本教材一次请求，只在打开时取）。 */
  async function openLayout() {
    if (!material || layoutText !== null) { setLayoutView(true); return; }
    setLayoutError(''); setLayoutView(true);
    try {
      const token = (window as unknown as { __SYLLORA__?: { token?: string } }).__SYLLORA__?.token;
      const response = await fetch(materialDocumentUrl(course.id, material.id), { credentials: 'same-origin', ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) });
      if (!response.ok) throw new Error(`版式正文读取失败（HTTP ${response.status}）`);
      setLayoutText(await response.text());
    } catch (e) { setLayoutError(e instanceof Error ? e.message : '版式正文读取失败'); }
  }

  const layoutComponents = useMemo(() => ({
    // 解析产物里的图片已本地化（images/xxx.png）：改写成受控路由，markdown 里不留过期链接。
    img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => <img {...props} alt={props.alt ?? ''} src={typeof props.src === 'string' && props.src.startsWith('images/') && material ? materialDocumentUrl(course.id, material.id, props.src) : props.src} />,
  }), [course.id, material?.id]);

  const outline = readingDoc?.document?.outline ?? [];

  /** 章节跳转：PDF 节点带页码 → 定位该页来源；否则按 section 命中的第一个来源。 */
  function focusChapter(node: { title: string; page: number | null }) {
    const target = node.page !== null
      ? readingDoc?.sources.find(source => source.anchor.startsWith(`第 ${node.page} 页`))
      : readingDoc?.sources.find(source => (source.section ?? '') === node.title);
    if (target) { articleRef.current?.querySelector<HTMLElement>(`[data-source-id="${CSS.escape(target.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); setHighlight(target.id); }
  }

  /**
   * 阅读接触提示（自动推测）：按 AI 答疑引用次数统计章节接触，≥3 次＝绿、1-2 次＝黄。
   * 这只是阅读接触启发，不是复习证据：未引用不代表薄弱，引用多也不等于复测通过。手工标记优先。
   */
  const autoMarks = useMemo(() => {
    const counts = new Map<string, number>();
    for (const message of course.messages ?? []) {
      if (!message.reading || !('materialId' in message.reading) || message.reading.materialId !== material?.id) continue;
      for (const sid of message.sourceIds ?? []) counts.set(sid, (counts.get(sid) ?? 0) + 1);
    }
    const bySection = new Map<string, number>();
    for (const source of readingDoc?.sources ?? []) {
      const n = counts.get(source.id) ?? 0;
      if (n > 0 && source.section) bySection.set(source.section, (bySection.get(source.section) ?? 0) + n);
    }
    const out: Record<string, 'mastered' | 'learning' | 'weak'> = {};
    for (const node of outline) {
      const n = bySection.get(node.title) ?? 0;
      if (n >= 3) out[node.anchor] = 'mastered';
      else if (n >= 1) out[node.anchor] = 'learning';
    }
    return out;
  }, [course.messages, readingDoc, material?.id, outline]);

  /** 章节回顾：每个章节取首段正文摘录（不是 AI 总结）。 */
  const reviewSections = useMemo(() => outline.map(node => {
    const first = (readingDoc?.sources ?? []).find(source => (source.section ?? '') === node.title || (node.page !== null && source.anchor.startsWith(`第 ${node.page} 页`)));
    const excerpt = (first?.text ?? '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/<!--[^>]*-->/g, '').replace(/\s+/g, ' ').trim();
    return { anchor: node.anchor, title: node.title, excerpt: excerpt.slice(0, 90) };
  }), [outline, readingDoc]);

  /** 章节阅读标记循环 未标记→已掌握→学习中→薄弱→未标记；保存失败回读原值。 */
  const cycleChapterStatus = useCallback(async (anchor: string) => {
    if (!material) return;
    const current = marks[anchor] ?? null;
    const next = MARK_ORDER[(MARK_ORDER.indexOf(current) + 1) % MARK_ORDER.length] ?? null;
    const optimistic = { ...marks };
    if (next === null) delete optimistic[anchor]; else optimistic[anchor] = next;
    setMarks(optimistic);
    try {
      const saved = await api.readingSetMark(course.id, material.id, anchor, next);
      setMarks(saved.marks ?? optimistic);
    } catch (e) {
      setError(e instanceof Error ? e.message : '阅读标记保存失败，请重试。');
      setMarks(marks);
    }
  }, [marks, course.id, material?.id]);

  /** 直答进行中时禁用再次发送（解释/搜索仍可发起，会先清掉直答视图）。 */
  const askBusy = ask?.streaming === true || pending !== null;

  return <div className={`reader-layout ${assistantOpen ? 'assistant-open' : 'assistant-collapsed'}`}><section className="reader-document-column" aria-label="资料阅读区"><div className="reader-toolbar"><div><FileText size={16} /><Dropdown label="选择阅读资料" value={material?.id ?? ''} onChange={value => { window.getSelection()?.removeAllRanges(); setSelectedId(value); }} disabled={!course.materials.length} placeholder="暂无资料" options={course.materials.map(m => ({ value: m.id, label: m.name, description: m.engine === 'docmind' ? 'DocMind 解析' : '本地解析' }))} /></div><button className="button small" onClick={onUpload}><Plus size={14} /><span>上传资料</span></button>{outline.length > 0 && <><button className="button small" onClick={() => setShowOutline(v => !v)} title="章节大纲与阅读标记"><ListTree size={14} /><span>{showOutline ? '收起大纲' : '大纲'}</span></button><button className="button small" onClick={() => setShowReview(v => !v)} title="章节回顾（每章首段摘录）"><NotebookPen size={14} /><span>{showReview ? '收起回顾' : '回顾'}</span></button><button className="button small" onClick={() => { setExamDone(false); setExamOpen(true); }} title="章节自测（演示外壳，不计成绩）"><ClipboardCheck size={14} /><span>自测</span></button></>}{readingDoc?.document?.hasMarkdown && <button className={`button small ${layoutView ? 'primary' : ''}`} onClick={() => { if (layoutView) { setLayoutView(false); return; } void openLayout(); }} title={layoutView ? '回到按资料片段渲染的正文' : '用 DocMind 解析的版式正文阅读（表格/公式/图片）'}><LayoutTemplate size={14} /><span>{layoutView ? '回到正文' : '版式视图'}</span></button>}{readingDoc?.previewUrl&&<MaterialPreview url={readingDoc.previewUrl} name={readingDoc.name} version={readingDoc.revision??'unpublished'}/>} {!assistantOpen && <button className="icon-button reader-mobile-expand" aria-label="展开阅读助手" onClick={onToggleAssistant}><PanelRightOpen size={18} /></button>}</div><div className={`reader-scroll ${!readingDoc?.content && !layoutText ? 'reader-empty-scroll' : ''}`}>
      {layoutView ? (layoutError ? <div className="reading-error" role="alert">{layoutError}</div> : layoutText === null ? <div className="reader-empty" role="status"><LoaderCircle className="spin" size={25} /><p>正在读取版式正文…</p></div> : <article className="reading-paper" aria-label="资料版式正文" data-layout-view=""><header className="paper-meta"><span>{course.name}</span><span>{material?.name}</span><span>DocMind 版式</span></header><p className="reading-layout-note">版式视图按 DocMind 解析结果渲染（含表格、公式与图片）；引用与提问请在「回到正文」中使用来源片段。</p><ReactMarkdown skipHtml remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={MARKDOWN_REHYPE_PLUGINS} components={layoutComponents}>{normalizeMathDelimiters(layoutText)}</ReactMarkdown></article>) : (loading ? <div className="reader-empty" role="status"><LoaderCircle className="spin" size={25} /><p>正在打开资料…</p></div> : readingDoc?.content ? <>
        {showOutline && <div className="reader-outline-panel" aria-label="章节大纲"><header><span><ListTree size={13} />大纲 · 点击圆点切换阅读标记（自评，不计入复习证据）</span><button className="text-button" onClick={() => setShowOutline(false)}>收起</button></header><ol className="reader-outline-list">{outline.map(node => { const manual = marks[node.anchor] ?? null; const status = manual ?? autoMarks[node.anchor] ?? null; const auto = status !== null && manual === null; const statusTitle = (status === null ? '未标记' : MARK_LABEL[status]) + (auto ? '（阅读接触推测）' : ''); return <li key={node.anchor} style={{ paddingLeft: `${18 + (node.level - 1) * 14}px` }}><button type="button" className={`outline-status-dot ${status ?? ''}`} title={`${statusTitle}（点击可手工切换）`} aria-label={`${node.title}：${statusTitle}`} onClick={() => void cycleChapterStatus(node.anchor)} /><button type="button" className="outline-chapter-title" title={`跳到「${node.title}」`} onClick={() => focusChapter(node)}>{node.title}</button></li>; })}</ol></div>}
        {showReview && <div className="reader-review-panel" aria-label="章节回顾"><header><span><NotebookPen size={13} />章节回顾 · 每章首段摘录</span><button className="text-button" onClick={() => setShowReview(false)}>收起</button></header><ol className="reader-review-list">{reviewSections.map(item => <li key={item.anchor}><button type="button" onClick={() => focusChapter(outline.find(node => node.anchor === item.anchor) ?? { title: item.title, page: null })}><span className={`outline-status-dot ${marks[item.anchor] ?? autoMarks[item.anchor] ?? ''}`} /><div><h4>{item.title}</h4><p>{item.excerpt || '（本章暂无正文摘录）'}</p></div></button></li>)}</ol></div>}
        <article className="reading-paper" ref={articleRef} aria-label="资料正文"><header className="paper-meta"><span>{course.name}</span><span>{readingDoc.engine === 'docmind' ? 'DocMind 解析 · 已发布正文' : '已发布正文'}</span><span>{readingDoc.sources.length} 个片段</span></header>{readingDoc.sources.map(source=><div data-source-id={source.id} className={highlight===source.id?'reading-source highlighted':'reading-source'} key={source.id}>{source.kind==='heading'?<h2>{source.text.replace(/^#+\s*/, '')}</h2>:<SourceBody text={source.text} kind={source.kind}/>}</div>)}</article>
      </> : <div className="reader-empty"><FileText size={35} /><h2>{!material ? '添加一份资料，开始阅读' : readingDoc?.source === 'unavailable' ? '这份资料还没有可阅读的正文' : '这份资料的正文为空'}</h2><p>{!material ? '支持 PDF、Word、PPT、Excel、HTML、Markdown、TXT；解析由 DocMind 完成（原件会上传到云端）。' : '请先在资料面板检查文件并初始化课程；资料初始化后可读取已发布的版本。'}</p><button className="button" onClick={onUpload}><Plus size={15} />添加资料</button></div>)}
      {error && <div className="reading-error" role="alert">{error}{retrySelection&&<button className="text-button" onClick={()=>void assist(retrySelection.mode,retrySelection.text,retrySelection.sourceIds)}>重试阅读任务</button>}<button className="text-button" onClick={() => void loadDocument()}>重新打开资料</button></div>}
    </div></section>
    {assistantOpen ? <aside className={`reader-assistant is-open ${ask || pending || result ? 'has-answer' : ''}`} aria-label="阅读助手"><header><span><Sparkles size={16} />阅读助手</span><button className="icon-button" aria-label="收起阅读助手" title="收起阅读助手" onClick={onToggleAssistant}><X size={17} /></button></header><div className="reading-assistant-content">{!ask && !result && !pending ? <div className="reading-assistant-empty"><span><MousePointer2 size={25} /></span><div><Sparkles size={16} /><span><strong>AI解释</strong><small>换一种方式理解选中的内容</small></span></div><div><Search size={16} /><span><strong>AI搜索</strong><small>找到资料中相关的段落</small></span></div></div> : ask ? <><span className="reading-result-label">AI 直答<small>不引用课程资料</small></span>{ask.selection !== '' && <blockquote className="reading-quote"><Quote size={15} /><p>{ask.selection}</p></blockquote>}{ask.error !== '' ? <div className="reading-error" role="alert">{ask.error}<button className="text-button" onClick={() => void runAsk(ask.prompt, ask.selection)}>重试直答</button></div> : <div className="reading-explanation"><ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={MARKDOWN_REHYPE_PLUGINS} components={{img:()=>null}}>{normalizeMathDelimiters(ask.text)}</ReactMarkdown></div>}{ask.streaming ? <div className="reading-pending" role="status"><LoaderCircle size={16} className="spin" />正在生成…<button className="text-button" onClick={() => controller.current?.abort()}>取消直答</button></div> : ask.error === '' && <div className="reading-pending">{ask.cancelled ? '已取消生成。' : '内容由模型自身知识生成，未参考课程资料。'}<button className="text-button" onClick={() => void runAsk(ask.prompt, ask.selection)}>重试直答</button></div>}</> : <><span className="reading-result-label">{(pending?.mode ?? result?.mode) === 'explain' ? 'AI解释' : 'AI搜索'}<small>课程资料</small></span><blockquote className="reading-quote"><Quote size={15} /><p>{pending?.text ?? result?.selection}</p></blockquote>{pending ? <div className="reading-pending" role="status"><LoaderCircle size={16} className="spin" />{waitingNote || (pending.mode === 'explain' ? '正在准备解释…' : '正在查找相关段落…')}<button className="text-button" onClick={()=>controller.current?.abort()}>取消阅读任务</button></div> : result?.mode === 'explain' ? <div className="reading-explanation"><ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={MARKDOWN_REHYPE_PLUGINS} components={{img:()=>null}}>{normalizeMathDelimiters(result.explanation)}</ReactMarkdown>{result.matches.map(match=><button className="text-button" key={match.sourceId} onClick={()=>locate(match)}>来源：{match.title}</button>)}</div> : <div className="reading-search-results"><ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={MARKDOWN_REHYPE_PLUGINS} components={{img:()=>null}}>{normalizeMathDelimiters(result?.explanation??'')}</ReactMarkdown><p>在课程资料中找到 {result?.matches.length ?? 0} 个相关段落</p>{result?.matches.map((match, i) => <article key={i} id={match.sourceId}><button className="text-button" onClick={()=>onSource(match.sourceId)}>查看资料来源</button><button className="text-button" onClick={()=>locate(match)}>定位段落</button><h3>{match.title}<ArrowUpRight size={13} /></h3><p>{match.excerpt}</p></article>)}</div>}</> }</div></aside> : <aside className="panel-rail reader-rail" aria-label="阅读助手已收起"><button className="icon-button" aria-label="展开阅读助手" onClick={onToggleAssistant}><PanelRightOpen size={18} /></button></aside>}
    {toolbar && createPortal(<div ref={toolsRef} className="selection-tools" role="toolbar" aria-label="选中文字操作" style={{ left: toolbar.x, top: toolbar.y }} onPointerDown={e => e.preventDefault()}><div className="selection-tools-row"><button onClick={() => void assist('explain')}><Sparkles size={15} />AI解释</button><span /><button onClick={() => void assist('search')}><Search size={15} />AI搜索</button></div><div className="selection-ask" onPointerDown={e => e.stopPropagation()}><input value={askDraft} onChange={e => setAskDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void runAsk(askDraft, toolbar.text); } }} placeholder="输入提示词，例如：用生活中的例子解释这段话" aria-label="自定义提示词" disabled={askBusy} /><button type="button" onClick={() => void runAsk(askDraft, toolbar.text)} disabled={askBusy || askDraft.trim() === ''}>发送</button></div></div>, document.body)}
    {examOpen && <div className="exam-modal" role="dialog" aria-modal="true" aria-label="章节自测"><div className="exam-modal-card"><header><span><GraduationCap size={17} />章节自测<small>演示外壳 · 不评分、不计入学习证据</small></span><button className="icon-button" aria-label="关闭章节自测" onClick={() => setExamOpen(false)}><X size={16} /></button></header><div className="exam-modal-body">{examDone ? <div className="exam-done"><h3>已交卷</h3><p>这是界面演示：没有生成成绩，也不会改变知识点状态。需要验证理解时，请使用课程计划里的独立练习与复测。</p><button className="button primary" onClick={() => { setExamDone(false); setExamOpen(false); }}>完成</button></div> : <><p className="exam-note">以下为示例题位（取自大纲前 3 节），仅用于预览自测界面。</p>{outline.slice(0, 3).map((node, index) => <fieldset className="exam-question" key={node.anchor}><legend>第 {index + 1} 题 · 关于「{node.title}」<small>（示例）</small></legend>{['A', 'B', 'C', 'D'].map(option => <label key={option}><input type="radio" name={`exam-q${index}`} />选项 {option} 示例</label>)}</fieldset>)}<button className="button primary" onClick={() => setExamDone(true)}>交卷</button></>}</div></div></div>}
  </div>;
}