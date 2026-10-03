import { ApiError, streamSse } from '@/src/lib/api';
import { reviewFetch } from '@/src/lib/review-transport';
import type { SylloraState } from '@/src/types/syllora';
import type { ReadingDocument, ReadingService } from './types';

export async function workbenchRpc<T=unknown>(action:string,payload:unknown={},signal?:AbortSignal):Promise<T> {
  const token=(window as unknown as {__SYLLORA__?:{token?:string}}).__SYLLORA__?.token;
  const timeout=AbortSignal.timeout(15000);
  const response=await reviewFetch(`/api/syllora/${action}`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({payload}),signal:signal?AbortSignal.any([signal,timeout]):timeout});
  let body:{ok?:boolean;result?:T;error?:{code?:string;message?:string}};
  try {body=await response.json();} catch {throw new ApiError('INVALID_RESPONSE',`服务返回非 JSON 响应 (${response.status})`,response.status);}
  if(!body||typeof body!=='object')throw new ApiError('INVALID_RESPONSE','服务响应格式无效，请重试查询原任务',response.status);
  if(!response.ok||body.error||body.ok===false)throw new ApiError(body.error?.code??'HTTP_ERROR',body.error?.message??`请求失败 (${response.status})`,response.status);
  if(!body||!Object.hasOwn(body,'result'))throw new ApiError('INVALID_RESPONSE','服务响应缺少结果，请重试查询原任务',response.status);
  return body.result as T;
}

const requests=new Map<string,string>();
const storageKey='syllora.pending-requests.v1';
/** B5：阅读助手轮询的总时延上限。宿主单次请求上限 120 秒，这里留出余量后
 * 放弃等待，避免任务卡死时无限轮询（同时保留选区可重试）。 */
const READING_POLL_TIMEOUT_MS=150_000;
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
/** 需求六：reading-ask 的 SSE 帧（宿主 bin.ts 的 handleReadingAsk，形制同 chat/stream）。 */
type ReadingAskFrame=
  | {event:'meta';data:{courseId:string;mode:string;documentTitle:string}}
  | {event:'token';data:{delta:string}}
  | {event:'done';data:{usage:Record<string,unknown>;turnId:string|null}}
  | {event:'error';data:{code:string;message:string}};

export const readingService:ReadingService={
  async document(courseId,materialId) {
    const result=await workbenchRpc<Omit<ReadingDocument,'courseId'>>('readingDocument',{courseId,materialId});
    return {...result,courseId};
  },
  async assist(document,selection,mode,signal,options) {
    if(signal?.aborted)throw new Error('阅读请求已取消');
    if(!document.revision)throw new Error('资料已变化或尚未初始化，请重新初始化课程资料后再选择正文。');
    const normalize=(value:string)=>value.replace(/\s+/g,'');
    const text=normalize(selection),all=document.sources.map(source=>normalize(source.text)).join('');
    const start=all.indexOf(text);
    if(start<0)throw new Error('选区不属于当前正文，请重新选择');
    let offset=0;
    const sourceIds=document.sources.filter(source=>{const end=offset+normalize(source.text).length,match=offset<start+text.length&&end>start;offset=end;return match;}).map(source=>source.id);
    if(sourceIds.length>12)throw new Error('请缩小选区到 12 个资料片段以内');
    const result=await logicalRequest<{jobId:string}>('generate',{courseId:document.courseId,kind:'answer',reading:{materialId:document.id,revision:document.revision,selection,sourceIds,mode}});
    let cancelled=false;
    const cancel=()=>{if(cancelled)return;cancelled=true;void workbenchRpc('cancel',{courseId:document.courseId,jobId:result.jobId}).catch(()=>undefined);};
    signal?.addEventListener('abort',cancel,{once:true});
    // B5：旧实现 `while(true)` 每 600ms 查一次 state，不设总时延——任务卡死时
    // 只靠服务端 120s 上限兜底，前端在这期间无限轮询且不给任何提示。这里加
    // 总超时（宿主请求上限 120s 之上留出余量），超时后保留选区可重试。
    const deadline=Date.now()+READING_POLL_TIMEOUT_MS;
    const timeout=AbortSignal.timeout(READING_POLL_TIMEOUT_MS);
    const pollingSignal=signal?AbortSignal.any([signal,timeout]):timeout;
    let warned=false;
    try {
      while(true) {
        if(signal?.aborted){cancel();throw new Error('阅读请求已取消');}
        if(Date.now()>=deadline)throw new Error('阅读任务已超过等待上限（150 秒），已停止等待并请求取消原任务；选区已保留，可重试。');
        const state=await workbenchRpc<SylloraState>('state',{},pollingSignal);
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
        // 超过 60 秒仍在查询同一个原任务时给出明确提示（不自动重复提交）。
        if(!warned&&Date.now()>deadline-READING_POLL_TIMEOUT_MS+60_000){warned=true;options?.onWaiting?.('仍在查询原任务，尚未完成…');}
        await new Promise(resolve=>setTimeout(resolve,600));
      }
    } catch(error) {
      if(Date.now()>=deadline||timeout.aborted){cancel();throw new Error('阅读任务已超过等待上限（150 秒），已停止等待并请求取消原任务；选区已保留，可重试。');}
      if(signal?.aborted){cancel();throw new Error('阅读请求已取消');}
      throw error;
    } finally {signal?.removeEventListener('abort',cancel);}
  },
  /**
   * 需求六：辅助阅读「直接提问」——不参考课程知识库、不标注来源、逐 token 流式。
   * `onDelta` 每收到一个 token 帧就回调一次（调用方边收边渲染）；`error` 帧直接
   * 抛错交由界面进入重试态；`done` 帧后以累计文本 resolve。取消走传入的 signal
   * （宿主侧 onClientDisconnect 会中止上游请求，不落盘任何记录）。
   */
  async ask(document,selection,prompt,signal,options) {
    const question=prompt.trim();
    if(question==='')throw new Error('请输入提示词后再发送。');
    if(signal?.aborted)throw new Error('阅读请求已取消');
    let text='';
    for await (const frame of streamSse<ReadingAskFrame>('/api/syllora/reading-ask',{payload:{courseId:document?.courseId??'',prompt:question,selection,documentTitle:document?.title||document?.name||''}},undefined,signal)) {
      if(frame.event==='token') {
        const delta=typeof frame.data?.delta==='string'?frame.data.delta:'';
        if(delta!==''){text+=delta;options?.onDelta?.(delta);}
      } else if(frame.event==='error') {
        throw new Error(frame.data?.message||'AI 直答未完成，请重试。');
      }
    }
    return {text};
  },
};
