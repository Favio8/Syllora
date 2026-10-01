import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { HarnessError, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { structuredCall, type StructuredCallClient } from '@syllora/course-builder'
import { SylloraService } from '../src/syllora.ts'
import { buildPlan, type Course } from '../src/syllora-domain.ts'
import { finishJob, generationFailure, jobDiagnostics, recordTokenUsage } from '../src/syllora-jobs.ts'

const roots:string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
describe('PRD bounded generation and execution diagnostics',()=>{
  it('classifies an outer request deadline as timeout even when the adapter reports caller abort',async()=>{
    const controller=new AbortController();let calls=0;
    const client:StructuredCallClient={async *stream(){calls++;controller.abort(new DOMException('synthetic deadline','TimeoutError'));throw new HarnessError('adapter abort','ABORTED');yield {type:'text-delta',text:'never'}}};
    const failure=await structuredCall(client,z.object({ok:z.boolean()}),{provider:'fixture',model:'fixture',messages:[],signal:controller.signal},3).catch(error=>error);
    expect(generationFailure(failure).code).toBe('UPSTREAM_TIMEOUT');expect(calls).toBe(1);
  })
  it('accepts a complete structured tool block without argument deltas',async()=>{
    const client:StructuredCallClient={async *stream(){yield {type:'block-end',index:0,block:{type:'tool-call',id:'fixture',name:'_emit_structured',arguments:'{"ok":true}'}} as StreamChunk}};
    expect(await structuredCall(client,z.object({ok:z.boolean()}),{provider:'fixture',model:'fixture',messages:[]},1)).toEqual({ok:true});
  })
  it('does not publish complete JSON returned after cancellation',async()=>{
    const controller=new AbortController();const client:StructuredCallClient={async *stream(){yield {type:'text-delta',text:'{"ok":true}'};controller.abort()}};
    const result=await structuredCall(client,z.object({ok:z.boolean()}),{provider:'fixture',model:'fixture',messages:[],signal:controller.signal},1).catch(error=>error);
    expect(result).toBeInstanceOf(Error);expect(generationFailure(result).code).toBe('CANCELLED');
  })
  it.each(['missing-field','wrong-option-count','invalid-answer','duplicate-options','foreign-source','unsupported-quote','failed-review'])(
    'blocks %s before publication and preserves the evidence snapshot',async mode=>{
      const root=await mkdtemp(join(tmpdir(),'syllora-invalid-output-'));roots.push(root);const now=Date.UTC(2026,9,2),pointId=randomUUID(),sourceId=randomUUID(),courseId=randomUUID();
      const course:Course={id:courseId,name:'合成题目校验课程',timezone:'Asia/Shanghai',archived:false,createdAt:now,materials:[{id:'m',name:'fixture.txt',fingerprint:'fixture',status:'ready',accepted:true,pages:0,sources:[{id:sourceId,materialId:'m',anchor:'段落 1',text:'合成定义：单位矩阵保持原向量不变。'}]}],points:[{id:pointId,name:'单位矩阵',chapter:'矩阵',sourceIds:[sourceId]}],scope:[pointId],plan:null,draft:null,questions:[],attempts:[],messages:[],actions:[],drafts:{prompt:'',answers:[]},changes:[],notice:null};
      course.plan=buildPlan(course,{scope:course.scope,dailyMinutes:40,days:7,restDays:[]},now,randomUUID);course.plan.tasks[0]!.status='in_progress';
      await writeFile(join(root,'syllora.json'),JSON.stringify({version:1,consent:true,calls:0,courses:[course],jobs:[]}));
      const output:any={stem:'合成问题：单位矩阵保持什么？',options:['原向量','答案 B','答案 C','答案 D'],answer:0,explanation:'合成定义支持答案。',sourceIds:[sourceId],quote:'单位矩阵保持原向量不变'};
      if(mode==='missing-field')delete output.stem;
      if(mode==='wrong-option-count')output.options.pop();
      if(mode==='invalid-answer')output.answer=4;
      if(mode==='duplicate-options')output.options[1]=' 原向量！';
      if(mode==='foreign-source')output.sourceIds=[randomUUID()];
      if(mode==='unsupported-quote')output.quote='从未出现在资料中的文字';
      let calls=0;const client:StructuredCallClient={async *stream(){calls++;yield {type:'text-delta',text:JSON.stringify(calls===1?output:{valid:false,reason:'合成复核拒绝'})}}};
      const svc=new SylloraService(root,{now:()=>now,config:async()=>({providerId:'fixture',model:'fixture',baseUrl:'http://127.0.0.1:9/v1',apiKey:'fixture-only',apiKeyEnv:null,temperature:0,maxConcurrency:1,defaultMode:'quick'}),client:()=>client});
      await svc.handle('generate',{courseId,requestId:randomUUID(),kind:'question',taskId:course.plan.tasks[0]!.id,slot:0});await svc.settleJobs();
      const state=await svc.handle('state') as any;expect(state.jobs[0].state).toBe('failed');expect(state.courses[0].questions).toEqual([]);expect(state.courses[0].attempts).toEqual([]);expect(state.courses[0].evidence[pointId].state).toBe('未评估');expect(state.courses[0].plan).toEqual(course.plan);
      expect(calls).toBe(mode==='failed-review'?2:1);
    })

  it.each([true,false])('compares every bounded history batch and rejects a semantic duplicate in an early batch: %s',async reject=>{
    const root=await mkdtemp(join(tmpdir(),'syllora-semantic-'));roots.push(root);const now=Date.UTC(2026,9,2),pointId=randomUUID(),sourceId=randomUUID(),courseId=randomUUID();
    const c:Course={id:courseId,name:'合成语义避重',timezone:'Etc/UTC',archived:false,createdAt:now,materials:[{id:'m',name:'fixture.txt',fingerprint:'fixture',status:'ready',accepted:true,pages:0,sources:[{id:sourceId,materialId:'m',anchor:'段落1',text:'单位矩阵保持原向量不变。'}]}],points:[{id:pointId,name:'单位矩阵',chapter:'矩阵',sourceIds:[sourceId]}],scope:[pointId],plan:null,draft:null,questions:[],attempts:[],messages:[],actions:[],drafts:{prompt:'',answers:[]},changes:[],notice:null};c.plan=buildPlan(c,{scope:c.scope,dailyMinutes:40,days:7,restDays:[]},now,randomUUID);c.plan.tasks[0]!.status='in_progress';
    for(let i=0;i<8;i++)c.questions.push({id:randomUUID(),pointId,taskId:'old',slot:0,family:`history-${i}`,stem:`历史题 ${i}：`+'合成题干'.repeat(450),options:['甲'.repeat(500),'乙'.repeat(500),'丙'.repeat(500),'丁'.repeat(500)],answer:0,explanation:'合成',sourceIds:[sourceId],quote:'单位矩阵保持原向量不变',status:'valid',assisted:false});
    const output={stem:'合成候选：变换后向量如何？',options:['保持原值','答案 B','答案 C','答案 D'],answer:0,explanation:'合成说明',sourceIds:[sourceId],quote:'单位矩阵保持原向量不变'};
    await writeFile(join(root,'syllora.json'),JSON.stringify({version:1,consent:true,calls:0,courses:[c],jobs:[]}));const compared:string[]=[],prompts:string[]=[];let calls=0;
    const client:StructuredCallClient={async *stream(options){calls++;const prompt=(options.messages.at(-1) as any).content[0].text;prompts.push(prompt);if(calls===1){yield {type:'text-delta',text:JSON.stringify(output)};return}const json=prompt.split('历史题批次：')[1].split('\n本次候选')[0];const history=JSON.parse(json);expect(json.length).toBeLessThanOrEqual(8002);compared.push(...history.map((q:any)=>q.id));yield {type:'text-delta',text:JSON.stringify({valid:!(reject&&history.some((q:any)=>q.id===c.questions[0]!.id)),reason:'合成近重复判定'})}}};
    const svc=new SylloraService(root,{now:()=>now,config:async()=>({providerId:'fixture',model:'fixture',baseUrl:'http://127.0.0.1:9/v1',apiKey:'fixture-only',apiKeyEnv:null,temperature:0,maxConcurrency:1,defaultMode:'quick'}),client:()=>client});await svc.handle('generate',{courseId,requestId:randomUUID(),kind:'question',taskId:c.plan.tasks[0]!.id,slot:0});await svc.settleJobs();const state=await svc.handle('state') as any;
    expect(prompts[1]).toContain('语义近重复');expect(prompts[1]).toContain('不同概念关系或推理步骤');expect(state.jobs[0].state).toBe(reject?'failed':'succeeded');expect(state.courses[0].questions).toHaveLength(reject?8:9);expect(state.courses[0].attempts).toHaveLength(0);
    if(reject){expect(calls).toBe(2);expect(state.jobs[0].errorCode).toBe('QUESTION_INVALID');expect(state.jobs[0].message).toContain('语义避重')}else{expect(new Set(compared)).toEqual(new Set(c.questions.map(q=>q.id)));expect(compared.length).toBe(8);expect(calls).toBeGreaterThan(2)}
  })

  it.each(['QUOTA','RATE_LIMIT','TIMEOUT','AUTH','OUTPUT_TRUNCATED'])(
    'preserves %s through wrappers without exposing provider response text',code=>{
      const result=generationFailure(new Error('outer',{cause:new HarnessError('fixture-private-response',code)}))
      expect(result.code).toBe({QUOTA:'QUOTA_EXCEEDED',RATE_LIMIT:'RATE_LIMITED',TIMEOUT:'UPSTREAM_TIMEOUT',AUTH:'MODEL_AUTH_FAILED',OUTPUT_TRUNCATED:'OUTPUT_TRUNCATED'}[code])
      expect(result.message).not.toContain('fixture-private-response')
    })
  it.each(['error','aborted','max-tokens'] as const)('does not publish parseable JSON when the stream terminates with %s',async kind=>{
    const reason=kind==='max-tokens'?{kind}:{kind,failure:{code:kind==='error'?'QUOTA':'ABORTED',message:'fixture-private-response'}}
    const client:StructuredCallClient={async *stream(){yield {type:'text-delta',text:'{"ok":true}'};yield {type:'finish',reason} as StreamChunk}}
    const error=await structuredCall(client,z.object({ok:z.boolean()}),{provider:'fixture',model:'fixture',messages:[]},1).catch(error=>error)
    expect(error).toBeInstanceOf(Error)
    expect(generationFailure(error).code).toBe(kind==='error'?'QUOTA_EXCEEDED':kind==='aborted'?'CANCELLED':'OUTPUT_TRUNCATED')
  })
  it('stops retries once an abort signal is observed',async()=>{
    let calls=0;const controller=new AbortController()
    const client:StructuredCallClient={async *stream(){calls++;controller.abort();throw new DOMException('fixture-abort','AbortError');yield {type:'text-delta',text:'never'}}}
    await expect(structuredCall(client,z.object({ok:z.boolean()}),{provider:'fixture',model:'fixture',messages:[],signal:controller.signal},3)).rejects.toThrow()
    expect(calls).toBe(1)
  })
  it('records versioned lifecycle durations without inventing token usage',()=>{
    const job={createdAt:100,...jobDiagnostics()};finishJob(job,250,'RATE_LIMITED')
    expect(job).toMatchObject({promptVersion:'syllora-teaching-v2',ruleVersion:'syllora-v1',finishedAt:250,elapsedMs:150,errorCode:'RATE_LIMITED'})
  })
  it('does not persist arbitrary provider responses in initialization progress failures',async()=>{
    const root=await mkdtemp(join(tmpdir(),'syllora-initialize-failure-'));roots.push(root);await writeFile(join(root,'fixture.md'),'# 合成定义\n\n单位矩阵保持原向量不变。');
    const courseId=randomUUID();const client:StructuredCallClient={async *stream(){throw new HarnessError('fixture-private-response','QUOTA');yield {type:'text-delta',text:'never'}}};
    const svc=new SylloraService(join(root,'.syllora'),{courseRoot:root,config:async()=>({providerId:'fixture',model:'fixture',baseUrl:'http://127.0.0.1:9/v1',apiKey:'fixture-only',apiKeyEnv:null,temperature:0,maxConcurrency:1,defaultMode:'quick'}),client:()=>client});
    await svc.handle('create',{name:'合成初始化失败',requestId:courseId});await svc.handle('preferences',{consent:true});await svc.handle('initialize',{courseId,requestId:randomUUID(),paths:['fixture.md']});await svc.settleJobs();
    const state=await svc.handle('state') as any;expect(state.jobs[0]).toMatchObject({state:'failed',errorCode:'QUOTA_EXCEEDED'});expect(state.jobs[0].progress.failures).toHaveLength(1);
    expect(state.jobs[0].progress.failures[0]).toContain('供应商账户配额');expect(await readFile(join(root,'.syllora','syllora.json'),'utf8')).not.toContain('fixture-private-response');
  })
  it('keeps per-direction completeness for partial usage and rejects invalid counts without inventing zero',()=>{
    const job={...jobDiagnostics(),inputTokens:null as number|null,outputTokens:null as number|null};recordTokenUsage(job,null,null);expect(job.inputTokens).toBeNull();expect(job.usageKnownCalls).toEqual({input:0,output:0});recordTokenUsage(job,12,0);recordTokenUsage(job,null,5);recordTokenUsage(job,-1,NaN);expect(job.inputTokens).toBe(12);expect(job.outputTokens).toBe(5);expect(job.usageKnownCalls).toEqual({input:1,output:2})
  })
  it('persists quota errors once and preserves history and the request identity',async()=>{
    const root=await mkdtemp(join(tmpdir(),'syllora-reliability-'));roots.push(root)
    let calls=0;const client:StructuredCallClient={async *stream(){calls++;yield {type:'finish',reason:{kind:'error',failure:{code:'QUOTA',message:'fixture-private-response'}}} as StreamChunk}}
    const svc=new SylloraService(root,{config:async()=>({providerId:'fixture',model:'fixture',baseUrl:'http://127.0.0.1:9/v1',apiKey:'fixture-only',apiKeyEnv:null,temperature:0,maxConcurrency:1,defaultMode:'quick'}),client:()=>client})
    const courseId=randomUUID(),requestId=randomUUID()
    await svc.handle('create',{name:'合成故障课程',requestId:courseId});await svc.handle('import',{courseId,name:'fixture.txt',text:'仅供自动测试的合成来源。'})
    await svc.handle('preferences',{consent:true})
    const first=await svc.handle('generate',{courseId,requestId,kind:'answer',prompt:'合成问题'})
    await svc.settleJobs()
    expect(await svc.handle('generate',{courseId,requestId,kind:'answer',prompt:'合成问题'})).toEqual(first)
    const state=await svc.handle('state') as any,job=state.jobs[0]
    expect(calls).toBe(1);expect(job.state).toBe('failed');expect(job.errorCode).toBe('QUOTA_EXCEEDED')
    expect(job.finishedAt).toBeGreaterThanOrEqual(job.createdAt);expect(job.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(state.courses[0].materials).toHaveLength(1);expect(state.courses[0].attempts).toHaveLength(0)
    expect(await readFile(join(root,'syllora.json'),'utf8')).not.toContain('fixture-private-response')
  })
})
