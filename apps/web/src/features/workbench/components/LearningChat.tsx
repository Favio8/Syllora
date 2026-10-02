'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, BookOpen, Sparkles, Paperclip, Square, PencilLine, Settings2, Plus } from 'lucide-react';
import { useAppStore } from '@/src/store/useAppStore';
import { useChatStream } from '@/src/hooks/useChatStream';
import { useSessionActions } from '@/src/hooks/useSessionActions';
import MarkdownView from '@/src/components/chat/MarkdownView';
import ToolFold from '@/src/components/chat/ToolFold';
import ThinkingFold from '@/src/components/chat/ThinkingFold';
import AskFold from '@/src/components/chat/AskFold';
import ApprovalPanel from '@/src/components/chat/ApprovalPanel';
import QueueDock from '@/src/components/chat/QueueDock';
export function VectorDrawing() {
  return <svg className="vector-drawing" viewBox="0 0 180 145" aria-label="向量空间示意图" role="img"><defs><pattern id="grid" width="18" height="18" patternUnits="userSpaceOnUse"><path d="M 18 0 L 0 0 0 18" fill="none" stroke="currentColor" strokeOpacity=".12" strokeWidth=".7" /></pattern><marker id="arrow-blue" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="none" stroke="currentColor" strokeWidth="1.4" /></marker></defs><rect x="5" y="5" width="162" height="126" rx="9" fill="url(#grid)" /><path d="M25 112H161 M42 128V12" stroke="currentColor" strokeOpacity=".22" strokeWidth="1" /><path d="M42 112L128 32" stroke="currentColor" strokeWidth="2.2" markerEnd="url(#arrow-blue)" /><path d="M42 112L147 77" stroke="currentColor" strokeWidth="2.2" markerEnd="url(#arrow-blue)" /><path d="M128 32L147 77" stroke="currentColor" strokeOpacity=".35" strokeDasharray="4 4" /><circle cx="42" cy="112" r="3.5" fill="currentColor" /><text x="129" y="23" fill="currentColor" fontSize="12" fontStyle="italic">v₁</text><text x="153" y="76" fill="currentColor" fontSize="12" fontStyle="italic">v₂</text><text x="27" y="130" fill="currentColor" fontSize="10" opacity=".45">O</text></svg>;
}


export default function LearningChat({courseName,name,folder,disabled,children,draft,onDraft,onUpload,onPractice,onOpenSettings}:{courseName:string;name:string;folder:string;disabled?:boolean;children?:ReactNode;draft?:string;onDraft?:(value:string)=>void;onUpload?:()=>void;onPractice?:()=>void;onOpenSettings?:()=>void}) {
  const messages=useAppStore(s=>s.messages);
  const streaming=useAppStore(s=>s.streaming);
  const sessionId=useAppStore(s=>s.activeSessionId);
  const courseId=useAppStore(s=>s.activeCourseId);
  const pendingAsk=useAppStore(s=>s.pendingAsk);
  const key=`syllora:chat-draft:${folder}`;
  const storedDraft=useAppStore(s=>s.composerDrafts[key]??'');
  const input=draft??storedDraft;
  const liveInput=useRef(input);liveInput.current=input;
  const setDraft=useAppStore(s=>s.setComposerDraft);
  const {send,answer,retryLast,stop}=useChatStream();
  const {createSession}=useSessionActions();
  const [storageError,setStorageError]=useState('');
  const [submitting,setSubmitting]=useState(false);
  const submittingRef=useRef(false);
  const scroll=useRef<HTMLDivElement>(null);
  const follow=useRef(true);
  useEffect(()=>{if(onDraft)return;try{const saved=localStorage.getItem(key);if(saved&&!useAppStore.getState().composerDrafts[key])setDraft(key,saved);}catch{setStorageError('草稿暂时无法在本机保存，请保留此页面。');}},[key,setDraft]);
  useEffect(()=>{const el=scroll.current;if(el&&follow.current&&messages.length>0)el.scrollTop=el.scrollHeight;},[messages,streaming]);
  function change(value:string,owner=key){setDraft(owner,value);if(onDraft){onDraft(value);return;}try{if(value)localStorage.setItem(owner,value);else localStorage.removeItem(owner);setStorageError('');}catch{setStorageError('草稿暂时无法在本机保存，请保留此页面。');}}
  async function submit(content=input){
    if(disabled||streaming||submittingRef.current||!content.trim()||!folder)return;
    const owner=key,ownerCourse=courseId,fromInput=content===input,before=useAppStore.getState().messages.length;
    submittingRef.current=true;setSubmitting(true);
    // Clear immediately: send() resolves only after the whole streamed turn.
    if(fromInput)change('',owner);
    try {
      const delivered=pendingAsk?await answer(content.trim()):(await send(content.trim()),useAppStore.getState().messages.length>before);
      const current=useAppStore.getState();
      // Restore only when nothing entered the transcript and the user has not typed since.
      if(!delivered&&fromInput&&current.activeCourseId===ownerCourse&&liveInput.current==='')change(content,owner);
    }finally{submittingRef.current=false;setSubmitting(false);}
  }
  return <div className="learning-workspace">
    <div className="chat-scroll" ref={scroll} onScroll={()=>{const el=scroll.current;if(el)follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<80;}}>
      <div className="workspace-intro"><span className="eyebrow">把每一门课，变成自己的知识</span><h1>今天，也向前一点。</h1><p>{name}，欢迎回到你的学习空间。</p></div>
      {children}
      {folder&&<><div className="chat-section-title"><h3><Sparkles size={15}/>学习对话</h3><button className="text-button" disabled={streaming||disabled} onClick={()=>void createSession()}><Plus size={14}/>新对话</button></div>
      {!messages.length&&<div className="chat-empty"><span className="assistant-avatar"><BookOpen size={22}/></span><h3>这门课，从你的第一个问题开始。</h3><p>说说你想学什么，或先添加一份课程资料。</p></div>}
      <div className="messages">{messages.map((message,index)=>{
        const assistant=message.role==='agent';
        const retryText=messages.slice(0,index).findLast(item=>item.role==='user')?.content;
        return <article className={`message ${assistant?'assistant':'user'}`} key={message.id}>
          <span className={assistant?'assistant-avatar':'user-avatar'}>{assistant?<BookOpen size={17}/>:name.charAt(0)}</span>
          <div className="message-body"><div className="message-meta"><strong>{assistant?'Syllora':name}</strong><span>{assistant?'学习伙伴':'你'}</span></div>
          {message.thinking&&<ThinkingFold thinking={message.thinking} thinkingMs={message.thinkingMs}/>}
          {!!message.tools?.length&&<ToolFold tools={message.tools}/>}
          {message.ask&&<AskFold question={message.ask.question}/>}
          {message.content&&<div className="message-text"><MarkdownView content={message.content} streaming={message.streaming}/></div>}
          {message.error&&<div className="chat-failure" role="alert"><p>{message.error}</p><button className="text-button" disabled={streaming||disabled} onClick={()=>void retryLast(retryText)}>重试这条消息</button><button className="text-button" onClick={onOpenSettings}>检查模型配置</button></div>}
          {message.streaming&&!message.content&&<p className="thinking" role="status">正在整理思路…</p>}
          </div>
        </article>;
      })}</div></>}
    </div>
    {folder&&<div className="composer-wrap"><ApprovalPanel agentId={sessionId?`study-${sessionId}`:null}/><QueueDock/>
      <div className="suggestions">{['用直观例子解释','帮我安排今天'].map(text=><button disabled={disabled||streaming||submitting} key={text} onClick={()=>void submit(text)}>{text}<ArrowUp size={12}/></button>)}</div>
      {pendingAsk&&<p className="composer-note">请回答学习助手的问题：{pendingAsk.question}</p>}
      <form className="composer" onSubmit={event=>{event.preventDefault();void submit();}}><label className="sr-only" htmlFor="chat-input">向 Syllora 提问</label><textarea id="chat-input" rows={2} maxLength={4000} value={input} disabled={disabled} onChange={event=>change(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.repeat&&!event.nativeEvent.isComposing){event.preventDefault();void submit();}}} placeholder={`关于${courseName}，有什么想一起弄明白的？`}/><div className="composer-controls"><span className="composer-hint">Enter 发送 · Shift + Enter 换行</span>{streaming?<button className="send-button" type="button" onClick={stop} aria-label="停止生成"><Square size={16}/></button>:<button className="send-button" type="submit" disabled={disabled||!input.trim()||submitting} aria-label="发送消息"><ArrowUp size={18}/></button>}</div></form>
      <div className="composer-actions"><button onClick={onPractice}><PencilLine size={16}/>练习</button><button onClick={onUpload}><Paperclip size={16}/>添加资料</button><button onClick={onOpenSettings}><Settings2 size={15}/>模型设置</button><span>回答与引用请结合资料核验</span></div>{storageError&&<p role="alert" className="composer-note">{storageError}</p>}
    </div>}
  </div>;
}
