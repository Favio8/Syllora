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
const workspaceTmp = resolve(root,'../tmp/workbench-e2e')
await mkdir(workspaceTmp,{recursive:true})
const testRoot=await mkdtemp(join(workspaceTmp,'syllora-e2e-'))
const desktop=process.env.SYLLORA_E2E_DESKTOP;
const desktopProfile=join(testRoot,'desktop-userdata');
const home=desktop?join(desktopProfile,'host-home'):join(testRoot,'home'), data=desktop?join(desktopProfile,'syllora-data'):join(testRoot,'data')
process.env.SYLLORA_HOME=home
await mkdir(data,{recursive:true})
// B11：含代码块、表格、列表与多行段落的讲义夹具——辅助阅读必须保留换行、
// 缩进与表格行结构，不能连成一堵墙（人工核对 reading-format.png）。
const READING_FIXTURE=[
  '自有测试讲义：单位矩阵与数据结构',
  '',
  '## 单位矩阵',
  '',
  '单位矩阵的主对角线元素为 1，其余元素为 0。',
  '单位矩阵与维度匹配的向量相乘，得到原向量。',
  '它在线性变换里扮演「乘以 1」的角色。',
  '',
  '## 二分查找（代码）',
  '',
  '```python',
  'def lower_bound(nums, target):',
  '    lo, hi = 0, len(nums)',
  '    while lo < hi:',
  '        mid = (lo + hi) // 2',
  '        if nums[mid] < target:',
  '            lo = mid + 1',
  '        else:',
  '            hi = mid',
  '    return lo',
  '```',
  '',
  '## 复杂度对照表',
  '',
  '| 算法 | 时间复杂度 | 空间复杂度 |',
  '| --- | --- | --- |',
  '| 二分查找 | O(log n) | O(1) |',
  '| 归并排序 | O(n log n) | O(n) |',
  '',
  '## 注意事项',
  '',
  '- 代码块必须保留换行与四格缩进',
  '- 表格必须按行解析，不能连成一行',
  '- 列表与多行段落也不能被折叠成一条',
].join('\n')
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
const hostEntry=process.env.SYLLORA_E2E_HOST_ENTRY??'apps/cli/src/bin.ts';
const host=desktop?null:spawn(process.execPath,[...(hostEntry.endsWith('.ts')?['--import','tsx']:[]),hostEntry,'serve','--port','0'],{cwd:root,env:{...process.env,TSX_TSCONFIG_PATH:join(root,'tsconfig.base.json'),SYLLORA_HOME:home,SYLLORA_DATA_DIR:data,SYLLORA_SYNTHETIC_RUN:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']})
let hostOutput='';host?.stdout?.on('data',b=>{hostOutput+=String(b)});host?.stderr?.on('data',b=>{hostOutput+=String(b)})
let browser:any
let page:any
let desktopApp:any
const require=createRequire(join(root,'apps/web/package.json'));
const {chromium,_electron}=require('playwright-core');
const desktopExecutable=desktop==='dev'?createRequire(join(root,'apps/desktop/package.json'))('electron'):desktop;
const desktopEnv={...process.env,SYLLORA_DESKTOP_USERDATA:desktopProfile,SYLLORA_SYNTHETIC_RUN:'1'};delete desktopEnv.ELECTRON_RUN_AS_NODE;
async function launchDesktop(){return _electron.launch({executablePath:desktopExecutable,args:desktop==='dev'?[join(root,'apps/desktop')]:[],env:desktopEnv,timeout:60000});}
const errors:string[]=[]
const failedResponses:string[]=[]
try {
  if(desktop){desktopApp=await launchDesktop();browser=desktopApp;page=await desktopApp.firstWindow();}
  let info:{port:number;token:string}|undefined
  for(let i=0;i<300;i++) {try{info=JSON.parse(await readFile(join(home,'host.json'),'utf8'));break}catch{await new Promise(r=>setTimeout(r,100))}}
  if(!info)throw new Error(`Host startup failed: ${hostOutput}`)
  const origin=`http://127.0.0.1:${info.port}`
  async function rpc(action:string,payload:unknown={}) {const response=await fetch(`${origin}/api/syllora/${action}`,{method:'POST',headers:{Authorization:`Bearer ${info!.token}`,'Content-Type':'application/json'},body:JSON.stringify({payload})});const body=await response.json() as any;if(body.error)throw new Error(body.error.message);return body.result}
  await rpc('preferences',{consent:true})
  if(!desktop){browser=await chromium.launch({executablePath:process.env.SYLLORA_BROWSER??'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});}
  else{await page.setViewportSize({width:1440,height:1000});assert.equal(await page.evaluate(()=>Boolean((window as any).sylloraDesktop?.isDesktop)),true);assert.equal(await desktopApp.evaluate(({app}:any)=>app.getVersion()),'0.1.2-beta');}
  page.on('pageerror',(e:Error)=>errors.push(e.message))
  page.on('response',(response:any)=>{if(response.status()>=400)failedResponses.push(`${response.status()} ${new URL(response.url()).pathname}`)})
  if(!desktop)await page.goto(`${origin}/#token=${info.token}`);else await page.waitForURL(origin,{waitUntil:'domcontentloaded'})
  // 首页内容依赖首次 state 响应；等待客户端就绪后再点 SSR 已可见的用户按钮。
  await page.getByRole('heading',{name:/今天想学点什么/}).waitFor();
  await page.getByRole('button',{name:'用户',exact:true}).click();await page.getByRole('menuitem',{name:'设置',exact:true}).click();
  await page.getByRole('button',{name:'供应商管理（1）',exact:true}).click();await page.getByRole('button',{name:'编辑',exact:true}).click();
  await page.getByText('自定义设置',{exact:false}).first().click();
  await page.getByLabel('默认模型',{exact:true}).selectOption('syllora-test-fixture');
  await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('button',{name:'关闭设置',exact:true}).click();
  const courseFolder=join(testRoot,'线性代数 · 自动化测试')
  await mkdir(courseFolder,{recursive:true})
  await page.getByRole('button',{name:'新建课程',exact:true}).first().click()
  if(desktop){await desktopApp.evaluate(({dialog}:any,path:string)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},courseFolder);await page.getByRole('button',{name:'选择文件夹',exact:true}).click();await page.waitForFunction((path:string)=>document.querySelector<HTMLInputElement>('input[placeholder="选择已有的课程资料文件夹"]')?.value===path,courseFolder);assert.equal(await page.getByLabel('课程文件夹路径').inputValue(),courseFolder);}
  await page.getByLabel('课程文件夹路径').fill(courseFolder)
  await page.getByRole('radio',{name:'数学',exact:true}).check();await page.getByRole('button',{name:'打开此课程',exact:true}).click()
  await page.getByRole('heading',{level:1,name:'线性代数 · 自动化测试'}).waitFor()
  await page.getByRole('tab',{name:'资料',exact:true}).click()
  await page.getByLabel('或粘贴正文').fill(READING_FIXTURE)
  await page.getByRole('button',{name:'保存正文'}).click()
  await page.getByRole('button',{name:/初始化课程 · 1 份资料/}).waitFor()
  await page.getByRole('button',{name:/初始化课程 · 1 份资料/}).click()
  for(let i=0;i<150;i++){if((await rpc('state')).courses[0]?.revision)break;await new Promise(r=>setTimeout(r,100))}
  assert.ok((await rpc('state')).courses[0].revision)
  // 需求三：讲义标签已移除，改由「今日」卡的「阅读讲义」入口打开中栏阅读器。
  await page.getByRole('tab',{name:'今日',exact:true}).click()
  await page.getByRole('button',{name:/阅读讲义/}).click()
  const chapterPicker=page.getByLabel('选择章节');await chapterPicker.waitFor();
  await chapterPicker.locator('option').filter({hasText:'矩阵与线性变换'}).waitFor({state:'attached'});
  await chapterPicker.selectOption((await chapterPicker.locator('option').filter({hasText:'矩阵与线性变换'}).getAttribute('value'))!);
  await page.getByRole('region',{name:'课程讲义'}).getByRole('heading',{name:'矩阵与线性变换',exact:true}).waitFor()
  await page.getByRole('button',{name:/线性代数 · 自动化测试.*\d+ 个知识点/}).waitFor()
  await page.getByRole('button',{name:'取消',exact:true}).waitFor({state:'detached'})
  await page.screenshot({path:join(testRoot,'course-lecture.png'),fullPage:true,animations:'disabled'})
  await page.getByRole('region',{name:'课程讲义'}).getByRole('button',{name:'原文 1',exact:true}).first().click()
  await page.getByRole('dialog',{name:'资料来源'}).waitFor()
  await page.getByRole('button',{name:'关闭来源'}).click()
  await page.getByRole('tab',{name:'学习',exact:true}).click()
  await page.getByRole('button',{name:'选择全部知识点'}).waitFor({timeout:20000})
  const scopeBoxes=page.locator('.sy-point input[type="checkbox"]');
  for(const box of await scopeBoxes.all())await box.uncheck();
  await page.getByRole('checkbox',{name:/单位矩阵/}).check();
  await page.getByRole('button',{name:'生成计划草案'}).click()
  await page.getByRole('button',{name:'确认生效'}).waitFor()
  const initialDraft=(await rpc('state')).courses[0]
  assert.equal(initialDraft.plan,null)
  assert.ok(initialDraft.draftDiff.tasksAdded.length>0)
  await page.getByRole('button',{name:'确认生效'}).click()
  await page.getByRole('button',{name:'继续',exact:true}).click()
  const startedSession=(await rpc('state')).courses[0].activeSession;assert.equal(startedSession.mode,'synthetic');assert.ok(startedSession.id)
  const study=page.getByRole('dialog',{name:'专注学习',exact:true});await study.waitFor();
  await study.getByRole('button',{name:'获取资料讲解',exact:true}).click();await study.getByRole('button',{name:'来源 1',exact:true}).waitFor({timeout:20000});
  await study.getByRole('button',{name:'来源 1',exact:true}).click();await page.getByRole('dialog',{name:'资料来源',exact:true}).waitFor();await page.getByRole('button',{name:'关闭来源',exact:true}).click();
  await study.getByRole('button',{name:'我已完成讲解学习',exact:true}).click();
  for(let slot=0;slot<2;slot++){
    await study.getByRole('button',{name:'生成题目',exact:true}).first().click();
    const choices=study.getByRole('group',{name:`练习 ${slot+1} 选项`});await choices.waitFor({timeout:20000});
    const before=(await rpc('state')).courses[0];assert.equal(before.questions.at(-1).answer,undefined);
    await choices.getByRole('button').nth(slot===0?1:0).click();await study.getByRole('button',{name:'提交答案',exact:true}).click();
    await study.getByText(slot===0?'回答错误 · 已保存独立作答':'回答正确 · 已保存独立作答',{exact:true}).waitFor();
  }
  await study.screenshot({path:join(testRoot,'study-session.png')});await page.getByRole('button',{name:'关闭专注学习',exact:true}).click();
  let state=await rpc('state');const courseId=state.courses[0].id,pointId=state.courses[0].points.find((point:any)=>point.name==='单位矩阵').id;
  assert.deepEqual(state.courses[0].scope,[pointId]);
  assert.equal(state.courses[0].attempts.length,2);assert.equal(state.courses[0].evidence[pointId].state,'待加强');
  await page.getByRole('tab',{name:'学习',exact:true}).click();await page.getByText('错题记录 · 1 题',{exact:true}).click();await page.getByText('你的选项 B：0',{exact:true}).waitFor();
  await page.getByRole('button',{name:'报告此题问题',exact:true}).click();const dispute=page.getByRole('dialog',{name:'题目报错',exact:true});await dispute.getByLabel('报错原因').fill('受控验收：争议题停止计入');await dispute.getByRole('button',{name:'提交报错',exact:true}).click();await dispute.waitFor({state:'detached'});
  assert.equal((await rpc('state')).courses[0].evidence[pointId].state,'待验证');
  await page.getByRole('button',{name:'辅助阅读',exact:true}).click();const paragraph=page.locator('.reading-paper [data-source-id]').filter({hasText:'主对角线'}).first();await paragraph.waitFor();
  // B11：代码保换行与缩进、表格按行解析、多行段落保软换行。
  const codeText=await page.locator('.reading-paper .reading-code code').first().innerText();
  assert.ok(codeText.includes('def lower_bound(nums, target):\n    lo, hi = 0, len(nums)\n    while lo < hi:\n        mid'),`code block lost newlines/indent: ${JSON.stringify(codeText)}`);
  assert.equal(await page.locator('.reading-paper table tr').count(),3);
  assert.ok(await page.locator('.reading-paper .reading-source br').count()>=2,'soft line breaks must survive in paragraphs');
  await page.screenshot({path:join(testRoot,'reading-format.png'),animations:'disabled'});
  await paragraph.evaluate((node:HTMLElement)=>{const range=document.createRange();range.selectNodeContents(node);const sel=window.getSelection()!;sel.removeAllRanges();sel.addRange(range);document.dispatchEvent(new Event('selectionchange'));});
  await page.getByRole('button',{name:'AI解释',exact:true}).click();await page.locator('.reading-explanation').waitFor({timeout:20000});
  await page.screenshot({path:join(testRoot,'reading-assistant.png'),animations:'disabled'});
  state=await rpc('state');assert.ok(state.activity.some((event:any)=>event.kind==='reading'));
  await page.getByRole('button',{name:'对话学习',exact:true}).click();await page.getByRole('button',{name:'归档课程',exact:true}).click();await page.getByRole('button',{name:'恢复课程',exact:true}).click();
  await page.reload();await page.getByRole('button',{name:/线性代数 · 自动化测试.*\d+ 个知识点/}).click();await page.getByRole('heading',{name:'线性代数 · 自动化测试',exact:true}).waitFor();
  state=await rpc('state');assert.equal(state.courses[0].id,courseId);assert.equal(state.courses[0].attempts.length,2);assert.equal(state.courses[0].archived,false);
  assert.deepEqual(errors,[]);assert.deepEqual(failedResponses.filter(x=>!x.startsWith('409 /api/syllora/record')),[]);

  // 需求三：三组标签与视觉规范的人工核对截图（浅色 + 暗色；面板处于空闲态）。
  await page.getByRole('tab',{name:'今日',exact:true}).click()
  await page.screenshot({path:join(testRoot,'panel-today-light.png'),animations:'disabled'})
  await page.getByRole('tab',{name:'学习',exact:true}).click()
  await page.screenshot({path:join(testRoot,'panel-study-light.png'),animations:'disabled'})
  await page.getByRole('tab',{name:'资料',exact:true}).click()
  await page.screenshot({path:join(testRoot,'panel-materials-light.png'),animations:'disabled'})
  await page.evaluate(()=>{document.documentElement.dataset.theme='dark'})
  await page.getByRole('tab',{name:'今日',exact:true}).click()
  await page.screenshot({path:join(testRoot,'panel-today-dark.png'),animations:'disabled'})
  await page.evaluate(()=>{document.documentElement.dataset.theme='light'})
  // 需求五：通知胶囊（右下角）——旧的中栏横条已移除。
  const dock=page.locator('[data-notification-dock]')
  if(await dock.count()>0){await page.screenshot({path:join(testRoot,'notification-capsule.png'),animations:'disabled'})}
  // 中栏底部不再出现旧横条。
  assert.equal(await page.locator('.sy-job').count(),0,'mid-column job bar must be gone')
  assert.equal(await page.locator('.sy-init-failures').count(),0,'mid-column failure list must be gone')
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'收起学习面板',exact:true}).click();
  await page.getByRole('button',{name:'切换状态栏',exact:true}).click();
  await page.screenshot({path:join(testRoot,'panel-mobile.png'),animations:'disabled'});
  await page.setViewportSize({width:1440,height:1000});

  // 在真实 Host（也可用 flat CLI bundle / desktop sidecar）上验证 PDF worker。
  const pdfFolder=join(testRoot,'pdf-worker-course');await mkdir(pdfFolder);
  const {PDFDocument,StandardFonts}=createRequire(join(root,'packages/course/builder/package.json'))('pdf-lib');
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  for(const line of ['Worker source page one contains readable text.','Worker source page two retains its physical anchor.'])pdf.addPage().drawText(line,{x:72,y:700,font});
  await writeFile(join(pdfFolder,'worker-source.pdf'),await pdf.save());
  const pdfCourse=await rpc('openCourse',{path:pdfFolder}),scan=await rpc('scan',{courseId:pdfCourse.id});
  const pdfJob=await rpc('initialize',{courseId:pdfCourse.id,requestId:crypto.randomUUID(),paths:scan.files.filter((file:any)=>file.status==='ready').map((file:any)=>file.path),fingerprints:Object.fromEntries(scan.files.filter((file:any)=>file.status==='ready').map((file:any)=>[file.path,file.fingerprint]))});
  let pdfState:any;
  for(let attempt=0;attempt<200;attempt++){pdfState=await rpc('state');const job=pdfState.jobs.find((item:any)=>item.id===pdfJob.jobId);if(job?.state!=='running'){assert.equal(job?.state,'succeeded',job?.message);break;}await new Promise(resolve=>setTimeout(resolve,100));}
  const parsedPdf=pdfState.courses.find((item:any)=>item.id===pdfCourse.id);
  assert.ok(parsedPdf.revision,'PDF worker initialization must publish');
  assert.equal(parsedPdf.materials[0].pages,2);
  assert.ok(parsedPdf.materials[0].sources.some((source:any)=>source.anchor.includes('第 2 页')),'PDF worker must retain physical page anchors');
  assert.deepEqual(errors,[]);assert.deepEqual(failedResponses.filter(x=>!x.startsWith('409 /api/syllora/record')),[]);
  await writeFile(join(testRoot,'result.json'),JSON.stringify({passed:true,protocol,desktop:desktop??false,checks:['settings editor saves shared model','open folder','save source','initialize published lectures','source navigation','outline and plan confirmation','focused study dialog','server grading and two attempts','wrong answer history','nested source and dispute dialogs','reading assistant activity','archive restore','reload persistence','reading code/table/soft breaks','three study-panel groups in light/dark/mobile','no legacy progress bars','PDF worker pages and published source anchors'],paidCalls:0,errors,failedResponses},null,2));
  console.log(JSON.stringify({passed:true,artifacts:testRoot}));
} catch(error) {
  await page?.screenshot({path:join(testRoot,'failure.png'),fullPage:true,animations:'disabled'}).catch(()=>undefined)
  await writeFile(join(testRoot,'failure.json'),JSON.stringify({error:String(error),browserErrors:errors,failedResponses,visibleText:await page?.locator('body').innerText().catch(()=>'(renderer unavailable)')},null,2))
  console.error(JSON.stringify({artifacts:testRoot,browserErrors:errors,failedResponses}))
  throw error
} finally {await browser?.close();host?.kill();mock.close()}
