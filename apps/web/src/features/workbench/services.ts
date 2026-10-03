import { ApiError } from '@/src/lib/api';
import type { SylloraState } from '@/src/types/syllora';
import type { ReadingAssistance, ReadingDocument, ReadingService } from './types';

export async function workbenchRpc<T=unknown>(action:string,payload:unknown={},signal?:AbortSignal):Promise<T> {
  const token=(window as unknown as {__SYLLORA__?:{token?:string}}).__SYLLORA__?.token;
  const timeout=AbortSignal.timeout(15000);
  const response=await fetch(`/api/syllora/${action}`,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({payload}),signal:signal?AbortSignal.any([signal,timeout]):timeout});
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
/** ��电子书正文切条（与后端 syllora-ui.ts chunkEbookMarkdown 同实现，改动需两边同步；M7 自动判规也复用）。 */
export function chunkEbookMarkdown(markdown: string): Array<{ id: string; section: string; text: string }> {
  const chunks: Array<{ id: string; section: string; text: string }> = [];
  let section = '前言';
  let buffer: string[] = [];
  let chars = 0;
  let index = 0;
  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text !== '') chunks.push({ id: `e${index}`, section: section.trim(), text });
    index++;
    buffer = [];
    chars = 0;
  };
  for (const line of markdown.split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) { flush(); section = heading[1]!.trim(); continue; }
    buffer.push(line);
    chars += line.length;
    if (chars > 1000) flush();
  }
  flush();
  return chunks;
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
          if(!message?.reading||!('revision' in message.reading)||message.reading.revision!==document.revision)throw new Error('回答不可用，资料可能已删除');
          const sources=course!.materials.flatMap(material=>material.sources);
          return {mode,selection,explanation:message.text,matches:message.sourceIds.map(id=>sources.find(source=>source.id===id)).filter(source=>source!==undefined).map(source=>({sourceId:source.id,materialId:source.materialId,title:source.anchor,excerpt:source.text}))};
        }
        await new Promise(resolve=>setTimeout(resolve,600));
      }
    } finally {signal?.removeEventListener('abort',cancel);}
  },
  /** ��电子书 AI解释/AI搜索 —— 范围=电子书本体，后端切条+选区定位（复用 sources 机制）。 */
  async assistEbook(courseId: string, ebookId: string, markdown: string, selection: string, mode: 'explain' | 'search', signal?:AbortSignal): Promise<ReadingAssistance> {
    const result=await logicalRequest<{jobId:string}>('generate',{courseId,kind:'answer',reading:{ebookId,selection,mode}});
    const cancel=()=>{void workbenchRpc('cancel',{courseId,jobId:result.jobId}).catch(()=>undefined);};
    signal?.addEventListener('abort',cancel,{once:true});
    try {
      while(true) {
        if(signal?.aborted){cancel();throw new Error('阅读请求已取消');}
        const state=await workbenchRpc<SylloraState>('state');
        const job=state.jobs.find(job=>job.id===result.jobId);
        if(!job)throw new Error('生成任务不存在，请刷新');
        if(job.state!=='running') {
          if(job.state!=='succeeded')throw new Error(job.message);
          const course=state.courses.find(course=>course.id===courseId);
          const message=course?.messages.find(message=>message.id===job.resultMessageId);
          if(!message?.reading||!('ebookId' in message.reading)||message.reading.ebookId!==ebookId)throw new Error('回答不可用，电子书可能已更新');
          const chunks=chunkEbookMarkdown(markdown);
          const byId=new Map(chunks.map(chunk=>[chunk.id,chunk] as const));
          const matches = message.sourceIds.map(id=>{const chunk=byId.get(id);return chunk?{sourceId:id,materialId:ebookId,title:chunk.section,excerpt:chunk.text.slice(0,140)}:null;}).filter((match):match is NonNullable<typeof match>=>match!==null);
          return {mode,selection,explanation:message.text,matches};
        }
        await new Promise(resolve=>setTimeout(resolve,600));
      }
    } finally {signal?.removeEventListener('abort',cancel);}
  },
};

/** 电子书对象（盖章决策⑤）：独立于资料库，读取 docmind 产物。 */
export interface EbookSummary {
  ebookId: string;
  fileName: string;
  pages: number | null;
  blocks: number;
  tables: number | null;
  images: number | null;
  refinedChars: number;
  outlineCount: number;
  createdAt: number;
}
export interface EbookOutlineNode {
  level: number;
  title: string;
  anchor: string;
  line: number;
}
/** M7 大纲学习状态：绿=已掌握、黄=学习中、红=薄弱（判规 D8 待确认，先手工标记）。 */
export type EbookNodeStatus = 'mastered' | 'learning' | 'weak';
export interface EbookDocument {
  ebookId: string;
  fileName: string;
  markdown: string;
  outline: { nodes: EbookOutlineNode[]; anomalies: Array<{ line: number; title: string; hint: string }> };
  progress: { nodes: Record<string, EbookNodeStatus> };
}

/** 电子书投喂（后端动作 `ebook/ingest`，job 在 state 里按 requestId 对应）。 */
export const ebookService = {
  /** 发起投喂：返回 {jobId, requestId}。大文件 base64 上传走 15s 内小信封（jobId）。 */
  async ingest(input: { courseId: string; fileName: string; base64: string; pageIndex?: string }) {
    const requestId = crypto.randomUUID();
    const result = await workbenchRpc<{ jobId: string }>('ebook/ingest', {
      courseId: input.courseId,
      requestId,
      fileName: input.fileName,
      base64: input.base64,
      ...(input.pageIndex && input.pageIndex.trim() !== '' ? { pageIndex: input.pageIndex.trim() } : {}),
    });
    return { jobId: result.jobId, requestId };
  },
  /** 按 requestId 轮询投喂作业至终态；succeeded 返回终态信息，其余抛 job.message。 */
  async poll(requestId: string, signal?: AbortSignal, onProgress?: (progress: { state: string; message: string }) => void) {
    const started = Date.now();
    while (true) {
      if (signal?.aborted) throw new Error('投喂已取消');
      const state = await workbenchRpc<SylloraState>('state');
      const job = state.jobs.find(job => job.requestId === requestId);
      if (!job) throw new Error('投喂任务不存在，请刷新后重试');
      onProgress?.({ state: job.state, message: job.message });
      if (job.state !== 'running') {
        if (job.state !== 'succeeded') throw new Error(job.message);
        return { state: job.state, message: job.message };
      }
      if (Date.now() - started > 30 * 60_000) throw new Error('投喂超时，请到「数据管理」查看任务状态');
      await new Promise(resolve => setTimeout(resolve, 600));
    }
  },
  /** 电子书列表摘要（扫描 docmind 产物，不入课程表）。 */
  async list(courseId: string) {
    const result = await workbenchRpc<{ ebooks: EbookSummary[] }>('ebook/list', { courseId });
    return result.ebooks;
  },
  /** 电子书正文：精炼版 markdown + 目录骨架（章节下拉/大纲模块的数据源）。 */
  async document(courseId: string, ebookId: string) {
    return workbenchRpc<EbookDocument>('ebook/document', { courseId, ebookId });
  },
  /** M7 大纲学习状态：手工标记 红/黄/绿（status=null 清除），返回最新 progress。 */
  async progressSet(courseId: string, ebookId: string, anchor: string, status: EbookNodeStatus | null) {
    return workbenchRpc<{ saved: boolean; progress: { nodes: Record<string, EbookNodeStatus> } }>(
      'ebook/progress-set',
      { courseId, ebookId, anchor, status },
    );
  },
  /** 电子书内文件（本地化图片等）的 HTTP 地址。 */
  ebookFileUrl(courseId: string, ebookId: string, relPath: string) {
    return `/api/syllora/ebook-file?courseId=${encodeURIComponent(courseId)}&ebookId=${encodeURIComponent(ebookId)}&path=${encodeURIComponent(relPath)}`;
  },
};
