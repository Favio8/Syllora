import { RULE_VERSION } from './syllora-domain.ts'

export const PROMPT_VERSION = 'syllora-teaching-v2'
export interface JobDiagnostics { promptVersion?: string; ruleVersion?: string; finishedAt?: number | null; elapsedMs?: number | null; errorCode?: string | null; usageKnownCalls?:{input:number;output:number} }

export function jobDiagnostics() { return { promptVersion:PROMPT_VERSION, ruleVersion:RULE_VERSION, finishedAt:null, elapsedMs:null, errorCode:null,usageKnownCalls:{input:0,output:0} } }
export function finishJob(job: JobDiagnostics & {createdAt:number}, now:number, code:string|null=null) {
  job.finishedAt=now;job.elapsedMs=Math.max(0,now-job.createdAt);job.errorCode=code
}
/** These are sums of reported tokens, with completeness counts; missing usage is never zero. */
export function recordTokenUsage(job:JobDiagnostics&{inputTokens:number|null;outputTokens:number|null},input:unknown,output:unknown) {
  const known=job.usageKnownCalls??={input:0,output:0}
  if(typeof input==='number'&&Number.isSafeInteger(input)&&input>=0){job.inputTokens=(job.inputTokens??0)+input;known.input++}
  if(typeof output==='number'&&Number.isSafeInteger(output)&&output>=0){job.outputTokens=(job.outputTokens??0)+output;known.output++}
}
/** Preserve machine codes through cause wrappers; never publish arbitrary upstream response text. */
export function generationFailure(error: unknown): {code:string;message:string} {
  let current=error
  const seen=new Set<unknown>()
  while(current instanceof Error && !seen.has(current)) {
    seen.add(current)
    const code=(current as Error & {code?:string}).code
    if(current.message==='课程资料超出 100 页 PDF 或 100,000 字符限制') return {code:'LIMIT_EXCEEDED',message:current.message}
    if(current.message==='资料部分可用，请查看失败范围并确认后重试') return {code:'PARTIAL_MATERIAL',message:current.message}
    if(current.message==='选中资料没有可用正文') return {code:'NO_USABLE_SOURCE',message:current.message}
    if(code==='QUOTA' || code==='QUOTA_EXCEEDED') return {code:'QUOTA_EXCEEDED',message:'供应商账户配额或余额不足，请在供应商处处理后重试；已保存的学习记录保持可读。'}
    if(code==='RATE_LIMIT' || code==='RATE_LIMITED') return {code:'RATE_LIMITED',message:'供应商正在限流，请稍后重试；未发布新学习证据。'}
    if(code==='TIMEOUT' || code==='UPSTREAM_TIMEOUT' || current.name==='TimeoutError') return {code:'UPSTREAM_TIMEOUT',message:'模型调用超时，原任务已停止，请查询状态后决定是否重试；已保存记录保留。'}
    if(code==='ABORTED' || code==='CANCELLED' || current.name==='AbortError') return {code:'CANCELLED',message:'生成已取消；已保存的学习记录保留。'}
    if(code==='AUTH' || code==='INVALID_CREDENTIAL' || code==='MISSING_CREDENTIAL') return {code:'MODEL_AUTH_FAILED',message:'模型服务鉴权失败，请检查所选供应商配置后重试。'}
    if(code==='OUTPUT_TRUNCATED') return {code, message:'模型输出已截断，本次结果未发布，请调整范围后重试。'}
    if(['EACCES','EPERM','ENOSPC','EIO','EBUSY'].includes(code??'')) return {code:'STORAGE_ERROR',message:'学习记录无法保存，请检查课程目录与可用空间；本次结果未发布。'}
    if(['CONSENT_REQUIRED','NO_USABLE_SOURCE','VERSION_CONFLICT','QUESTION_INVALID','INVALID_SOURCE','MODEL_NOT_CONFIGURED','FOLDER_MISSING'].includes(code??'')) return {code:code!,message:current.message}
    current=current.cause
  }
  return {code:'INVALID_OUTPUT',message:'生成未完成或内容校验失败，本次结果未发布，请检查资料与模型配置后重试。'}
}
