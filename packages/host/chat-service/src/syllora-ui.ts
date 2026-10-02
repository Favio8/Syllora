import { z } from 'zod'
import { learningSources, type Course, type Source } from './syllora-domain.ts'
import { SylloraError } from './syllora.ts'

export const COURSE_ICONS = ['math','statistics','code','science','physics','language','literature','art','music','geography','history','notebook'] as const
export const courseIconSchema = z.enum(COURSE_ICONS)
export const uiPreferencesSchema = z.object({ name:z.string().trim().min(1).max(16), theme:z.enum(['light','dark']), dailyMinutes:z.number().int().min(5).max(480) })
export type UiPreferences = z.infer<typeof uiPreferencesSchema> & { revision:number }
export const defaultUiPreferences = ():UiPreferences => ({name:'学习者',theme:'light',dailyMinutes:40,revision:0})
export const readingContextSchema = z.object({materialId:z.string().uuid(),revision:z.string().uuid(),selection:z.string().trim().min(1).max(4000),sourceIds:z.array(z.string()).min(1).max(12),mode:z.enum(['explain','search'])})
export type ReadingContext = z.infer<typeof readingContextSchema>
export interface LearningActivity { id:string;courseId:string;at:number;kind:'task'|'chat'|'reading';minutes:number;taskId?:string;planVersion:number }

export function recordActivity(course:Course,event:Omit<LearningActivity,'courseId'|'planVersion'>) {
  const events=course.activity??=[]
  if(!events.some(previous=>previous.id===event.id))events.push({...event,courseId:course.id,planVersion:course.plan?.version??0})
}

export function readingDocument(course:Course,materialId:string) {
  const material=course.materials.find(item=>item.id===materialId&&item.status!=='deleted'&&item.active!==false)
  if(!material)throw new SylloraError('NOT_FOUND','资料不存在或已停用')
  const sources=learningSources(course).filter(source=>source.materialId===materialId)
  return {id:material.id,name:material.name,title:material.name,revision:course.revision??null,status:material.status,accepted:material.accepted,sources,content:sources.map(source=>source.text).join('\n\n'),source:'published' as const,previewUrl:material.file?`/api/syllora/material-file?courseId=${course.id}&materialId=${material.id}`:null,pageIssues:material.pageIssues??[]}
}

export function validateReading(course:Course,context:ReadingContext):Source[] {
  if(course.revision!==context.revision)throw new SylloraError('VERSION_CONFLICT','资料版本已更新，请重新打开正文并选择文字')
  const document=readingDocument(course,context.materialId)
  const selected=context.sourceIds.map(id=>document.sources.find(source=>source.id===id))
  if(selected.some(source=>!source))throw new SylloraError('INVALID_SOURCE','选区来源不属于当前资料版本')
  const normalize=(value:string)=>value.replace(/\s+/g,'')
  if(!normalize(selected.map(source=>source!.text).join('\n\n')).includes(normalize(context.selection)))throw new SylloraError('INVALID_SELECTION','选区不在所选资料正文中')
  return selected as Source[]
}
