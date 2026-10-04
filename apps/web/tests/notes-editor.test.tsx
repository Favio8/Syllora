import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/react';
import NotesEditor from '../src/components/NotesEditor';

afterEach(cleanup);
async function open(value = '普通文字') {
  let editor: Editor | null = null;
  const onChange = vi.fn(), onError = vi.fn();
  const view = render(<NotesEditor courseId="course" noteId="note" value={value} onChange={onChange} onEditor={ed => { editor = ed; }} onError={onError} />);
  await waitFor(() => expect(editor).not.toBeNull());
  return { ...view, editor: editor!, onChange, onError };
}
const markdown = (editor: Editor) => (editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();

describe('笔记 Markdown 编辑器', () => {
  it('persists highlighted and italic text through Markdown serialization and reopen', async () => {
    const { editor } = await open();
    act(() => { editor.commands.selectAll(); });
    fireEvent.click(screen.getByRole('button', { name: '高亮' }));
    fireEvent.click(screen.getByRole('button', { name: '斜体' }));
    const saved = markdown(editor);
    expect(saved).toContain('=='); expect(saved).toContain('*');
    act(() => { editor.commands.setContent(saved); });
    expect(editor.getHTML()).toContain('<mark>'); expect(editor.getHTML()).toContain('<em>');
    expect(screen.getByRole('button', { name: '高亮' })).toHaveAttribute('aria-pressed');
  });
  it('renders lists, fenced code and quotes, supports undo, and preserves Markdown AI insertion', async () => {
    const { editor, container } = await open();
    act(() => { editor.commands.selectAll(); editor.commands.insertContent('## 小结\n\n- 第一项\n- 第二项\n\n```js\nconst x = 1;\n```\n\n> 引用'); });
    expect(container.querySelector('h2')).toHaveTextContent('小结');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('pre code')).toHaveTextContent('const x = 1;');
    expect(container.querySelector('blockquote')).toHaveTextContent('引用');
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(editor.getText()).toBe('普通文字');
    fireEvent.click(screen.getByRole('button', { name: '重做' }));
    expect(editor.getText()).toContain('小结');
  });
  it('keeps the text selection when applying a link and rejects executable URLs', async () => {
    const { editor, onError } = await open();
    act(() => { editor.commands.selectAll(); });
    fireEvent.click(screen.getByRole('button', { name: '链接' }));
    fireEvent.change(screen.getByLabelText('链接地址'), { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(screen.getByRole('button', { name: '应用链接' }));
    expect(onError).toHaveBeenCalled(); expect(editor.getHTML()).not.toContain('<a');
    fireEvent.change(screen.getByLabelText('链接地址'), { target: { value: 'https://example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '应用链接' }));
    expect(markdown(editor)).toContain('[普通文字](https://example.com)');
  });
});
