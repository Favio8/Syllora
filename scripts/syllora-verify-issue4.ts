/** Issue #4 browser scenarios not covered by syllora-e2e.ts: stale polling, save failure, dual-page plan confirmation, legacy snapshot load, archive/restore. Uses the same clearly labelled local model fixture; no paid API calls. */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { saveProvider, setCredential, activateProvider } from '../packages/host/chat-service/src/settings.ts'
const root = fileURLToPath(new URL('../',import.meta.url))
const workspaceTmp = resolve(root,'../tmp')
await mkdir(workspaceTmp,{recursive:true})
const testRoot=await mkdtemp(join(workspaceTmp,'syllora-issue4-'))
const home=join(testRoot,'home'), data=join(testRoot,'data')
process.env.SYLLORA_HOME=home
await mkdir(data,{recursive:true})
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
const uuid=()=>crypto.randomUUID()
const screenshots:string[]=[]
const shot=async(page:any,name:string)=>{const path=join(testRoot,name);await page.screenshot({path,fullPage:true});screenshots.push(name)}
let sequence=0
const mock=createServer((req,res)=>{
  let body='';req.on('data',part=>{body+=part});req.on('end',()=>{
    try {
      const request=JSON.parse(body)
      const last=request.messages.at(-1).content
      const text=typeof last==='string'?last:last.map((p:{text?:string})=>p.text??'').join('')
      const start=text.indexOf('[{"id":')
      const sources=JSON.parse(text.slice(start))
      const sourceId=(sources.find((s:{text:string})=>s.text.includes('主对角线'))??sources[0]).id
      let output:unknown
      if(text.includes('从资料生成课程')) output={points:[{chapter:'矩阵与线性变换',name:'单位矩阵',sourceIds:[sourceId]}]}
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
const startHost=()=>spawn(process.execPath,['--import','tsx','apps/cli/src/bin.ts','serve','--port','0'],{cwd:root,env:{...process.env,TSX_TSCONFIG_PATH:join(root,'tsconfig.base.json'),SYLLORA_HOME:home,SYLLORA_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']})
let host=startHost()
let hostOutput='';host.stdout.on('data',b=>{hostOutput+=String(b)});host.stderr.on('data',b=>{hostOutput+=String(b)})
let browser:any
let page:any
const errors:string[]=[]
const failedResponses:string[]=[]
const evidence:Record<string,unknown>={}
const checks:string[]=[]
const rpcState=async()=>{for(let i=0;i<300;i++) {try{const info=JSON.parse(await readFile(join(home,'host.json'),'utf8'));const response=await fetch(`http://127.0.0.1:${info.port}/api/syllora/state`,{method:'POST',headers:{Authorization:`Bearer ${info.token}`,'Content-Type':'application/json'},body:'{}'});return (await response.json()).result}catch{await sleep(100)}}throw new Error(`Host startup failed: ${hostOutput}`)}
let token=''
class ApiError extends Error {constructor(message:string,readonly code?:string){super(message)}}
const rpc=async(action:string,payload:Record<string,unknown>={})=>{let lastError:unknown;for(let i=0;i<300;i++) {try{const info=JSON.parse(await readFile(join(home,'host.json'),'utf8'));token=info.token;const response=await fetch(`http://127.0.0.1:${info.port}/api/syllora/${action}`,{method:'POST',headers:{Authorization:`Bearer ${info.token}`,'Content-Type':'application/json'},body:JSON.stringify({payload})});const body=await response.json() as {result?:unknown;error?:{code:string;message:string}};if(body.error)throw new ApiError(body.error.message,body.error.code);if(!response.ok)throw new ApiError(`请求失败 (${response.status})`);return body.result}catch(e){if(e instanceof ApiError&&e.code!=='UNAUTHORIZED')throw e;lastError=e;await sleep(100)}}throw new Error(`host not reachable for ${action}: ${lastError}`)}
const waitUntil=async(ok:()=>Promise<boolean>|boolean,timeout=30000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await ok())return;await sleep(200)}throw new Error('waitUntil timeout')}
try {
  // Bootstrap over the real HTTP envelope: course, material, outline, plan v1, one wrong answer.
  await rpc('preferences',{consent:true,callLimit:20})
  const courseId=(await rpc('create',{name:'issue4 验证课程',requestId:uuid(),timezone:'Asia/Shanghai'})) as {id:string}
  await rpc('import',{courseId:courseId.id,name:'讲义.txt',text:'自有测试讲义：单位矩阵\n\n单位矩阵的主对角线元素为 1，其余元素为 0。单位矩阵与维度匹配的向量相乘，得到原向量。'})
  await rpc('generate',{courseId:courseId.id,kind:'outline',requestId:uuid()})
  await waitUntil(async()=>((await rpcState()).courses[0].points as unknown[]).length>0)
  let state=await rpcState();const pointId=state.courses[0].points[0].id
  await rpc('plan',{courseId:courseId.id,scope:[pointId],dailyMinutes:40,days:7,restDays:[],baseVersion:0})
  state=await rpcState();await rpc('confirmPlan',{courseId:courseId.id,baseVersion:0,draftId:state.courses[0].draft.id})
  const taskId=(await rpcState()).courses[0].plan.tasks[0].id
  await rpc('start',{courseId:courseId.id,taskId})
  await rpc('generate',{courseId:courseId.id,kind:'question',requestId:uuid(),taskId,slot:0})
  await waitUntil(async()=>((await rpcState()).courses[0].questions as Array<{status:string}>)?.some?.(q=>q.status==='valid'))
  state=await rpcState();const questionId=state.courses[0].questions[0].id
  const attempt=await rpc('submit',{courseId:courseId.id,questionId,option:1,requestId:uuid()}) as {id:string;correct:boolean}
  assert.equal(attempt.correct,false)
  evidence.bootstrap={courseId:courseId.id,pointId,taskId,questionId,attemptId:attempt.id}
  checks.push('bootstrap plan and fixed grading')
  const require=createRequire(join(root,'apps/web/package.json'))
  const {chromium}=require('playwright-core')
  browser=await chromium.launch({executablePath:process.env.SYLLORA_BROWSER??'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true})
  page=await browser.newPage({viewport:{width:1440,height:1000}})
  page.on('pageerror',(e:Error)=>errors.push(e.message))
  page.on('response',(response:any)=>{if(response.status()>=400)failedResponses.push(`${response.status()} ${new URL(response.url()).pathname}`)})
  const info=JSON.parse(await readFile(join(home,'host.json'),'utf8'))
  const origin=`http://127.0.0.1:${info.port}`
  await page.goto(origin)
  await page.getByRole('heading',{name:'issue4 验证课程',exact:true}).waitFor()
  const promptBox=()=>page.getByRole('textbox',{name:'向课程资料提问'})

  // Scenario 1: a state response whose request started before the draft save must not overwrite the
  // saved draft. The first intercepted poll is issued pre-edit, then fulfilled with the pre-edit body
  // after a delay (polledAt < savedAt, the guarded race). Later polls are held so a poisoned cache
  // could not heal before switching away and back rehydrates from it.
  await rpc('create',{name:'issue4 第二门课程',requestId:uuid(),timezone:'Asia/Shanghai'})
  const staleBody=JSON.stringify({result:await rpcState()})
  let pollPhase:'armed'|'held'|'after-stale'='armed'
  let markHeld:(()=>void)|undefined
  const pollHeld=new Promise<void>(resolve=>{markHeld=resolve})
  await page.route('**/api/syllora/state',async route=>{
    if(pollPhase==='armed') {pollPhase='held';markHeld();await sleep(3000);await route.fulfill({contentType:'application/json',body:staleBody});pollPhase='after-stale';return}
    if(pollPhase==='after-stale') await sleep(15000)
    await route.continue()
  })
  await pollHeld
  await promptBox().fill('旧轮询不应覆盖的草稿')
  await sleep(1200)
  await waitUntil(async()=>(await rpcState()).courses[0].drafts.prompt==='旧轮询不应覆盖的草稿')
  await sleep(3000)
  assert.equal(await promptBox().inputValue(),'旧轮询不应覆盖的草稿')
  await page.getByRole('button',{name:/issue4 第二门课程.*0 个知识点/}).click()
  await page.getByRole('heading',{name:'issue4 第二门课程',exact:true}).waitFor()
  await page.getByRole('button',{name:/issue4 验证课程.*1 个知识点/}).click()
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[aria-label="向课程资料提问"]')?.value==='旧轮询不应覆盖的草稿')
  await shot(page,'01-stale-poll-guard.png')
  await page.unroute('**/api/syllora/state')
  await page.reload()
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[aria-label="向课程资料提问"]')?.value==='旧轮询不应覆盖的草稿')
  checks.push('stale polling keeps saved draft')

  // Scenario 3 (page pair): page B is frozen on a stale state snapshot while page A confirms live.
  await rpc('plan',{courseId:courseId.id,scope:[pointId],dailyMinutes:40,days:7,restDays:[],baseVersion:1})
  const frozenBody=JSON.stringify({result:await rpcState()})
  const expectedDraft=JSON.parse(frozenBody).result.courses[0].draft.id
  const contextB=await browser.newContext()
  const pageB=await contextB.newPage()
  await pageB.route('**/api/syllora/state',route=>route.fulfill({contentType:'application/json',body:frozenBody}))
  await pageB.setViewportSize({width:1440,height:1000})
  await pageB.goto(origin)
  await pageB.getByRole('heading',{name:'issue4 验证课程',exact:true}).waitFor()
  await pageB.getByRole('tab',{name:'计划',exact:true}).click()
  await pageB.getByRole('button',{name:'确认生效',exact:true}).waitFor()
  await page.getByRole('tab',{name:'计划',exact:true}).click()
  // Wrong answers now create a proposal. Wait for the explicit replacement draft before confirming.
  await page.locator(`.sy-draft[data-draft-id="${expectedDraft}"]`).waitFor()
  await page.getByRole('button',{name:'确认生效',exact:true}).waitFor()
  await page.getByRole('button',{name:'确认生效',exact:true}).click()
  await page.getByRole('button',{name:'确认生效',exact:true}).waitFor({state:'detached'})
  state=await rpcState();assert.equal(state.courses[0].plan.version,2);assert.equal(state.courses[0].draft,null)
  await shot(pageB,'03a-dual-page-frozen-draft.png')
  await pageB.getByRole('button',{name:'确认生效',exact:true}).click()
  await pageB.locator('.sy-error').filter({hasText:'没有待确认计划'}).waitFor()
  await rpc('plan',{courseId:courseId.id,scope:[pointId],dailyMinutes:40,days:7,restDays:[],baseVersion:2})
  await pageB.getByRole('button',{name:'确认生效',exact:true}).click()
  await pageB.locator('.sy-error').filter({hasText:'另一页面更新了草案'}).waitFor()
  state=await rpcState();assert.equal(state.courses[0].plan.version,2);assert.ok(state.courses[0].draft)
  await pageB.unroute('**/api/syllora/state')
  await pageB.getByText('待确认草案 · v3').waitFor()
  await shot(pageB,'03b-dual-page-conflict.png')
  evidence.dualPage={appliedPlanVersion:2,conflicts:['没有待确认计划','另一页面更新了草案，请查看最新差异后确认']}
  checks.push('dual-page confirm rejected (consumed and replaced draft)')

  // Task-progress protection over the real HTTP envelope: draft made stale by learning progress.
  await rpc('plan',{courseId:courseId.id,scope:[pointId],dailyMinutes:40,days:7,restDays:[],baseVersion:2})
  await rpc('explainDone',{courseId:courseId.id,taskId})
  await rpc('generate',{courseId:courseId.id,kind:'question',requestId:uuid(),taskId,slot:1})
  await waitUntil(async()=>{const q=((await rpcState()).courses[0].questions as Array<{slot:number;status:string}>).filter(item=>item.slot===1&&item.status==='valid');return q.length>0})
  state=await rpcState();const question2=state.courses[0].questions.find((q:{slot:number})=>q.slot===1)
  await rpc('submit',{courseId:courseId.id,questionId:question2.id,option:0,requestId:uuid()})
  state=await rpcState();assert.equal(state.courses[0].plan.tasks[0].status,'completed')
  await assert.rejects(rpc('confirmPlan',{courseId:courseId.id,baseVersion:2,draftId:state.courses[0].draft.id}),/任务进度已变化/)
  await rpc('rejectPlan',{courseId:courseId.id})
  checks.push('task-progress change rejects stale draft')

  // Scenario 2: a failed draft save must keep the user on the current course.
  await page.route('**/api/syllora/saveDraft',route=>route.abort())
  await promptBox().fill('这条草稿保存会失败')
  await page.locator('.sy-error').filter({hasText:'未提交草稿未能保存，已停留在当前课程'}).waitFor()
  await page.getByRole('button',{name:/issue4 第二门课程.*0 个知识点/}).click()
  await sleep(800)
  assert.equal(await page.getByRole('heading',{name:'issue4 验证课程',exact:true}).isVisible(),true)
  await shot(page,'02-save-failure-stays.png')
  await page.unroute('**/api/syllora/saveDraft')
  checks.push('save failure keeps user on current course')

  // Scenario 4: restart on a legacy snapshot (no actions/drafts/changes/notice) with an aged attempt.
  host.kill();await new Promise<void>(r=>host.on('exit',r))
  await rm(join(home,'host.lock'),{force:true})
  const snapshotPath=join(data,'syllora.json')
  const db=JSON.parse(await readFile(snapshotPath,'utf8')) as {courses:Array<Record<string,unknown>>}
  for (const course of db.courses) {delete course.actions;delete course.drafts;delete course.changes;delete course.notice;for (const attemptItem of course.attempts as Array<{at:number}>) attemptItem.at-=25*3_600_000}
  await writeFile(snapshotPath,JSON.stringify(db))
  host=startHost();hostOutput='';host.stdout.on('data',b=>{hostOutput+=String(b)});host.stderr.on('data',b=>{hostOutput+=String(b)})
  await rpcState()
  const restarted=JSON.parse(await readFile(join(home,'host.json'),'utf8')) as {port:number}
  await page.goto(`http://127.0.0.1:${restarted.port}`)
  await page.getByRole('heading',{name:'issue4 验证课程',exact:true}).waitFor()
  state=await rpcState();const loaded=state.courses.find((c:{id:string})=>c.id===courseId.id)
  assert.ok(Array.isArray(loaded.actions)&&loaded.actions.length>0)
  assert.deepEqual(loaded.drafts,{prompt:'',answers:[]})
  assert.deepEqual(loaded.changes,[])
  assert.equal(loaded.notice,null)
  await shot(page,'04-legacy-snapshot-load.png')
  checks.push('legacy snapshot loads with defaults')

  // Scenario 5: archive write protection, restore notice, restore draft keeps the plan until confirmed.
  await page.getByRole('button',{name:'归档课程'}).click()
  await page.getByRole('heading',{name:'课程已归档，恢复后可继续学习'}).waitFor()
  assert.equal(await page.getByRole('button',{name:/^继续/}).isDisabled(),true)
  await page.locator('.sy-section-title').filter({hasText:'已归档'}).waitFor()
  await assert.rejects(rpc('plan',{courseId:courseId.id,scope:[pointId],dailyMinutes:40,days:7,restDays:[],baseVersion:2}),/请先恢复归档课程/)
  await shot(page,'05a-archive-protection.png')
  const planBeforeRestore=JSON.stringify(loaded.plan)
  await page.getByRole('button',{name:'恢复课程'}).click()
  await page.getByText('恢复后有 1 项复习已到期。确认新日程前，原计划保持不变。').waitFor()
  await shot(page,'05b-restore-notice.png')
  await page.getByRole('button',{name:'生成恢复日程草案'}).click()
  await page.getByText('待确认草案 · v3').waitFor()
  state=await rpcState()
  assert.equal(JSON.stringify(state.courses.find((c:{id:string})=>c.id===courseId.id).plan),planBeforeRestore)
  assert.equal(state.courses.find((c:{id:string})=>c.id===courseId.id).draftDiff.tasksAdded.length,1)
  await shot(page,'05c-restore-draft.png')
  await page.getByRole('button',{name:'确认生效',exact:true}).click()
  await page.getByRole('button',{name:'确认生效',exact:true}).waitFor({state:'detached'})
  state=await rpcState();const restored=state.courses.find((c:{id:string})=>c.id===courseId.id)
  assert.equal(restored.plan.version,3)
  assert.ok(restored.plan.tasks.some((t:{kind:string;pointId:string})=>t.kind==='review'&&t.pointId===pointId))
  assert.equal(restored.changes.length,1)
  evidence.restore={planVersion:restored.plan.version,changes:restored.changes.length}
  await shot(page,'05d-restore-confirmed.png')
  checks.push('archive protection and restore draft flow')

  const unexpectedFailures=failedResponses.filter(entry=>!entry.includes('/api/syllora/confirmPlan'))
  assert.deepEqual(unexpectedFailures,[])
  assert.deepEqual(errors,[])
  await contextB.close()
  await writeFile(join(testRoot,'result.json'),JSON.stringify({passed:true,model:'local test fixture, not a live provider',checks,evidence,screenshots,browserErrors:errors},null,2))
  console.log(JSON.stringify({passed:true,artifacts:testRoot,checks}))
} catch(error) {
  await page?.screenshot({path:join(testRoot,'failure.png'),fullPage:true})
  await writeFile(join(testRoot,'failure.json'),JSON.stringify({error:String(error),checks,browserErrors:errors,failedResponses,visibleText:await page?.locator('body').innerText()},null,2))
  console.error(JSON.stringify({artifacts:testRoot,checks,browserErrors:errors,failedResponses}))
  throw error
} finally {await browser?.close();host.kill();mock.close()}
