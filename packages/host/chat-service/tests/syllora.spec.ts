import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { SylloraService } from '../src/syllora.ts'
import { buildPlan, evidence, HOUR, publicCourse, type Course, type Question } from '../src/syllora-domain.ts'
import type { ResolvedChatConfig } from '../src/config.ts'
import type { StructuredCallClient } from '@studyclaw/course-builder'

const roots:string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
function fixture():Course {
  return { id:'c',name:'代数',timezone:'Asia/Shanghai',archived:false,createdAt:0,
    materials:[{id:'m',name:'讲义.txt',fingerprint:'hash',status:'ready',accepted:true,pages:0,sources:[{id:'s',materialId:'m',anchor:'段落 1',text:'单位矩阵的主对角线元素为一，其余元素为零。'}]}],
    points:[{id:'p',name:'单位矩阵',chapter:'矩阵',sourceIds:['s']}],scope:['p'],plan:null,draft:null,questions:[],attempts:[],messages:[] }
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
    const c=fixture();const now=Date.UTC(2026,9,1);expect(buildPlan(c,{scope:['p'],dailyMinutes:15,days:7,restDays:[]},now,randomUUID).feasible).toBe(false);
    c.plan=buildPlan(c,{scope:['p'],dailyMinutes:20,days:7,restDays:[]},now,randomUUID);c.plan.tasks[0]!.status='in_progress';
    const draft=buildPlan(c,{scope:['p'],dailyMinutes:20,days:7,restDays:[]},now,randomUUID);expect(draft.tasks).toHaveLength(1);expect(draft.tasks[0]!.id).toBe(c.plan.tasks[0]!.id);
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
    await expect(svc.handle('confirmPlan',{courseId,baseVersion:0})).rejects.toThrow();
    state=await svc.handle('state') as any;const taskId=state.courses[0].plan.tasks[0].id;
    await svc.handle('generate',{courseId,requestId:randomUUID(),kind:'question',taskId,slot:0});state=await waitJob(svc);expect(state.jobs.at(-1).state).toBe('succeeded');
    const q=state.courses[0].questions[0];expect(q.answer).toBeUndefined();const requestId=randomUUID();
    await svc.handle('submit',{courseId,questionId:q.id,requestId,option:1});await svc.handle('submit',{courseId,questionId:q.id,requestId,option:1});
    state=await svc.handle('state') as any;expect(state.courses[0].attempts).toHaveLength(1);expect(state.courses[0].evidence[pointId].state).toBe('待加强');
    await svc.handle('dispute',{courseId,questionId:q.id,reason:'来源不支持'});state=await svc.handle('state') as any;expect(state.courses[0].evidence[pointId].state).toBe('未评估');expect(state.courses[0].attempts).toHaveLength(1);
    const disk=JSON.parse(await readFile(join(root,'syllora.json'),'utf8'));expect(disk.calls).toBe(3);
  })
  it('does not resurrect a deleted course when generation returns late',async()=>{
    let release!:()=>void;const gate=new Promise<void>(r=>{release=r});const client:StructuredCallClient={async *stream(){await gate;yield {type:'text-delta',text:JSON.stringify({text:'资料不足',sourceIds:[],insufficient:true})}}};
    const {svc}=await service(client);const courseId=await create(svc);await svc.handle('preferences',{consent:true,callLimit:3});await svc.handle('generate',{courseId,requestId:randomUUID(),kind:'answer',prompt:'什么是单位矩阵？'});
    await svc.handle('delete',{courseId,confirmed:true});release();await new Promise(r=>setTimeout(r,60));const state=await svc.handle('state') as any;expect(state.courses).toHaveLength(0);expect(state.jobs).toHaveLength(0);
  })
})
