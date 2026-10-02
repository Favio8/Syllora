'use client';
import { useEffect, useState } from 'react';
import { workbenchRpc } from '../services';
export interface UiPreferences {name:string;theme:'light'|'dark';dailyMinutes:number;revision:number}
export default function PreferencesEditor({initial,onSaved}:{initial:UiPreferences;onSaved:()=>Promise<void>}) {
  const [draft,setDraft]=useState(initial),[baseline,setBaseline]=useState(initial),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const same=(a:UiPreferences,b:UiPreferences)=>a.name===b.name&&a.theme===b.theme&&a.dailyMinutes===b.dailyMinutes;
  useEffect(()=>{if(initial.revision>baseline.revision&&same(draft,baseline)&&!busy){setDraft(initial);setBaseline(initial);}},[initial,draft,baseline,busy]);
  return <form className="integrated-preferences" onSubmit={async event=>{event.preventDefault();const submitted=draft;setBusy(true);setError('');try{const saved=await workbenchRpc<UiPreferences>('uiPreferences',{...submitted,baseVersion:submitted.revision});setBaseline(saved);setDraft(current=>same(current,submitted)?saved:{...current,revision:saved.revision});await onSaved();}catch(error){setError(error instanceof Error?error.message:'无法保存偏好');}finally{setBusy(false);}}}>
    <h3>用户偏好与外观</h3><label>用户名称<input aria-label="用户名称" maxLength={16} required value={draft.name} onChange={event=>setDraft({...draft,name:event.target.value})}/></label>
    <label>默认每日学习分钟<input aria-label="默认每日学习分钟" type="number" min={5} max={480} required value={draft.dailyMinutes} onChange={event=>setDraft({...draft,dailyMinutes:Number(event.target.value)})}/></label>
    <p>用于新计划的默认值，已确认的课程计划保留原设置。</p><div className="appearance-preview-grid">{(['light','dark'] as const).map(theme=><button type="button" key={theme} className={`appearance-preview ${theme} ${draft.theme===theme?'selected':''}`} aria-pressed={draft.theme===theme} onClick={()=>setDraft({...draft,theme})}>{theme==='light'?'浅色':'深色'}</button>)}</div>
    {initial.revision>draft.revision&&!error&&<p role="status">偏好已被另一页面修改。未保存输入与原修订号已保留。</p>}
    {(error||initial.revision>draft.revision)&&<p role={error?'alert':'status'}>{error}<button type="button" disabled={busy} onClick={async()=>{try{const latest=await workbenchRpc<UiPreferences>('uiPreferences');setDraft(latest);setBaseline(latest);setError('');}catch(error){setError(error instanceof Error?error.message:'加载失败');}}}>加载最新设置</button></p>}
    <button className="sy-primary" disabled={busy}>{busy?'正在保存…':'保存外观与偏好'}</button>
  </form>;
}
