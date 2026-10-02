"use client";
import { useEffect, useRef, useState } from 'react';
import ReviewDisclosure from '../features/workbench/components/ReviewDisclosure';
import type { CourseView, SylloraState, Task } from '../types/syllora';
type Rpc=(action:string,payload:Record<string,unknown>)=>Promise<unknown>;

/** Record rendered objects only after they enter the viewport; never count generation as display. */
export function useLearningExposures(course:CourseView|undefined,rpc:Rpc,tab:string) {
  const recorded=useRef(new Set<string>()),pending=useRef(new Set<string>());
  const [error,setError]=useState('');
  useEffect(()=>{
    setError('');if(!course||course.archived||typeof IntersectionObserver==='undefined')return;
    let alive=true;
    const observer=new IntersectionObserver(entries=>{
      const objects:Array<{kind:'answer'|'question';id:string}>=[];
      for(const entry of entries) {
        if(!entry.isIntersecting||entry.intersectionRatio<=0)continue;
        const element=entry.target as HTMLElement,kind=element.dataset.learningKind,id=element.dataset.learningId;
        if(!id||!kind)continue;
        const key=`${course.id}:${kind}:${id}`;
        if(recorded.current.has(key)||pending.current.has(key))continue;
        pending.current.add(key);
        if(kind==='draft')void rpc('recordDraftExposure',{courseId:course.id,draftId:id}).then(()=>{recorded.current.add(key)},()=>{if(alive)setError('展示记录未能保存，下一次同步会重试。')}).finally(()=>pending.current.delete(key));
        else if(kind==='answer'||kind==='question')objects.push({kind,id});
      }
      for(let offset=0;offset<objects.length;offset+=50) {
        const batch=objects.slice(offset,offset+50),keys=batch.map(object=>`${course.id}:${object.kind}:${object.id}`);
        void rpc('recordExposure',{courseId:course.id,objects:batch}).then(()=>{keys.forEach(key=>recorded.current.add(key))},()=>{if(alive)setError('展示记录未能保存，下一次同步会重试。')}).finally(()=>keys.forEach(key=>pending.current.delete(key)));
      }
    },{threshold:0});
    document.querySelectorAll('[data-learning-id]').forEach(element=>observer.observe(element));
    return()=>{alive=false;observer.disconnect()};
  },[course,rpc,tab]);
  return error;
}

export function SessionControls({course,task,busy,onRun}:{course:CourseView;task:Task|undefined;busy:boolean;onRun:(action:string,payload:Record<string,unknown>)=>Promise<unknown>}) {
  const [help,setHelp]=useState(''),requestId=useRef<string|null>(null);
  const session=course.activeSession;
  return <section aria-label="本次学习会话" className="sy-notice">{session?<><p>本次学习已开始{session.mode==='synthetic'?' · 合成验证，单列统计':''}。刷新和切课保留会话；闲置 {session.idleMinutes} 分钟后关闭。</p><button disabled={busy||course.archived} onClick={()=>void onRun('endSession',{sessionId:session.id})}>结束本次学习</button><details><summary>记录额外人工帮助</summary><p>只在本课程保存帮助原因，不发送给模型。</p><label>帮助原因<textarea aria-label="人工帮助原因" value={help} maxLength={1000} onChange={event=>{setHelp(event.target.value);requestId.current=null}}/></label><button disabled={busy||course.archived||!help.trim()} onClick={async()=>{requestId.current??=crypto.randomUUID();if(await onRun('recordHelp',{reason:help,requestId:requestId.current})){setHelp('');requestId.current=null}}}>保存人工帮助记录</button></details></>:<><p>点击任务「继续」或「开始本次学习」后记录本次会话。浏览历史与自动同步不会开始会话。</p>{task&&task.status==='in_progress'&&!(course.blockedPointIds??[]).includes(task.pointId)&&<button disabled={busy||course.archived} onClick={()=>void onRun('start',{taskId:task.id})}>开始本次学习</button>}</>}</section>;
}

const rate=(value:number|null)=>value===null?'暂无可计算样本':`${(value*100).toFixed(1)}%`;
const duration=(value:number|null)=>value===null?'未记录':`${(value/1000).toFixed(1)} 秒`;
export function LearningMetrics({course}:{course:CourseView}) {
  const metrics=course.metrics;if(!metrics)return null;
  const last=metrics.sessions.at(-1);
  return <ReviewDisclosure title="学习过程记录" icon="history"><p>闭环采用点击开始后 24 小时观察窗，至少一条有效独立作答及对应下一行动。尚未到观察窗结束的会话单列，争议或来源失效后重新计算。</p><p>普通时钟：闭环 {metrics.standard.closedLoops} / 已观察 {metrics.standard.observed} · {rate(metrics.standard.rate)} · 待观察 {metrics.standard.pending}</p><p>合成验证：闭环 {metrics.synthetic.closedLoops} / 已观察 {metrics.synthetic.observed} · {rate(metrics.synthetic.rate)} · 待观察 {metrics.synthetic.pending}</p>{last&&<p>最近会话首次有效反馈 {duration(last.firstFeedbackMs)}；已记录生成等待 {duration(last.systemWaitMs)}；其余经过时间 {duration(last.otherElapsedMs)}。其余时间包括阅读、操作及未单独测量的本地处理，不能作为精确用户用时。</p>}<p>来源报错 {metrics.sourceReports.reported} / 展示对象 {metrics.sourceReports.shown} · {rate(metrics.sourceReports.rate)}（用户报错，不是确认错误率）</p><p>调整草案接受 {metrics.planAdjustments.accepted} / 展示 {metrics.planAdjustments.shown} · {rate(metrics.planAdjustments.rate)}</p><p>人工帮助 {metrics.helpCount} 次 · 未关联会话的作答 {metrics.untrackedAttempts} 条，不补造会话。</p></ReviewDisclosure>;
}

export function LearningJobDiagnostics({jobs}:{jobs:SylloraState['jobs']}) {
  return <ReviewDisclosure title="生成执行诊断" icon="activity"><p>以下为最近 10 个任务。只显示供应商实际返回的用量；部分调用缺失时，已取得合计不代表全部用量。</p>{jobs.length===0?<p>尚无生成任务。</p>:[...jobs].slice(-10).reverse().map(job=><article key={job.id}><p>{job.state} · 调用 {job.calls} 次{job.errorCode?` · ${job.errorCode}`:''}</p><p>已取得输入 {job.inputTokens===null?'未取得':job.inputTokens} / 输出 {job.outputTokens===null?'未取得':job.outputTokens} token；输入覆盖 {job.usageKnownCalls?`${job.usageKnownCalls.input}/${job.calls}`:'旧记录未知'} 次，输出覆盖 {job.usageKnownCalls?`${job.usageKnownCalls.output}/${job.calls}`:'旧记录未知'} 次。</p><small>提示 {job.promptVersion??'旧记录未知'} · 规则 {job.ruleVersion??'旧记录未知'} · 耗时 {duration(job.elapsedMs??null)}</small></article>)}</ReviewDisclosure>;
}
