import { HOUR, learningSources, usableSources, type Attempt, type Course } from './syllora-domain.js'
import { learningSettings, validReviewHours } from './syllora-policy.js'
export interface SourceVersion { sourceId:string;materialId:string;version:string }
export interface LearningSession { id:string;startedAt:number;lastAt:number;endedAt:number|null;endReason:'explicit'|'idle'|'archive'|null;idleMinutes:number;taskIds:string[];jobIds:string[];mode:'standard'|'synthetic';eligible:boolean;planVersion:number;sourceVersions:SourceVersion[] }
export interface LearningEvent { id:string;kind:'exposure'|'draft_shown'|'draft_accepted'|'draft_rejected'|'help';at:number;sessionId:string|null;objectKind:'answer'|'question'|'draft'|'help';objectId:string;planVersion:number;sourceVersions:SourceVersion[];reason?:string }
export interface SessionJob { id:string;sessionId?:string;createdAt:number;finishedAt?:number|null }
export function sourceVersions(course:Course,sourceIds?:string[]):SourceVersion[] {
  const selected=sourceIds?new Set(sourceIds):null
  return learningSources(course).filter(source=>!selected||selected.has(source.id)).map(source=>({sourceId:source.id,materialId:source.materialId,version:source.version??String(course.materials.find(material=>material.id===source.materialId)?.version??course.materials.find(material=>material.id===source.materialId)?.fingerprint??'unknown')}))
}
export function currentSession(course:Course,now:number):LearningSession|null {
  return [...(course.sessions??[])].reverse().find(session=>session.endedAt===null&&now<session.lastAt+session.idleMinutes*60_000)??null
}
export function sessionNeedsExpiry(course:Course,now:number):boolean {
  return (course.sessions??[]).some(session=>session.endedAt===null&&now>=session.lastAt+session.idleMinutes*60_000)
}
export function expireSessions(course:Course,now:number):void {
  for(const session of course.sessions??[])if(session.endedAt===null&&now>=session.lastAt+session.idleMinutes*60_000){session.endedAt=session.lastAt+session.idleMinutes*60_000;session.endReason='idle'}
}
export function touchSession(course:Course,now:number,makeId:()=>string,synthetic:boolean,taskId?:string,create=false):LearningSession|null {
  expireSessions(course,now);let session=currentSession(course,now)
  if(!session&&create) {
    const point=course.points.find(point=>point.id===course.plan?.tasks.find(task=>task.id===taskId)?.pointId)
    const sources=sourceVersions(course,point?.sourceIds)
    session={id:makeId(),startedAt:now,lastAt:now,endedAt:null,endReason:null,idleMinutes:learningSettings(course).sessionIdleMinutes,taskIds:taskId?[taskId]:[],jobIds:[],mode:synthetic?'synthetic':'standard',eligible:sources.length>0,planVersion:course.plan?.version??0,sourceVersions:sources}
    ;(course.sessions??=[]).push(session)
  }
  if(session){session.lastAt=Math.max(session.lastAt,now);if(taskId&&!session.taskIds.includes(taskId))session.taskIds.push(taskId)}
  return session
}
export function endSession(course:Course,sessionId:string,now:number,reason:'explicit'|'archive'='explicit'):boolean {
  const session=course.sessions?.find(session=>session.id===sessionId);if(!session)return false
  if(session.endedAt===null){session.endedAt=Math.max(session.startedAt,now);session.lastAt=session.endedAt;session.endReason=reason}
  return true
}
export function recordLearningEvent(course:Course,kind:LearningEvent['kind'],objectKind:LearningEvent['objectKind'],objectId:string,now:number,makeId:()=>string,reason?:string,sourceIds?:string[]):void {
  const events=course.learningEvents??=[]
  if(kind!=='help'&&events.some(event=>event.kind===kind&&event.objectKind===objectKind&&event.objectId===objectId))return
  events.push({id:makeId(),kind,objectKind,objectId,at:now,sessionId:currentSession(course,now)?.id??null,planVersion:course.plan?.version??0,sourceVersions:sourceVersions(course,sourceIds),...(reason?{reason}:{})})
}
function independentAttempts(course:Course):Attempt[] {
  const available=new Set(usableSources(course).map(source=>source.id)),seen=new Map<string,Set<string>>()
  return [...course.attempts].sort((a,b)=>a.at-b.at||a.sequence-b.sequence).filter(attempt=>{
    const question=course.questions.find(question=>question.id===attempt.questionId)
    if((attempt.ruleSnapshot&&(attempt.ruleSnapshot.version!=='syllora-v1'||!validReviewHours(attempt.ruleSnapshot.reviewHours)))||!question||question.status!=='valid'||attempt.assisted||!question.sourceIds.length||question.sourceIds.some(id=>!available.has(id)))return false
    const families=seen.get(question.pointId)??new Set<string>();seen.set(question.pointId,families)
    if(families.has(question.family))return false;families.add(question.family);return true
  })
}
function unionDuration(intervals:Array<[number,number]>):number {
  const sorted=intervals.filter(([start,end])=>end>start).sort((a,b)=>a[0]-b[0]);let total=0,start=0,end=0,first=true
  for(const [nextStart,nextEnd] of sorted){if(first){start=nextStart;end=nextEnd;first=false}else if(nextStart<=end)end=Math.max(end,nextEnd);else{total+=end-start;start=nextStart;end=nextEnd}}
  return first?0:total+end-start
}
export function sessionMetrics(course:Course,now:number,jobs:SessionJob[]=[]){
  const valid=independentAttempts(course),events=course.learningEvents??[]
  const sessions=(course.sessions??[]).map(session=>{
    const deadline=session.startedAt+24*HOUR,windowEnd=Math.min(deadline,session.endedAt??Infinity)
    const attempts=valid.filter(attempt=>attempt.sessionId===session.id&&attempt.at>=session.startedAt&&attempt.at<=windowEnd)
    const first=attempts[0],closedLoop=attempts.some(attempt=>!!attempt.nextActionId&&course.actions.some(action=>action.id===attempt.nextActionId&&!['prepare','blocked','archived'].includes(action.kind)))
    const matched=jobs.filter(job=>session.jobIds.includes(job.id)),timingKnown=session.jobIds.every(id=>matched.some(job=>job.id===id))
    const systemWaitMs=first&&timingKnown?unionDuration(matched.map(job=>[Math.max(session.startedAt,job.createdAt),Math.min(first.at,job.finishedAt??first.at)])):null
    return {id:session.id,mode:session.mode,startedAt:session.startedAt,endedAt:session.endedAt,eligible:session.eligible,observed:now>=deadline,closedLoop,firstFeedbackAt:first?.at??null,firstFeedbackMs:first?Math.max(0,first.at-session.startedAt):null,systemWaitMs,otherElapsedMs:first&&systemWaitMs!==null?Math.max(0,first.at-session.startedAt-systemWaitMs):null}
  })
  const group=(mode:LearningSession['mode'])=>{const eligible=sessions.filter(session=>session.mode===mode&&session.eligible),observed=eligible.filter(session=>session.observed),success=observed.filter(session=>session.closedLoop);return {eligible:eligible.length,observed:observed.length,closedLoops:success.length,pending:eligible.length-observed.length,rate:observed.length?success.length/observed.length:null}}
  const exposures=events.filter(event=>event.kind==='exposure'),reported=exposures.filter(event=>event.objectKind==='question'?course.questions.some(question=>question.id===event.objectId&&question.dispute):course.messages.some(message=>message.id===event.objectId&&message.report))
  const shown=new Set(events.filter(event=>event.kind==='draft_shown'&&event.planVersion>0).map(event=>event.objectId)),accepted=new Set(events.filter(event=>event.kind==='draft_accepted'&&shown.has(event.objectId)).map(event=>event.objectId))
  return {standard:group('standard'),synthetic:group('synthetic'),sessions,sourceReports:{shown:exposures.length,reported:reported.length,rate:exposures.length?reported.length/exposures.length:null},planAdjustments:{shown:shown.size,accepted:accepted.size,rate:shown.size?accepted.size/shown.size:null},helpCount:events.filter(event=>event.kind==='help').length,untrackedAttempts:course.attempts.filter(attempt=>!attempt.sessionId).length}
}
