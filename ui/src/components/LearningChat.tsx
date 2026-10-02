'use client';

import { useEffect, useRef } from 'react';
import { ArrowRight, ArrowUp, BookOpen, Sparkles, Paperclip, Clock3, Check, LoaderCircle, PencilLine } from 'lucide-react';
import type { Course, Task } from '@/types';

function VectorDrawing() {
  return <svg className="vector-drawing" viewBox="0 0 180 145" aria-label="向量空间示意图" role="img"><defs><pattern id="grid" width="18" height="18" patternUnits="userSpaceOnUse"><path d="M 18 0 L 0 0 0 18" fill="none" stroke="currentColor" strokeOpacity=".12" strokeWidth=".7" /></pattern><marker id="arrow-blue" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="none" stroke="currentColor" strokeWidth="1.4" /></marker></defs><rect x="5" y="5" width="162" height="126" rx="9" fill="url(#grid)" /><path d="M25 112H161 M42 128V12" stroke="currentColor" strokeOpacity=".22" strokeWidth="1" /><path d="M42 112L128 32" stroke="currentColor" strokeWidth="2.2" markerEnd="url(#arrow-blue)" /><path d="M42 112L147 77" stroke="currentColor" strokeWidth="2.2" markerEnd="url(#arrow-blue)" /><path d="M128 32L147 77" stroke="currentColor" strokeOpacity=".35" strokeDasharray="4 4" /><circle cx="42" cy="112" r="3.5" fill="currentColor" /><text x="129" y="23" fill="currentColor" fontSize="12" fontStyle="italic">v₁</text><text x="153" y="76" fill="currentColor" fontSize="12" fontStyle="italic">v₂</text><text x="27" y="130" fill="currentColor" fontSize="10" opacity=".45">O</text></svg>;
}

export default function LearningChat({ course, name, sending, busy, input, onInput, onSend, onStudy, onUpload, onPractice }: { course: Course; name: string; sending: boolean; busy: boolean; input: string; onInput: (value: string) => void; onSend: (content: string) => Promise<void>; onStudy: (task: Task) => void; onUpload: () => void; onPractice: () => void }) {
  const bottom = useRef<HTMLDivElement>(null);
  const nextTask = course.tasks.find(t => !t.completed);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' }); }, [course.messages.length, sending]);
  async function submit(content = input) {
    if (!content.trim() || busy) return;
    await onSend(content.trim());
  }
  return <div className="learning-workspace">
    <div className="chat-scroll">
      <div className="workspace-intro"><span className="eyebrow">把每一门课，变成自己的知识</span><h1>今天，也向前一点。</h1><p>{name}，欢迎回到你的学习空间。</p></div>
      <section className="next-step"><div className="next-copy"><span className="blue-eyebrow"><span className="tiny-blue-dot" />{nextTask ? '今日下一步' : course.tasks.length ? '今日学习已完成' : '开始你的学习'}</span><h2>{nextTask?.title ?? (course.tasks.length ? '慢慢积累，终会看见变化' : `为「${course.name}」添加第一份资料`)}</h2><p>{course.chapter}{nextTask && <><span className="dot-separator">·</span><Clock3 size={13} />{nextTask.minutes} 分钟</>}</p><button className="button primary" onClick={() => nextTask ? onStudy(nextTask) : course.tasks.length ? void submit('给我一道练习') : onUpload()}>{nextTask ? '开始学习' : course.tasks.length ? '再做一道练习' : '添加资料'}<ArrowRight size={16} /></button></div><VectorDrawing /></section>
      <div className="chat-section-title"><h3><Sparkles size={15} />学习对话</h3><span>思考，提问，再理解</span></div>
      {!course.messages.length && <div className="chat-empty"><span className="assistant-avatar"><BookOpen size={22} /></span><h3>这门课，从你的第一个问题开始。</h3><p>说说你想学什么，或先添加一份课程资料。</p></div>}
      <div className="messages">{course.messages.map(message => <article className={`message ${message.role}`} key={message.id}><span className={message.role === 'assistant' ? 'assistant-avatar' : 'user-avatar'}>{message.role === 'assistant' ? <BookOpen size={17} /> : name.charAt(0)}</span><div className="message-body"><div className="message-meta"><strong>{message.role === 'assistant' ? 'Syllora' : name}</strong><span>{message.role === 'assistant' ? '学习伙伴' : '你'}</span>{message.role === 'assistant' && <span className="demo-badge">演示回复</span>}</div><div className="message-text">{message.content.split('\n\n').map((p, index) => <p key={index}>{p}</p>)}</div>{message.id === 'welcome-linear' && <div className="concept-note"><span className="concept-line" /><div><strong>一个值得记住的直觉</strong><p>线性相关：向量没有带来新的独立方向。</p></div></div>}</div></article>)}{sending && <div className="message assistant"><span className="assistant-avatar"><BookOpen size={17} /></span><div className="thinking" role="status"><span /><span /><span />正在准备演示回复</div></div>}</div>
      <div ref={bottom} />
    </div>
    <div className="composer-wrap"><div className="suggestions">{['用直观例子解释', '帮我安排今天'].map(text => <button disabled={busy} key={text} onClick={() => void submit(text)}>{text}<ArrowUp size={12} /></button>)}</div><form className="composer" onSubmit={e => { e.preventDefault(); void submit(); }}><label className="sr-only" htmlFor="chat-input">向 Syllora 提问</label><textarea id="chat-input" rows={2} maxLength={2000} value={input} onChange={e => onInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }} placeholder={`关于${course.name}，有什么想一起弄明白的？`} /><div className="composer-controls"><span className="composer-hint">Enter 发送 · Shift + Enter 换行</span><button className="send-button" type="submit" disabled={!input.trim() || busy} aria-label="发送消息">{sending ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={18} />}</button></div></form><div className="composer-actions"><button onClick={onPractice}><PencilLine size={16} />练习</button><button onClick={onUpload}><Paperclip size={16} />添加资料</button><span><Check size={11} />对话使用模拟数据</span></div></div>
  </div>;
}
