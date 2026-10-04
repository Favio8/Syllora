'use client';
import { useEffect, useRef, useState } from 'react';
import type { CourseView, SylloraState } from '@/src/types/syllora';
import { workbenchRpc } from './services';

type Local = {baseVersion:number;scope:string[];estimates:Record<string,string>;dirty:boolean;sequence:number};
const storageKey='syllora.planning-drafts.v1';
function fromCourse(course:CourseView):Local {
  return {baseVersion:course.planningDraft?.revision??0,scope:[...(course.planningDraft?.scope??course.draft?.scope??course.scope)],estimates:Object.fromEntries(Object.entries(course.planningDraft?.estimates??course.draft?.estimates??course.plan?.estimates??{}).map(([id,n])=>[id,String(n)])),dirty:false,sequence:0};
}
function restored():Record<string,Local> {
  if(typeof window==='undefined')return {};
  try {
    const value:unknown=JSON.parse(localStorage.getItem(storageKey)||'{}');
    if(!value||typeof value!=='object'||Array.isArray(value))return {};
    const result:Record<string,Local>={};
    for(const [id,item] of Object.entries(value)) {
      const v=item as Partial<Local>|null;
      if(!v||typeof v.baseVersion!=='number'||!Number.isSafeInteger(v.baseVersion)||v.baseVersion<0||!Array.isArray(v.scope)||!v.scope.every(point=>typeof point==='string')||!v.estimates||typeof v.estimates!=='object'||Array.isArray(v.estimates)||!Object.values(v.estimates).every(n=>typeof n==='string')||typeof v.dirty!=='boolean')continue;
      result[id]={baseVersion:v.baseVersion!,scope:v.scope,estimates:v.estimates,dirty:v.dirty,sequence:Number.isSafeInteger(v.sequence)?v.sequence!:0};
    }
    return result;
  }catch{return {};}
}
export function usePlanningDraft(course:CourseView|undefined) {
  const records=useRef<Record<string,Local>|null>(null);
  records.current??=restored();
  const flights=useRef(new Map<string,Promise<boolean>>());
  const [status,setStatus]=useState('');
  const [,rerender]=useState(0);
  const currentId=useRef(course?.id);currentId.current=course?.id;
  const persisted=course?.planningDraft;
  if(course) {
    const existing=records.current[course.id];
    if(!existing||(!existing.dirty&&(persisted?.revision??0)>existing.baseVersion))records.current[course.id]=fromCourse(course);
  }
  const local=course?records.current[course.id]:undefined;
  const store=()=>{try{localStorage.setItem(storageKey,JSON.stringify(records.current));}catch{setStatus('恢复缓存未能写入，请点击保存配置。')}};
  const edit=(change:Partial<Pick<Local,'scope'|'estimates'>>)=>{if(!course||course.archived)return;const old=records.current![course.id]!;records.current![course.id]={...old,...change,dirty:true,sequence:old.sequence+1};store();setStatus('待保存');rerender(n=>n+1);};
  const save=async(id=course?.id):Promise<boolean>=>{
    if(!id)return true;
    const pending=flights.current.get(id);if(pending){if(!await pending)return false;return save(id);}
    const draft=records.current![id];if(!draft?.dirty)return true;
    const estimates=Object.fromEntries(Object.entries(draft.estimates).filter(([,value])=>value.trim()!=='').map(([key,value])=>[key,Number(value)]));
    if(Object.values(estimates).some(n=>!Number.isInteger(n)||n<5||n>240)){setStatus('任务估时请输入 5–240 的整数分钟。');return false;}
    if(currentId.current===id)setStatus('正在保存…');
    const request=(async()=>{try {
      const result=await workbenchRpc<{revision:number}>('planningDraft',{courseId:id,baseVersion:draft.baseVersion,scope:draft.scope,estimates});
      const next=records.current![id]!;records.current![id]={...next,baseVersion:result.revision,dirty:next.sequence!==draft.sequence};store();
      if(currentId.current===id)setStatus(next.sequence===draft.sequence?'已保存':'待保存');return true;
    }catch(cause){if(currentId.current===id)setStatus(cause instanceof Error?cause.message:'保存失败，当前选择已保留。');return false;}finally{flights.current.delete(id);}})();
    flights.current.set(id,request);return request;
  };
  useEffect(()=>{if(!local?.dirty||course?.archived)return;const id=course?.id;const timer=setTimeout(()=>void save(id),450);return()=>clearTimeout(timer);},[course?.id,local?.sequence]);
  useEffect(()=>setStatus(local?.dirty?'待保存':''),[course?.id]);
  const reload=async()=>{
    if(!course)return;
    const id=course.id;
    const pending=flights.current.get(id);if(pending)await pending;
    try {
      const state=await workbenchRpc<SylloraState>('state');
      const latest=state.courses.find(item=>item.id===id);
      if(!latest)throw new Error('课程已不存在，当前输入仍已保留。');
      records.current![id]=fromCourse(latest);store();rerender(n=>n+1);
      if(currentId.current===id)setStatus('已载入最新配置');
    }catch(error){if(currentId.current===id)setStatus(error instanceof Error?error.message:'无法读取最新配置，当前输入已保留。');}
  };
  return {scope:local?.scope??[],estimates:local?.estimates??{},setScope:(scope:string[])=>edit({scope}),setEstimates:(estimates:Record<string,string>)=>edit({estimates}),savePlanning:save,planningStatus:status,reloadPlanning:reload};
}
