"use client";

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, BookOpen, Bot, LoaderCircle, Paperclip, PencilLine, Square } from 'lucide-react';
import MessageCard from './MessageCard';
import ApprovalPanel from './ApprovalPanel';
import QueueDock from './QueueDock';
import WakeupCard from './WakeupCard';
import ModelSeat from './ModelSeat';
import AgentPermissionPicker from './AgentPermissionPicker';
import { useChatStream } from '@/src/hooks/useChatStream';
import { useSessionActions } from '@/src/hooks/useSessionActions';
import { useAppStore } from '@/src/store/useAppStore';

/** 输入框自动增高的上限：再高就内部滚动，免得把对话区挤没。 */
const COMPOSER_MAX_HEIGHT = 180;

/** Original learning workspace shell, backed by the existing streaming Agent. */
export default function WorkbenchChat({ courseName, children, onUpload, onPractice, onAgentManage, onOpenSettings, disabled = false }: {
  courseName: string; children?: ReactNode; onUpload: () => void; onPractice: () => void; onAgentManage?: () => void; onOpenSettings?: () => void; disabled?: boolean;
}) {
  const messages = useAppStore(s => s.messages);
  const streaming = useAppStore(s => s.streaming);
  const pendingAsk = useAppStore(s => s.pendingAsk);
  const sessionId = useAppStore(s => s.activeSessionId);
  const courseId = useAppStore(s => s.activeCourseId);
  const folder = useAppStore(s => s.workspacePath);
  const wakeup = useAppStore(s => s.wakeupCard);
  const banner = useAppStore(s => s.sessionBanner);
  const key = `${folder ?? ''}\0${courseId ?? ''}\0${sessionId ?? 'new'}`;
  const value = useAppStore(s => s.composerDrafts[key] ?? '');
  const setDraft = useAppStore(s => s.setComposerDraft);
  const setChatFocus = useAppStore(s => s.setChatFocus);
  const flash = useAppStore(s => s.flashStatusBanner);
  const { send, answer, retryLast, stop } = useChatStream();
  const { forkSession } = useSessionActions();
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true);
  const [answering, setAnswering] = useState(false);
  useEffect(() => { follow.current = true; }, [sessionId, courseId]);
  useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [messages, streaming]);
  // 输入框自动增高：下边界固定（composer 是底部弹性列的最后一项），内容越多只向上长。
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [value]);
  async function submit() {
    if (!value.trim() || disabled || streaming || answering) return;
    if (pendingAsk) {
      setAnswering(true);
      try { if (await answer(value.trim())) setDraft(key, ''); } finally { setAnswering(false); }
    } else { void send(value.trim()); setDraft(key, ''); }
    input.current?.focus();
  }
  async function branch(index: number) {
    if (!sessionId || !courseId) return;
    try { await forkSession(sessionId, courseId, index); }
    catch (error) { flash(`无法创建分支：${error instanceof Error ? error.message : String(error)}`); }
  }
  let persistedIndex = -1;
  let lastUserText = '';
  return <div className="workbench-chat">
    <div className="workbench-chat-scroll" ref={scroll} onScroll={() => { const el = scroll.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64; }}>
      {children}
      {banner && !banner.includes('模式') && <p className="workbench-chat-status" role="status">{banner}</p>}
      <div className="agent-runtime agent-message-list">
        {wakeup && <WakeupCard card={wakeup} />}
        {!messages.length && <div className="workbench-chat-welcome"><span className="brand-icon"><BookOpen size={21} /></span><div><strong>Syllora <small>学习伙伴</small></strong><p>关于{courseName}，有什么想一起弄明白的？<br />从一个问题开始，或用练习检查你的理解。</p></div></div>}
        {messages.map(message => {
          const persisted = message.persisted !== false && (message.role === 'user' || Boolean(message.content));
          if (persisted) persistedIndex++;
          const index = persistedIndex;
          if (message.role === 'user' && message.persisted !== false) lastUserText = message.content;
          const retryText = lastUserText;
          return <div className={`agent-message ${message.role}`} key={message.id}><MessageCard message={message} onRetry={message.error ? () => retryLast(retryText) : undefined} onBranch={persisted && sessionId ? () => branch(index) : undefined} branchUnavailable={streaming} /></div>;
        })}
        {streaming && <div className="workbench-chat-status" role="status"><LoaderCircle size={15} className="spin" />正在准备回答…</div>}
      </div>
    </div>
    <div className="workbench-composer">
      <div className="agent-runtime"><ApprovalPanel agentId={sessionId ? `study-${sessionId}` : null} /><QueueDock /></div>
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <textarea ref={input} aria-label="向学习伙伴提问" value={value} disabled={disabled} placeholder={pendingAsk ? '回答学习伙伴的问题…' : `关于${courseName}，有什么想一起弄明白的？`} onChange={event => setDraft(key, event.target.value)} onFocus={() => setChatFocus(true)} onBlur={() => setChatFocus(false)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
        {/* 功能键与发送键同处输入框内的一行：左组是工具与权限，右组是模型与发送。
            悬停提示由 data-tip 的 CSS 气泡渲染（显示在按键上方）。 */}
        <div className="composer-toolbar">
          <div className="composer-tools">
            <button type="button" className="button small" data-tip="导入或重新整理课程资料" disabled={disabled} onClick={onUpload}><Paperclip size={16} />上传资料</button>
            <button type="button" className="button small" data-tip="打开本轮练习" disabled={disabled} onClick={onPractice}><PencilLine size={16} />练习</button>
            {onAgentManage ? <button type="button" className="button small" data-tip="Agent 预设、插件与技能" disabled={disabled} onClick={onAgentManage}><Bot size={16} />Agent 管理</button> : null}
            <span className="composer-permission-slot" data-tip="Agent 的操作权限"><AgentPermissionPicker disabled={disabled} onSaved={flash} /></span>
          </div>
          <div className="composer-submit">
            <span className="composer-model-slot" data-tip="选择模型与推理等级"><ModelSeat {...(onOpenSettings ? { onOpenSettings } : {})} /></span>
            {streaming ? <button type="button" className="icon-button" aria-label="停止生成" data-tip="停止生成" onClick={stop}><Square size={17} /></button> : <button className="icon-button composer-send" aria-label="发送消息" data-tip="发送" disabled={!value.trim() || disabled || answering}><ArrowUp size={19} /></button>}
          </div>
        </div>
      </form>
    </div>
  </div>;
}
