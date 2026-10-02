'use client';
import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { workbenchRpc } from '../services';
export interface UiPreferences {name:string;theme:'light'|'dark';dailyMinutes:number;revision:number}
export default function PreferencesEditor({initial,onSaved}:{initial:UiPreferences;onSaved:()=>Promise<void>}) {
  const [draft,setDraft]=useState(initial),[baseline,setBaseline]=useState(initial),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const same=(a:UiPreferences,b:UiPreferences)=>a.name===b.name&&a.theme===b.theme&&a.dailyMinutes===b.dailyMinutes;
  useEffect(()=>{if(initial.revision>baseline.revision&&same(draft,baseline)&&!busy){setDraft(initial);setBaseline(initial);}},[initial,draft,baseline,busy]);
  return <form className="settings-section" onSubmit={async event=>{event.preventDefault();const submitted=draft;setBusy(true);setError('');try{const saved=await workbenchRpc<UiPreferences>('uiPreferences',{...submitted,baseVersion:submitted.revision});setBaseline(saved);setDraft(current=>same(current,submitted)?saved:{...current,revision:saved.revision});await onSaved();}catch(error){setError(error instanceof Error?error.message:'无法保存偏好');}finally{setBusy(false);}}}>
    <header className="settings-section-head"><h3>用户偏好与外观</h3><p>名称与学习默认值保存在本机，外观立即应用到整个工作台。</p></header>
    <div className="settings-group">
      <div className="settings-row"><span className="settings-row-text"><span className="settings-row-title">用户名称</span><span className="settings-row-desc">显示在首页问候与对话中，最多 16 个字。</span></span><input className="settings-input" aria-label="用户名称" maxLength={16} required value={draft.name} onChange={event=>setDraft({...draft,name:event.target.value})}/></div>
      <div className="settings-row"><span className="settings-row-text"><span className="settings-row-title">默认每日学习分钟</span><span className="settings-row-desc">用于新计划的默认值，已确认的课程计划保留原设置。</span></span><span className="settings-input-unit"><input className="settings-input" aria-label="默认每日学习分钟" type="number" min={5} max={480} required value={draft.dailyMinutes} onChange={event=>setDraft({...draft,dailyMinutes:Number(event.target.value)})}/><span>分钟</span></span></div>
      <div className="settings-row settings-row-stack"><span className="settings-row-title">外观</span><div className="settings-cubes">{(['light','dark'] as const).map(theme=><button type="button" key={theme} className={`settings-cube ${theme}${draft.theme===theme?' selected':''}`} aria-pressed={draft.theme===theme} onClick={()=>setDraft({...draft,theme})}>{theme==='light'?<Sun size={16}/>:<Moon size={16}/>}<span>{theme==='light'?'浅色':'深色'}</span></button>)}</div></div>
    </div>
    {initial.revision>draft.revision&&!error&&<p className="settings-note" role="status">偏好已被另一页面修改。未保存输入与原修订号已保留。</p>}
    {(error||initial.revision>draft.revision)&&<p className="settings-note error" role={error?'alert':'status'}>{error}<button type="button" className="settings-btn sm" disabled={busy} onClick={async()=>{try{const latest=await workbenchRpc<UiPreferences>('uiPreferences');setDraft(latest);setBaseline(latest);setError('');}catch(error){setError(error instanceof Error?error.message:'加载失败');}}}>加载最新设置</button></p>}
    <div className="settings-actions"><button className="settings-btn primary" disabled={busy}>{busy?'正在保存…':'保存外观与偏好'}</button></div>
  </form>;
}
