import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPlan, HOUR, recordNext, publicCourse, ruleSnapshot, type Course } from '../src/syllora-domain.ts'
import { currentSession, endSession, expireSessions, recordLearningEvent, sessionMetrics, touchSession } from '../src/syllora-sessions.ts'
import { SylloraService } from '../src/syllora.ts'
const roots:string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
const now=Date.UTC(2026,9,2)
function fixture():Course {
 const pointId=randomUUID(),sourceId=randomUUID(),materialId=randomUUID();const c:Course={id:randomUUID(),name:'合成会话夹具',timezone:'Etc/UTC',archived:false,createdAt:now,materials:[{id:materialId,name:'fixture.txt',fingerprint:'fixture',version:'synthetic-v1',status:'ready',accepted:true,pages:0,sources:[{id:sourceId,materialId,anchor:'段落 1',text:'单位矩阵保持原向量不变。',version:'synthetic-v1'}]}],points:[{id:pointId,name:'单位矩阵',chapter:'矩阵',sourceIds:[sourceId]}],scope:[pointId],plan:null,draft:null,questions:[],attempts:[],messages:[],actions:[],drafts:{prompt:'',answers:[]},changes:[],notice:null};c.plan=buildPlan(c,{scope:c.scope,dailyMinutes:40,days:7,restDays:[]},now,randomUUID);c.plan.tasks[0]!.status='in_progress';return c
}
function question(c:Course,family=randomUUID()) {const q={id:randomUUID(),pointId:c.scope[0]!,taskId:c.plan!.tasks[0]!.id,slot:0,family,stem:'合成题 '+family,options:['正确','错一','错二','错三'],answer:0,explanation:'夹具解释',sourceIds:c.points[0]!.sourceIds,quote:'单位矩阵保持原向量不变',status:'valid' as const,assisted:false};c.questions.push(q);return q}
function attempt(c:Course,at:number,assisted=false,correct=true,family?:string) {const q=question(c,family),s=currentSession(c,at);recordNext(c,at,randomUUID,'grade');c.attempts.push({id:randomUUID(),questionId:q.id,option:correct?0:1,correct,assisted,at,sequence:c.attempts.length,ruleSnapshot:ruleSnapshot(c),...(s?{sessionId:s.id}:{}),nextActionId:c.actions.at(-1)!.id});return q}
async function service(c:Course,clock:{at:number}) {const root=await mkdtemp(join(tmpdir(),'syllora-sessions-'));roots.push(root);await writeFile(join(root,'syllora.json'),JSON.stringify({version:1,consent:false,calls:0,courses:[c],jobs:[]}));return {root,svc:new SylloraService(root,{now:()=>clock.at})}}
describe('learning sessions and PRD process observations',()=>{
 it('keeps ordinary browsing out of the denominator, persists snapshots and expires exactly at idle boundary',()=>{
  const c=fixture();expect(currentSession(c,now)).toBeNull();expect(sessionMetrics(c,now).standard.rate).toBeNull();
  const s=touchSession(c,now,randomUUID,false,c.plan!.tasks[0]!.id,true)!;c.learningSettings={revision:1,reviewHours:[48,96,240],sessionIdleMinutes:60};
  expect(s.idleMinutes).toBe(30);expect(s.sourceVersions[0]!.version).toBe('synthetic-v1');expect(s.planVersion).toBe(1);
  expect(touchSession(c,now+1,randomUUID,false,c.plan!.tasks[0]!.id,true)!.id).toBe(s.id);expect(c.sessions).toHaveLength(1);
  expect(currentSession(c,now+30*60_000)).not.toBeNull();expireSessions(c,now+30*60_000+1);expect(s.endReason).toBe('idle');
  const next=touchSession(c,now+31*60_000,randomUUID,false,c.plan!.tasks[0]!.id,true)!;expect(next.idleMinutes).toBe(60);expect(next.id).not.toBe(s.id)
 })
 it('retains the successful loop association after more than forty later actions, UI cropping and service reopening',async()=>{
  const c=fixture(),s=touchSession(c,now,randomUUID,true,c.plan!.tasks[0]!.id,true)!;attempt(c,now+1000);endSession(c,s.id,now+2000);const actionId=c.attempts[0]!.nextActionId;expect(sessionMetrics(c,now+24*HOUR).synthetic.closedLoops).toBe(1);
  for(let i=0;i<50;i++)recordNext(c,now+3000+i,randomUUID,'sync',true);
  expect(sessionMetrics(c,now+24*HOUR).synthetic.closedLoops).toBe(1);expect(c.actions.some(action=>action.id===actionId)).toBe(true);expect(publicCourse(c,now+24*HOUR).actions).toHaveLength(40);
  const clock={at:now+24*HOUR},{root}=await service(c,clock);const reopened=(await new SylloraService(root,{now:()=>clock.at}).handle('state') as any).courses[0];expect(reopened.metrics.synthetic.closedLoops).toBe(1);expect(reopened.actions).toHaveLength(40);const saved=JSON.parse(await readFile(join(root,'syllora.json'),'utf8'));expect(saved.courses[0].actions.some((action:any)=>action.id===actionId)).toBe(true)
 })
 it('uses a full 24 hour observation window and separates synthetic sessions; explicit end is idempotent',()=>{
  const c=fixture(),s=touchSession(c,now,randomUUID,true,c.plan!.tasks[0]!.id,true)!;attempt(c,now+1000);endSession(c,s.id,now+2000);endSession(c,s.id,now+3000);
  expect(s.endedAt).toBe(now+2000);expect(sessionMetrics(c,now+2000).synthetic).toMatchObject({pending:1,observed:0,rate:null});expect(sessionMetrics(c,now+24*HOUR).synthetic).toMatchObject({observed:1,closedLoops:1,rate:1});expect(sessionMetrics(c,now+24*HOUR).standard.eligible).toBe(0)
 })
 it('accepts an independent wrong answer as a loop and recomputes when its question is disputed',()=>{
  const c=fixture(),s=touchSession(c,now,randomUUID,false,c.plan!.tasks[0]!.id,true)!;const q=attempt(c,now+1000,false,false);endSession(c,s.id,now+2000);
  expect(sessionMetrics(c,now+24*HOUR).standard.closedLoops).toBe(1);q.status='disputed';expect(sessionMetrics(c,now+24*HOUR).standard.closedLoops).toBe(0);expect(c.attempts).toHaveLength(1)
 })
 it('excludes assisted, repeated-family, unavailable-source, unknown-rule, legacy and out-of-window attempts',()=>{
  const c=fixture();attempt(c,now-1,false,true,'same-family');const s=touchSession(c,now,randomUUID,false,c.plan!.tasks[0]!.id,true)!;
  attempt(c,now+1,true);attempt(c,now+2,false,true,'same-family');const unknown=attempt(c,now+3);c.attempts.at(-1)!.ruleSnapshot!.version='future-unverified';s.lastAt=now+25*HOUR;attempt(c,now+24*HOUR+1);endSession(c,s.id,now+25*HOUR);
  expect(sessionMetrics(c,now+25*HOUR).standard.closedLoops).toBe(0);unknown.status='invalid';expect(sessionMetrics(c,now).untrackedAttempts).toBe(1);
  const q=attempt(c,now+4);c.attempts.at(-1)!.sessionId=s.id;c.materials[0]!.status='deleted';expect(sessionMetrics(c,now+25*HOUR).standard.closedLoops).toBe(0);expect(q.status).toBe('valid')
 })
 it('includes the exact 24-hour boundary and unions overlapping system waits without calling the remainder user time',()=>{
  const c=fixture(),s=touchSession(c,now,randomUUID,false,c.plan!.tasks[0]!.id,true)!;s.lastAt=now+24*HOUR;attempt(c,now+24*HOUR);s.jobIds=['a','b'];
  const jobs=[{id:'a',createdAt:now+100,finishedAt:now+1000},{id:'b',createdAt:now+500,finishedAt:now+1500}];const metric=sessionMetrics(c,now+24*HOUR,jobs).sessions[0]!;
  expect(metric.closedLoop).toBe(true);expect(metric.systemWaitMs).toBe(1400);expect(metric.otherElapsedMs).toBe(24*HOUR-1400);expect(sessionMetrics(c,now+24*HOUR,[jobs[0]!]).sessions[0]!.systemWaitMs).toBeNull()
 })
 it('counts unique displayed objects and displayed accepted drafts, never generated-but-hidden objects',()=>{
  const c=fixture(),q=question(c),message={id:randomUUID(),role:'assistant' as const,text:'合成回答',sourceIds:c.points[0]!.sourceIds,at:now};c.messages.push(message);
  recordLearningEvent(c,'exposure','question',q.id,now,randomUUID);recordLearningEvent(c,'exposure','question',q.id,now+1,randomUUID);recordLearningEvent(c,'exposure','answer',message.id,now,randomUUID);
  q.dispute={reason:'尚待核验',at:now};recordLearningEvent(c,'draft_accepted','draft','unshown',now,randomUUID);recordLearningEvent(c,'draft_shown','draft','shown',now,randomUUID);recordLearningEvent(c,'draft_accepted','draft','shown',now,randomUUID);
  const metrics=sessionMetrics(c,now);expect(metrics.sourceReports).toEqual({shown:2,reported:1,rate:0.5});expect(metrics.planAdjustments).toEqual({shown:1,accepted:1,rate:1});expect(metrics.helpCount).toBe(0)
 })
 it('restores ten separate synthetic sessions on the same machine across service restarts without duplicate grades',async()=>{
  const c=fixture();for(let i=0;i<10;i++)question(c);const clock={at:now};const context=await service(c,clock);let svc=context.svc;
  for(let i=0;i<10;i++) {
   clock.at=now+i*10_000;await svc.handle('start',{courseId:c.id,taskId:c.plan!.tasks[0]!.id});const first=(await svc.handle('state') as any).courses[0].activeSession;
   svc=new SylloraService(context.root,{now:()=>clock.at});expect((await svc.handle('state') as any).courses[0].activeSession.id).toBe(first.id);
   clock.at+=1000;const payload={courseId:c.id,questionId:c.questions[i]!.id,option:0,requestId:randomUUID()};const grade=await svc.handle('submit',payload);expect(await svc.handle('submit',payload)).toMatchObject({id:(grade as any).id,sessionId:first.id});await svc.handle('endSession',{courseId:c.id,sessionId:first.id});await svc.handle('endSession',{courseId:c.id,sessionId:first.id});
  }
  clock.at=now+24*HOUR+100_000;svc=new SylloraService(context.root,{now:()=>clock.at});const state=(await svc.handle('state') as any).courses[0];expect(state.metrics.synthetic).toEqual({eligible:10,observed:10,closedLoops:10,pending:0,rate:1});expect(state.metrics.standard.eligible).toBe(0);expect(state.attempts).toHaveLength(10);const db=JSON.parse(await readFile(join(context.root,'syllora.json'),'utf8'));expect(db.courses[0].sessions).toHaveLength(10);expect(db.courses[0].attempts.every((a:any)=>a.ruleSnapshot&&a.sourceVersions.length&&a.nextActionId)).toBe(true)
 })
 it('persists reports, rejects cross-course objects, records help once and replays it after ending',async()=>{
  const c=fixture(),q=question(c),message={id:randomUUID(),role:'assistant' as const,text:'合成回答',sourceIds:c.points[0]!.sourceIds,at:now};c.messages.push(message);const clock={at:now},{root,svc}=await service(c,clock);
  await expect(svc.handle('recordHelp',{courseId:c.id,requestId:randomUUID(),reason:'帮助'})).rejects.toMatchObject({code:'NO_SESSION'});
  await expect(svc.handle('recordExposure',{courseId:c.id,objects:[{kind:'question',id:randomUUID()}]})).rejects.toMatchObject({code:'NOT_FOUND'});
  await svc.handle('start',{courseId:c.id,taskId:c.plan!.tasks[0]!.id});const help={courseId:c.id,requestId:randomUUID(),reason:'合成操作指导'};await svc.handle('recordHelp',help);await svc.handle('recordHelp',help);await expect(svc.handle('recordHelp',{...help,reason:'不同原因'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  const objects=[{kind:'question',id:q.id},{kind:'answer',id:message.id}];await svc.handle('recordExposure',{courseId:c.id,objects});await svc.handle('recordExposure',{courseId:c.id,objects});await svc.handle('reportAnswer',{courseId:c.id,messageId:message.id,reason:'合成来源核验'});await svc.handle('dispute',{courseId:c.id,questionId:q.id,reason:'合成题目核验'});
  const view=(await svc.handle('state') as any).courses[0];expect(view.metrics.helpCount).toBe(1);expect(view.metrics.sourceReports).toEqual({shown:2,reported:2,rate:1});await svc.handle('endSession',{courseId:c.id,sessionId:view.activeSession.id});await svc.handle('recordHelp',help);
  const reopened=(await new SylloraService(root,{now:()=>clock.at}).handle('state') as any).courses[0];expect(reopened.messages[0].report.reason).toBe('合成来源核验');expect(reopened.questions[0].dispute.reason).toBe('合成题目核验');expect(reopened.metrics.helpCount).toBe(1)
 })
 it('expires on read without extending activity and closes active sessions when archived',async()=>{
  const c=fixture(),clock={at:now},{svc}=await service(c,clock);await svc.handle('start',{courseId:c.id,taskId:c.plan!.tasks[0]!.id});clock.at+=30*60_000-1;expect((await svc.handle('state') as any).courses[0].activeSession).not.toBeNull();clock.at++;let view=(await svc.handle('state') as any).courses[0];expect(view.activeSession).toBeNull();expect(view.metrics.sessions[0].endedAt).toBe(now+30*60_000);
  await svc.handle('start',{courseId:c.id,taskId:c.plan!.tasks[0]!.id});await svc.handle('archive',{courseId:c.id,archived:true});view=(await svc.handle('state') as any).courses[0];expect(view.activeSession).toBeNull();expect(view.metrics.sessions).toHaveLength(2)
 })
})
