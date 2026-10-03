import type { SylloraState } from '@/src/types/syllora';
import type { CourseIconId, WorkspaceData } from './types';
import { resolveCourseIcon } from './lib/courseIcons';
import { dayKey } from './lib/activity';
export function projectWorkspace(state:SylloraState):WorkspaceData {
  const preferences=state.uiPreferences??{name:'学习者',theme:'light' as const,dailyMinutes:40,revision:0};
  return {version:1,preferences:{...preferences,compact:false},preferencesVersion:preferences.revision,courses:state.courses.map(course=>({
    id:course.id,name:course.name,subtitle:course.next.text,symbol:'',icon:(course.icon??'notebook') as CourseIconId,color:resolveCourseIcon(undefined,(course.icon??'notebook') as CourseIconId).color,archived:course.archived,chapter:course.points[0]?.chapter??'尚未初始化',revision:course.revision,
    tasks:(course.plan?.tasks??[]).filter(task=>task.status!=='skipped').map(task=>({id:task.id,title:course.points.find(point=>point.id===task.pointId)?.name??'知识点',kind:task.kind==='review'?'复习':'学习',minutes:task.minutes,completed:task.status==='completed',status:task.status,date:task.date,available:!course.archived&&!(course.blockedPointIds??[]).includes(task.pointId)&&task.date<=new Intl.DateTimeFormat('en-CA',{timeZone:course.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.now())})),
    points:course.points.map(point=>({id:point.id,title:point.name,chapter:point.chapter,state:course.evidence[point.id]?.state??'未评估'})),
    materials:course.materials.filter(material=>material.status!=='deleted'&&material.active!==false).map(material=>({id:material.id,name:material.name,size:material.file?.bytes??0,addedAt:`v${material.revisionNumber??1}`})),
    messages:course.messages.map(message=>({id:message.id,role:message.role,content:message.text,createdAt:new Date(message.at).toISOString()})),
  })),activity:(state.activity??[]).map(event=>({...event,date:dayKey(event.at,state.courses.find(course=>course.id===event.courseId)?.timezone)}))};
}
