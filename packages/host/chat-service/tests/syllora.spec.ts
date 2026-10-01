import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { SylloraService } from '../src/syllora.ts'
import { buildPlan, diffPlan, evidence, HOUR, publicCourse, type Course, type Plan, type Question } from '../src/syllora-domain.ts'
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

describe('Syllora new features',()=>{
  // Helper: create a course with an outline point (matching existing test pattern)
  async function createWithPoint():Promise<{svc:SylloraService;courseId:string}>{
    let n=0;const client:StructuredCallClient={async *stream(options){
      const serialized=JSON.stringify(options.messages);const match=serialized.match(/\\"id\\":\\"([a-f0-9-]+)\\"/);const sourceId=match?.[1];
      const value=n++===0?{points:[{chapter:'矩阵',name:'单位矩阵',sourceIds:[sourceId]}]}:{valid:true,reason:'ok'};
      yield {type:'text-delta',text:JSON.stringify(value)};
    }};
    const {svc}=await service(client);const courseId=await create(svc);await svc.handle('preferences',{consent:true,callLimit:10});
    await svc.handle('generate',{courseId,requestId:randomUUID(),kind:'outline'});
    const settled=await waitJob(svc);
    const job=settled.jobs.find((j:any)=>j.courseId===courseId);
    if(job?.state!=='succeeded')throw new Error(`outline gen failed: ${job?.message}`);
    return {svc,courseId}
  }
  describe('adjustTaskMinutes',()=>{
    it('preserves adjusted minutes and increments version without changing id',async()=>{
      const {svc,courseId}=await createWithPoint();
      const state=await svc.handle('state') as any;const pid=state.courses[0].points[0].id;
      await svc.handle('plan',{courseId,scope:[pid],dailyMinutes:40,days:7,restDays:[],baseVersion:0});
      const s1=await svc.handle('state') as any;const draft=s1.courses[0].draft;const taskId=draft.tasks.find((t:any)=>t.status==='todo').id;const oldId=draft.id;const oldVersion=draft.version;
      await svc.handle('adjustTaskMinutes',{courseId,taskId,minutes:35});
      const s2=await svc.handle('state') as any;const d2=s2.courses[0].draft;
      const updated=d2.tasks.find((t:any)=>t.id===taskId);expect(updated.minutes).toBe(35);
      expect(d2.id).toBe(oldId);expect(d2.version).toBe(oldVersion+1);
    })
    it('recomputes overflow when minutes exceed the daily budget',async()=>{
      const {svc,courseId}=await createWithPoint();
      const pid=(await svc.handle('state') as any).courses[0].points[0].id;
      await svc.handle('plan',{courseId,scope:[pid],dailyMinutes:40,days:7,restDays:[],baseVersion:0});
      let s=await svc.handle('state') as any;
      expect(s.courses[0].draft.overflow).toHaveLength(0);
      expect(s.courses[0].draft.feasible).toBe(true);
      const taskId=s.courses[0].draft.tasks.find((t:any)=>t.status==='todo').id;
      await svc.handle('adjustTaskMinutes',{courseId,taskId,minutes:50});
      s=await svc.handle('state') as any;
      expect(s.courses[0].draft.overflow.length).toBeGreaterThan(0);
      expect(s.courses[0].draft.feasible).toBe(false);
    })
  })
  describe('wrong-answer planAdjustment',()=>{
    it.skip('returns GENERATED on first wrong answer (needs LLM mock)',async()=>{})
  })
  describe('diffPlan pure function',()=>{
    const id=()=>'id';const now=Date.UTC(2026,9,1);
    const makeCourse=(overrides?:Partial<Course>):Course=>({id:'c',name:'代数',timezone:'Asia/Shanghai',archived:false,createdAt:0,
      materials:[{id:'m',name:'讲义.txt',fingerprint:'hash',status:'ready',accepted:true,pages:0,sources:[{id:'s',materialId:'m',anchor:'段落1',text:'单位矩阵的主对角线元素为一，其余元素为零。'}]}],
      points:[{id:'a',name:'单位矩阵',chapter:'矩阵',sourceIds:['s']},{id:'b',name:'转置',chapter:'矩阵',sourceIds:['s']}],scope:['a','b'],
      plan:null,draft:null,questions:[],attempts:[],messages:[],...overrides})
    it('returns all tasks as added when oldPlan is null',()=>{
      const c=makeCourse();c.plan=buildPlan(c,{scope:['a','b'],dailyMinutes:40,days:7,restDays:[]},now,id);
      const result=diffPlan(null,c.plan);expect(result.added.length).toBeGreaterThan(0);expect(result.removed).toHaveLength(0);expect(result.moved).toHaveLength(0);
    })
    it('same plan compared to itself yields only unchanged',()=>{
      const c=makeCourse();c.plan=buildPlan(c,{scope:['a'],dailyMinutes:40,days:7,restDays:[]},now,id);
      const result=diffPlan(c.plan,c.plan);expect(result.unchanged.length).toBeGreaterThan(0);expect(result.added).toHaveLength(0);expect(result.removed).toHaveLength(0);
    })
    it('date change results in moved tasks',()=>{
      const c=makeCourse();c.plan=buildPlan(c,{scope:['a'],dailyMinutes:40,days:7,restDays:[]},now,id);
      const oldPlan=JSON.parse(JSON.stringify(c.plan)) as Plan;
      c.plan.tasks.forEach(t=>{if(t.status==='todo')t.date='2026-10-10'});
      const result=diffPlan(oldPlan,c.plan);expect(result.added).toHaveLength(0);expect(result.moved.length).toBeGreaterThan(0);
    })
    it('removed todo task appears in removed',()=>{
      const c=makeCourse();c.plan=buildPlan(c,{scope:['a'],dailyMinutes:40,days:1,restDays:[]},now,id);
      const oldPlan=JSON.parse(JSON.stringify(c.plan)) as Plan;
      c.plan.tasks=c.plan.tasks.filter(t=>t.status!=='todo');
      const result=diffPlan(oldPlan,c.plan);expect(result.removed.length).toBeGreaterThan(0);
    })
    it('different cycle review tasks are not conflated',()=>{
      const c=makeCourse();
      const t1={id:'r1',pointId:'a',kind:'review' as const,date:'2026-10-02',minutes:10,status:'todo' as const,explained:true,slots:1,cycle:1000};
      const t2={id:'r2',pointId:'a',kind:'review' as const,date:'2026-10-03',minutes:10,status:'todo' as const,explained:true,slots:1,cycle:2000};
      c.plan={id:'p1',version:1,baseVersion:0,scope:['a'],tasks:[t1,t2],overflow:[],dailyMinutes:40,feasible:true,days:7,restDays:[]};
      const newDraft={id:'p2',version:2,baseVersion:1,scope:['a'],tasks:[t1,t2],overflow:[],dailyMinutes:40,feasible:true,days:7,restDays:[]};
      const result=diffPlan(c.plan,newDraft);expect(result.moved).toHaveLength(0);expect(result.unchanged.length).toBe(2);
    })
  })
  describe('reorderPoints validation',()=>{
    it('rejects incomplete, duplicate or foreign point id arrays',async()=>{
      const {svc,courseId}=await createWithPoint();
      const state=await svc.handle('state') as any;const pid=state.courses[0].points[0].id;
      await expect(svc.handle('reorderPoints',{courseId,pointIds:[pid]})).resolves.toEqual({saved:true});
      await expect(svc.handle('reorderPoints',{courseId,pointIds:[pid,pid]})).rejects.toThrow('知识点顺序无效');
      await expect(svc.handle('reorderPoints',{courseId,pointIds:['00000000-0000-0000-0000-000000000000']})).rejects.toThrow('知识点顺序无效');
    })
  })
  describe('targetDate timezone-aware',()=>{
    it('rejects dates more than 90 days out',async()=>{
      const {svc,courseId}=await createWithPoint();
      const state=await svc.handle('state') as any;const pid=state.courses[0].points[0].id;
      await expect(svc.handle('plan',{courseId,scope:[pid],dailyMinutes:40,targetDate:'2030-01-01',restDays:[],baseVersion:0})).rejects.toThrow('目标日期超出 90 天上限');
    })
  })
})
