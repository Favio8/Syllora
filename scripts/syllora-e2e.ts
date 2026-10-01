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
process.env.STUDYCLAW_HOME=home
await mkdir(data,{recursive:true})
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
      else if(text.includes('生成一道四选一题')) {sequence++;output={stem:`练习 ${sequence}：单位矩阵的主对角线元素等于什么？`,options:['1','0','2','-1'],answer:0,explanation:'依据本次导入讲义：主对角线为 1，其余元素为 0。',sourceIds:[sourceId],quote:'单位矩阵的主对角线元素为 1'}}
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
const host=spawn(process.execPath,['--import','tsx','apps/cli/src/bin.ts','serve','--port','0'],{cwd:root,env:{...process.env,TSX_TSCONFIG_PATH:join(root,'tsconfig.base.json'),STUDYCLAW_HOME:home,SYLLORA_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']})
let hostOutput='';host.stdout.on('data',b=>{hostOutput+=String(b)});host.stderr.on('data',b=>{hostOutput+=String(b)})
let browser:any
try {
  let info:{port:number;token:string}|undefined
  for(let i=0;i<300;i++) {try{info=JSON.parse(await readFile(join(home,'host.json'),'utf8'));break}catch{await new Promise(r=>setTimeout(r,100))}}
  if(!info)throw new Error(`Host startup failed: ${hostOutput}`)
  const origin=`http://127.0.0.1:${info.port}`
  async function rpc(action:string,payload:unknown={}) {const response=await fetch(`${origin}/api/syllora/${action}`,{method:'POST',headers:{Authorization:`Bearer ${info!.token}`,'Content-Type':'application/json'},body:JSON.stringify({payload})});const body=await response.json() as any;if(body.error)throw new Error(body.error.message);return body.result}
  await rpc('preferences',{consent:true,callLimit:20})
  const require=createRequire(join(root,'apps/web/package.json'))
  const {chromium}=require('playwright-core')
  browser=await chromium.launch({executablePath:process.env.SYLLORA_BROWSER??'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true})
  const page=await browser.newPage({viewport:{width:1440,height:1000}})
  const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message))
  await page.goto(origin)
  await page.getByRole('button',{name:'创建第一门课程'}).click()
  await page.getByLabel('课程名称').fill('线性代数 · 自动化测试')
  await page.getByRole('button',{name:'创建课程',exact:true}).click()
  await page.getByRole('heading',{name:'线性代数 · 自动化测试'}).waitFor()
  await page.getByLabel('或粘贴正文').fill('自有测试讲义：单位矩阵\n\n单位矩阵的主对角线元素为 1，其余元素为 0。单位矩阵与维度匹配的向量相乘，得到原向量。')
  await page.getByRole('button',{name:'保存正文'}).click()
  await page.getByText('可用 · 2 个片段',{exact:true}).waitFor()
  await page.getByRole('tab',{name:'大纲',exact:true}).click()
  await page.getByRole('button',{name:'从资料生成／补充大纲'}).click()
  await page.getByRole('button',{name:'选择全部知识点'}).waitFor({timeout:20000})
  await page.getByRole('button',{name:'选择全部知识点'}).click()
  await page.getByRole('button',{name:'生成计划草案'}).click()
  await page.getByRole('button',{name:'确认生效'}).click()
  await page.getByRole('button',{name:'继续',exact:true}).click()
  await page.getByRole('button',{name:'获取资料讲解'}).click()
  await page.getByRole('button',{name:'来源 1',exact:true}).waitFor({timeout:20000})
  await page.getByRole('button',{name:'我已完成讲解学习'}).click()
  await page.getByRole('button',{name:'生成题目',exact:true}).first().click()
  await page.getByRole('group',{name:'练习 1 选项'}).waitFor({timeout:20000})
  let state=await rpc('state');assert.equal(state.courses[0].questions[0].answer,undefined)
  await page.getByRole('group',{name:'练习 1 选项'}).getByRole('button').nth(1).click()
  await page.getByRole('button',{name:'提交答案',exact:true}).click()
  await page.getByText('回答错误 · 已保存独立作答',{exact:true}).waitFor()
  await page.getByRole('button',{name:'生成题目',exact:true}).click()
  await page.getByRole('group',{name:'练习 2 选项'}).waitFor({timeout:20000})
  await page.getByRole('group',{name:'练习 2 选项'}).getByRole('button').first().click()
  await page.getByRole('button',{name:'提交答案',exact:true}).click()
  await page.getByText('活动已完成',{exact:true}).waitFor()
  await page.getByRole('tab',{name:'复习',exact:true}).click()
  await page.screenshot({path:join(testRoot,'mvp-workbench.png'),fullPage:true})
  state=await rpc('state');const courseId=state.courses[0].id;const pointId=state.courses[0].points[0].id
  assert.equal(state.courses[0].evidence[pointId].state,'待加强');assert.equal(state.courses[0].attempts.length,2)
  await page.reload();await page.getByRole('heading',{name:'线性代数 · 自动化测试'}).waitFor()
  state=await rpc('state');assert.equal(state.courses[0].progress.completed,1)
  const questionId=state.courses[0].questions[0].id
  await rpc('dispute',{courseId,questionId,reason:'自动化测试：排除唯一错答'})
  state=await rpc('state');assert.equal(state.courses[0].evidence[pointId].state,'待验证')
  await page.getByRole('button',{name:'模型与设置'}).click();await page.getByRole('dialog',{name:'模型与设置'}).waitFor();await page.screenshot({path:join(testRoot,'model-settings.png'),fullPage:true})
  assert.deepEqual(errors,[])
  await writeFile(join(testRoot,'result.json'),JSON.stringify({passed:true,model:'local test fixture, not a live provider',checks:['create','import','outline','confirm plan','cited answer','hidden answer','fixed grading','task completion','reload persistence','dispute replay','model settings'],browserErrors:errors},null,2))
  console.log(JSON.stringify({passed:true,artifacts:testRoot}))
} finally {await browser?.close();host.kill();mock.close()}
