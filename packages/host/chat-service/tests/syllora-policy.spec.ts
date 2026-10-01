import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPlan, evidence, HOUR, ruleSnapshot, type Course } from '../src/syllora-domain.ts'
import { SylloraService } from '../src/syllora.ts'
const roots:string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
function fixture():Course {
  const pointId=randomUUID(),sourceId=randomUUID(),now=Date.UTC(2026,9,2)
  const course:Course={id:randomUUID(),name:'合成间隔课程',timezone:'Asia/Shanghai',archived:false,createdAt:now,materials:[{id:'m',name:'fixture.txt',fingerprint:'fixture',status:'ready',accepted:true,pages:0,sources:[{id:sourceId,materialId:'m',anchor:'段落 1',text:'单位矩阵保持原向量不变。'}]}],points:[{id:pointId,name:'单位矩阵',chapter:'矩阵',sourceIds:[sourceId]}],scope:[pointId],plan:null,draft:null,questions:[],attempts:[],messages:[],actions:[],drafts:{prompt:'',answers:[]},changes:[],notice:null}
  course.plan=buildPlan(course,{scope:course.scope,dailyMinutes:40,days:7,restDays:[]},now,randomUUID);return course
}
function attempt(course:Course,at:number,correct=true,snapshot=true) {
  const questionId=randomUUID();course.questions.push({id:questionId,pointId:course.scope[0]!,taskId:course.plan!.tasks[0]!.id,slot:0,family:questionId,stem:questionId,options:['正确','错误一','错误二','错误三'],answer:0,explanation:'合成定义。',sourceIds:course.points[0]!.sourceIds,quote:'单位矩阵保持原向量不变',status:'valid',assisted:false})
  course.attempts.push({id:randomUUID(),questionId,option:correct?0:1,correct,assisted:false,at,sequence:course.attempts.length,...(snapshot?{ruleSnapshot:ruleSnapshot(course)}:{})});return questionId
}
describe('future review policy configuration',()=>{
  it('uses immutable parameter snapshots and does not reinterpret legacy attempts after an edit',()=>{
    const c=fixture();attempt(c,0,true,false);attempt(c,1000,true,false);const original=structuredClone(c.attempts)
    c.learningSettings={revision:1,reviewHours:[48,96,240],sessionIdleMinutes:30}
    expect(evidence(c,c.scope[0]!).dueAt).toBe(1000+24*HOUR);expect(c.attempts).toEqual(original)
    attempt(c,1000+24*HOUR,true);expect(evidence(c,c.scope[0]!).interval).toBe(96)
    const saved=structuredClone(c.attempts);c.learningSettings={revision:2,reviewHours:[72,120,336],sessionIdleMinutes:60}
    expect(evidence(c,c.scope[0]!).dueAt).toBe(1000+120*HOUR);expect(c.attempts).toEqual(saved)
  })
  it('keeps an earlier unfinished due time and resets using the new event policy after failure',()=>{
    const c=fixture();attempt(c,0,false);c.learningSettings={revision:1,reviewHours:[48,96,240],sessionIdleMinutes:30};attempt(c,HOUR,false)
    expect(evidence(c,c.scope[0]!).dueAt).toBe(24*HOUR);attempt(c,24*HOUR,false);expect(evidence(c,c.scope[0]!).dueAt).toBe(72*HOUR)
    attempt(c,25*HOUR,true);attempt(c,26*HOUR,true);expect(evidence(c,c.scope[0]!).dueAt).toBe(74*HOUR)
    expect(evidence(c,c.scope[0]!).state).toBe('初步掌握')
  })
  it('persists explicit configuration, rejects stale edits and preserves plan/due history after reopening',async()=>{
    const c=fixture(),now=Date.UTC(2026,9,2);attempt(c,now-1000);attempt(c,now)
    const root=await mkdtemp(join(tmpdir(),'syllora-policy-'));roots.push(root);await writeFile(join(root,'syllora.json'),JSON.stringify({version:1,consent:false,calls:0,courses:[c],jobs:[]}))
    const svc=new SylloraService(root,{now:()=>now}),before=(await svc.handle('state') as any).courses[0]
    await svc.handle('learningSettings',{courseId:c.id,baseVersion:0,reviewHours:[48,96,240],sessionIdleMinutes:45})
    await expect(svc.handle('learningSettings',{courseId:c.id,baseVersion:0,reviewHours:[24,72,168]})).rejects.toMatchObject({code:'VERSION_CONFLICT'})
    const reloaded=new SylloraService(root,{now:()=>now}),current=(await reloaded.handle('state') as any).courses[0]
    expect(current.learningSettings).toEqual({revision:1,reviewHours:[48,96,240],sessionIdleMinutes:45});expect(current.plan).toEqual(before.plan);expect(current.evidence[c.scope[0]!].dueAt).toBe(before.evidence[c.scope[0]!].dueAt)
    expect(JSON.parse(await readFile(join(root,'syllora.json'),'utf8')).courses[0].attempts).toEqual(c.attempts)
  })
  it.each([[12,72,168],[24,12,168],[24,72,72.5],[24,72,8761],[24,72]].map(hours=>({hours})))('rejects invalid policy $hours without saving',async ({hours})=>{
    const c=fixture(),root=await mkdtemp(join(tmpdir(),'syllora-policy-'));roots.push(root);await writeFile(join(root,'syllora.json'),JSON.stringify({version:1,consent:false,calls:0,courses:[c],jobs:[]}));const svc=new SylloraService(root)
    await expect(svc.handle('learningSettings',{courseId:c.id,baseVersion:0,reviewHours:hours})).rejects.toThrow();expect((await svc.handle('state') as any).courses[0].learningSettings.revision).toBe(0)
  })
})
