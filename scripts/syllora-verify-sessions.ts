import { fixtureLecture } from './syllora-fixture.ts'
/** Ten synthetic primary learning flows through real local HTTP and a real Host restart. No live provider, private data, or cross-device acceptance. */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { saveProvider, setCredential, activateProvider } from '../packages/host/chat-service/src/settings.ts'
const root = fileURLToPath(new URL('../',import.meta.url))
const workspaceTmp = resolve(root,'../tmp')
await mkdir(workspaceTmp,{recursive:true})
const testRoot=await mkdtemp(join(workspaceTmp,'syllora-sessions-'))
const home=join(testRoot,'home'), data=join(testRoot,'data')
process.env.SYLLORA_HOME=home
await mkdir(data,{recursive:true})
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
const uuid=()=>crypto.randomUUID()
let sequence=0
const mock=createServer((req,res)=>{
  let body='';req.on('data',part=>{body+=part});req.on('end',()=>{
    try {
      const request=JSON.parse(body)
      const last=request.messages.at(-1).content
      const text=typeof last==='string'?last:last.map((p:{text?:string})=>p.text??'').join('')
      const start=Math.max(text.lastIndexOf('\n所选资料（'),text.lastIndexOf('\n所选资料：'))
      assert.ok(start>=0,'fixture source block header')
      const sources=JSON.parse(text.slice(text.indexOf('\n',start+1)+1))
      const sourceId=(sources.find((s:{text:string})=>s.text.includes('主对角线'))??sources[0]).id
      let output:unknown
      if(text.includes('初始化整理课程讲义')) output=fixtureLecture(sources,sourceId)
      else if(text.includes('从资料生成课程')) output={points:[{chapter:'矩阵与线性变换',name:'单位矩阵',sourceIds:[sourceId]}]}
      else if(text.includes('审查下面的题目')) output={valid:true,reason:'测试服务：单一标准答案'}
      else if(text.includes('生成一道四选一题')) {sequence++;output={stem:`练习 ${sequence}：单位矩阵的主对角线元素等于什么？`,options:['1','0','2','3'],answer:0,explanation:'依据本次导入讲义：主对角线为 1，其余元素为 0。',sourceIds:[sourceId],quote:'单位矩阵的主对角线元素为 1'}}
      else output={text:'单位矩阵的主对角线元素为 **1**，其余元素为 **0**。\n\n例如二阶单位矩阵保持二维向量不变。这是教学示例。',sourceIds:[sourceId],insufficient:false}
      res.writeHead(200,{'Content-Type':'text/event-stream'})
      res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'syllora-test-fixture',choices:[{index:0,delta:{role:'assistant',content:JSON.stringify(output)},finish_reason:null}]})}\n\n`)
      res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'syllora-test-fixture',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:150,completion_tokens:80,total_tokens:230}})}\n\n`)
      res.end('data: [DONE]\n\n')
    } catch {res.writeHead(500);res.end('fixture failure')}
  })
})
await new Promise<void>(r=>mock.listen(0,'127.0.0.1',r))
const address=mock.address() as {port:number}
await saveProvider(data,{id:'syllora-test',name:'自动化测试服务',model:'syllora-test-fixture',baseUrl:`http://127.0.0.1:${address.port}/v1`})
await setCredential(data,'syllora-test','test-only-not-a-real-secret')
await activateProvider(data,'syllora-test')
const startHost=()=>spawn(process.execPath,['--import','tsx','apps/cli/src/bin.ts','serve','--port','0'],{cwd:root,env:{...process.env,TSX_TSCONFIG_PATH:join(root,'tsconfig.base.json'),SYLLORA_HOME:home,SYLLORA_DATA_DIR:data,SYLLORA_SYNTHETIC_RUN:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']})
let host=startHost()
let hostOutput='';host.stdout.on('data',b=>{hostOutput+=String(b)});host.stderr.on('data',b=>{hostOutput+=String(b)})
const checks:string[]=[]
const rpcState=async()=>{for(let i=0;i<300;i++) {try{const info=JSON.parse(await readFile(join(home,'host.json'),'utf8'));const response=await fetch(`http://127.0.0.1:${info.port}/api/syllora/state`,{method:'POST',headers:{Authorization:`Bearer ${info.token}`,'Content-Type':'application/json'},body:'{}'});return (await response.json()).result}catch{await sleep(100)}}throw new Error(`Host startup failed: ${hostOutput}`)}
class ApiError extends Error {constructor(message:string,readonly code?:string){super(message)}}
const rpc=async(action:string,payload:Record<string,unknown>={})=>{let lastError:unknown;for(let i=0;i<300;i++) {try{const info=JSON.parse(await readFile(join(home,'host.json'),'utf8'));const response=await fetch(`http://127.0.0.1:${info.port}/api/syllora/${action}`,{method:'POST',headers:{Authorization:`Bearer ${info.token}`,'Content-Type':'application/json'},body:JSON.stringify({payload})});const body=await response.json() as {result?:unknown;error?:{code:string;message:string}};if(body.error)throw new ApiError(body.error.message,body.error.code);if(!response.ok)throw new ApiError(`请求失败 (${response.status})`);return body.result}catch(e){if(e instanceof ApiError&&e.code!=='UNAUTHORIZED')throw e;lastError=e;await sleep(100)}}throw new Error(`host not reachable for ${action}: ${lastError}`)}
const waitUntil=async(ok:()=>Promise<boolean>|boolean,timeout=30000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await ok())return;await sleep(200)}throw new Error('waitUntil timeout')}
const sessions:Array<Record<string,unknown>>=[]
try {
  await rpc('preferences',{consent:true})
  for(let round=0;round<10;round++) {
    const courseId=(await rpc('create',{name:`合成十轮验证 ${round+1}`,requestId:uuid(),timezone:'Etc/UTC'})) as {id:string}
    await rpc('import',{courseId:courseId.id,name:'fixture.txt',text:'自有合成夹具：单位矩阵的主对角线元素为 1，其余元素为 0。单位矩阵与维度匹配的向量相乘，得到原向量。'})
    const view=async()=>((await rpcState()).courses.find((course:{id:string})=>course.id===courseId.id))
    const generate=async(kind:string,extra:Record<string,unknown>={})=>{
      const {jobId}=await rpc('generate',{courseId:courseId.id,kind,requestId:uuid(),...extra}) as {jobId:string};
      await waitUntil(async()=>{const job=(await rpcState()).jobs.find((job:{id:string})=>job.id===jobId);if(job?.state==='failed')throw new Error(`fixture job failed: ${job.errorCode}`);return job?.state==='succeeded'})
    }
    await generate('outline');let course=await view();assert.equal(course.points.length,1)
    await rpc('plan',{courseId:courseId.id,scope:[course.points[0].id],dailyMinutes:40,days:7,restDays:[],baseVersion:0});course=await view();await rpc('confirmPlan',{courseId:courseId.id,baseVersion:0,draftId:course.draft.id})
    course=await view();const taskId=course.plan.tasks[0].id;await rpc('start',{courseId:courseId.id,taskId});course=await view();const sessionId=course.activeSession.id;assert.equal(course.activeSession.mode,'synthetic')
    await generate('answer',{taskId});await rpc('explainDone',{courseId:courseId.id,taskId})
    for(let slot=0;slot<2;slot++) {
      await generate('question',{taskId,slot});course=await view();const question=course.questions.find((question:{taskId:string;slot:number})=>question.taskId===taskId&&question.slot===slot);assert.equal(question.answer,undefined)
      const payload={courseId:courseId.id,questionId:question.id,option:0,requestId:uuid()},attempt=await rpc('submit',payload) as {id:string;sessionId:string;correct:boolean};assert.equal(attempt.correct,true);assert.equal(attempt.sessionId,sessionId);assert.equal((await rpc('submit',payload) as {id:string}).id,attempt.id)
    }
    await rpc('endSession',{courseId:courseId.id,sessionId});course=await view();assert.equal(course.attempts.length,2);assert.equal(course.plan.tasks[0].status,'completed');assert.equal(course.evidence[course.scope[0]].state,'初步掌握');assert.ok(course.next.availableAt);assert.ok(course.metrics.sessions[0].closedLoop);assert.equal(course.metrics.synthetic.pending,1);assert.equal(course.metrics.standard.eligible,0)
    sessions.push({courseId:courseId.id,sessionId,attemptIds:course.attempts.map((attempt:{id:string})=>attempt.id),nextActionId:course.actions.at(-1).id,closedLoop:course.metrics.sessions[0].closedLoop,mode:course.metrics.sessions[0].mode})
    if(round===4) {
      const oldHost=host;const stopped=new Promise<void>(resolve=>oldHost.once('exit',()=>resolve()));oldHost.kill();await stopped;await rm(join(home,'host.json'),{force:true});host=startHost();hostOutput='';host.stdout.on('data',b=>{hostOutput+=String(b)});host.stderr.on('data',b=>{hostOutput+=String(b)});await rpcState();checks.push('real Host restart after five synthetic full flows')
      const restored=await rpcState();assert.equal(restored.courses.length,5);assert.ok(restored.courses.every((course:any)=>course.attempts.length===2&&course.metrics.sessions.length===1&&course.activeSession===null))
    }
  }
  const state=await rpcState();assert.equal(state.courses.length,10);assert.equal(state.courses.reduce((sum:number,course:any)=>sum+course.attempts.length,0),20);assert.equal(state.courses.reduce((sum:number,course:any)=>sum+course.metrics.synthetic.pending,0),10);assert.ok(state.jobs.every((job:any)=>job.state==='succeeded'&&job.usageKnownCalls.input===job.calls&&job.usageKnownCalls.output===job.calls));checks.push('ten isolated primary flows completed with source answers, two independent grades, profile and persisted next action');checks.push('duplicate grades did not increase evidence or sessions');checks.push('synthetic sessions remain outside ordinary-clock denominator and wait for 24-hour observation')
  await writeFile(join(testRoot,'result.json'),JSON.stringify({passed:true,model:'local synthetic HTTP/SSE fixture; not a live provider',device:'same FavioStation; not another member/device acceptance',checks,sessions,calls:state.settings.calls,observedRealSessions:0},null,2));console.log(JSON.stringify({passed:true,artifacts:testRoot,checks,syntheticSessions:sessions.length}))
} catch(error) {await writeFile(join(testRoot,'failure.json'),JSON.stringify({error:String(error),checks,sessions},null,2));console.error(JSON.stringify({artifacts:testRoot,error:String(error)}));throw error}
finally {host.kill();mock.close()}
