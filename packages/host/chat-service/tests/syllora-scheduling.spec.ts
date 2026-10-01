import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPlan, dayStart, duePointIds, evidence, HOUR, pointHasSources, proposeReviews, recommend, type Course } from '../src/syllora-domain.ts'
import { SylloraService } from '../src/syllora.ts'

const roots:string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
const now=Date.UTC(2026,9,1,4)
function fixture():Course {
  const courseId=randomUUID(),pointId=randomUUID(),sourceId=randomUUID()
  return {id:courseId,name:'合成排程课程',timezone:'Asia/Shanghai',archived:false,createdAt:now,
    materials:[{id:randomUUID(),name:'synthetic.txt',fingerprint:'fixture',status:'ready',accepted:true,pages:0,sources:[{id:sourceId,materialId:'fixture',anchor:'段落 1',text:'合成资料：单位矩阵保持向量不变。'}]}],
    points:[{id:pointId,name:'单位矩阵',chapter:'矩阵',sourceIds:[sourceId]}],scope:[pointId],plan:null,draft:null,questions:[],attempts:[],messages:[],actions:[],drafts:{prompt:'',answers:[]},changes:[],notice:null}
}
function plan(course:Course,extra:Partial<Parameters<typeof buildPlan>[1]>={}) {
  course.plan=buildPlan(course,{scope:course.scope,dailyMinutes:20,days:7,restDays:[],...extra},now,randomUUID)
  return course.plan
}
async function stored(course:Course,clock:()=>number=()=>now) {
  const root=await mkdtemp(join(tmpdir(),'syllora-scheduling-'));roots.push(root)
  await writeFile(join(root,'syllora.json'),JSON.stringify({version:1,consent:false,calls:0,courses:[course],jobs:[]}))
  return {root,svc:new SylloraService(root,{now:clock})}
}

describe('PRD schedule and source recovery regressions',()=>{
  it('places a review after a full day and a rest day without moving the active plan',()=>{
    const c=fixture();const active=plan(c,{restDays:[5]});active.tasks[0]!.status='completed'
    const before=structuredClone(active)
    const draft=proposeReviews(c,c.scope,now,randomUUID)
    expect(draft.feasible).toBe(true);expect(draft.overflow).toEqual([])
    expect(draft.tasks.find(t=>t.kind==='review')!.date).toBe('2026-10-03')
    expect(c.plan).toEqual(before);expect(draft.tasks[0]).toEqual(before.tasks[0])
  })
  it('does not place review outside the deadline and retains an editable overflow task',()=>{
    const c=fixture();plan(c,{deadline:'2026-10-01'})
    const draft=proposeReviews(c,c.scope,now,randomUUID)
    expect(draft.feasible).toBe(false);expect(draft.overflow).toEqual([{pointId:c.scope[0],reason:'window-full'}])
    expect(draft.tasks.filter(t=>t.kind==='review')).toHaveLength(1)
    expect(proposeReviews(c,c.scope,now+24*HOUR,randomUUID).feasible).toBe(false)
  })
  it('deduplicates review requests and keeps one unfinished review for each point',()=>{
    const c=fixture();plan(c,{dailyMinutes:40})
    c.plan=proposeReviews(c,[...c.scope,...c.scope],now,randomUUID)
    expect(c.plan.tasks.filter(t=>t.kind==='review')).toHaveLength(1)
    expect(proposeReviews(c,c.scope,now,randomUUID).tasks.filter(t=>t.kind==='review')).toHaveLength(1)
  })
  it('waits for the planned course-local day and recommends due work before future work',()=>{
    const c=fixture();plan(c,{restDays:[4]})
    const waiting=recommend(c,now)
    expect(waiting.kind).toBe('waiting');expect(waiting.availableAt).toBe(Date.UTC(2026,9,1,16))
    expect(recommend(c,waiting.availableAt!-1).kind).toBe('waiting')
    expect(recommend(c,waiting.availableAt!).kind).toBe('planned')
    c.plan!.tasks.push({...c.plan!.tasks[0]!,id:randomUUID(),date:'2026-10-01'})
    expect(recommend(c,now).taskId).toBe(c.plan!.tasks[1]!.id)
  })
  it('computes availability across DST and fractional timezones',()=>{
    expect(dayStart('2026-03-08','America/New_York')).toBe(Date.UTC(2026,2,8,5))
    expect(dayStart('2026-03-09','America/New_York')).toBe(Date.UTC(2026,2,9,4))
    expect(dayStart('2026-10-02','Asia/Kathmandu')).toBe(Date.UTC(2026,9,1,18,15))
  })
  it('counts current preserved tasks against a reduced budget and preserves their dates',()=>{
    const c=fixture();plan(c,{dailyMinutes:40,estimates:{[c.scope[0]!]:35}}).tasks[0]!.status='in_progress'
    const old=structuredClone(c.plan!.tasks[0])
    const draft=buildPlan(c,{scope:c.scope,dailyMinutes:20,days:7,restDays:[]},now,randomUUID)
    expect(draft.feasible).toBe(false);expect(draft.tasks[0]).toEqual(old)
    expect(draft.overflow).toContainEqual({pointId:c.scope[0],reason:'task-too-large'})
  })
  it('blocks future starts at the service boundary, including an existing review',async()=>{
    const c=fixture();plan(c,{restDays:[4]});const {svc}=await stored(c)
    await expect(svc.handle('start',{courseId:c.id,taskId:c.plan!.tasks[0]!.id})).rejects.toMatchObject({code:'TASK_NOT_DUE'})
    const future=fixture();plan(future,{dailyMinutes:40,restDays:[4]});future.plan=proposeReviews(future,future.scope,now,randomUUID)
    const second=await stored(future)
    await expect(second.svc.handle('review',{courseId:future.id,pointId:future.scope[0]})).rejects.toMatchObject({code:'TASK_NOT_DUE'})
    expect((await svc.handle('state') as any).courses[0].plan.tasks[0].status).toBe('todo')
  })
  it('recomputes a waiting next action when the clock reaches the plan date',async()=>{
    const c=fixture();plan(c,{restDays:[4]});let clock=now;const {svc}=await stored(c,()=>clock)
    const before=(await svc.handle('state') as any).courses[0];expect(before.next.kind).toBe('waiting')
    clock=before.next.availableAt
    const after=(await svc.handle('state') as any).courses[0];expect(after.next.kind).toBe('planned')
    expect(after.actions).toHaveLength(before.actions.length+1)
    await svc.handle('start',{courseId:c.id,taskId:after.next.taskId})
    expect((await svc.handle('state') as any).courses[0].next.kind).toBe('continue')
  })
  it('preserves history and routes a deleted-source active task to recovery',async()=>{
    const c=fixture();plan(c).tasks[0]!.status='in_progress'
    const question={id:randomUUID(),pointId:c.scope[0]!,taskId:c.plan!.tasks[0]!.id,slot:0,family:'fixture',stem:'合成题',options:['一','二','三','四'],answer:0,explanation:'合成解释',sourceIds:c.points[0]!.sourceIds,quote:'单位矩阵',status:'valid' as const,assisted:false}
    c.questions.push(question);c.attempts.push({id:randomUUID(),questionId:question.id,option:0,correct:true,assisted:false,at:now,sequence:0})
    const {root,svc}=await stored(c)
    await svc.handle('deleteMaterial',{courseId:c.id,materialId:c.materials[0]!.id,confirmed:true})
    let current=(await svc.handle('state') as any).courses[0]
    expect(current.next.kind).toBe('blocked');expect(current.plan.tasks).toEqual(c.plan!.tasks)
    expect(current.attempts).toEqual(c.attempts);expect(current.evidence[c.scope[0]!].count).toBe(0)
    await expect(svc.handle('start',{courseId:c.id,taskId:c.plan!.tasks[0]!.id})).rejects.toMatchObject({code:'NO_USABLE_SOURCE'})
    expect((await new SylloraService(root,{now:()=>now}).handle('state') as any).courses[0].next.kind).toBe('blocked')
    const disk=JSON.parse(await readFile(join(root,'syllora.json'),'utf8'))
    const materialId=randomUUID(),sourceId=randomUUID(),replacementId=randomUUID()
    disk.courses[0].materials.push({id:materialId,name:'补充.txt',fingerprint:'new',status:'ready',accepted:true,pages:0,sources:[{id:sourceId,materialId,anchor:'段落 1',text:'补充合成资料：单位矩阵。'}]})
    disk.courses[0].points.push({id:replacementId,name:'补充单位矩阵',chapter:'矩阵',sourceIds:[sourceId]})
    await writeFile(join(root,'syllora.json'),JSON.stringify(disk))
    const restored=new SylloraService(root,{now:()=>now})
    await expect(restored.handle('restorePointSources',{courseId:c.id,pointId:c.scope[0],replacementPointId:randomUUID()})).rejects.toMatchObject({code:'NOT_FOUND'})
    await restored.handle('restorePointSources',{courseId:c.id,pointId:c.scope[0],replacementPointId:replacementId})
    current=(await restored.handle('state') as any).courses[0]
    expect(current.points[0].id).toBe(c.scope[0]);expect(current.next.kind).toBe('continue')
    expect(current.plan.tasks).toEqual(c.plan!.tasks);expect(current.evidence[c.scope[0]!].count).toBe(0)
    expect(current.questions[0].status).toBe('invalid');expect(current.attempts).toEqual(c.attempts)
  })
  it('does not offer new teaching from historical or inactive sources',()=>{
    const c=fixture();plan(c);c.materials[0]!.history=[...c.materials[0]!.sources];c.materials[0]!.sources=[]
    expect(pointHasSources(c,c.scope[0]!)).toBe(false);expect(recommend(c,now).kind).toBe('blocked')
    c.materials[0]!.sources=[...c.materials[0]!.history];c.materials[0]!.active=false
    expect(pointHasSources(c,c.scope[0]!)).toBe(false);expect(duePointIds(c,now)).toEqual([])
    expect(evidence(c,c.scope[0]!).state).toBe('未评估')
  })
})
