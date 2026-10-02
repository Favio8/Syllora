"use client";

/**
 * 笔记整页工作区。
 * 三栏：笔记列表（含图片树）｜ 富文本编辑器 ｜ AI 助手。
 * 正文始终是 Markdown（`[[双链]]` + `![](assets/x.png)`），图谱与后端解析不受影响。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Image as ImageIcon, Link2, LoaderCircle, Plus, Sparkles, Trash2, X } from "lucide-react";
import type { Editor } from "@tiptap/react";
import { api } from "../lib/api";
import type { NoteMeta } from "../types/api";
import NotesEditor from "./NotesEditor";
import LearningModeSwitch from "../features/workbench/components/LearningModeSwitch";

interface Props {
  courseId: string;
  courseName: string;
  onClose: () => void;
  onEpoch: () => void;
  /** 切到对话学习 / 辅助阅读：由外壳负责离开笔记页并设置学习模式。 */
  onSwitchMode: (mode: 'chat' | 'reading') => void;
}

const formatUpdated = (at: number) => new Date(at).toLocaleString("zh-CN", { hour12: false });

export default function NotesWorkspace({ courseId, courseName, onClose, onEpoch, onSwitchMode }: Props) {
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
  // AI 续写
  const [suggestText, setSuggestText] = useState("");
  const [suggestSources, setSuggestSources] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);

  const newTitleRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const loadedRef = useRef<{ title: string; content: string } | null>(null);

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

  const open = useCallback(
    async (noteId: string) => {
      setError("");
      try {
        const result = await api.notes.read(courseId, noteId);
        setEditingId(noteId);
        setTitle(result.meta.title);
        setContent(result.content);
        setSavedLinks(result.meta.wikilinks);
        setSuggestText("");
        setSuggestSources([]);
        setLinking(false);
        setPendingLink(null);
        loadedRef.current = { title: result.meta.title, content: result.content };
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "无法打开笔记");
      }
    },
    [courseId],
  );

  const dirty = editingId !== null && loadedRef.current !== null && (title !== loadedRef.current.title || content !== loadedRef.current.content);
  /** 未保存修改的守卫；返回 true 表示可以离开。 */
  const confirmLeave = () => !dirty || window.confirm("这篇笔记有未保存的修改，确定放弃并返回？");
  const closeWithGuard = () => {
    if (!confirmLeave()) return;
    onClose();
  };
  /** 切模式前走同一条守卫，避免静默丢掉未保存的修改。 */
  const switchMode = (surface: 'chat' | 'reading' | 'notes') => {
    if (surface === 'notes') return;
    if (!confirmLeave()) return;
    onSwitchMode(surface);
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
      onEpoch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "新建笔记失败");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (editingId === null || title.trim() === "" || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.notes.update(courseId, editingId, { title: title.trim(), content });
      setTitle(result.meta.title);
      setSavedLinks(result.meta.wikilinks);
      loadedRef.current = { title: result.meta.title, content };
      await load();
      onEpoch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存笔记失败");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (noteId: string) => {
    if (busy) return;
    if (!window.confirm("删除这篇笔记？正文与其中的图片会一并删除，无法撤销。")) return;
    setBusy(true);
    setError("");
    try {
      await api.notes.delete(courseId, noteId);
      if (editingId === noteId) {
        setEditingId(null); setTitle(""); setContent(""); setSavedLinks([]); loadedRef.current = null;
      }
      await load();
      onEpoch();
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

  /** AI 续写：把「标题 + 光标前文」发给宿主。 */
  const handleSuggest = async () => {
    const ed = editorRef.current;
    if (!ed || suggesting) return;
    const prefix = ed.state.doc.textBetween(0, ed.state.selection.from, "\n");
    setSuggesting(true);
    setError("");
    setSuggestText("");
    setSuggestSources([]);
    try {
      const res = await api.notes.suggest(courseId, { title: title.trim(), prefix });
      setSuggestText(res.continuation);
      setSuggestSources(res.sourceIds);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "AI 续写失败");
    } finally {
      setSuggesting(false);
    }
  };

  const insertSuggestion = () => {
    const ed = editorRef.current;
    if (!ed || !suggestText) return;
    ed.chain().focus().insertContent(suggestText).run();
    setSuggestText("");
    setSuggestSources([]);
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
                  <button type="button" className="sy-nw-item-btn" onClick={() => { if (dirty && !window.confirm("有未保存的修改，切换将放弃，确定？")) return; void open(note.id); }}>
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
                onEditor={(ed) => { editorRef.current = ed; }}
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
            </>
          )}
          {error !== "" ? <p className="sy-nw-error" role="alert">{error}</p> : null}
        </section>

        {/* 右：AI 助手 */}
        <aside className="sy-nw-ai">
          <div className="sy-nw-ai-head"><Sparkles size={14} /><span>AI 助手</span></div>
          {editingId === null ? (
            <p className="sy-muted">选择一篇笔记后，可让 AI 依据课程资料续写。</p>
          ) : (
            <>
              <button className="sy-nw-ai-run" disabled={suggesting} onClick={() => void handleSuggest()}>
                {suggesting ? <><LoaderCircle size={14} className="sy-spin" />生成中…</> : <><Sparkles size={14} />续写</>}
              </button>
              {suggestText && (
                <div className="sy-nw-ai-card" data-testid="notes-suggestion">
                  <p className="sy-nw-ai-text">{suggestText}</p>
                  {suggestSources.length > 0 && <p className="sy-nw-ai-src"><ImageIcon size={11} />依据 {suggestSources.length} 个资料片段</p>}
                  <div className="sy-nw-ai-btns">
                    <button className="sy-primary" onClick={insertSuggestion}>插入<small>Tab</small></button>
                    <button onClick={() => { setSuggestText(""); setSuggestSources([]); }}>丢弃</button>
                  </div>
                </div>
              )}
              {!suggestText && !suggesting && (
                <p className="sy-nw-ai-hint">把光标放在要续写的位置，点「续写」；出现建议后点「插入」采纳，内容插到光标处。</p>
              )}
            </>
          )}
        </aside>
      </div>

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
