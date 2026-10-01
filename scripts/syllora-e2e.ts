import { fixtureLecture, fixturePdf } from './syllora-fixture.ts'
/** Browser acceptance with a clearly labelled local model fixture; no paid API calls. */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { saveProvider, setCredential, activateProvider } from '../packages/host/chat-service/src/settings.ts'
const root = fileURLToPath(new URL('../',import.meta.url))
const workspaceTmp = resolve(root,'../tmp')
await mkdir(workspaceTmp,{recursive:true})
const testRoot=await mkdtemp(join(workspaceTmp,'syllora-e2e-'))
const home=join(testRoot,'home'), data=join(testRoot,'data')
process.env.SYLLORA_HOME=home
await mkdir(data,{recursive:true})
let sequence=0
const protocol=process.env.SYLLORA_E2E_PROTOCOL==='anthropic'?'anthropic':'openai'
const mock=createServer((req,res)=>{
  if(req.method==='GET' && req.url?.endsWith('/models')) {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'syllora-test-fixture',display_name:'Fixture'}],has_more:false}));return}
  let body='';req.on('data',part=>{body+=part});req.on('end',()=>{
    try {
      assert.equal(req.url,protocol==='anthropic'?'/v1/messages':'/v1/chat/completions')
      assert.equal(protocol==='anthropic'?req.headers['x-api-key']:req.headers.authorization,protocol==='anthropic'?'test-only-not-a-real-secret':'Bearer test-only-not-a-real-secret')
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
      else output={text:sources.some((s:{text:string})=>s.text.includes('主对角线'))?'单位矩阵的主对角线元素为 **1**，其余元素为 **0**。\n\n例如二阶单位矩阵保持二维向量不变。这是教学示例。':`这是本地自动化测试响应。资料原文：${sources[0].text}`,sourceIds:[sourceId],insufficient:false}
      res.writeHead(200,{'Content-Type':'text/event-stream'})
      if(protocol==='anthropic') {
        const frame=(event:string,data:unknown)=>res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        frame('message_start',{message:{usage:{input_tokens:150,output_tokens:0}}});frame('content_block_start',{index:0,content_block:{type:'text',text:''}})
        frame('content_block_delta',{index:0,delta:{type:'text_delta',text:JSON.stringify(output)}});frame('content_block_stop',{index:0})
        frame('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:80}});frame('message_stop',{});res.end();return
      }
      res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'syllora-test-fixture',choices:[{index:0,delta:{role:'assistant',content:JSON.stringify(output)},finish_reason:null}]})}\n\n`)
      res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'syllora-test-fixture',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:150,completion_tokens:80,total_tokens:230}})}\n\n`)
      res.end('data: [DONE]\n\n')
    } catch {res.writeHead(500);res.end('fixture failure')}
  })
})
await new Promise<void>(r=>mock.listen(0,'127.0.0.1',r))
const address=mock.address() as {port:number}
await saveProvider(data,{id:'syllora-test',name:'自动化测试服务',model:'syllora-test-fixture',baseUrl:`http://127.0.0.1:${address.port}/v1`,protocol})
await setCredential(data,'syllora-test','test-only-not-a-real-secret')
await activateProvider(data,'syllora-test')
const host=spawn(process.execPath,['--import','tsx','apps/cli/src/bin.ts','serve','--port','0'],{cwd:root,env:{...process.env,TSX_TSCONFIG_PATH:join(root,'tsconfig.base.json'),SYLLORA_HOME:home,SYLLORA_DATA_DIR:data,SYLLORA_SYNTHETIC_RUN:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']})
let hostOutput='';host.stdout.on('data',b=>{hostOutput+=String(b)});host.stderr.on('data',b=>{hostOutput+=String(b)})
let browser:any
let page:any
const errors:string[]=[]
const failedResponses:string[]=[]
try {
  let info:{port:number;token:string}|undefined
  for(let i=0;i<300;i++) {try{info=JSON.parse(await readFile(join(home,'host.json'),'utf8'));break}catch{await new Promise(r=>setTimeout(r,100))}}
  if(!info)throw new Error(`Host startup failed: ${hostOutput}`)
  const origin=`http://127.0.0.1:${info.port}`
  async function rpc(action:string,payload:unknown={}) {const response=await fetch(`${origin}/api/syllora/${action}`,{method:'POST',headers:{Authorization:`Bearer ${info!.token}`,'Content-Type':'application/json'},body:JSON.stringify({payload})});const body=await response.json() as any;if(body.error)throw new Error(body.error.message);return body.result}
  await rpc('preferences',{consent:true})
  const require=createRequire(join(root,'apps/web/package.json'))
  const {chromium}=require('playwright-core')
  browser=await chromium.launch({executablePath:process.env.SYLLORA_BROWSER??'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true})
  page=await browser.newPage({viewport:{width:1440,height:1000}})
  page.on('pageerror',(e:Error)=>errors.push(e.message))
  page.on('response',(response:any)=>{if(response.status()>=400)failedResponses.push(`${response.status()} ${new URL(response.url()).pathname}`)})
  await page.goto(origin)
  const courseFolder=join(testRoot,'线性代数 · 自动化测试')
  await mkdir(courseFolder,{recursive:true})
  await page.getByRole('button',{name:'打开课程文件夹',exact:true}).first().click()
  await page.getByLabel('课程文件夹路径').fill(courseFolder)
  await page.getByRole('button',{name:'打开此课程',exact:true}).click()
  await page.getByRole('heading',{name:'线性代数 · 自动化测试'}).waitFor()
  await page.getByLabel('或粘贴正文').fill('自有测试讲义：单位矩阵\n\n单位矩阵的主对角线元素为 1，其余元素为 0。单位矩阵与维度匹配的向量相乘，得到原向量。')
  await page.getByRole('button',{name:'保存正文'}).click()
  await page.getByRole('button',{name:/初始化课程 · 1 份资料/}).waitFor()
  await page.getByRole('button',{name:/初始化课程 · 1 份资料/}).click()
  for(let i=0;i<150;i++){if((await rpc('state')).courses[0]?.revision)break;await new Promise(r=>setTimeout(r,100))}
  assert.ok((await rpc('state')).courses[0].revision)
  await page.getByRole('tab',{name:'讲义',exact:true}).click()
  await page.getByRole('region',{name:'课程讲义'}).getByRole('heading',{name:'矩阵与线性变换',exact:true}).waitFor()
  await page.getByRole('button',{name:/线性代数 · 自动化测试.*1 个知识点/}).waitFor()
  await page.getByRole('button',{name:'取消',exact:true}).waitFor({state:'detached'})
  await page.screenshot({path:join(testRoot,'course-lecture.png'),fullPage:true})
  await page.getByRole('region',{name:'课程讲义'}).getByRole('button',{name:'原文 1',exact:true}).first().click()
  await page.getByRole('dialog',{name:'资料来源'}).waitFor()
  await page.getByRole('button',{name:'关闭来源'}).click()
  await page.getByRole('tab',{name:'大纲',exact:true}).click()
  await page.getByRole('button',{name:'选择全部知识点'}).waitFor({timeout:20000})
  await page.getByRole('button',{name:'选择全部知识点'}).click()
  await page.getByRole('button',{name:'生成计划草案'}).click()
  await page.getByRole('button',{name:'确认生效'}).waitFor()
  const initialDraft=(await rpc('state')).courses[0]
  assert.equal(initialDraft.plan,null)
  assert.ok(initialDraft.draftDiff.tasksAdded.length>0)
  await page.getByRole('button',{name:'确认生效'}).click()
  await page.getByRole('button',{name:'继续',exact:true}).click()
  const startedSession=(await rpc('state')).courses[0].activeSession;assert.equal(startedSession.mode,'synthetic');assert.ok(startedSession.id)
  await page.getByRole('button',{name:'获取资料讲解'}).click()
  await page.getByRole('button',{name:'来源 1',exact:true}).waitFor({timeout:20000})
  await page.getByRole('button',{name:'我已完成讲解学习'}).click()
  await page.getByRole('button',{name:'生成题目',exact:true}).first().click()
  await page.getByRole('group',{name:'练习 1 选项'}).waitFor({timeout:20000})
  let state=await rpc('state');assert.equal(state.courses[0].questions[0].answer,undefined)
  await page.getByRole('group',{name:'练习 1 选项'}).getByRole('button').nth(1).click()
  // Persist an unsubmitted selection, then rebuild the page from server state.
  for(let i=0;i<50;i++) {if((await rpc('state')).courses[0].drafts.answers.length)break;await new Promise(r=>setTimeout(r,100))}
  assert.equal((await rpc('state')).courses[0].drafts.answers[0]?.option,1)
  await page.reload()
  await page.getByRole('group',{name:'练习 1 选项'}).waitFor()
  // Answer selection is hydrated from the draft cache in a post-render effect, so wait for the value instead of reading it immediately.
  await page.waitForFunction(()=>String(document.querySelectorAll('[aria-label="练习 1 选项"] button')[1]?.className).includes('is-selected'))
  assert.equal((await rpc('state')).courses[0].activeSession.id,startedSession.id)
  await page.getByRole('button',{name:'提交答案',exact:true}).click()
  await page.getByText('回答错误 · 已保存独立作答',{exact:true}).waitFor()
  await page.getByRole('button',{name:'生成题目',exact:true}).click()
  await page.getByRole('group',{name:'练习 2 选项'}).waitFor({timeout:20000})
  await page.getByRole('group',{name:'练习 2 选项'}).getByRole('button').first().click()
  await page.getByRole('button',{name:'提交答案',exact:true}).click()
  await page.getByRole('button',{name:/单位矩阵.*活动完成/}).waitFor()
  await page.getByRole('tab',{name:'复习',exact:true}).click()
  await page.getByText('错题记录 · 1 题',{exact:true}).click()
  await page.getByText('你的选项 B：0',{exact:true}).waitFor()
  await page.getByText('正确选项 A：1',{exact:true}).waitFor()
  await page.getByRole('button',{name:'查看错题依据',exact:true}).click()
  await page.getByRole('dialog',{name:'资料来源'}).waitFor();await page.getByRole('button',{name:'关闭来源'}).click()
  await page.screenshot({path:join(testRoot,'wrong-answer-history.png'),fullPage:true})
  await page.screenshot({path:join(testRoot,'mvp-workbench.png'),fullPage:true})
  state=await rpc('state');const courseId=state.courses[0].id;const pointId=state.courses[0].points[0].id
  assert.equal(state.courses[0].evidence[pointId].state,'待加强');assert.equal(state.courses[0].attempts.length,2)
  assert.ok(state.courses[0].actions.length>0)
  assert.equal(state.courses[0].attempts[0].sessionId,startedSession.id);assert.ok(state.courses[0].attempts[0].nextActionId)
  await page.getByText('记录额外人工帮助',{exact:true}).click();await page.getByLabel('人工帮助原因').fill('合成验证：记录额外操作指导');await page.getByRole('button',{name:'保存人工帮助记录',exact:true}).click()
  for(let i=0;i<50;i++){if((await rpc('state')).courses[0].metrics.helpCount===1)break;await new Promise(r=>setTimeout(r,100))}
  state=await rpc('state');assert.equal(state.courses[0].metrics.helpCount,1);assert.ok(state.courses[0].metrics.sourceReports.shown>0)
  await page.getByRole('button',{name:'报告回答来源问题',exact:true}).first().click();const report=page.getByRole('dialog',{name:'回答来源报错'});await report.getByLabel('回答报错原因').fill('合成验证：来源仍需人工核验');await report.getByRole('button',{name:'保存回答报错',exact:true}).click();await report.waitFor({state:'detached'});
  state=await rpc('state');assert.equal(state.courses[0].messages.find((message:any)=>message.role==='assistant').report.reason,'合成验证：来源仍需人工核验')
  await page.getByText('复习间隔设置',{exact:true}).click();await page.getByLabel('首次补强与复测（小时）').fill('48');await page.getByLabel('会话闲置关闭（分钟）').fill('45');const oldDue=state.courses[0].evidence[pointId].dueAt;await page.getByRole('button',{name:'保存未来复习间隔',exact:true}).click()
  for(let i=0;i<50;i++){if((await rpc('state')).courses[0].learningSettings.revision===1)break;await new Promise(r=>setTimeout(r,100))}
  state=await rpc('state');assert.deepEqual(state.courses[0].learningSettings.reviewHours,[48,72,168]);assert.equal(state.courses[0].evidence[pointId].dueAt,oldDue);assert.equal(state.courses[0].activeSession.idleMinutes,30)
  await page.getByText('学习过程记录',{exact:true}).click();await page.screenshot({path:join(testRoot,'session-observations.png'),fullPage:true})
  await page.getByRole('tab',{name:'计划',exact:true}).click()
  await page.getByRole('heading',{name:'下一行动记录',exact:true}).waitFor()
  await page.getByRole('heading',{name:'分母变化',exact:true}).waitFor()
  const originalPlan=JSON.stringify(state.courses[0].plan)
  await page.getByRole('tab',{name:'复习',exact:true}).click()
  await page.getByRole('button',{name:/生成(到期复习|即时巩固)草案/}).click()
  await page.getByRole('button',{name:'保留原计划',exact:true}).waitFor()
  state=await rpc('state');assert.equal(JSON.stringify(state.courses[0].plan),originalPlan)
  assert.ok(state.courses[0].draftDiff.tasksAdded.length>0)
  await page.screenshot({path:join(testRoot,'review-plan-diff.png'),fullPage:true})
  await page.getByRole('button',{name:'保留原计划',exact:true}).click()
  await page.getByRole('button',{name:'保留原计划',exact:true}).waitFor({state:'detached'})
  state=await rpc('state');assert.equal(JSON.stringify(state.courses[0].plan),originalPlan)
  assert.equal(state.courses[0].draft,null)
  await page.getByRole('tab',{name:'复习',exact:true}).click()
  await page.getByRole('button',{name:/生成(到期复习|即时巩固)草案/}).click()
  await page.getByRole('button',{name:'确认生效',exact:true}).click()
  await page.getByRole('button',{name:'确认生效',exact:true}).waitFor({state:'detached'})
  state=await rpc('state');assert.equal(state.courses[0].changes.length,2)
  await page.reload();await page.getByRole('heading',{name:'线性代数 · 自动化测试'}).waitFor()
  state=await rpc('state');assert.equal(state.courses[0].progress.completed,1)
  await page.getByRole('tab',{name:'计划',exact:true}).click();await page.getByRole('button',{name:/单位矩阵.*活动完成/}).first().click()
  await page.getByRole('button',{name:'题目报错并暂停计入',exact:true}).first().click()
  const dispute=page.getByRole('dialog',{name:'题目报错'});await dispute.getByLabel('报错原因').fill('自动化测试：排除唯一错答');await dispute.getByRole('button',{name:'提交报错',exact:true}).click();await dispute.waitFor({state:'detached'})
  state=await rpc('state');assert.equal(state.courses[0].evidence[pointId].state,'待验证')
  await page.getByRole('button',{name:'模型与设置'}).click();await page.getByRole('dialog',{name:'模型与设置'}).waitFor()
  await page.getByRole('button',{name:'供应商管理（1）',exact:true}).click();await page.getByText('自动化测试服务',{exact:true}).waitFor();await page.getByRole('button',{name:'编辑',exact:true}).click()
  await page.getByText('自定义设置',{exact:false}).first().click();assert.equal(await page.locator('select[name$="_protocol"]').inputValue(),protocol)
  await page.getByRole('dialog',{name:'模型与设置'}).screenshot({path:join(testRoot,'model-settings.png')})
  await page.getByRole('button',{name:'诊断日志',exact:true}).click();await page.getByRole('button',{name:'导出诊断日志',exact:true}).waitFor();const settingsBox=await page.getByRole('dialog',{name:'模型与设置'}).boundingBox(),closeBox=await page.getByRole('button',{name:'关闭设置',exact:true}).boundingBox();assert.ok(closeBox.y>=settingsBox.y&&closeBox.y+closeBox.height<=settingsBox.y+settingsBox.height);await page.getByRole('dialog',{name:'模型与设置'}).screenshot({path:join(testRoot,'diagnostics.png')})
  await page.getByRole('button',{name:'关闭设置',exact:true}).click()
  for(const name of ['线性代数 · 已命名','线性代数 · 自动化测试']) {await page.getByRole('button',{name:'重命名课程',exact:true}).click();const rename=page.getByRole('dialog',{name:'重命名课程'});await rename.getByLabel('课程名称').fill(name);await rename.getByRole('button',{name:'保存',exact:true}).click();await rename.waitFor({state:'detached'});await page.getByRole('heading',{name,exact:true}).waitFor()}
  state=await rpc('state');assert.equal(state.courses.find((c:{id:string})=>c.id===courseId).folder,courseFolder)
  await page.getByRole('textbox',{name:'向课程资料提问'}).fill('切课后保留的未发送问题')
  const secondFolder=join(testRoot,'切课草稿检查');await mkdir(secondFolder)
  await page.getByRole('button',{name:'打开课程文件夹',exact:true}).click()
  await page.getByLabel('课程文件夹路径').fill(secondFolder)
  await page.getByRole('button',{name:'打开此课程',exact:true}).click()
  await page.getByRole('heading',{name:'切课草稿检查',exact:true}).waitFor()
  await page.getByRole('button',{name:/线性代数 · 自动化测试.*个知识点/}).click()
  await page.getByRole('heading',{name:'线性代数 · 自动化测试',exact:true}).waitFor()
  // The prompt draft is hydrated in a post-render effect; wait for the value instead of reading it immediately.
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[aria-label="向课程资料提问"]')?.value==='切课后保留的未发送问题')
  state=await rpc('state');assert.equal(state.courses.find((c:{id:string})=>c.id===courseId).drafts.prompt,'切课后保留的未发送问题')
  assert.equal(state.courses.find((c:{id:string})=>c.id===courseId).activeSession.id,startedSession.id)
  await page.reload()
  await page.getByRole('button',{name:/线性代数 · 自动化测试.*个知识点/}).click()
  await page.getByRole('heading',{name:'线性代数 · 自动化测试',exact:true}).waitFor()
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[aria-label="向课程资料提问"]')?.value==='切课后保留的未发送问题')
  const pdfFolder=join(testRoot,'PDF 原件验收');await mkdir(pdfFolder)
  const original=fixturePdf(['PDF original fixture text.','','Final physical page evidence.']);await writeFile(join(pdfFolder,'讲义.pdf'),original)
  await page.getByRole('button',{name:'打开课程文件夹',exact:true}).click();await page.getByLabel('课程文件夹路径').fill(pdfFolder);await page.getByRole('button',{name:'打开此课程',exact:true}).click()
  await page.getByRole('heading',{name:'PDF 原件验收',exact:true}).waitFor();await page.getByRole('button',{name:/初始化课程 · 1 份资料/}).click()
  await page.locator('.sy-job.sy-error').filter({hasText:'资料部分可用'}).waitFor()
  await page.getByRole('checkbox',{name:'解析部分失败时，接受明确列出的可用部分'}).check()
  await page.getByRole('button',{name:/初始化课程 · 1 份资料/}).click()
  await page.getByRole('button',{name:'预览原文件',exact:true}).waitFor()
  await page.locator('.sy-issues summary').click();await page.locator('.sy-issues').getByText(/第 2 页/).waitFor()
  await page.screenshot({path:join(testRoot,'pdf-material-details.png'),fullPage:true})
  const previewResponse=page.waitForResponse((response:any)=>new URL(response.url()).pathname==='/api/syllora/material-file')
  await page.getByRole('button',{name:'预览原文件',exact:true}).click();const preview=await previewResponse
  assert.equal(preview.status(),200);assert.equal(preview.request().method(),'GET');assert.ok(preview.request().headers().authorization);assert.equal(new URL(preview.url()).searchParams.has('token'),false)
  await page.getByRole('dialog',{name:'原文件预览'}).waitFor()
  // Read the blob actually used by the viewer; CDP may hide native PDF response bodies.
  const previewBytes=await page.evaluate(async()=>{const src=document.querySelector<HTMLIFrameElement>('iframe[title="PDF 原文件"]')!.src;return Array.from(new Uint8Array(await(await fetch(src)).arrayBuffer()))})
  assert.ok(Buffer.from(previewBytes).equals(original),'PDF viewer blob must match the original bytes')
  await page.getByRole('link',{name:'下载原文件'}).waitFor()
  await page.waitForTimeout(750)
  await page.screenshot({path:join(testRoot,'pdf-original-preview.png'),fullPage:true});await page.getByRole('button',{name:'关闭原文件预览'}).click()
  await page.getByRole('textbox',{name:'向课程资料提问'}).fill('根据资料说明');await page.getByRole('button',{name:'发送问题',exact:true}).click()
  await page.locator('.sy-job').filter({hasText:/本次使用 \d+ \/ \d+ 个候选片段/}).waitFor();await page.screenshot({path:join(testRoot,'context-coverage.png'),fullPage:true})
  state=await rpc('state');const pdfCourse=state.courses.find((c:{folder?:string})=>c.folder===pdfFolder),originalSourceIds=pdfCourse.materials[0].sources.map((s:{id:string})=>s.id),firstRevision=pdfCourse.revision
  await writeFile(join(pdfFolder,'讲义.pdf'),fixturePdf(['PDF original fixture text.','','Revised final page evidence.']))
  await page.getByRole('button',{name:'预览原文件',exact:true}).click();await page.getByRole('alert').filter({hasText:'原文件已变化'}).waitFor()
  await page.getByRole('button',{name:'重新扫描资料',exact:true}).click();await page.getByText(/内容已变化/).waitFor();await page.getByRole('button',{name:/更新课程讲义 · 1 份资料/}).click()
  for(let i=0;i<150;i++){const latest=(await rpc('state')).courses.find((c:{id:string})=>c.id===pdfCourse.id);if(latest.revision!==firstRevision){assert.equal(latest.materials[0].revisionNumber,2);assert.ok(originalSourceIds.every((id:string)=>[...latest.materials[0].sources,...latest.materials[0].history].some(s=>s.id===id)));break}await new Promise(r=>setTimeout(r,100))}
  assert.notEqual((await rpc('state')).courses.find((c:{id:string})=>c.id===pdfCourse.id).revision,firstRevision)
  await page.getByText(/部分可用 · 已接受 · v2 ·/).waitFor();await page.screenshot({path:join(testRoot,'pdf-version-update.png'),fullPage:true})
  assert.deepEqual(failedResponses,['409 /api/syllora/material-file'])
  assert.deepEqual(errors,[])
  await writeFile(join(testRoot,'result.json'),JSON.stringify({passed:true,protocol,model:'local test fixture, not a live provider',checks:['synthetic session survives reload and course switch','source exposure and answer report persisted','manual help record persisted','future review settings preserve historical due and active idle snapshot','open course folder','inspect saved source','initialize','read lecture','locate original source','outline','confirm plan','cited answer','hidden answer','fixed grading','grouped wrong-answer history and source','task completion','reload persistence','dispute replay','model settings with provider protocol','diagnostics view','rename without moving course folder','next-action history','denominator trace','review diff reject and confirm','answer draft reload','course-switch prompt draft','PDF partial confirmation and physical page issues','authenticated byte-for-byte original preview','answer context coverage','changed original preview rejected','material version update preserves original source IDs'],browserErrors:errors,expectedFailures:failedResponses},null,2))
  console.log(JSON.stringify({passed:true,artifacts:testRoot}))
} catch(error) {
  await page?.screenshot({path:join(testRoot,'failure.png'),fullPage:true})
  await writeFile(join(testRoot,'failure.json'),JSON.stringify({error:String(error),browserErrors:errors,failedResponses,visibleText:await page?.locator('body').innerText()},null,2))
  console.error(JSON.stringify({artifacts:testRoot,browserErrors:errors,failedResponses}))
  throw error
} finally {await browser?.close();host.kill();mock.close()}
