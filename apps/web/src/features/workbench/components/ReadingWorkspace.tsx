'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, FileText, Sparkles, Search, Plus, MousePointer2, X, LoaderCircle, Quote, ArrowUpRight, PanelRightOpen, Upload, ListTree, NotebookPen, ClipboardCheck, GraduationCap } from 'lucide-react';
import Dropdown from './Dropdown';
import ReactMarkdown from 'react-markdown';
import { MARKDOWN_REHYPE_PLUGINS, MARKDOWN_REMARK_PLUGINS } from '@/src/lib/markdownPlugins';
import { MaterialPreview } from '../../../components/syllora-project-ui';
import type { Course, ReadingAssistance, ReadingDocument } from '@/src/features/workbench/types';
import { ebookService, readingService, chunkEbookMarkdown, type EbookDocument, type EbookNodeStatus, type EbookSummary } from '@/src/features/workbench/services';

export default function ReadingWorkspace({ course, onUpload, assistantOpen, onToggleAssistant, onExpandAssistant, onActivity, onSource }: { course: Course; onUpload: () => void; assistantOpen: boolean; onToggleAssistant: () => void; onExpandAssistant: () => void; onActivity: () => void;onSource:(id:string)=>void }) {
  const [selectedId, setSelectedId] = useState(course.materials[0]?.id ?? '');
  const material = course.materials.find(m => m.id === selectedId) ?? course.materials[0];
  const [readingDoc, setReadingDoc] = useState<ReadingDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [toolbar, setToolbar] = useState<{ text: string; x: number; y: number } | null>(null);
  const [result, setResult] = useState<ReadingAssistance | null>(null);
  const [pending, setPending] = useState<{ text: string; mode: 'explain' | 'search' } | null>(null);
  const jumpTarget=useRef<string|null>(null);
  const [highlight,setHighlight]=useState('');
  const articleRef = useRef<HTMLElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const requestVersion = useRef(0);
  const controller=useRef<AbortController|null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const feedController = useRef<AbortController | null>(null);
  const feedVersion = useRef(0);
  const [feeding, setFeeding] = useState<{ requestId: string; jobId: string; message: string } | null>(null);
  const [feedNotice, setFeedNotice] = useState('');
  // 资料 ↔ 电子书 来源切换；电子书阅读 = 精炼 markdown +
  // 目录骨架章节下拉 + 本地化图片渲染。
  const [mode, setMode] = useState<'material' | 'ebook'>('material');
  const [ebooks, setEbooks] = useState<EbookSummary[]>([]);
  const [ebookSelectedId, setEbookSelectedId] = useState('');
  const [ebookDoc, setEbookDoc] = useState<EbookDocument | null>(null);
  const [ebookChapterId, setEbookChapterId] = useState('');
  const [ebookLoading, setEbookLoading] = useState(false);
  const ebookVersion = useRef(0);
  // 大纲面板：红/黄/绿学习状态（手工标记，progress.json 持久化）。
  const [showOutline, setShowOutline] = useState(false);
  // 复习：考前速记面板 + 考试 UI 外壳（对接待同学 skill 确认，）。
  const [showReview, setShowReview] = useState(false);
  const [examOpen, setExamOpen] = useState(false);
  const [examDone, setExamDone] = useState(false);

  const loadDocument = useCallback(async () => {
    controller.current?.abort();
    const version = ++requestVersion.current;
    setToolbar(null); setResult(null); setPending(null);setHighlight(''); setError(''); setReadingDoc(null);
    if (mode !== 'material' || !material) { setLoading(false); return; }
    setLoading(true);
    try {
      const next = await readingService.document(course.id, material.id);
      if (version === requestVersion.current) setReadingDoc(next);
    } catch (e) {
      if (version === requestVersion.current) setError(e instanceof Error ? e.message : '资料正文加载失败，请重试。');
    } finally { if (version === requestVersion.current) setLoading(false); }
  }, [course.id, material?.id, course.revision, mode]);

  useEffect(() => { void loadDocument(); return () => { requestVersion.current++;controller.current?.abort(); }; }, [loadDocument]);

  // 电子书来源：进入电子书模式时拉列表，选中后拉正文（精炼 markdown + 大纲）。
  useEffect(() => {
    if (mode !== 'ebook') return;
    let alive = true;
    setEbookDoc(null); setEbookChapterId(''); setError('');
    void ebookService.list(course.id).then(
      list => { if (!alive) return; setEbooks(list); if (list.length > 0 && !list.some(e => e.ebookId === ebookSelectedId)) setEbookSelectedId(list[0].ebookId); },
      (e) => { if (alive) setError(e instanceof Error ? e.message : '电子书列表加载失败，请重试。'); },
    );
    return () => { alive = false };
  }, [mode, course.id]);

  useEffect(() => {
    if (mode !== 'ebook' || !ebookSelectedId) return;
    let alive = true;
    const version = ++ebookVersion.current;
    setEbookDoc(null); setEbookChapterId(''); setError(''); setEbookLoading(true);
    void ebookService.document(course.id, ebookSelectedId).then(
      doc => { if (alive && version === ebookVersion.current) { setEbookDoc(doc); setEbookLoading(false); } },
      (e) => { if (alive && version === ebookVersion.current) { setError(e instanceof Error ? e.message : '电子书正文加载失败，请重试。'); setEbookLoading(false); } },
    );
    return () => { alive = false };
  }, [mode, ebookSelectedId, course.id]);

  // 章节下拉 → 滚动到对应标题（锚点与后端 outline 的 slug 算法一致）。
  useEffect(() => {
    if (!ebookChapterId) return;
    document.getElementById(ebookChapterId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [ebookChapterId, ebookDoc]);
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
  /** 电子书模式的来源跳转 —— 按章节标题定位大纲锚点（无匹配则回全书）。 */
  function jumpEbookSource(title: string) {
    const node = ebookDoc?.outline.nodes.find(n => n.title === title);
    setEbookChapterId(node ? node.anchor : '');
  }
  /** 来源跳转：电子书走章节定位，资料走既有高亮滚动。 */
  function goSource(match: ReadingAssistance['matches'][number]) {
    if (mode === 'ebook' && match.materialId === ebookSelectedId) jumpEbookSource(match.title);
    else onSource(match.sourceId);
  }
  useEffect(()=>{if(readingDoc&&jumpTarget.current){const id=jumpTarget.current;articleRef.current?.querySelector<HTMLElement>(`[data-source-id="${CSS.escape(id)}"]`)?.scrollIntoView({behavior:'smooth',block:'center'});setHighlight(id);jumpTarget.current=null;}},[readingDoc]);

  async function assist(assistMode: 'explain' | 'search') {
    if (!toolbar) return;
    const onEbook = mode === 'ebook';
    if (onEbook && (!ebookDoc || !ebookSelectedId)) { setError('请先在电子书正文中选择文字'); return; }
    if (!onEbook && !readingDoc) return;
    const text = toolbar.text;
    onExpandAssistant();
    const version = ++requestVersion.current;
    setToolbar(null); setResult(null); setError(''); setPending({ text, mode: assistMode });
    try {
      controller.current?.abort();controller.current=new AbortController();
      const answer = onEbook
        ? await readingService.assistEbook(course.id, ebookSelectedId, ebookDoc!.markdown, text, assistMode, controller.current.signal)
        : await readingService.assist(readingDoc!, text, assistMode, controller.current.signal);
      if (version === requestVersion.current) { setResult(answer); onActivity(); }
    } catch (e) { if (version === requestVersion.current) setError(e instanceof Error?e.message:'阅读助手未完成，请重试。'); }
    finally { if (version === requestVersion.current) setPending(null); }
  }

  /** 投喂电子书：base64 上传 → ebook/ingest → 按 requestId 轮询作业。 */
  async function feedEbook(file: File) {
    const maxBytes = 150 * 1024 * 1024;
    if (file.size > maxBytes) { setError(`电子书原文件超过 ${maxBytes / 1024 / 1024} MiB 上限`); return; }
    const version = ++feedVersion.current;
    const controller = new AbortController();
    feedController.current = controller;
    setError(''); setFeedNotice(''); setFeeding({ requestId: '', jobId: '', message: '正在读取文件…' });
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.readAsDataURL(file);
      });
      const started = await ebookService.ingest({ courseId: course.id, fileName: file.name, base64 });
      if (version !== feedVersion.current) return;
      setFeeding(prev => ({ requestId: started.requestId, jobId: started.jobId, message: '已提交，正在解析…' }));
      const done = await ebookService.poll(started.requestId, controller.signal, progress => {
        if (version === feedVersion.current) setFeeding(prev => prev ? { ...prev, message: progress.message } : prev);
      });
      if (version !== feedVersion.current) return;
      setFeedNotice(done.message);
      setTimeout(() => { if (version === feedVersion.current) setFeedNotice(''); }, 10_000);
      // 投喂完成自动切到电子书模式并刷新列表、选中刚投的书（不必等用户手动切换）。
      setMode('ebook');
      void ebookService.list(course.id).then(fresh => {
        if (version !== feedVersion.current || !fresh.length) return;
        setEbooks(fresh);
        const target = fresh.find(e => e.fileName === file.name) ?? fresh[fresh.length - 1];
        if (target && target.ebookId !== ebookSelectedId) setEbookSelectedId(target.ebookId);
      });
    } catch (e) {
      if (version === feedVersion.current) setError(e instanceof Error ? e.message : '投喂未完成，请重试。');
    } finally {
      if (version === feedVersion.current) setFeeding(null);
    }
  }

  /** 与后端 syllora-outline.ts：slugify 逐字对齐（生成的锚点必须可命中）。 */
  function ebookSlug(title: string): string {
    return title.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'section';
  }
  function headingText(children: React.ReactNode): string {
    let acc = '';
    const walk = (node: React.ReactNode) => {
      if (typeof node === 'string' || typeof node === 'number') acc += String(node);
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object' && 'props' in node && (node as { props?: unknown }).props) walk((node as { props: { children?: React.ReactNode } }).props.children);
    };
    walk(children);
    return acc;
  }
  // 标题锚点必须与后端 outline 的 slug 稳定一致：计数表每次渲染重建，
  // 不能挂在 ref 上跨渲染累计（否则第二次渲染起 id 漂移成 slug-1，跳章静默失效）。
  const headingSeen = new Map<string, number>();
  function renderHeading(level: 1 | 2 | 3 | 4 | 5 | 6) {
    const Tag = `h${level}` as 'h1';
    return function Heading({ children }: { children?: React.ReactNode }) {
      const base = ebookSlug(headingText(children));
      const seen = headingSeen.get(base) ?? 0;
      headingSeen.set(base, seen + 1);
      const id = seen === 0 ? base : `${base}-${seen}`;
      return <Tag id={id}>{children}</Tag>;
    };
  }
  const resolveEbookImg = (src: string | undefined) => (src && src.startsWith('images/') ? ebookService.ebookFileUrl(course.id, ebookSelectedId, src) : src);
  const ebookMarkdownComponents = {
    h1: renderHeading(1), h2: renderHeading(2), h3: renderHeading(3), h4: renderHeading(4), h5: renderHeading(5), h6: renderHeading(6),
    img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => <img {...props} src={typeof props.src === 'string' ? resolveEbookImg(props.src) : props.src} alt={props.alt ?? ''} />,
  };

  // 整本切条只算一次：轮询与输入都会触发重渲染，两处 memo 各自重算等于每次都切两遍全书。
  const ebookChunks = useMemo(() => (ebookDoc ? chunkEbookMarkdown(ebookDoc.markdown) : []), [ebookDoc]);

  /** 自动判规（默认规则，待你批）：按 AI 答疑来源统计章节接触次数（chunk→章节），≥3 次→绿(已掌握)、1-2 次→黄(学习中)、0→红(薄弱)；手工标记优先于自动。 */
  const autoProgress = useMemo(() => {
    const counts = new Map<string, number>();
    for (const message of course.messages ?? []) {
      if (!message.reading || !('ebookId' in message.reading) || message.reading.ebookId !== ebookSelectedId) continue;
      for (const sid of message.sourceIds ?? []) counts.set(sid, (counts.get(sid) ?? 0) + 1);
    }
    const bySection = new Map<string, number>();
    if (ebookDoc) for (const chunk of ebookChunks) {
      const n = counts.get(chunk.id) ?? 0;
      if (n > 0) bySection.set(chunk.section, (bySection.get(chunk.section) ?? 0) + n);
    }
    const out: Record<string, EbookNodeStatus> = {};
    for (const node of ebookDoc?.outline.nodes ?? []) {
      const n = bySection.get(node.title) ?? 0;
      if (n >= 3) out[node.anchor] = 'mastered';
      else if (n >= 1) out[node.anchor] = 'learning';
    }
    return out;
  }, [course.messages, ebookDoc, ebookSelectedId, ebookChunks]);

  /** 考前速记：每章取首块正文摘要（浓缩版占位，AI 二度浓缩待模型接入后替换）。 */
  const reviewSections = useMemo(() => {
    if (!ebookDoc) return [] as Array<{ anchor: string; title: string; excerpt: string }>;
    const firstBySection = new Map<string, string>();
    for (const chunk of ebookChunks) {
      if (!firstBySection.has(chunk.section)) {
        firstBySection.set(chunk.section, chunk.text.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\s+/g, ' ').trim());
      }
    }
    return (ebookDoc.outline.nodes ?? []).map(node => ({ anchor: node.anchor, title: node.title, excerpt: (firstBySection.get(node.title) ?? '').slice(0, 90) }));
  }, [ebookDoc, ebookChunks]);

  /** 章节学习状态循环 未标记→绿(已掌握)→黄(学习中)→红(薄弱)→未标记，乐观更新+后端落盘。 */
  const cycleChapterStatus = useCallback(async (anchor: string) => {
    if (!ebookDoc) return;
    const current = ebookDoc.progress?.nodes?.[anchor] ?? null;
    const order: Array<EbookNodeStatus | null> = [null, 'mastered', 'learning', 'weak'];
    const next = order[(order.indexOf(current) + 1) % order.length] ?? null;
    const nodes = { ...(ebookDoc.progress?.nodes ?? {}) };
    if (next === null) delete nodes[anchor]; else nodes[anchor] = next;
    setEbookDoc({ ...ebookDoc, progress: { nodes } });
    try {
      const resp = await ebookService.progressSet(course.id, ebookSelectedId, anchor, next);
      if (resp?.progress?.nodes) setEbookDoc(doc => (doc ? { ...doc, progress: resp.progress } : doc));
    } catch (e) {
      setError(e instanceof Error ? e.message : '学习状态保存失败，请重试。');
      try {
        const doc = await ebookService.document(course.id, ebookSelectedId);
        setEbookDoc(doc);
      } catch { /* 保持乐观状态 */ }
    }
  }, [ebookDoc, course.id, ebookSelectedId]);

  return <div className={`reader-layout ${assistantOpen ? 'assistant-open' : 'assistant-collapsed'}`}><section className="reader-document-column" aria-label="资料阅读区"><div className="reader-toolbar"><div className="reader-source-switch" role="group" aria-label="阅读来源"><button type="button" className={mode === 'material' ? 'active' : ''} onClick={() => setMode('material')}><FileText size={14} />资料</button><button type="button" className={mode === 'ebook' ? 'active' : ''} onClick={() => setMode('ebook')}><BookOpen size={14} />电子书</button></div>{mode === 'ebook' ? <><Dropdown label="选择电子书" value={ebookSelectedId} onChange={value => setEbookSelectedId(value)} disabled={!ebooks.length} placeholder="暂无电子书" options={ebooks.map(e => ({ value: e.ebookId, label: e.fileName, description: `${e.pages ?? '?'} 页 · ${e.outlineCount} 节 · ${e.images ?? 0} 图` }))} />{ebookDoc ? <Dropdown label="章节" value={ebookChapterId} onChange={value => setEbookChapterId(value)} placeholder="全书" options={[{ value: '', label: '全书浏览' }, ...ebookDoc.outline.nodes.map(n => ({ value: n.anchor, label: n.title, description: `H${n.level}` }))]} /> : null}<button className="button small" onClick={() => setShowOutline(v => !v)} title="章节大纲与学习状态"><ListTree size={14} /><span>{showOutline ? '收起大纲' : '大纲'}</span></button><button className="button small" onClick={() => setShowReview(v => !v)} title="考前速记（电子书二度浓缩）"><NotebookPen size={14} /><span>{showReview ? '收起速记' : '速记'}</span></button><button className="button small" onClick={() => setExamOpen(true)} title="章节自测（UI 外壳）"><ClipboardCheck size={14} /><span>考试</span></button></> : <><div><FileText size={16} /><Dropdown label="选择阅读资料" value={material?.id ?? ''} onChange={value => { window.getSelection()?.removeAllRanges(); setSelectedId(value); }} disabled={!course.materials.length} placeholder="暂无资料" options={course.materials.map(m => ({ value: m.id, label: m.name, description: m.name.toLowerCase().endsWith('.pdf') ? 'PDF 学习资料' : '文本学习资料' }))} /></div><button className="button small" onClick={onUpload}><Plus size={14} /><span>上传资料</span></button></>}<button className="button small" disabled={feeding !== null} onClick={() => fileRef.current?.click()}><Upload size={14} /><span>{feeding !== null ? '投喂中…' : '投喂电子书'}</span></button><input ref={fileRef} type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.html" className="hidden" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void feedEbook(file); }} />{feeding !== null && <span className="reader-feed-status" role="status"><LoaderCircle size={13} className="spin" />{feeding.message}<button className="text-button" onClick={() => feedController.current?.abort()}>取消</button></span>}{feedNotice && <span className="reader-feed-notice" role="status">{feedNotice}</span>}{readingDoc?.previewUrl&&<MaterialPreview url={readingDoc.previewUrl} name={readingDoc.name} version={readingDoc.revision??'unpublished'}/>} {!assistantOpen && <button className="icon-button reader-mobile-expand" aria-label="展开阅读助手" onClick={onToggleAssistant}><PanelRightOpen size={18} /></button>}</div><div className={`reader-scroll ${!readingDoc?.content ? 'reader-empty-scroll' : ''}`}>{readingDoc?.content&&<div className="reading-intro"><span className="blue-eyebrow"><BookOpen size={14} />辅助阅读</span><p>选中不理解的文字，让思路在这里展开。</p></div>}
      {mode === 'ebook' ? <>{showOutline && ebookDoc ? <div className="reader-outline-panel" aria-label="章节大纲"><header><span><ListTree size={13} />大纲（点击圆点切换学习状态）</span><button className="text-button" onClick={() => setShowOutline(false)}>收起</button></header><ol className="reader-outline-list">{ebookDoc.outline.nodes.map(node => { const manual = ebookDoc.progress?.nodes?.[node.anchor] ?? null; const status = manual ?? autoProgress[node.anchor] ?? null; const auto = status !== null && manual === null; const statusTitle = (status === 'mastered' ? '已掌握' : status === 'learning' ? '学习中' : status === 'weak' ? '薄弱' : '未标记') + (auto ? '（自动）' : ''); return <li key={node.anchor} className={ebookChapterId === node.anchor ? 'is-active' : ''} style={{ paddingLeft: `${18 + (node.level - 1) * 14}px` }}><button type="button" className={`outline-status-dot ${status ?? ''}`} title={`${statusTitle}（点击可手工切换）`} aria-label={`${node.title}：${statusTitle}`} onClick={() => void cycleChapterStatus(node.anchor)} /><button type="button" className="outline-chapter-title" title={`跳到「${node.title}」`} onClick={() => setEbookChapterId(node.anchor)}>{node.title}</button></li>; })}</ol></div> : null}{showReview && ebookDoc ? <div className="reader-review-panel" aria-label="考前速记"><header><span><NotebookPen size={13} />考前速记（每章要点，AI 二度浓缩接入中）</span><button className="text-button" onClick={() => setShowReview(false)}>收起</button></header><ol className="reader-review-list">{reviewSections.map(item => <li key={item.anchor} onClick={() => setEbookChapterId(item.anchor)}><span className={`outline-status-dot ${ebookDoc.progress?.nodes?.[item.anchor] ?? autoProgress[item.anchor] ?? ''}`} /><div><h4>{item.title}</h4><p>{item.excerpt || '（本章暂无正文摘要）'}</p></div></li>)}</ol></div> : null}{(ebookLoading ? <div className="reader-empty" role="status"><LoaderCircle className="spin" size={25} /><p>正在打开电子书…</p></div> : ebookDoc ? <article className="reading-paper" aria-label="电子书正文"><header className="paper-meta"><span>{course.name}</span><span>{ebookDoc.fileName}</span><span>{ebookDoc.outline.nodes.length} 节</span></header><ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={MARKDOWN_REHYPE_PLUGINS} components={ebookMarkdownComponents}>{ebookDoc.markdown}</ReactMarkdown></article> : <div className="reader-empty"><BookOpen size={35} /><h2>{ebooks.length ? '电子书正文为空' : '还没有电子书'}</h2><p>{ebooks.length ? '正文尚未生成，请稍后重试。' : '点击右上角「投喂电子书」上传教材，系统会自动结构化并生成目录。'}</p></div>)}</> : (loading ? <div className="reader-empty" role="status"><LoaderCircle className="spin" size={25} /><p>正在打开资料…</p></div> : readingDoc?.content ? <article className="reading-paper" ref={articleRef} aria-label="资料正文"><header className="paper-meta"><span>{course.name}</span><span>{'已发布正文'}</span></header>{readingDoc.sources.map(source=><div data-source-id={source.id} className={highlight===source.id?'reading-source highlighted':'reading-source'} key={source.id}>{source.kind==='heading'?<h2>{source.text.replace(/^#+\s*/, '')}</h2>:<ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={MARKDOWN_REHYPE_PLUGINS} components={{img:()=>null}}>{source.text}</ReactMarkdown>}</div>)}<footer className="paper-end"><span />读到这里，不妨用自己的话再说一遍。<span /></footer></article> : <div className="reader-empty"><FileText size={35} /><h2>{!material ? '添加一份资料，开始阅读' : readingDoc?.source === 'unavailable' ? '这份资料还没有可阅读的正文' : '这份资料的正文为空'}</h2><p>{!material ? '你可以添加 TXT、Markdown，或文本 PDF。' : material.name.toLowerCase().endsWith('.pdf') ? '请先在资料面板检查文件并初始化课程。' : '资料初始化后可读取已发布的版本。'}</p><button className="button" onClick={onUpload}><Plus size={15} />添加资料</button></div>)}
      {error && <div className="reading-error" role="alert">{error}<button className="text-button" onClick={() => void loadDocument()}>重新打开资料</button></div>}
    </div>{readingDoc?.content&&<footer className="reader-bottom-hint"><MousePointer2 size={13} />选中文字，即可使用 AI解释、AI搜索</footer>}</section>
    {assistantOpen ? <aside className={`reader-assistant is-open ${pending || result ? 'has-answer' : ''}`} aria-label="阅读助手"><header><span><Sparkles size={16} />阅读助手</span><button className="icon-button" aria-label="收起阅读助手" title="收起阅读助手" onClick={onToggleAssistant}><X size={17} /></button></header><div className="reading-assistant-content">{!result && !pending ? <div className="reading-assistant-empty"><span><MousePointer2 size={25} /></span><h3>从一个疑问开始</h3><p>在正文中选中一个概念或一段话，选择你需要的帮助。</p><div><Sparkles size={16} /><span><strong>AI解释</strong><small>换一种方式理解选中的内容</small></span></div><div><Search size={16} /><span><strong>AI搜索</strong><small>找到资料中相关的段落</small></span></div></div> : <><span className="reading-result-label">{(pending?.mode ?? result?.mode) === 'explain' ? 'AI解释' : 'AI搜索'}<small>课程资料</small></span><blockquote className="reading-quote"><Quote size={15} /><p>{pending?.text ?? result?.selection}</p></blockquote>{pending ? <div className="reading-pending" role="status"><LoaderCircle size={16} className="spin" />{pending.mode === 'explain' ? '正在准备解释…' : '正在查找相关段落…'}<button className="text-button" onClick={()=>controller.current?.abort()}>取消阅读任务</button></div> : result?.mode === 'explain' ? <div className="reading-explanation"><ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={MARKDOWN_REHYPE_PLUGINS} components={{img:()=>null}}>{result.explanation}</ReactMarkdown>{result.matches.map(match=><button className="text-button" key={match.sourceId} onClick={()=>goSource(match)}>来源：{match.title}</button>)}</div> : <div className="reading-search-results"><ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={MARKDOWN_REHYPE_PLUGINS} components={{img:()=>null}}>{result?.explanation??''}</ReactMarkdown><p>在课程资料中找到 {result?.matches.length ?? 0} 个相关段落</p>{result?.matches.map((match, i) => <article key={i} id={match.sourceId}><button className="text-button" onClick={()=>goSource(match)}>查看资料来源</button><button className="text-button" onClick={()=>{if(mode==='ebook')goSource(match);else locate(match);}}>定位段落</button><h3>{match.title}<ArrowUpRight size={13} /></h3><p>{match.excerpt}</p></article>)}</div>}</> }</div><footer>回答基于当前课程资料；点击来源可核对原文。</footer></aside> : <aside className="panel-rail reader-rail" aria-label="阅读助手已收起"><button className="icon-button" aria-label="展开阅读助手" onClick={onToggleAssistant}><PanelRightOpen size={18} /></button></aside>}
    {toolbar && createPortal(<div ref={toolsRef} className="selection-tools" role="toolbar" aria-label="选中文字操作" style={{ left: toolbar.x, top: toolbar.y }} onPointerDown={e => e.preventDefault()}><button onClick={() => void assist('explain')}><Sparkles size={15} />AI解释</button><span /><button onClick={() => void assist('search')}><Search size={15} />AI搜索</button></div>, document.body)}
    {examOpen && <div className="exam-modal" role="dialog" aria-label="章节自测"><div className="exam-modal-card"><header><span><GraduationCap size={17} />章节自测<small>UI 外壳 · 考试接入契约待同学 skill 确认（）</small></span><button className="icon-button" aria-label="关闭" onClick={() => setExamOpen(false)}><X size={16} /></button></header><div className="exam-modal-body">{examDone ? <div className="exam-done"><h3>已交卷</h3><p>判题与评分需要考试接入契约（）确认后启用；当前仅展示界面外壳。</p><button className="button primary" onClick={() => { setExamDone(false); setExamOpen(false); }}>完成</button></div> : <><p className="exam-note">从当前电子书章节出若干单选题（示例占位，来自大纲前 3 节）。</p>{(ebookDoc?.outline.nodes ?? []).slice(0, 3).map((node, index) => <div className="exam-question" key={node.anchor}><h4>第 {index + 1} 题 · 关于「{node.title}」<small>（示例题）</small></h4><label><input type="radio" name={`q${index}`} />选项 A 示例</label><label><input type="radio" name={`q${index}`} />选项 B 示例</label><label><input type="radio" name={`q${index}`} />选项 C 示例</label><label><input type="radio" name={`q${index}`} />选项 D 示例</label></div>)}<button className="button primary" onClick={() => setExamDone(true)}>交卷</button></>}</div></div></div>}
  </div>;
}
