import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { SylloraService } from '../src/syllora.ts'
import { buildPlan, duePointIds, evidence, HOUR, noteChange, planDiff, proposeReviews, publicCourse, recommend, recordNext, refreshNotice, restoreNotice, type Course, type Question } from '../src/syllora-domain.ts'
import type { ResolvedChatConfig } from '../src/config.ts'
import type { StructuredCallClient } from '@syllora/course-builder'

const roots:string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
function fixture():Course {
  return { id:'c',name:'代数',timezone:'Asia/Shanghai',archived:false,createdAt:0,
    materials:[{id:'m',name:'讲义.txt',fingerprint:'hash',status:'ready',accepted:true,pages:0,sources:[{id:'s',materialId:'m',anchor:'段落 1',text:'单位矩阵的主对角线元素为一，其余元素为零。'}]}],
    points:[{id:'p',name:'单位矩阵',chapter:'矩阵',sourceIds:['s']}],scope:['p'],plan:null,draft:null,questions:[],attempts:[],messages:[],actions:[],drafts:{prompt:'',answers:[]},changes:[],notice:null }
}
function addAttempt(course:Course,at:number,correct:boolean,assisted=false):Question {
  const id=randomUUID();const q:Question={id,pointId:'p',taskId:'t',slot:0,family:id,stem:id,options:['一','二','三','四'],answer:0,explanation:'解释',sourceIds:['s'],quote:'主对角线元素为一',status:'valid',assisted}
  course.questions.push(q);course.attempts.push({id:randomUUID(),questionId:id,option:correct?0:1,correct,assisted,at,sequence:course.attempts.length});return q
}
describe('Syllora evidence replay',()=>{
  it('requires two distinct independent answers, then a delayed new question',()=>{
    const c=fixture();addAttempt(c,0,true);expect(evidence(c,'p').state).toBe('待验证');
    addAttempt(c,1000,true);expect(evidence(c,'p').state).toBe('初步掌握');
    const due=1000+24*HOUR;addAttempt(c,due-1000,true);expect(evidence(c,'p').dueAt).toBe(due);expect(evidence(c,'p').state).toBe('初步掌握');
    addAttempt(c,due,true);expect(evidence(c,'p').state).toBe('复测通过');expect(evidence(c,'p').dueAt).toBe(due+72*HOUR);
    addAttempt(c,due+72*HOUR,true);expect(evidence(c,'p').dueAt).toBe(due+72*HOUR+168*HOUR);
  })
  it('resets after failure and does not skip the two-answer recovery',()=>{
    const c=fixture();addAttempt(c,0,true);addAttempt(c,1,true);addAttempt(c,24*HOUR+1,true);addAttempt(c,25*HOUR,false);expect(evidence(c,'p').state).toBe('待加强');
    addAttempt(c,26*HOUR,true);expect(evidence(c,'p').state).toBe('待加强');addAttempt(c,27*HOUR,true);expect(evidence(c,'p').state).toBe('初步掌握');expect(evidence(c,'p').dueAt).toBe(51*HOUR);
  })
  it('ignores assisted answers and duplicate families without breaking a streak',()=>{
    const c=fixture();const q=addAttempt(c,0,true);addAttempt(c,1,false,true);const copy=addAttempt(c,2,true);copy.family=q.family;
    expect(evidence(c,'p').count).toBe(1);addAttempt(c,3,true);expect(evidence(c,'p').state).toBe('初步掌握');
  })
  it('replays disputed evidence, including the sole incorrect answer',()=>{
    const c=fixture();addAttempt(c,0,true);const wrong=addAttempt(c,1,false);expect(evidence(c,'p').state).toBe('待加强');wrong.status='disputed';expect(evidence(c,'p').state).toBe('待验证');
    c.materials[0]!.status='deleted';expect(evidence(c,'p').state).toBe('未评估');expect(evidence(c,'p').dueAt).toBeNull();expect(c.attempts).toHaveLength(2);
  })
  it('hides answer, explanation and quote until exposure or submission',()=>{
    const c=fixture();const q=addAttempt(c,0,true);c.attempts=[];
    expect(publicCourse(c,0).questions[0]).not.toHaveProperty('answer');expect(publicCourse(c,0).questions[0]).not.toHaveProperty('quote');
    q.assisted=true;expect(publicCourse(c,0).questions[0]).toHaveProperty('answer',0);
  })
  it('detects unsplittable tasks and preserves started activities',()=>{
    const c=fixture();const now=Date.UTC(2026,9,1);const tooBig=buildPlan(c,{scope:['p'],dailyMinutes:15,days:7,restDays:[]},now,randomUUID);
    expect(tooBig.feasible).toBe(false);expect(tooBig.overflow).toEqual([{pointId:'p',reason:'task-too-large'}]);
    c.plan=buildPlan(c,{scope:['p'],dailyMinutes:20,days:7,restDays:[]},now,randomUUID);c.plan.tasks[0]!.status='in_progress';
    const draft=buildPlan(c,{scope:['p'],dailyMinutes:20,days:7,restDays:[]},now,randomUUID);expect(draft.tasks).toHaveLength(1);expect(draft.tasks[0]!.id).toBe(c.plan.tasks[0]!.id);
  })
  it('keeps an append-only next action and explains denominator changes',()=>{
    const c=fixture();const now=Date.UTC(2026,9,1);
    expect(recordNext(c,now,()=>'a1','init')).toBe(true);expect(recordNext(c,now+1,()=>'a2','init')).toBe(false);
    c.plan=buildPlan(c,{scope:['p'],dailyMinutes:40,days:7,restDays:[]},now,randomUUID);c.scope=c.plan.scope;c.plan.tasks[0]!.status='in_progress';
    expect(recordNext(c,now+2,()=>'a3','task')).toBe(true);expect(c.actions.map(a=>a.kind)).toEqual(['summary','continue']);
    expect(c.actions[1]!.reason).toContain('进行中');expect(c.actions[1]!.evidenceState).toBe('未评估');
    noteChange(c,now,()=>'n1',null);
    const view=publicCourse(c,now);expect(view.progress.change).toContain('计划 v');expect(view.progress.change).toContain('任务 0 →');expect(view.progress.distribution['未评估']).toBe(1);expect(view.progress.activityLabel).toBeNull();
    const empty=fixture();empty.scope=[];empty.plan=null;expect(publicCourse(empty,now).progress.activityLabel).toBe('暂无任务');expect(publicCourse(empty,now).progress.scopeLabel).toBe('暂无范围');
    const wrong=addAttempt(c,now,false);expect(recommend(c,now).practice?.pointId).toBe('p');c.plan.tasks[0]!.status='todo';wrong.status='disputed';expect(recommend(c,now+3).kind).toBe('retest');
  })
  it('diffs scope and tasks, and stages review without changing the active plan',()=>{
    const c=fixture();const now=Date.UTC(2026,9,1);
    c.plan=buildPlan(c,{scope:['p'],dailyMinutes:40,days:7,restDays:[]},now,randomUUID);c.scope=['p'];
    const moved=structuredClone(c.plan);moved.tasks[0]!.date='2026-10-03';moved.scope=[];
    const diff=planDiff(c.plan,moved);expect(diff.tasksMoved[0]!.from).toBe(c.plan.tasks[0]!.date);expect(diff.tasksMoved[0]!.to).toBe('2026-10-03');expect(diff.scopeRemoved).toEqual(['p']);
    const active=c.plan.tasks.length;const draft=proposeReviews(c,['p'],now,()=>'review');
    expect(c.plan.tasks).toHaveLength(active);expect(draft.tasks.at(-1)!.immediate).toBe(true);expect(draft.feasible).toBe(true);
    c.plan.dailyMinutes=20;const tight=proposeReviews(c,['p'],now,()=>'tight');expect(tight.feasible).toBe(false);expect(tight.overflow).toEqual([{pointId:'p',reason:'window-full'}]);expect(c.plan.tasks).toHaveLength(active);
    addAttempt(c,now,false);expect(duePointIds(c,now+24*HOUR)).toEqual(['p']);expect(proposeReviews(c,['p'],now+24*HOUR,()=>'due').tasks.at(-1)!.immediate).toBe(false);
    expect(restoreNotice(c,now+24*HOUR)?.text).toContain('恢复后有 1 项复习已到期');expect(c.plan.tasks).toHaveLength(active);
    c.notice={kind:'due',pointIds:['p'],text:'有到期复习未排入日程。原计划保持不变。'};expect(refreshNotice(c,now+24*HOUR)).toBe(false);expect(c.notice?.kind).toBe('due');expect(refreshNotice(c,now)).toBe(true);expect(c.notice).toBeNull();
    c.notice={kind:'immediate',pointIds:['p'],text:'即时巩固未排入日程，原复习时间保持不变。'};expect(refreshNotice(c,now)).toBe(false);expect(c.notice?.kind).toBe('immediate');
  })
})

describe('Syllora plan deadlines and estimates',()=>{
  it('pins the window to the deadline in the course timezone across midnight',()=>{
    const c=fixture();const utc=structuredClone(c);utc.timezone='UTC'
    const now=Date.UTC(2026,9,1,23,30) // 2026-10-01 23:30 UTC is already 2026-10-02 in Asia/Shanghai
    const shanghai=buildPlan(c,{scope:['p'],dailyMinutes:40,days:7,restDays:[],deadline:'2026-10-03'},now,randomUUID)
    expect(shanghai.deadline).toBe('2026-10-03');expect(shanghai.tasks[0]!.date).toBe('2026-10-02');expect(shanghai.restDays).toEqual([]);expect(shanghai.estimates).toEqual({})
    const utcPlan=buildPlan(utc,{scope:['p'],dailyMinutes:40,days:7,restDays:[],deadline:'2026-10-03'},now,randomUUID)
    expect(utcPlan.tasks[0]!.date).toBe('2026-10-01')
    const sameDay=buildPlan(c,{scope:['p'],dailyMinutes:40,days:7,restDays:[],deadline:'2026-10-02'},now,randomUUID)
    expect(sameDay.feasible).toBe(true);expect(sameDay.tasks[0]!.date).toBe('2026-10-02')
  })
  it('reports a window-full reason when rest days exhaust the window',()=>{
    const c=fixture();const now=Date.UTC(2026,9,1)
    const allRest=buildPlan(c,{scope:['p'],dailyMinutes:40,days:7,restDays:[0,1,2,3,4,5,6]},now,randomUUID)
    expect(allRest.feasible).toBe(false);expect(allRest.overflow).toEqual([{pointId:'p',reason:'window-full'}])
  })
  it('applies per-point estimates without changing slot counts',()=>{
    const c=fixture();const now=Date.UTC(2026,9,1)
    const estimated=buildPlan(c,{scope:['p'],dailyMinutes:40,days:7,restDays:[],estimates:{p:35}},now,randomUUID)
    expect(estimated.tasks[0]!.minutes).toBe(35);expect(estimated.tasks[0]!.slots).toBe(2);expect(estimated.estimates).toEqual({p:35})
    const oversized=buildPlan(c,{scope:['p'],dailyMinutes:30,days:7,restDays:[],estimates:{p:35}},now,randomUUID)
    expect(oversized.overflow).toEqual([{pointId:'p',reason:'task-too-large'}])
  })
  it('keeps future task identity for move diffs and preserves activity dates',()=>{
    const c=fixture();const now=Date.UTC(2026,9,1) // 2026-10-01 is a Thursday in the course timezone
    const first=buildPlan(c,{scope:['p'],dailyMinutes:40,days:7,restDays:[]},now,randomUUID)
    c.plan=first
    const moved=buildPlan(c,{scope:['p'],dailyMinutes:40,days:7,restDays:[4]},now,randomUUID)
    expect(moved.tasks[0]!.id).toBe(first.tasks[0]!.id);expect(moved.tasks[0]!.date).toBe('2026-10-02')
    const diff=planDiff(first,moved);expect(diff.tasksMoved).toHaveLength(1);expect(diff.tasksRemoved).toHaveLength(0);expect(diff.tasksAdded).toHaveLength(0)
    first.tasks[0]!.status='in_progress';first.tasks[0]!.date='2026-09-28';c.plan=first
    const preserved=buildPlan(c,{scope:['p'],dailyMinutes:40,days:7,restDays:[]},now,randomUUID)
    expect(preserved.tasks.some(t=>t.status==='in_progress'&&t.date==='2026-09-28')).toBe(true);expect(preserved.tasks.filter(t=>t.status==='todo')).toHaveLength(0)
  })
})

const config:ResolvedChatConfig={providerId:'test',model:'test',baseUrl:'http://localhost:9999/v1',apiKey:'fixture-only',apiKeyEnv:null,temperature:0,maxConcurrency:1,defaultMode:'quick'}
async function service(client?:StructuredCallClient){const root=await mkdtemp(join(tmpdir(),'syllora-test-'));roots.push(root);return {root,svc:new SylloraService(root,{config:async()=>config,...(client?{client:()=>client}:{})})}}
async function create(svc:SylloraService){const courseId=randomUUID();await svc.handle('create',{name:'测试课程',requestId:courseId});await svc.handle('import',{courseId,name:'讲义.txt',text:'单位矩阵的主对角线元素为一，其余元素为零。'});return courseId}
async function waitJob(svc:SylloraService){for(let i=0;i<200;i++){const state=await svc.handle('state') as any;if(state.jobs.length&&state.jobs.every((j:any)=>j.state!=='running'))return state;await new Promise(r=>setTimeout(r,10))}throw new Error('job did not settle')}
describe('Syllora persistence and boundaries',()=>{
  it('persists courses, rejects cross-course mutation and deduplicates material',async()=>{
    const {svc,root}=await service();const courseId=await create(svc);
    const duplicate=await svc.handle('import',{courseId,name:'另一名称.txt',text:'单位矩阵的主对角线元素为一，其余元素为零。'}) as any;expect(duplicate.duplicate).toBe(true);
    await expect(svc.handle('rename',{courseId:randomUUID(),name:'越权'})).rejects.toThrow('课程不存在');
    const restored=new SylloraService(root);const state=await restored.handle('state') as any;expect(state.courses).toHaveLength(1);expect(state.courses[0].materials).toHaveLength(1);
  })
  it('blocks unconsented model calls and zero budgets before contacting the model',async()=>{
    let calls=0;const client:StructuredCallClient={async *stream(){calls++;yield {type:'text-delta',text:'{}'}}};const {svc}=await service(client);const courseId=await create(svc);
    await expect(svc.handle('generate',{courseId,requestId:randomUUID(),kind:'outline'})).rejects.toThrow('确认允许');
    await svc.handle('preferences',{consent:true,callLimit:0});await expect(svc.handle('generate',{courseId,requestId:randomUUID(),kind:'outline'})).rejects.toThrow('上限');expect(calls).toBe(0);
  })
  it('runs generation, plan confirmation, fixed grading and dispute replay',async()=>{
    let n=0;const client:StructuredCallClient={async *stream(options){
      const serialized=JSON.stringify(options.messages);const match=serialized.match(/\\"id\\":\\"([a-f0-9-]+)\\"/);const sourceId=match?.[1];
      const value=n++===0?{points:[{chapter:'矩阵',name:'单位矩阵',sourceIds:[sourceId]}]}:n===2?{stem:'单位矩阵主对角线上的值是什么？',options:['一','二','三','四'],answer:0,explanation:'由定义可知为一。',sourceIds:[sourceId],quote:'主对角线元素为一'}:{valid:true,reason:'依据充分'};
      yield {type:'text-delta',text:JSON.stringify(value)};
    }};
    const {svc,root}=await service(client);const courseId=await create(svc);await svc.handle('preferences',{consent:true,callLimit:10});
    await svc.handle('generate',{courseId,requestId:randomUUID(),kind:'outline'});let state=await waitJob(svc);expect(state.jobs[0].state).toBe('succeeded');
    const pointId=state.courses[0].points[0].id;await svc.handle('plan',{courseId,scope:[pointId],dailyMinutes:40,days:7,baseVersion:0});
    state=await svc.handle('state') as any;expect(state.courses[0].plan).toBeNull();await svc.handle('confirmPlan',{courseId,baseVersion:0,draftId:state.courses[0].draft.id});
    state=await svc.handle('state') as any;expect(state.courses[0].progress.change).toContain('任务 0 →');expect(state.courses[0].actions.some((a:any)=>a.trigger==='plan')).toBe(true);
    await svc.handle('review',{courseId,pointId});state=await svc.handle('state') as any;expect(state.courses[0].plan.tasks).toHaveLength(1);expect(state.courses[0].draft.tasks.at(-1).immediate).toBe(true);
    await svc.handle('rejectPlan',{courseId});state=await svc.handle('state') as any;expect(state.courses[0].plan.tasks).toHaveLength(1);expect(state.courses[0].draft).toBeNull();expect(state.courses[0].notice.text).toContain('即时巩固');
    await svc.handle('review',{courseId,pointId});state=await svc.handle('state') as any;await svc.handle('confirmPlan',{courseId,baseVersion:state.courses[0].draft.baseVersion,draftId:state.courses[0].draft.id});
    state=await svc.handle('state') as any;expect(state.courses[0].plan.tasks).toHaveLength(2);expect(state.courses[0].notice).toBeNull();expect(state.courses[0].progress.change).toContain('新增即时巩固');
    await expect(svc.handle('confirmPlan',{courseId,baseVersion:0})).rejects.toThrow();
    state=await svc.handle('state') as any;const taskId=state.courses[0].plan.tasks[0].id;
    await svc.handle('generate',{courseId,requestId:randomUUID(),kind:'question',taskId,slot:0});state=await waitJob(svc);expect(state.jobs.at(-1).state).toBe('succeeded');
    const q=state.courses[0].questions[0];expect(q.answer).toBeUndefined();
    await svc.handle('saveDraft',{courseId,prompt:'未提交的问题',answers:[{questionId:q.id,option:2}]});state=await svc.handle('state') as any;expect(state.courses[0].drafts.answers).toEqual([{questionId:q.id,option:2}]);expect(state.courses[0].attempts).toHaveLength(0);expect(state.courses[0].evidence[pointId].state).toBe('未评估');
    const requestId=randomUUID();
    await svc.handle('submit',{courseId,questionId:q.id,requestId,option:1});await svc.handle('submit',{courseId,questionId:q.id,requestId,option:1});
    state=await svc.handle('state') as any;expect(state.courses[0].attempts).toHaveLength(1);expect(state.courses[0].evidence[pointId].state).toBe('待加强');
    expect(state.courses[0].actions.at(-1).trigger).toBe('grade');expect(state.courses[0].next.practice.pointId).toBe(pointId);expect(state.courses[0].progress.distribution['待加强']).toBe(1);
    await svc.handle('dispute',{courseId,questionId:q.id,reason:'来源不支持'});state=await svc.handle('state') as any;expect(state.courses[0].evidence[pointId].state).toBe('未评估');expect(state.courses[0].attempts).toHaveLength(1);
    expect(state.courses[0].next.kind).toBe('retest');expect(state.courses[0].actions.at(-1).trigger).toBe('dispute');expect(state.courses[0].actions.length).toBeGreaterThan(1);
    const disk=JSON.parse(await readFile(join(root,'syllora.json'),'utf8'));expect(disk.calls).toBe(3);
  })
  it('does not resurrect a deleted course when generation returns late',async()=>{
    let release!:()=>void;const gate=new Promise<void>(r=>{release=r});const client:StructuredCallClient={async *stream(){await gate;yield {type:'text-delta',text:JSON.stringify({text:'资料不足',sourceIds:[],insufficient:true})}}};
    const {svc}=await service(client);const courseId=await create(svc);await svc.handle('preferences',{consent:true,callLimit:3});await svc.handle('generate',{courseId,requestId:randomUUID(),kind:'answer',prompt:'什么是单位矩阵？'});
    await svc.handle('delete',{courseId,confirmed:true});release();await new Promise(r=>setTimeout(r,60));const state=await svc.handle('state') as any;expect(state.courses).toHaveLength(0);expect(state.jobs).toHaveLength(0);
  })
  it('stores unsubmitted drafts per course and restores older snapshots',async()=>{
    const {svc,root}=await service();const courseId=await create(svc);const otherId=randomUUID();
    await svc.handle('create',{name:'另一门课程',requestId:otherId,timezone:'Asia/Shanghai'});
    await svc.handle('saveDraft',{courseId,prompt:'还没发送的问题',answers:[{questionId:randomUUID(),option:2}]});
    let state=await svc.handle('state') as any;const course=state.courses.find((c:any)=>c.id===courseId);const other=state.courses.find((c:any)=>c.id===otherId);
    expect(course.drafts.prompt).toBe('还没发送的问题');expect(course.drafts.answers).toEqual([]);expect(course.attempts).toEqual([]);expect(other.drafts.prompt).toBe('');
    expect(course.progress.activityLabel).toBe('暂无任务');expect(course.progress.scopeLabel).toBe('暂无范围');expect(course.actions[0].trigger).toBe('init');
    const disk=JSON.parse(await readFile(join(root,'syllora.json'),'utf8'));delete disk.courses[0].actions;delete disk.courses[0].drafts;delete disk.courses[0].changes;
    await writeFile(join(root,'syllora.json'),JSON.stringify(disk));
    const restored=new SylloraService(root);state=await restored.handle('state') as any;expect(state.courses[0].drafts.prompt).toBe('');expect(state.courses[0].actions[0].trigger).toBe('init');
  })
  it('sends prior course messages when answering a follow-up',async()=>{
    let seen='';const client:StructuredCallClient={async *stream(options){
      seen=JSON.stringify(options.messages);const sourceId=seen.match(/\\"id\\":\\"([a-f0-9-]+)\\"/)?.[1];
      yield {type:'text-delta',text:JSON.stringify({text:'这是只属于上一轮回答的标记。',sourceIds:[sourceId],insufficient:false})};
    }};
    const {svc}=await service(client);const courseId=await create(svc);await svc.handle('preferences',{consent:true,callLimit:4});
    await svc.handle('generate',{courseId,requestId:randomUUID(),kind:'answer',prompt:'什么是单位矩阵？'});await waitJob(svc);
    await svc.handle('generate',{courseId,requestId:randomUUID(),kind:'answer',prompt:'请换一种讲法'});await waitJob(svc);
    expect(seen).toContain('什么是单位矩阵');expect(seen).toContain('这是只属于上一轮回答的标记');expect(seen).toContain('不能作为资料来源');
    const state=await svc.handle('state') as any;expect(state.courses[0].drafts.prompt).toBe('');expect(state.courses[0].messages).toHaveLength(4);
  })
  it('records accepted material and restores a due backlog without changing the plan',async()=>{
    let now=Date.UTC(2026,9,1);let n=0;const client:StructuredCallClient={async *stream(options){
      const sourceId=JSON.stringify(options.messages).match(/\\"id\\":\\"([a-f0-9-]+)\\"/)?.[1];
      const value=n++===0?{points:[{chapter:'矩阵',name:'单位矩阵',sourceIds:[sourceId]}]}:n===2?{stem:'单位矩阵主对角线上的值是什么？',options:['一','二','三','四'],answer:0,explanation:'由定义可知为一。',sourceIds:[sourceId],quote:'主对角线元素为一'}:{valid:true,reason:'依据充分'};
      yield {type:'text-delta',text:JSON.stringify(value)};
    }};
    const root=await mkdtemp(join(tmpdir(),'syllora-test-'));roots.push(root);
    const svc=new SylloraService(root,{now:()=>now,config:async()=>config,client:()=>client});
    const courseId=await create(svc);const opened=await svc.handle('state') as any;const materialId=opened.courses[0].materials[0].id;
    await svc.handle('acceptMaterial',{courseId,materialId});
    let state=await svc.handle('state') as any;expect(state.courses[0].actions.at(-1).trigger).toBe('material');
    await svc.handle('preferences',{consent:true,callLimit:10});
    await svc.handle('generate',{courseId,requestId:randomUUID(),kind:'outline'});state=await waitJob(svc);
    const pointId=state.courses[0].points[0].id;await svc.handle('plan',{courseId,scope:[pointId],dailyMinutes:40,days:7,baseVersion:0});
    state=await svc.handle('state') as any;await svc.handle('confirmPlan',{courseId,baseVersion:0,draftId:state.courses[0].draft.id});
    state=await svc.handle('state') as any;const taskCount=state.courses[0].plan.tasks.length;const taskId=state.courses[0].plan.tasks[0].id;
    await svc.handle('generate',{courseId,requestId:randomUUID(),kind:'question',taskId,slot:0});state=await waitJob(svc);
    await svc.handle('submit',{courseId,questionId:state.courses[0].questions[0].id,requestId:randomUUID(),option:1});
    now+=24*HOUR;await svc.handle('archive',{courseId,archived:true});await svc.handle('archive',{courseId,archived:false});
    state=await svc.handle('state') as any;expect(state.courses[0].plan.tasks).toHaveLength(taskCount);expect(state.courses[0].notice.kind).toBe('restore');expect(state.courses[0].notice.text).toContain('恢复后有');
    await svc.handle('proposeRestore',{courseId});state=await svc.handle('state') as any;expect(state.courses[0].plan.tasks).toHaveLength(taskCount);expect(state.courses[0].draft.tasks.length).toBeGreaterThan(taskCount);
  })
  it('plans with a deadline and estimates end to end, rejecting stale confirms',async()=>{
    let n=0;const client:StructuredCallClient={async *stream(options){
      const sourceId=JSON.stringify(options.messages).match(/\\"id\\":\\"([a-f0-9-]+)\\"/)?.[1];
      const value=n++===0?{points:[{chapter:'矩阵',name:'单位矩阵',sourceIds:[sourceId]}]}:{valid:true,reason:'ok'};
      yield {type:'text-delta',text:JSON.stringify(value)};
    }};
    let now=Date.UTC(2026,9,1);const root=await mkdtemp(join(tmpdir(),'syllora-test-'));roots.push(root);
    const svc=new SylloraService(root,{now:()=>now,config:async()=>config,client:()=>client});
    const courseId=await create(svc);await svc.handle('preferences',{consent:true,callLimit:5});
    await svc.handle('generate',{courseId,requestId:randomUUID(),kind:'outline'});let state=await waitJob(svc);
    const pointId=state.courses[0].points[0].id;
    await expect(svc.handle('plan',{courseId,scope:[pointId],dailyMinutes:40,days:7,restDays:[],baseVersion:0,deadline:'2026-09-30'})).rejects.toThrow('目标日期已过');
    for (const deadline of ['2027-02-30','2027-13-01','2027-00-15','2027-04-31']) await expect(svc.handle('plan',{courseId,scope:[pointId],dailyMinutes:40,days:7,restDays:[],baseVersion:0,deadline})).rejects.toThrow('有效');
    await expect(svc.handle('plan',{courseId,scope:[pointId],dailyMinutes:40,days:7,restDays:[],baseVersion:0,deadline:'2028-01-01'})).rejects.toThrow('366 天');
    await svc.handle('plan',{courseId,scope:[pointId],dailyMinutes:40,days:7,restDays:[],baseVersion:0,deadline:'2026-10-02',estimates:{[pointId]:35}});
    let draft=(await svc.handle('state') as any).courses[0].draft;
    expect(draft.deadline).toBe('2026-10-02');expect(draft.estimates).toEqual({[pointId]:35});expect(draft.tasks[0].minutes).toBe(35);expect(draft.tasks[0].date).toBe('2026-10-01');expect(draft.feasible).toBe(true);
    const staleId=draft.id;
    await svc.handle('plan',{courseId,scope:[pointId],dailyMinutes:40,days:7,restDays:[],baseVersion:0,deadline:'2026-10-02',estimates:{[pointId]:25}});
    await expect(svc.handle('confirmPlan',{courseId,baseVersion:0,draftId:staleId})).rejects.toThrow('另一页面更新了草案');
    draft=(await svc.handle('state') as any).courses[0].draft;
    now=Date.UTC(2026,9,3);
    await expect(svc.handle('confirmPlan',{courseId,baseVersion:0,draftId:draft.id})).rejects.toThrow('目标日期已过');
    now=Date.UTC(2026,9,1);
    await svc.handle('confirmPlan',{courseId,baseVersion:0,draftId:draft.id});
    state=await svc.handle('state') as any;const plan=state.courses[0].plan;
    expect(plan.version).toBe(1);expect(plan.tasks[0].minutes).toBe(25);expect(plan.tasks[0].slots).toBe(2);expect(plan.deadline).toBe('2026-10-02')
  })
  it('migrates legacy plan snapshots with string overflow on load',async()=>{
    const {svc,root}=await service();const courseId=await create(svc);
    const disk=JSON.parse(await readFile(join(root,'syllora.json'),'utf8'));
    disk.courses[0].plan={id:'legacy',version:1,baseVersion:0,scope:['p'],tasks:[],overflow:['p'],dailyMinutes:40,feasible:false};
    await writeFile(join(root,'syllora.json'),JSON.stringify(disk));
    const restored=new SylloraService(root);const state=await restored.handle('state') as any;
    const plan=state.courses.find((c:any)=>c.id===courseId).plan;
    expect(plan.overflow).toEqual([{pointId:'p',reason:'window-full'}]);expect(plan.deadline).toBeNull();expect(plan.restDays).toEqual([]);expect(plan.estimates).toEqual({});
  })
})
