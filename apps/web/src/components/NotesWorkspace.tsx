"use client";

/**
 * 笔记整页工作区。
 * 三栏：笔记列表（含图片树）｜ 富文本编辑器 + 底部 AI 输入框 ｜ 笔记图谱。
 * 正文始终是 Markdown（`[[双链]]` + `![](assets/x.png)`），图谱与后端解析不受影响。
 *
 * AI 输入框与主界面输入框同构：功能键在左（续写/总结/扩写/润色/精简），
 * 模型座位与发送在右，并支持"选中一段 → 输入提示词 → 以该段为对象处理"
 * （选中的 {from,to} 在提交时冻结，结果先出卡片、再一键替换/插入，单事务一步撤销）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Image as ImageIcon, Link2, LoaderCircle, Plus, Sparkles, Trash2, X } from "lucide-react";
import type { Editor } from "@tiptap/react";
import { api } from "../lib/api";
import type { NoteMeta, NoteAiAction } from "../types/api";
import NotesEditor from "./NotesEditor";
import NotesGraph from "./NotesGraph";
import ModelSeat from "./chat/ModelSeat";
import LearningModeSwitch from "../features/workbench/components/LearningModeSwitch";
import Dropdown from "../features/workbench/components/Dropdown";

interface Props {
  courseId: string;
  courseName: string;
  onClose: () => void;
  /** 切到虚拟课堂 / 对话学习 / 辅助阅读：由外壳负责离开笔记页并设置学习模式。 */
  onSwitchMode: (mode: 'chat' | 'reading' | 'classroom') => void;
  /** 需求七：笔记页内直接切换课程（左栏下拉）。未归档课程全量。 */
  courses?: Array<{ id: string; name: string }>;
  onSwitchCourse?: (courseId: string) => void | Promise<void>;
}

/** 输入框左侧的功能键：点一下就用当前上下文执行。 */
const AI_ACTIONS: Array<{ id: NoteAiAction; label: string; tip: string }> = [
  { id: "continue", label: "AI 续写", tip: "接着光标处往下写" },
  { id: "summarize", label: "AI 总结", tip: "把笔记总结成要点" },
  { id: "expand", label: "扩写", tip: "补足因果、步骤或例子（需选中）" },
  { id: "polish", label: "润色", tip: "修病句、标点与术语（需选中）" },
  { id: "shorten", label: "精简", tip: "删冗余、保留关键信息（需选中）" },
];

/** 把纯文本产物转成块级节点：空行分段，连续 `- ` 行成项目符号列表。
 *  直接插入字符串会被当成一个文本节点，多段内容会塌成一段。 */
function textToContent(text: string): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = [];
  const paragraph = (line: string) => ({ type: "paragraph", content: line === "" ? [] : [{ type: "text", text: line }] });
  for (const block of text.split(/\n{2,}/).map((item) => item.trim()).filter((item) => item !== "")) {
    let bullets: string[] = [];
    const flush = () => {
      if (bullets.length === 0) return;
      nodes.push({ type: "bulletList", content: bullets.map((item) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: item }] }] })) });
      bullets = [];
    };
    for (const line of block.split("\n")) {
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      if (bullet) { bullets.push(bullet[1]!.trim()); continue }
      flush();
      nodes.push(paragraph(line));
    }
    flush();
  }
  return nodes.length > 0 ? nodes : [paragraph(text)];
}

const formatUpdated = (at: number) => new Date(at).toLocaleString("zh-CN", { hour12: false });

export default function NotesWorkspace({ courseId, courseName, onClose, onSwitchMode, courses = [], onSwitchCourse }: Props) {
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [savedLinks, setSavedLinks] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [linking, setLinking] = useState(false);
  // 关联插入所用的选区快照（点「关联」时记下，避免按钮失焦后选区丢失）
  const [pendingLink, setPendingLink] = useState<{ from: number; to: number; text: string } | null>(null);
  // AI 输入框：选区胶囊 + 提示词 + 结果卡（应用前不碰文档）
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState<{ text: string; sourceIds: string[]; action: NoteAiAction; target: { from: number; to: number; text: string } | null } | null>(null);
  const [selection, setSelection] = useState<{ from: number; to: number; text: string } | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  // 图谱刷新用：保存/新建/删除后自增
  const [graphEpoch, setGraphEpoch] = useState(0);
  /** 需求一：原先用 window.confirm —— 原生阻塞框会冻住整个渲染进程（轮询、
   *  输入法组合全部停摆），弹窗被 Esc 划掉后焦点还会掉到 body 上，表现为
   *  「怎么打字都没反应」。改成应用内非阻塞确认框。 */
  const [confirmAsk, setConfirmAsk] = useState<{ message: string; confirmLabel: string; danger?: boolean; run: () => void } | null>(null);

  const aiInputRef = useRef<HTMLTextAreaElement>(null);
  const newTitleRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const loadedRef = useRef<{ title: string; content: string } | null>(null);
  // R05：请求世代守卫——迟到的 open/AI/保存响应不得回填另一课程或另一篇笔记。
  const noteVersionRef = useRef<string | undefined>(undefined);
  const openingRef = useRef(0);
  const activeNoteRef = useRef<string | null>(null);
  const aiRequestRef = useRef(0);

  const load = useCallback(async () => {
    try {
      const result = await api.notes.list(courseId);
      setNotes(result.notes);
      return result.notes;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取笔记");
      return [];
    }
  }, [courseId]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void load().finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [load]);

  useEffect(() => { if (creating) newTitleRef.current?.focus(); }, [creating]);

  // 需求七：笔记页内切换课程后，编辑器要回到"空选择"状态（同一组件实例换课）。
  useEffect(() => {
    setEditingId(null); setTitle(""); setContent(""); setSavedLinks([]);
    setAiResult(null); setAiPrompt(""); setSelection(null); setPendingLink(null); setLinking(false);
    loadedRef.current = null;
    activeNoteRef.current = null; aiRequestRef.current++; openingRef.current++;
    noteVersionRef.current = undefined; setAiBusy(false);
  }, [courseId]);

  // 输入框自动增高：下边界固定（在编辑器列底部），内容多只向上长。
  useEffect(() => {
    const el = aiInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [aiPrompt]);

  const open = useCallback(
    async (noteId: string) => {
      setError("");
      const request = ++openingRef.current;
      activeNoteRef.current = noteId;
      aiRequestRef.current++;
      setAiBusy(false);
      try {
        const result = await api.notes.read(courseId, noteId);
        if (request !== openingRef.current) return;
        noteVersionRef.current = result.version;
        setEditingId(noteId);
        setTitle(result.meta.title);
        setContent(result.content);
        setSavedLinks(result.meta.wikilinks);
        setAiResult(null);
        setAiPrompt("");
        setSelection(null);
        setLinking(false);
        setPendingLink(null);
        loadedRef.current = { title: result.meta.title, content: result.content };
      } catch (cause) {
        if (request === openingRef.current) setError(cause instanceof Error ? cause.message : "无法打开笔记");
      }
    },
    [courseId],
  );

  const dirty = editingId !== null && loadedRef.current !== null && (title !== loadedRef.current.title || content !== loadedRef.current.content);
  /** 未保存修改的守卫；返回 true 表示可以离开。 */
  const confirmLeave = () => !dirty;
  const closeWithGuard = () => {
    if (confirmLeave()) { onClose(); return; }
    setConfirmAsk({ message: "这篇笔记有未保存的修改，确定放弃并返回？", confirmLabel: "放弃修改并返回", run: onClose });
  };
  /** 切模式前走同一条守卫，避免静默丢掉未保存的修改。 */
  const switchMode = (surface: 'chat' | 'reading' | 'classroom' | 'notes') => {
    if (surface === 'notes') return;
    if (confirmLeave()) { onSwitchMode(surface); return; }
    setConfirmAsk({ message: "这篇笔记有未保存的修改，确定放弃并切换？", confirmLabel: "放弃修改并切换", run: () => onSwitchMode(surface) });
  };

  const create = async () => {
    const wanted = newTitle.trim();
    if (wanted === "" || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.notes.create(courseId, wanted);
      setCreating(false);
      setNewTitle("");
      await open(result.meta.id);
      await load();
      setGraphEpoch((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "新建笔记失败");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (editingId === null || title.trim() === "" || busy) return;
    const target = editingId;
    setBusy(true);
    setError("");
    try {
      const result = await api.notes.update(courseId, editingId, { title: title.trim(), content, ...(noteVersionRef.current ? { baseVersion: noteVersionRef.current } : {}) });
      if (activeNoteRef.current !== target) return;
      noteVersionRef.current = result.version;
      setTitle(result.meta.title);
      setSavedLinks(result.meta.wikilinks);
      loadedRef.current = { title: result.meta.title, content };
      await load();
      setGraphEpoch((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存笔记失败");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (noteId: string) => {
    if (busy) return;
    setConfirmAsk({ message: "删除这篇笔记？正文与其中的图片会一并删除，无法撤销。", confirmLabel: "删除笔记", danger: true, run: () => void removeNote(noteId) });
    return;
  };

  const removeNote = async (noteId: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api.notes.delete(courseId, noteId);
      if (editingId === noteId) {
        setEditingId(null); setTitle(""); setContent(""); setSavedLinks([]); loadedRef.current = null;
      }
      await load();
      setGraphEpoch((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除笔记失败");
    } finally {
      setBusy(false);
    }
  };

  /** 点「关联」：记下当前选区。 */
  const openLinkPicker = () => {
    const ed = editorRef.current;
    if (!ed) return;
    const { from, to } = ed.state.selection;
    if (from === to) {
      setError("请先在正文中选中要关联的文字");
      setTimeout(() => setError(""), 2000);
      return;
    }
    setPendingLink({ from, to, text: ed.state.doc.textBetween(from, to, " ") });
    setLinking(true);
  };

  /** 选中笔记 → 把选区替换成 `[[目标|原文]]`。 */
  const insertLink = (targetTitle: string) => {
    const ed = editorRef.current;
    if (!ed || !pendingLink) return;
    const { from, to, text } = pendingLink;
    const link = text.trim() ? `[[${targetTitle}|${text}]]` : `[[${targetTitle}]]`;
    ed.chain().focus().insertContentAt({ from, to }, link).run();
    setLinking(false);
    setPendingLink(null);
  };

  /** 选区跟踪：选中就出现胶囊；失焦也保留（提交时再冻结一次）。 */
  useEffect(() => {
    if (!editor) return;
    const sync = () => {
      const { from, to, empty } = editor.state.selection;
      setSelection(empty ? null : { from, to, text: editor.state.doc.textBetween(from, to, " ").trim() });
    };
    sync();
    editor.on("selectionUpdate", sync);
    return () => { editor.off("selectionUpdate", sync); };
  }, [editor]);

  /** 执行一次 AI 动作：选段类动作用当前选区，其余用整篇 / 光标前文。 */
  const runAi = async (action: NoteAiAction, instruction = ""): Promise<boolean> => {
    const ed = editorRef.current;
    if (!ed || aiBusy) return false;
    const needsSelection = action === "expand" || action === "rewrite" || action === "polish" || action === "shorten";
    const picked = needsSelection || instruction !== "" ? selection : null;
    if (needsSelection && picked === null) {
      setError("请先在正文中选中要处理的内容");
      return false;
    }
    setAiBusy(true);
    setError("");
    setAiResult(null);
    const request = ++aiRequestRef.current;
    const targetNote = activeNoteRef.current;
    try {
      const res = await api.notes.suggest(courseId, {
        title: title.trim(),
        action,
        prefix: action === "continue" ? ed.state.doc.textBetween(0, ed.state.selection.from, "\n") : "",
        selection: picked?.text ?? "",
        body: ed.state.doc.textBetween(0, ed.state.doc.content.size, "\n"),
        instruction,
      });
      if (request !== aiRequestRef.current || targetNote !== activeNoteRef.current) return false;
      // 目标在提交时冻结：之后用户改动文档也不会把结果贴错地方。
      setAiResult({ text: res.text, sourceIds: res.sourceIds, action, target: picked });
      return true;
    } catch (cause) {
      if (request === aiRequestRef.current && targetNote === activeNoteRef.current) setError(cause instanceof Error ? cause.message : "AI 处理失败");
      return false;
    } finally {
      if (request === aiRequestRef.current) setAiBusy(false);
    }
  };

  /** 应用结果：替换冻结的选区，或插到当前光标处；应用前核对原文未被改动。 */
  const applyResult = (mode: "replace" | "insert") => {
    const ed = editorRef.current;
    if (!ed || aiResult === null) return;
    const target = aiResult.target;
    if (mode === "replace" && target !== null) {
      const current = ed.state.doc.textBetween(target.from, target.to, " ");
      if (current.trim() !== target.text.trim()) {
        setError("原文已变化，请重新选中后再试");
        return;
      }
      ed.chain().focus().insertContentAt({ from: target.from, to: target.to }, textToContent(aiResult.text)).run();
    } else {
      ed.chain().focus().insertContent(textToContent(aiResult.text)).run();
    }
    setAiResult(null);
  };

  /** 提交提示词：自定义指令走 custom，选区在提交时作为处理对象。 */
  const submitPrompt = async () => {
    const text = aiPrompt.trim();
    if (text === "") return;
    const ok = await runAi("custom", text);
    if (ok) setAiPrompt("");
  };

  /** 点左栏缩略图：定位到正文里那张图。 */
  const jumpToImage = async (noteId: string, name: string) => {
    if (editingId !== noteId) await open(noteId);
    setTimeout(() => {
      const ed = editorRef.current;
      if (!ed) return;
      const img = Array.from(ed.view.dom.querySelectorAll("img")).find((el) => el.src.includes(name));
      if (img) {
        img.scrollIntoView({ behavior: "smooth", block: "center" });
        img.classList.add("is-flash");
        setTimeout(() => img.classList.remove("is-flash"), 1200);
      }
    }, 120);
  };

  return (
    <div className="sy-nw">
      <header className="sy-nw-top">
        <button className="sy-nw-back" onClick={closeWithGuard}><ArrowLeft size={16} />返回工作台</button>
        <div className="sy-nw-title"><span>笔记</span><small>{courseName}</small></div>
        <div className="sy-nw-actions">
          {/* 开关放在最后一个：与工作台顶栏同规格，且保存按钮出现/消失时它的绝对位置不变。 */}
          {editingId !== null && (
            <button className="sy-primary" disabled={busy || title.trim() === ""} onClick={() => void save()}>
              {busy ? "保存中…" : dirty ? "保存" : "已保存"}
            </button>
          )}
          <LearningModeSwitch disabled={false} current="notes" onSelect={switchMode} />
        </div>
      </header>

      <div className="sy-nw-body">
        {/* 左：笔记列表 + 图片树 */}
        <aside className="sy-nw-list">
          {/* 需求七：笔记页内直接切换课程——未保存的修改先走应用内确认。 */}
          {courses.length > 0 && (
            <div className="sy-nw-course">
              <Dropdown
                label="选择课程"
                value={courseId}
                options={courses.map(item => ({ value: item.id, label: item.name }))}
                onChange={value => {
                  if (value === courseId || !onSwitchCourse) return;
                  const go = () => { void onSwitchCourse(value); };
                  if (!confirmLeave()) { setConfirmAsk({ message: "这篇笔记有未保存的修改，切课将放弃，确定？", confirmLabel: "放弃修改并切换课程", run: go }); return; }
                  go();
                }}
              />
            </div>
          )}
          <div className="sy-nw-list-head">
            <span>本课程笔记 <small>{notes.length}</small></span>
            <button aria-label="新建笔记" title="新建笔记" onClick={() => { setCreating(true); setNewTitle(""); }}><Plus size={15} /></button>
          </div>
          {creating && (
            <input ref={newTitleRef} className="sy-nw-new" aria-label="新笔记标题" placeholder="输入标题后按 Enter"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void create(); } if (e.key === "Escape") setCreating(false); }}
              onBlur={() => { if (newTitle.trim() === "") setCreating(false); }}
            />
          )}
          {loading ? <p className="sy-muted">正在读取…</p> : null}
          {!loading && notes.length === 0 ? <p className="sy-muted">暂无笔记</p> : null}
          {notes.map((note) => {
            const hasImages = (note.images?.length ?? 0) > 0;
            const isSelected = editingId === note.id;
            return (
              <div className="sy-nw-group" key={note.id}>
                <div className={`sy-nw-item ${isSelected ? "is-selected" : ""}`}>
                  <button type="button" className="sy-nw-item-btn" aria-label={`打开笔记 ${note.title}`} onClick={() => { if (dirty) { setConfirmAsk({ message: "有未保存的修改，切换将放弃，确定？", confirmLabel: "放弃修改并切换", run: () => { void open(note.id); } }); return; } void open(note.id); }}>
                    <strong>{note.title}</strong>
                    <small>{formatUpdated(note.updatedAt)}{hasImages ? ` · ${note.images.length} 图` : ""}</small>
                  </button>
                  <button type="button" className="sy-nw-del" aria-label={`删除笔记 ${note.title}`} title="删除笔记" disabled={busy} onClick={() => void remove(note.id)}>
                    <Trash2 size={13} />
                  </button>
                </div>
                {/* 只展开当前选中的笔记：它涉及的图片一行一行列在下方 */}
                {isSelected && hasImages && (
                  <div className="sy-nw-imglist">
                    {note.images.map((name, i) => (
                      <button type="button" className="sy-nw-imgrow" key={name} title="跳到正文该图" onClick={() => void jumpToImage(note.id, name)}>
                        <ImageIcon size={12} />图片 {i + 1}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </aside>

        {/* 中：编辑器 */}
        <section className="sy-nw-editor">
          {editingId === null ? (
            <p className="sy-muted sy-nw-empty">选择左侧笔记开始编辑，或点左上角 + 新建一篇。</p>
          ) : (
            <>
              <input className="sy-nw-title-input" aria-label="笔记标题" maxLength={200} value={title}
                onChange={(e) => setTitle(e.target.value)} placeholder="笔记标题" />
              <NotesEditor
                courseId={courseId}
                value={content}
                noteId={editingId}
                onChange={setContent}
                onEditor={(ed) => { editorRef.current = ed; setEditor(ed); }}
                onError={setError}
                extraToolbar={
                  <button type="button" className="sy-nw-link-btn" title="选中文字后点此关联到其他笔记" onClick={openLinkPicker}>
                    <Link2 size={13} />关联
                  </button>
                }
              />
              <div className="sy-nw-foot">
                {savedLinks.length > 0 && (
                  <div className="sy-nw-links">
                    <span className="sy-nw-links-title">已关联</span>
                    {savedLinks.map((l) => <span className="sy-nw-link-tag" key={l}><Link2 size={10} />{l}</span>)}
                  </div>
                )}
              </div>

              {aiResult !== null && (
                <div className="sy-nw-ai-card" data-testid="notes-ai-result">
                  <div className="sy-nw-ai-card-head">
                    <span>{AI_ACTIONS.find((item) => item.id === aiResult.action)?.label ?? "AI 处理"}{aiResult.target !== null ? " · 针对选中内容" : ""}</span>
                    {aiResult.sourceIds.length > 0 && <small>依据 {aiResult.sourceIds.length} 个资料片段</small>}
                  </div>
                  <textarea className="sy-nw-ai-result" aria-label="AI 结果（可先编辑再应用）" value={aiResult.text} onChange={(event) => setAiResult({ ...aiResult, text: event.target.value })} />
                  <div className="sy-nw-ai-btns">
                    {aiResult.target !== null && <button className="sy-primary" onClick={() => applyResult("replace")}>替换选中</button>}
                    <button className={aiResult.target === null ? "sy-primary" : ""} onClick={() => applyResult("insert")}>插入到光标处</button>
                    <button onClick={() => setAiResult(null)}>丢弃</button>
                  </div>
                </div>
              )}

              {/* 底部 AI 输入框：与主界面输入框同构——功能键在左，模型与发送在右 */}
              <form className="sy-nw-composer" onSubmit={(event) => { event.preventDefault(); void submitPrompt(); }}>
                {selection !== null && (
                  <div className="sy-nw-selchip" data-testid="notes-selection-chip">
                    <span>已选：{selection.text.length > 42 ? `${selection.text.slice(0, 42)}…` : selection.text}</span>
                    <button type="button" aria-label="清除选区" onClick={() => setSelection(null)}><X size={12} /></button>
                  </div>
                )}
                <textarea
                  ref={aiInputRef}
                  aria-label="笔记 AI 指令"
                  value={aiPrompt}
                  disabled={editingId === null}
                  placeholder={selection !== null ? "对选中的内容做什么？例如：以这句话为主题拓展" : "输入提示词，对整篇笔记做什么；也可以先在正文里选中一段"}
                  onChange={(event) => setAiPrompt(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submitPrompt(); } }}
                />
                <div className="sy-nw-composer-toolbar">
                  <div className="sy-nw-composer-tools">
                    {AI_ACTIONS.map((action) => (
                      <button type="button" key={action.id} className="button small" data-tip={action.tip} disabled={aiBusy || editingId === null} onClick={() => void runAi(action.id)}>{action.label}</button>
                    ))}
                  </div>
                  <div className="sy-nw-composer-submit">
                    <span className="sy-nw-model-slot" data-tip="选择模型与推理等级"><ModelSeat /></span>
                    <button className="icon-button sy-nw-send" type="submit" aria-label="发送给 AI" data-tip="发送" disabled={aiBusy || aiPrompt.trim() === "" || editingId === null}>
                      {aiBusy ? <LoaderCircle size={17} className="sy-spin" /> : <Sparkles size={17} />}
                    </button>
                  </div>
                </div>
              </form>
            </>
          )}
          {error !== "" ? <p className="sy-nw-error" role="alert">{error}</p> : null}
        </section>

        {/* 右：笔记图谱（默认展示当前课程全部笔记的关联；双击画布或点放大看大图） */}
        <aside className="sy-nw-graph" aria-label="笔记图谱">
          <NotesGraph courseId={courseId} refreshKey={graphEpoch} fill />
        </aside>
      </div>

      {/* 需求一：应用内确认框（替代 window.confirm，不阻塞渲染进程） */}
      {confirmAsk && (
        <div className="sy-overlay" onClick={() => setConfirmAsk(null)}>
          <section className="sy-modal sy-confirm-inline" role="alertdialog" aria-modal="true" aria-label="需要确认" onClick={event => event.stopPropagation()}>
            <header><h2>需要确认</h2><button aria-label="关闭确认" onClick={() => setConfirmAsk(null)}><X size={19} /></button></header>
            <p>{confirmAsk.message}</p>
            <div className="sy-row">
              <button className={confirmAsk.danger ? "sy-danger" : "sy-primary"} type="button" autoFocus onClick={() => { const ask = confirmAsk; setConfirmAsk(null); ask.run(); }}>{confirmAsk.confirmLabel}</button>
              <button type="button" onClick={() => setConfirmAsk(null)}>取消</button>
            </div>
          </section>
        </div>
      )}

      {/* 关联选择浮层 */}
      {linking && (
        <div className="sy-nw-link-pick" role="dialog" aria-label="关联到">
          <div className="sy-nw-link-pick-head"><span>关联到…</span><button type="button" aria-label="取消关联" onClick={() => { setLinking(false); setPendingLink(null); }}><X size={13} /></button></div>
          {notes.filter((n) => n.id !== editingId).length === 0
            ? <p className="sy-muted">没有其他笔记可关联</p>
            : notes.filter((n) => n.id !== editingId).map((n) => (
              <button type="button" className="sy-nw-link-opt" key={n.id} onClick={() => insertLink(n.title)}>
                <Link2 size={11} />{n.title}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
