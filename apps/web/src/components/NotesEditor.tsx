"use client";

/**
 * 笔记富文本编辑器（TipTap + Markdown 存储）。
 * - 正文对外始终是 Markdown：图片在正文里存相对路径 `![](assets/x.png)`，`[[双链]]` 原样保留。
 * - 编辑器内部把相对路径换成带 token 的完整 URL 才能显示；保存前再剥回相对路径
 *   （token 绝不写进 .md、也绝不随「AI 续写」发给模型）。
 * - 支持粘贴截图 / 拖入图片文件：先压缩再上传，落盘后插入图片节点。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { Bold, Heading1, Heading2, LoaderCircle } from "lucide-react";
import { api, noteAssetUrl } from "../lib/api";

/** 相对引用 → 带 token 的完整 URL（编辑器内部显示用）。 */
export function resolveAssets(md: string, courseId: string): string {
  return md.replace(/!\[([^\]]*)\]\(assets\/([A-Za-z0-9._-]+)\)/g, (_m, alt: string, name: string) =>
    `![${alt}](${noteAssetUrl(courseId, name)})`,
  );
}
/** 保存前：把带 token 的图片 URL 还原成相对路径。 */
export function stripAssets(md: string): string {
  return md.replace(/!\[([^\]]*)\]\(([^)]*?name=([A-Za-z0-9._-]+)[^)]*)\)/g, (_m, alt: string, _url: string, name: string) =>
    `![${alt}](assets/${name})`,
  );
}

/** 压到最长边 1600px 的 WebP（支持透明，体积小）；返回 base64 与后缀。 */
async function compressImage(file: File): Promise<{ ext: string; data: string }> {
  const bitmap = await createImageBitmap(file);
  const maxDim = 1600;
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法处理图片");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("图片编码失败"))), "image/webp", 0.88),
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return { ext: "webp", data: btoa(bin) };
}

interface Props {
  courseId: string;
  /** 干净 Markdown（相对图片路径）。 */
  value: string;
  /** 切换笔记的标识：变化时重设编辑器内容。 */
  noteId: string | null;
  onChange: (md: string) => void;
  onEditor: (editor: Editor | null) => void;
  onError: (message: string) => void;
  /** 追加到工具栏右侧的按钮（如「关联」）。 */
  extraToolbar?: ReactNode;
}

export default function NotesEditor({ courseId, value, noteId, onChange, onEditor, onError, extraToolbar }: Props) {
  const editorRef = useRef<Editor | null>(null);
  const courseRef = useRef(courseId);
  courseRef.current = courseId;
  const [uploading, setUploading] = useState(false);
  const uploadingRef = useRef(false);

  /** 上传一组图片并插入正文。 */
  const uploadFiles = useCallback(
    async (files: File[]) => {
      const ed = editorRef.current;
      if (!ed || uploadingRef.current) return;
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return;
      uploadingRef.current = true;
      setUploading(true);
      try {
        for (const file of images) {
          const { ext, data } = await compressImage(file);
          const { name } = await api.notes.uploadImage(courseRef.current, { ext, data });
          ed.chain().focus().setImage({ src: noteAssetUrl(courseRef.current, name), alt: file.name }).run();
        }
      } catch (cause) {
        onError(cause instanceof Error ? cause.message : "图片上传失败");
      } finally {
        uploadingRef.current = false;
        setUploading(false);
      }
    },
    [onError],
  );

  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions: [
        StarterKit,
        Image.configure({ allowBase64: false }),
        Placeholder.configure({ placeholder: "支持 Markdown；选中文字点「关联」；可直接粘贴或拖入图片。" }),
        Markdown.configure({ html: false, linkify: true, breaks: true, transformPastedText: true }),
      ],
      content: resolveAssets(value, courseId),
      editorProps: {
        attributes: { class: "sy-nw-prose" },
        handlePaste: (_view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.some((f) => f.type.startsWith("image/"))) {
            void uploadFiles(files);
            return true;
          }
          return false;
        },
        handleDrop: (_view, event) => {
          const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
          if (files.some((f) => f.type.startsWith("image/"))) {
            void uploadFiles(files);
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor: ed }) => {
        const md = (ed.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();
        onChange(stripAssets(md));
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // 暴露给父组件（AI 续写插入、关联插入、滚动到图片）
  useEffect(() => {
    editorRef.current = editor;
    onEditor(editor);
  }, [editor, onEditor]);

  // 切换笔记时重设内容（不触发 onUpdate，避免误标为已修改）
  useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(resolveAssets(value, courseId), { emitUpdate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, editor]);

  const toolbarBtn = (active: boolean) => `sy-nw-tb${active ? " is-active" : ""}`;

  return (
    <div className="sy-nw-editor-root">
      <div className="sy-nw-toolbar" role="toolbar" aria-label="格式">
        <button type="button" className={toolbarBtn(!!editor?.isActive("bold"))} title="加粗" aria-label="加粗"
          onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={15} /></button>
        <span className="sy-nw-tool-sep" />
        <button type="button" className={toolbarBtn(!!editor?.isActive("heading", { level: 1 }))} title="一级标题" aria-label="一级标题"
          onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}><Heading1 size={15} /></button>
        <button type="button" className={toolbarBtn(!!editor?.isActive("heading", { level: 2 }))} title="二级标题" aria-label="二级标题"
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 size={15} /></button>
        <button type="button" className={toolbarBtn(!!editor?.isActive("heading", { level: 3 }))} title="三级标题" aria-label="三级标题"
          onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}><span className="sy-nw-h3">H3</span></button>
        {extraToolbar && <span className="sy-nw-tool-sep" />}
        {extraToolbar}
        {uploading && <span className="sy-nw-tb-busy"><LoaderCircle size={13} className="sy-spin" />图片上传中…</span>}
      </div>
      <EditorContent editor={editor} className="sy-nw-editor-content" />
    </div>
  );
}
