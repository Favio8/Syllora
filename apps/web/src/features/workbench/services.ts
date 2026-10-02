import { ApiError } from '@/src/lib/api';
import type { SylloraState } from '@/src/types/syllora';
import type { ReadingDocument, ReadingService } from './types';

export async function workbenchRpc<T=unknown>(action:string,payload:unknown={},signal?:AbortSignal):Promise<T> {
  const token=(window as unknown as {__SYLLORA__?:{token?:string}}).__SYLLORA__?.token;
  const timeout=AbortSignal.timeout(15000);
  const response=await fetch(`/api/syllora/${action}`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({payload}),signal:signal?AbortSignal.any([signal,timeout]):timeout});
  let body:{ok?:boolean;result?:T;error?:{code?:string;message?:string}};
  try {body=await response.json();} catch {throw new ApiError('INVALID_RESPONSE',`服务返回非 JSON 响应 (${response.status})`,response.status);}
  if(!body||typeof body!=='object')throw new ApiError('INVALID_RESPONSE','服务响应格式无效，请重试查询原任务',response.status);
  if(!response.ok||body.error||body.ok===false)throw new ApiError(body.error?.code??'HTTP_ERROR',body.error?.message??`请求失败 (${response.status})`,response.status);
  if(!body||!Object.hasOwn(body,'result'))throw new ApiError('INVALID_RESPONSE','服务响应缺少结果，请重试查询原任务',response.status);
  return body.result as T;
}

const requests=new Map<string,string>();
const storageKey='syllora.pending-requests.v1';
async function requestKey(action:string,payload:Record<string,unknown>) {const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([action,payload])));return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');}
function remember(key:string,id:string|null) {
  if(id)requests.set(key,id);else requests.delete(key);
  try {sessionStorage.setItem(storageKey,JSON.stringify([...requests]));}catch {/* In-memory recovery still works when browser storage is unavailable. */}
}
function restore() {
  try {for(const [key,id] of JSON.parse(sessionStorage.getItem(storageKey)??'[]'))if(typeof key==='string'&&typeof id==='string')requests.set(key,id);}catch {/* An invalid recovery cache cannot alter server records. */}
}
/** A transport failure may follow an accepted mutation. Keep its ID and query the original job. */
export async function logicalRequest<T=unknown>(action:string,payload:Record<string,unknown>):Promise<T> {
  restore();const key=await requestKey(action,payload),requestId=requests.get(key)??crypto.randomUUID();remember(key,requestId);
  try {const result=await workbenchRpc<T>(action,{...payload,requestId});remember(key,null);return result;}
  catch(error) {
    if(error instanceof ApiError&&error.status<500&&error.code!=='INVALID_RESPONSE'){remember(key,null);throw error;}
    if(action==='generate'||action==='initialize') {
      try {const state=await workbenchRpc<SylloraState>('state');const job=state.jobs.find(job=>job.courseId===payload.courseId&&job.requestId===requestId);if(job){remember(key,null);return {jobId:job.id,draftVersion:state.courses.find(course=>course.id===payload.courseId)?.drafts.version??0} as T;}}catch {/* Retry retains the original ID. */}
    }
    throw error;
  }
}
export const readingService:ReadingService={
  async document(courseId,materialId) {
    const result=await workbenchRpc<Omit<ReadingDocument,'courseId'>>('readingDocument',{courseId,materialId});
    return {...result,courseId};
  },
  async assist(document,selection,mode,signal) {
    if(!document.revision)throw new Error('请先初始化课程资料');
    const normalize=(value:string)=>value.replace(/\s+/g,'');
    const text=normalize(selection),all=document.sources.map(source=>normalize(source.text)).join('');
    const start=all.indexOf(text);
    if(start<0)throw new Error('选区不属于当前正文，请重新选择');
    let offset=0;
    const sourceIds=document.sources.filter(source=>{const end=offset+normalize(source.text).length,match=offset<start+text.length&&end>start;offset=end;return match;}).map(source=>source.id);
    if(sourceIds.length>12)throw new Error('请缩小选区到 12 个资料片段以内');
    const result=await logicalRequest<{jobId:string}>('generate',{courseId:document.courseId,kind:'answer',reading:{materialId:document.id,revision:document.revision,selection,sourceIds,mode}});
    const cancel=()=>{void workbenchRpc('cancel',{courseId:document.courseId,jobId:result.jobId}).catch(()=>undefined);};
    signal?.addEventListener('abort',cancel,{once:true});
    try {
      while(true) {
        if(signal?.aborted){cancel();throw new Error('阅读请求已取消');}
        const state=await workbenchRpc<SylloraState>('state');
        const job=state.jobs.find(job=>job.id===result.jobId);
        if(!job)throw new Error('生成任务不存在，请刷新');
        if(job.state!=='running') {
          if(job.state!=='succeeded')throw new Error(job.message);
          const course=state.courses.find(course=>course.id===document.courseId);
          const message=course?.messages.find(message=>message.id===job.resultMessageId);
          if(!message?.reading||message.reading.revision!==document.revision)throw new Error('回答不可用，资料可能已删除');
          const sources=course!.materials.flatMap(material=>material.sources);
          return {mode,selection,explanation:message.text,matches:message.sourceIds.map(id=>sources.find(source=>source.id===id)).filter(source=>source!==undefined).map(source=>({sourceId:source.id,materialId:source.materialId,title:source.anchor,excerpt:source.text}))};
        }
        await new Promise(resolve=>setTimeout(resolve,600));
      }
    } finally {signal?.removeEventListener('abort',cancel);}
  },
};
