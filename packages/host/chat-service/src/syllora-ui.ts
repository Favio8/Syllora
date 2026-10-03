import { z } from 'zod'
import { learningSources, type Course, type Source, type ReadingContext } from './syllora-domain.ts'
import { SylloraError } from './syllora.ts'

export const COURSE_ICONS = ['math','statistics','code','science','physics','language','literature','art','music','geography','history','notebook'] as const
export const courseIconSchema = z.enum(COURSE_ICONS)
export const uiPreferencesSchema = z.object({ name:z.string().trim().min(1).max(16), theme:z.enum(['light','dark']), dailyMinutes:z.number().int().min(5).max(480) })
export type UiPreferences = z.infer<typeof uiPreferencesSchema> & { revision:number }
export const defaultUiPreferences = ():UiPreferences => ({name:'学习者',theme:'light',dailyMinutes:40,revision:0})
export const materialReadingSchema = z.object({ materialId:z.string().uuid(), revision:z.string().uuid(), selection:z.string().trim().min(1).max(4000), sourceIds:z.array(z.string()).min(1).max(12), mode:z.enum(['explain','search']) }).strict()
export const ebookReadingSchema = z.object({ ebookId:z.string().uuid(), selection:z.string().trim().min(1).max(4000), mode:z.enum(['explain','search']) }).strict()
export const readingContextSchema = z.union([materialReadingSchema, ebookReadingSchema]).describe('资料模式带 materialId/revision/sourceIds；电子书模式带 ebookId')
export type { ReadingContext }
export type MaterialReadingContext = z.infer<typeof materialReadingSchema>
export type EbookReadingContext = z.infer<typeof ebookReadingSchema>

/**
 * 电子书正文切条（约 1000 字符一块，锚到最近章节标题），
 * 用于 assist 的伪来源（范围=电子书+原始资料，复用 sources 机制）。
 * 注意：前端 `services.ts` 有同实现用于组装 matches，改动需两边同步。
 */
export function chunkEbookMarkdown(markdown: string): Array<{ id: string; section: string; text: string }> {
  const chunks: Array<{ id: string; section: string; text: string }> = []
  let section = '前言'
  let buffer: string[] = []
  let chars = 0
  let index = 0
  const flush = () => {
    const text = buffer.join('\n').trim()
    if (text !== '') chunks.push({ id: `e${index}`, section: section.trim(), text })
    index++
    buffer = []
    chars = 0
  }
  for (const line of markdown.split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      section = heading[1]!.trim()
      continue
    }
    buffer.push(line)
    chars += line.length
    if (chars > 1000) flush()
  }
  flush()
  return chunks
}
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
  // 仅资料模式调用（ebook 模式走 syllora.ts 的 ebookReadingSources）。
  if(!('materialId' in context))throw new SylloraError('INVALID_REQUEST','该上下文无资料标识')
  if(course.revision!==context.revision)throw new SylloraError('VERSION_CONFLICT','资料版本已更新，请重新打开正文并选择文字')
  const document=readingDocument(course,context.materialId)
  const selected=context.sourceIds.map(id=>document.sources.find(source=>source.id===id))
  if(selected.some(source=>!source))throw new SylloraError('INVALID_SOURCE','选区来源不属于当前资料版本')
  const normalize=(value:string)=>value.replace(/\s+/g,'')
  if(!normalize(selected.map(source=>source!.text).join('\n\n')).includes(normalize(context.selection)))throw new SylloraError('INVALID_SELECTION','选区不在所选资料正文中')
  return selected as Source[]
}

/** 多文件拟序草案契约（落盘 {courseRoot}/draft-order.json，AI 草案与人工确认共用同一形状）。 */
export const ebookOrderDraftSchema = z.object({
  version: z.literal(1),
  /** 参加拟序的电子书顺序（全课程级）。 */
  files: z.array(z.object({ ebookId: z.string().uuid(), fileName: z.string().trim().min(1).max(160), order: z.number().int().min(0) })),
  /** 各电子书章节的全局排序（确认后驱动章一文件切分顺序）。 */
  sections: z.array(z.object({ ebookId: z.string().uuid(), anchor: z.string().trim().min(1).max(120), title: z.string().trim().min(1).max(200), order: z.number().int().min(0) })),
  confirmed: z.boolean(),
  /** 草案来源：ai（模型拟序草稿）/ manual（人工调整后保存）。 */
  draftedBy: z.enum(['ai', 'manual']).nullable(),
  draftedAt: z.number().int().nullable(),
}).strict()
export type EbookOrderDraft = z.infer<typeof ebookOrderDraftSchema>
export const emptyEbookOrderDraft = (): EbookOrderDraft => ({ version: 1, files: [], sections: [], confirmed: false, draftedBy: null, draftedAt: null })

/** agent 自动建谱产物（每本电子书 docmind/graph.json； 契约初版）。 */
export const bookGraphSchema = z.object({
  version: z.literal(1),
  builtAt: z.number().int(),
  model: z.string().max(80),
  concepts: z.array(z.object({
    name: z.string().min(1).max(40),
    summary: z.string().max(120),
    /** 章节标题原文（Agent 输出），落盘前换算为锚点。 */
    chapters: z.array(z.string().min(1).max(120)).min(1).max(30),
  })).max(60),
  relations: z.array(z.object({
    source: z.string().min(1).max(40),
    target: z.string().min(1).max(40),
    kind: z.enum(['prerequisite', 'related', 'part_of', 'example']),
  })).max(120),
}).strict()
export type BookGraph = z.infer<typeof bookGraphSchema>
/** Agent 单次调用输出（version/builtAt/model 由落盘代码补齐）。 */
export const bookGraphDraftSchema = bookGraphSchema.omit({ version: true, builtAt: true, model: true })
export type BookGraphDraft = z.infer<typeof bookGraphDraftSchema>
