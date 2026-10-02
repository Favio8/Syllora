"use client";

/**
 * 复习相关的两块 UI：「复习间隔设置」与「错题记录」。
 *
 * 原先挂在工作台右侧看板的「复习」标签里；该标签删除后，它们由左侧
 * 「复习与巩固」（Catalog 的 review 视图）按课程渲染——那里能拿到完整
 * CourseView（evidence/dueAt/错题/学习设置），而不是工作台的有损投影。
 */

import { useEffect, useState } from "react";
import type { CourseView } from "../../../types/syllora";
import ReviewDisclosure from "./ReviewDisclosure";

const formatTime = (at:number,zone:string) => new Intl.DateTimeFormat('zh-CN',{timeZone:zone,month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(at);

export function LearningPolicySettings({course,busy,onSave}:{course:CourseView;busy:boolean;onSave:(settings:{baseVersion:number;reviewHours:number[];sessionIdleMinutes:number})=>Promise<boolean>}) {
  const settings=course.learningSettings??{revision:0,reviewHours:[24,72,168],sessionIdleMinutes:30};
  const [baseline,setBaseline]=useState<{revision:number;reviewHours:number[];sessionIdleMinutes:number}>(settings),[dirty,setDirty]=useState(false);
  const [hours,setHours]=useState(settings.reviewHours.map(String)),[idle,setIdle]=useState(String(settings.sessionIdleMinutes)),[error,setError]=useState('');
  const loadLatest=()=>{setBaseline(settings);setHours(settings.reviewHours.map(String));setIdle(String(settings.sessionIdleMinutes));setDirty(false);setError('')};
  useEffect(()=>{if(!dirty&&settings.revision>baseline.revision){setBaseline(settings);setHours(settings.reviewHours.map(String));setIdle(String(settings.sessionIdleMinutes));setError('')}},[settings,baseline.revision,dirty]);
  const stale=settings.revision>baseline.revision;
  return <ReviewDisclosure title="复习间隔设置" icon="settings"><p className="sy-muted">默认 24、72、168 小时，按实际经过时长计算。修改只影响之后新建立的周期，已有到期时间与历史作答不变。</p>{stale&&<div role="status"><p>学习设置已被另一页面修改。你的未保存输入和原修订号已保留；请载入最新设置后重新编辑。</p><button disabled={busy||course.archived} onClick={loadLatest}>放弃草稿并载入最新设置</button></div>}{['首次补强与复测','复测通过后的间隔','后续复习间隔'].map((label,i)=><label key={label}>{label}（小时）<input aria-label={`${label}（小时）`} type="number" min={24} max={8760} step={1} value={hours[i]} disabled={busy||course.archived} onChange={event=>{setHours(hours.map((old,index)=>index===i?event.target.value:old));setDirty(true)}}/></label>)}<label>会话闲置关闭（分钟）<input aria-label="会话闲置关闭（分钟）" type="number" min={5} max={1440} value={idle} disabled={busy||course.archived} onChange={event=>{setIdle(event.target.value);setDirty(true)}}/></label><p>默认 30 分钟无学习操作后关闭，轮询与刷新不续期；修改只影响以后开始的会话。</p>{error&&<p role="alert">{error}</p>}<button disabled={busy||course.archived} onClick={async()=>{const values=hours.map(Number);if(!Number.isInteger(Number(idle))||Number(idle)<5||Number(idle)>1440){setError('闲置关闭请输入 5–1440 的整数分钟。');return}if(values.some(value=>!Number.isSafeInteger(value)||value<24||value>8760)||values[0]!>values[1]!||values[1]!>values[2]!){setError('请输入不递减的三个整数小时，范围 24–8760。');return}setError('');if(await onSave({baseVersion:baseline.revision,reviewHours:values,sessionIdleMinutes:Number(idle)})){setBaseline({revision:baseline.revision+1,reviewHours:values,sessionIdleMinutes:Number(idle)});setDirty(false)}}}>保存未来复习间隔</button></ReviewDisclosure>;
}

export function WrongAnswerHistory({course,pointId,onSource,onDispute}:{course:CourseView;pointId:string;onSource:(id:string)=>void;onDispute:(id:string)=>void}) {
  const wrong=course.questions.filter(question=>question.pointId===pointId&&question.status==='valid'&&course.attempts.some(attempt=>attempt.questionId===question.id&&!attempt.correct));
  if(!wrong.length)return null;
  return <details><summary>错题记录 · {wrong.length} 题</summary>{wrong.map(question=>{
    const attempt=course.attempts.find(attempt=>attempt.questionId===question.id)!;
    return <article className="sy-question" key={question.id} data-learning-kind="question" data-learning-id={question.id}><h4>{question.stem}</h4><p>你的选项 {String.fromCharCode(65+attempt.option)}：{question.options[attempt.option]}</p><small>{attempt.assisted?'辅助学习，不计独立证据':'独立错答'} · {formatTime(attempt.at,course.timezone)}</small>{question.answer!==undefined&&<p>正确选项 {String.fromCharCode(65+question.answer)}：{question.options[question.answer]}</p>}<p>{question.explanation}</p><blockquote>{question.quote}</blockquote><div className="sy-row">{question.sourceIds.map(sourceId=><button key={sourceId} onClick={()=>onSource(sourceId)}>查看错题依据</button>)}<button disabled={course.archived} onClick={()=>onDispute(question.id)}>报告此题问题</button></div></article>;
  })}</details>;
}
