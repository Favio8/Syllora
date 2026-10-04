import { api, ApiError, streamSse } from '@/src/lib/api';
import type { SylloraState } from '@/src/types/syllora';
import type { ReadingDocument, ReadingService } from './types';
// R07：前后端共用同一份可见文本解析（Host 的 syllora-selection），加粗/链接/
// 行内代码等格式符号不再让真实选区被误判为"不属于正文"。
import { readingText, normalizeReadingText, selectionBelongs } from '../../../../../packages/host/chat-service/src/syllora-selection';

export async function workbenchRpc<T=unknown>(action:string,payload:unknown={},signal?:AbortSignal,timeoutMs:number=15_000):Promise<T> {
  const token=(window as unknown as {__SYLLORA__?:{token?:string}}).__SYLLORA__?.token;
  const timeout=AbortSignal.timeout(timeoutMs);
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
export async function logicalRequest<T=unknown>(action:string,payload:Record<string,unknown>,timeoutMs?:number):Promise<T> {
  // 调用方显式给出 requestId 时以它为准：响应丢失后重试仍对应原任务。
  restore();const key=await requestKey(action,payload),requestId=typeof payload.requestId==='string'&&payload.requestId!==''?payload.requestId:(requests.get(key)??crypto.randomUUID());remember(key,requestId);
  try {const result=await workbenchRpc<T>(action,{...payload,requestId},undefined,timeoutMs);remember(key,null);return result;}
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
    const normalize=normalizeReadingText;
    const text=normalize(selection),all=document.sources.map(source=>normalize(readingText(source.text,source.kind))).join('');
    const start=all.indexOf(text);
    if(start<0&&!options?.sourceIds?.length)throw new Error('选区不属于当前正文，请重新选择');
    let offset=0;
    const sourceIds=options?.sourceIds??document.sources.filter(source=>{const end=offset+normalize(readingText(source.text,source.kind)).length,match=offset<start+text.length&&end>start;offset=end;return match;}).map(source=>source.id);
    const picked=sourceIds.map(id=>document.sources.find(source=>source.id===id));
    if(picked.some(source=>!source)||!selectionBelongs(picked as ReadingDocument['sources'],selection))throw new Error('选区不属于当前正文，请重新选择');
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
          if(!message?.reading||!('revision' in message.reading)||message.reading.revision!==document.revision)throw new Error('回答不可用，资料可能已删除');
          // state 只带来源定位信息（整本教材不再把全文塞进每次轮询）：摘录用本次已取回的文档正文。
          const sources=document.sources;
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

/**
 * 虚拟课堂：生成在云端（OpenMAIC），宿主做编排，前端只认本项目信封。
 *
 * - 生成：专线 `classroom/generate`（logicalRequest 保证 requestId 幂等，重试沿用同一作业）；
 * - 轮询：点号 `classroom.job`（5 秒节奏，容忍瞬时网络失败——生成要数分钟到数小时）；
 * - 附件：裸字节 POST + 百分号编码的文件名头（与云端同形，宿主暂存到下一次生成）。
 */
export const classroomService = {
  /** 发起生成：附件 id 来自 uploadAttachment；materialIds 指向课程资料（空数组=全部可用资料）。 */
  async generate(input: {
    courseId: string;
    requirement: string;
    materialIds: string[];
    attachmentIds?: string[];
    roles?: Array<{ id: string; name: string; kind: 'teacher' | 'student'; persona?: string; voice?: string }>;
  }) {
    return logicalRequest<{ jobId: string; status: string; step: string }>('classroom/generate', {
      courseId: input.courseId,
      requirement: input.requirement,
      materialIds: input.materialIds,
      attachmentIds: input.attachmentIds ?? [],
      roles: input.roles ?? [],
    });
  },
  /** 轮询作业直到终态；瞬时失败累计一定次数才放弃，4xx（口令/请求错误）立即抛出。 */
  async poll(courseId: string, jobId: string, options: { signal?: AbortSignal; onProgress?: (job: import('@/src/lib/api').ClassroomJobState) => void } = {}) {
    const started = Date.now();
    let transient = 0;
    for (;;) {
      if (options.signal?.aborted) throw new Error('已停止等待；任务可能仍在云端继续');
      let job: import('@/src/lib/api').ClassroomJobState;
      try {
        job = await api.classroomJob(courseId, jobId);
        transient = 0;
      } catch (error) {
        const status = error instanceof ApiError ? error.status : 0;
        // 4xx 是确定的失败（口令、参数），立即抛出；网络抖动与 5xx 继续重试。
        if (status >= 400 && status < 500) throw error;
        transient += 1;
        if (transient > 10) throw error;
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }
      options.onProgress?.(job);
      if (job.done) return job;
      if (Date.now() - started > 3 * 60 * 60_000) throw new Error('等待超时：任务可能仍在云端继续，可稍后刷新课堂列表查看');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  },
  /** 附件上传：裸字节 + 文件名头；返回附件 id（宿主内存暂存，只服务下一次生成）。 */
  async uploadAttachment(courseId: string, file: File) {
    const token = (window as unknown as { __SYLLORA__?: { token?: string } }).__SYLLORA__?.token;
    const response = await fetch(`/api/syllora/classroom/material?courseId=${encodeURIComponent(courseId)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        // 头只能是 ASCII：中文名必须百分号编码（宿主按 decodeURIComponent 解码）。
        'x-material-filename': encodeURIComponent(file.name),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: await file.arrayBuffer(),
      signal: AbortSignal.timeout(180_000),
    });
    let body: { result?: { attachmentId: string; name: string; bytes: number; mime: string; count: number }; error?: { code?: string; message?: string } };
    try { body = await response.json(); } catch { throw new ApiError('INVALID_RESPONSE', `服务返回非 JSON 响应 (${response.status})`, response.status); }
    if (!response.ok || body.error || !body.result) throw new ApiError(body.error?.code ?? 'HTTP_ERROR', body.error?.message ?? `附件上传失败 (${response.status})`, response.status);
    return body.result;
  },
};
