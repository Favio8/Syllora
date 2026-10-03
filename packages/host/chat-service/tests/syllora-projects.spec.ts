import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { StructuredCallClient } from '@syllora/course-builder'
import { SylloraProjects, migrateSharedSettings } from '../src/syllora-projects.ts'
import { SylloraService } from '../src/syllora.ts'
import { selectContext, sha, structuredSources, within } from '../src/syllora-files.ts'
import * as files from '../src/syllora-files.ts'
import { evidence, type Course } from '../src/syllora-domain.ts'
import { validateLecture } from '../src/syllora-initialize.ts'
import type { ResolvedChatConfig } from '../src/config.ts'

/** ENOTEMPTY/EBUSY：取消类用例的清理会与仍在收尾的写入竞争，重试几次即可，不掩盖真正的清理失败。 */
async function removeCourseRoot(root:string){
  for(let attempt=0;;attempt++){
    try { await rm(root,{recursive:true,force:true}); return }
    catch(error){
      const code=(error as NodeJS.ErrnoException).code
      if(attempt>=5||!['ENOTEMPTY','EBUSY','EPERM'].includes(code??''))throw error
      await new Promise(r=>setTimeout(r,50*2**attempt))
    }
  }
}
const temp=resolve('..','tmp','course-folder-tests'),roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0)){if(!root.startsWith(temp))throw new Error('unsafe test cleanup');await removeCourseRoot(root)}})
const config:ResolvedChatConfig={providerId:'fixture',model:'fixture',baseUrl:'http://localhost:9999/v1',apiKey:'fixture-only',apiKeyEnv:null,temperature:0,maxConcurrency:1,defaultMode:'quick'}
function lecture(sources:any[]) {
  return {chapter:sources[0].section.split(' / ').at(-1).slice(0,60),intro:{text:'按资料整理的章节导读。',sourceIds:sources.map(s=>s.id)},concepts:sources.filter(s=>s.text.length>=4&&s.kind!=='heading').map((s,i)=>({name:`${s.section.split(' / ').at(-1).slice(0,45)} 概念 ${i+1}`,text:'概念解释来自所附资料。',sourceIds:[s.id],quote:s.text.slice(0,Math.min(40,s.text.length))})),examples:[],connections:[],analogies:[]}
}
async function setup(change?:(sources:any[],call:number)=>Promise<unknown>|unknown,pdf?:NonNullable<ConstructorParameters<typeof SylloraProjects>[1]>['pdf'],maxConcurrency=1) {
  await mkdir(temp,{recursive:true});const root=await mkdtemp(join(temp,'case-'));roots.push(root)
  const folder=join(root,'course');await mkdir(folder)
  let calls=0
  const client:StructuredCallClient={async *stream(options){const raw=JSON.stringify(options.messages);const message=(options.messages.at(-1) as any).content[0].text;const sources=JSON.parse(message.slice(message.indexOf('所选资料：\n')+'所选资料：\n'.length));calls++;yield {type:'text-delta',text:JSON.stringify(change?await change(sources,calls):lecture(sources))};expect(raw).not.toContain('fixture-only')}}
  const app=join(root,'app'), projects=new SylloraProjects(app,{config:async()=>({...config,maxConcurrency}),client:()=>client,...(pdf?{pdf}:{})})
  await projects.handle('preferences',{consent:true})
  const course=await projects.handle('openCourse',{path:folder}) as {id:string}
  return {root,folder,app,projects,id:course.id,calls:()=>calls,client}
}
async function settle(projects:SylloraProjects,jobId:string){for(let i=0;i<400;i++){const state=await projects.handle('state',{}) as any;const job=state.jobs.find((j:any)=>j.id===jobId);if(job&&job.state!=='running')return {state,job};await new Promise(r=>setTimeout(r,10))}throw new Error('initialization did not settle')}
async function initialize(s:Awaited<ReturnType<typeof setup>>,acceptPartial=false){const scan=await s.projects.handle('scan',{courseId:s.id}) as any;const files=scan.files.filter((f:any)=>f.status==='ready');const job=await s.projects.handle('initialize',{courseId:s.id,requestId:randomUUID(),paths:files.map((f:any)=>f.path),fingerprints:Object.fromEntries(files.map((f:any)=>[f.path,f.fingerprint])),acceptPartial}) as any;return settle(s.projects,job.jobId)}
const DOC='# 第一章\n\n单位矩阵的主对角线元素为一，其余元素为零。\n\n# 第二章\n\n矩阵乘法需要检查左矩阵列数与右矩阵行数是否相等。\n'
describe('course folder initialization',()=>{
  it('CR-14: retries loading projects after a damaged index is repaired without restarting',async()=>{
    const s=await setup(),filename=join(s.app,'.syllora','projects.json')
    const original=await readFile(filename,'utf8')
    await writeFile(filename,'{broken')
    // 同一实例先失败一次：load 必须清掉 ready 缓存，修好文件后无需重启即可重试。
    const restarted=new SylloraProjects(s.app)
    await expect(restarted.handle('state',{})).rejects.toThrow()
    await writeFile(filename,original)
    expect((await restarted.handle('state',{}) as any).courses[0].id).toBe(s.id)
  })
  it('persists one stable identity and restores records after reopening and moving folders',async()=>{
    const s=await setup();await writeFile(join(s.folder,'lecture.md'),DOC)
    const first=await initialize(s);expect(first.job.state).toBe('succeeded');expect(first.state.courses[0].points).toHaveLength(2);expect(first.state.courses[0].scope).toEqual([])
    expect((await s.projects.handle('openCourse',{path:s.folder}) as any).id).toBe(s.id)
    const restarted=new SylloraProjects(s.app,{config:async()=>config});expect((await restarted.handle('state',{}) as any).courses[0].revision).toBe(first.state.courses[0].revision)
    const moved=join(s.root,'moved');await rename(s.folder,moved)
    expect((await restarted.handle('openCourse',{path:moved}) as any).id).toBe(s.id)
    expect((await restarted.handle('state',{}) as any).courses[0].folder).toBe(moved)
    expect(await stat(s.folder).catch(()=>null)).toBeNull()
    const stored=JSON.parse(await readFile(join(moved,'.syllora','course.json'),'utf8'));expect(stored.courses[0].id).toBe(s.id)
  })
  it('covers late chapters beyond 22,000 characters and more than 30 knowledge points',async()=>{
    const s=await setup();const doc=Array.from({length:40},(_,i)=>`# 第${i+1}章\n\n主题${i+1}的定义。${'本段包含课程依据与完整解释。'.repeat(45)}\n`).join('\n');await writeFile(join(s.folder,'long.md'),doc)
    expect(doc.length).toBeGreaterThan(22000)
    const {state,job}=await initialize(s);expect(job.state).toBe('succeeded');expect(state.courses[0].points).toHaveLength(40)
    const result=await s.projects.handle('lectures',{courseId:s.id}) as any;expect(result.lectures).toHaveLength(40);expect(result.lectures.at(-1).chapter).toBe('第40章')
    const manifest=JSON.parse(await readFile(join(s.folder,'.syllora','revisions',state.courses[0].revision,'manifest.json'),'utf8'));expect(manifest.coveredSourceCount).toBe(manifest.sourceCount)
    expect(await readFile(join(s.folder,'long.md'),'utf8')).toBe(doc)
    const ids=state.courses[0].points.map((point:any)=>point.id),calls=s.calls();
    const replay=await initialize(s);expect(replay.job.state).toBe('succeeded');expect(s.calls()).toBe(calls);expect(replay.state.courses[0].points.map((point:any)=>point.id)).toEqual(ids)
    await writeFile(join(s.folder,'long.md'),doc.replace('主题40的定义。','主题40的定义，新增尾章依据。'))
    const changed=await initialize(s);expect(changed.job.state).toBe('succeeded');expect(s.calls()-calls).toBe(1);expect(changed.state.courses[0].points.map((point:any)=>point.id)).toEqual(ids);expect(new Set(changed.state.courses[0].points.map((point:any)=>point.id)).size).toBe(40)
    const latest=await s.projects.handle('lectures',{courseId:s.id}) as any;expect(latest.lectures.at(-1).concepts[0].quote).toContain('新增尾章依据')
  })
  it('counts all parsed characters including whitespace before sending any model request',async()=>{
    const s=await setup();await writeFile(join(s.folder,'oversized.txt'),'正文依据。'+'\n'.repeat(100001))
    const result=await initialize(s);expect(result.job.state).toBe('failed');expect(result.job.message).toContain('100,000');expect(s.calls()).toBe(0)
  })
  it('keeps a running task when reopening the same folder and preserves concurrent point edits',async()=>{
    let pause=false,entered!:()=>void,release!:()=>void;const start=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r)
    const s=await setup(async sources=>{if(pause){entered();await gate}return lecture(sources)});await writeFile(join(s.folder,'lecture.md'),DOC)
    const first=await initialize(s);const pointId=first.state.courses[0].points[0].id;pause=true
    await writeFile(join(s.folder,'lecture.md'),DOC.replace('其余元素为零','其余元素为零，必须核对维度'))
    const job=await s.projects.handle('initialize',{courseId:s.id,requestId:randomUUID(),paths:['lecture.md']}) as any;await start
    await s.projects.handle('openCourse',{path:s.folder});expect((await s.projects.handle('state',{}) as any).jobs.find((j:any)=>j.id===job.jobId).state).toBe('running')
    await s.projects.handle('point',{courseId:s.id,pointId,name:'我的概念名称'});release()
    const result=await settle(s.projects,job.jobId);expect(result.job.state).toBe('succeeded');expect(result.state.courses[0].points.find((p:any)=>p.id===pointId).name).toBe('我的概念名称')
  })
  it('recovers an interrupted job on restart without replacing its published revision',async()=>{
    const s=await setup();await writeFile(join(s.folder,'lecture.md'),DOC);const first=await initialize(s)
    const filename=join(s.folder,'.syllora','course.json'),db=JSON.parse(await readFile(filename,'utf8')),jobId=randomUUID()
    db.jobs.push({...db.jobs[0],id:jobId,requestId:randomUUID(),state:'running'});await writeFile(filename,JSON.stringify(db))
    const restarted=new SylloraProjects(s.app,{config:async()=>config}),state=await restarted.handle('state',{}) as any
    expect(state.jobs.find((j:any)=>j.id===jobId).state).toBe('failed');expect(state.courses[0].revision).toBe(first.state.courses[0].revision)
  })
  it('reuses checkpoints, preserves the previous publication on failure and retries only changed chapters',async()=>{
    let invalid=false
    // 整批概念都给不出可核验的依据：修整无法抢救（不会编造出处），这一批才该失败。
    const s=await setup(sources=>{const result=lecture(sources);if(invalid&&result.chapter==='第二章')result.concepts.forEach(c=>{c.quote='不在资料中的错误依据'});return result})
    await writeFile(join(s.folder,'lecture.md'),DOC);const first=await initialize(s);expect(first.job.state).toBe('succeeded');const initialCalls=s.calls()
    const latest=await initialize(s);expect(latest.job.state).toBe('succeeded');expect(s.calls()).toBe(initialCalls)
    await writeFile(join(s.folder,'lecture.md'),DOC.replace('是否相等','是否相等，以及维度条件'));invalid=true
    const failed=await initialize(s);expect(failed.job.state).toBe('failed');expect(failed.state.courses[0].revision).toBe(latest.state.courses[0].revision)
    expect(failed.job.progress.failures.join(' ')).toContain('第二章')
    expect(failed.job.calls).toBeLessThanOrEqual(4)
    invalid=false;const count=s.calls();const recovered=await initialize(s);expect(recovered.job.state).toBe('succeeded');expect(s.calls()-count).toBe(1)
    expect(recovered.state.courses[0].materials[0].revisionNumber).toBe(2);expect(recovered.state.courses[0].materials[0].history.length).toBeGreaterThan(0)
    expect(recovered.state.courses[0].points.map((p:any)=>p.id)).toEqual(first.state.courses[0].points.map((p:any)=>p.id))
  })
  it('cancels initialization without publishing and does not write into another opened course',async()=>{
    let release!:()=>void, entered!:()=>void;const start=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r)
    const s=await setup(async sources=>{entered();await gate;return lecture(sources)});await writeFile(join(s.folder,'lecture.md'),DOC)
    const job=await s.projects.handle('initialize',{courseId:s.id,requestId:randomUUID(),paths:['lecture.md']}) as any;await start
    const other=join(s.root,'other');await mkdir(other);const second=await s.projects.handle('openCourse',{path:other}) as any
    await s.projects.handle('cancel',{courseId:s.id,jobId:job.jobId});release()
    const result=await settle(s.projects,job.jobId);expect(result.job.state).toBe('cancelled');expect(result.state.courses.every((c:any)=>!c.revision&&c.points.length===0)).toBe(true)
    await new Promise(r=>setTimeout(r,50));expect((await s.projects.handle('state',{}) as any).courses.find((c:any)=>c.id===second.id).materials).toEqual([])
  })
  it('rejects stale inspection fingerprints and changes during generation',async()=>{
    let modify=false
    const s=await setup(async sources=>{if(modify)await writeFile(join(s.folder,'lecture.md'),DOC+'\n变化的原文。');return lecture(sources)})
    await writeFile(join(s.folder,'lecture.md'),DOC);const scan=await s.projects.handle('scan',{courseId:s.id}) as any;await writeFile(join(s.folder,'lecture.md'),DOC+'\n补充资料。')
    const job=await s.projects.handle('initialize',{courseId:s.id,requestId:randomUUID(),paths:['lecture.md'],fingerprints:{'lecture.md':scan.files[0].fingerprint}}) as any
    expect((await settle(s.projects,job.jobId)).job.state).toBe('failed')
    modify=true;const result=await initialize(s);expect(result.job.state).toBe('failed');expect(result.state.courses[0].revision).toBeUndefined()
  })
  it('shows failed PDF pages and requires accepting the usable part',async()=>{
    const s=await setup(undefined,async()=>({total:3,pages:[{num:1,text:'第一物理页包含定义和依据。'},{num:2,text:''},{num:3,text:'第三物理页包含后续说明。'}]}));await writeFile(join(s.folder,'lecture.pdf'),'pdf-fixture')
    const failed=await initialize(s);expect(failed.job.state).toBe('failed');expect(failed.job.progress.failures.join(' ')).toContain('没有正文');expect(s.calls()).toBe(0)
    const accepted=await initialize(s,true);expect(accepted.job.state).toBe('succeeded');expect(accepted.state.courses[0].materials[0].sources.map((v:any)=>v.anchor).join(' ')).toContain('第 3 页');expect(accepted.state.courses[0].materials[0].sources.map((v:any)=>v.anchor).join(' ')).not.toContain('第 2 页')
    expect(accepted.state.courses[0].materials[0].pageIssues).toEqual([{num:2,reason:'blank-page'}])
  })
  it('previews only the original matching the published version and keeps it after removing a material',async()=>{
    const s=await setup(undefined,async()=>({total:1,pages:[{num:1,text:'PDF 正文包含可引用的准确依据。'}]})),bytes=Buffer.from('PDF-original-fixture')
    await writeFile(join(s.folder,'lecture.pdf'),bytes);const result=await initialize(s),material=result.state.courses[0].materials[0]
    expect((await s.projects.readMaterialFile(s.id,material.id)).data).toEqual(bytes)
    const other=join(s.root,'other-preview');await mkdir(other);const otherId=(await s.projects.handle('openCourse',{path:other}) as any).id
    await expect(s.projects.readMaterialFile(otherId,material.id)).rejects.toThrow('不属于当前课程')
    await writeFile(join(s.folder,'lecture.pdf'),'modified');await expect(s.projects.readMaterialFile(s.id,material.id)).rejects.toThrow('原文件已变化')
    await s.projects.handle('deleteMaterial',{courseId:s.id,materialId:material.id,confirmed:true})
    await expect(s.projects.readMaterialFile(s.id,material.id)).rejects.toThrow('资料不存在');expect(await readFile(join(s.folder,'lecture.pdf'),'utf8')).toBe('modified')
  })
  it('scans without hidden/generated files, rejects traversal and saves uploads without overwriting originals',async()=>{
    const s=await setup();await writeFile(join(s.folder,'lecture.md'),DOC);await mkdir(join(s.folder,'node_modules'));await writeFile(join(s.folder,'node_modules','noise.md'),'noise');await writeFile(join(s.folder,'.hidden.md'),'noise');await writeFile(join(s.folder,'image.png'),'image')
    const scan=await s.projects.handle('scan',{courseId:s.id}) as any;expect(scan.files.map((f:any)=>f.path)).toEqual(['image.png','lecture.md']);expect(scan.files[0].status).toBe('unsupported')
    await expect(within(s.folder,'../private.md')).rejects.toThrow('课程目录')
    expect((await s.projects.handle('import',{courseId:s.id,name:'lecture.md',text:DOC}) as any).duplicate).toBe(true)
    const first=await s.projects.handle('import',{courseId:s.id,name:'lecture.md',text:'新的资料正文。'}) as any;const second=await s.projects.handle('import',{courseId:s.id,name:'lecture.md',text:'另一份资料正文。'}) as any
    expect(first.path).toBe('sources/lecture.md');expect(second.path).toBe('sources/lecture-1.md');expect(await readFile(join(s.folder,'lecture.md'),'utf8')).toBe(DOC)
    expect((await s.projects.handle('state',{}) as any).courses[0].materials).toEqual([])
  })
  it('deletes only application products and retains original sources and inherited history',async()=>{
    const s=await setup();await writeFile(join(s.folder,'lecture.md'),DOC);await initialize(s);await mkdir(join(s.folder,'.syllora','history'));await writeFile(join(s.folder,'.syllora','history','legacy.txt'),'history')
    await s.projects.handle('delete',{courseId:s.id,confirmed:true})
    expect(await readFile(join(s.folder,'lecture.md'),'utf8')).toBe(DOC);expect(await readFile(join(s.folder,'.syllora','history','legacy.txt'),'utf8')).toBe('history');expect(await stat(join(s.folder,'.syllora','course.json')).catch(()=>null)).toBeNull()
  })
  it('a repeated delete of the same material does not run the destructive cleanup twice',async()=>{
    // 多标签页/陈旧快照会用同一 materialId 重发删除。首次请求已把资料置为
    // deleted 并清掉 revision；重复请求不得再执行一次破坏性清理
    // （`delete course.revision` + syllora-projects 的 removeProducts('revisions')）。
    const s=await setup();await writeFile(join(s.folder,'lecture.md'),DOC)
    const first=await initialize(s);expect(first.job.state).toBe('succeeded')
    const materialId=first.state.courses[0].materials[0].id
    const spy=vi.spyOn(files,'removeProducts')
    try {
      const one=await s.projects.handle('deleteMaterial',{courseId:s.id,materialId,confirmed:true}) as any
      expect(one).toEqual({saved:true})
      expect(spy).toHaveBeenCalledTimes(1)
      const two=await s.projects.handle('deleteMaterial',{courseId:s.id,materialId,confirmed:true}) as any
      expect(two).toEqual({saved:true})
      // 守卫在这里生效：不再执行第二次 removeProducts
      expect(spy).toHaveBeenCalledTimes(1)
      const after=await s.projects.handle('state',{}) as any
      expect(after.courses[0].materials.find((m:any)=>m.id===materialId).status).toBe('deleted')
    } finally { spy.mockRestore() }
  })
  it('does not follow a .syllora directory junction outside the chosen folder',async()=>{
    const s=await setup(),target=join(s.root,'outside'),folder=join(s.root,'linked');await mkdir(target);await mkdir(folder);await symlink(target,join(folder,'.syllora'),'junction')
    await expect(s.projects.handle('openCourse',{path:folder})).rejects.toThrow('目录链接');expect(await stat(join(target,'course.json')).catch(()=>null)).toBeNull()
  })
  it('legacy consent toggles do not cancel calls under the always-enabled local policy',async()=>{
    let entered!:()=>void,release!:()=>void;const start=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r)
    const s=await setup(async sources=>{entered();await gate;return lecture(sources)});await writeFile(join(s.folder,'lecture.md'),DOC)
    const job=await s.projects.handle('initialize',{courseId:s.id,requestId:randomUUID(),paths:['lecture.md']}) as any;await start;await s.projects.handle('preferences',{consent:false});release()
    const result=await settle(s.projects,job.jobId);expect(result.job.state).toBe('succeeded');expect(result.state.settings.consent).toBe(true);expect(result.state.courses[0].revision).toBeDefined()
  })
})
describe('structured sources and migration',()=>{
  it('preserves fences, tables, source offsets, sentence cuts and neighboring evidence',()=>{
    const raw='# 概念\n\n定义完整。例子紧随其后。\n\n```ts\n\n# 不是章节\nconst value = 1;\n```\n\n| 列一 | 列二 |\n| --- | --- |\n'+Array.from({length:300},(_,i)=>`| ${i} | 表格中的依据文本 |\n`).join('')
    const sources=structuredSources('m','v',[{text:raw,anchor:'lecture.md'}]);expect(sources.every(s=>[...s.text].length<=2400)).toBe(true)
    for(const source of sources)expect(raw.slice(source.start,source.end)).toBe(source.text)
    expect(sources.find(s=>s.kind==='code')!.text).toContain('# 不是章节');expect(sources.some(s=>s.section.includes('不是章节'))).toBe(false)
    expect(sources.find(s=>s.kind==='table'&&s.context?.includes('续段'))!.context).toContain('| 列一 | 列二 |')
    expect(sources[1]!.previousId).toBe(sources[0]!.id)
    const other=structuredSources('m','v',[{text:'无关的课程内容。',anchor:'a'},{text:'单位矩阵的主对角线元素为一。',anchor:'b'}]);expect(selectContext(other,'单位矩阵到底是什么意思',600)[0]!.text).toContain('单位矩阵')
    const numbered=structuredSources('m','v',[{text:'## 定义\n定义的正文。\n1. 第一个例子\n2. 第二个例子\n\n1.2 下一节\n后续正文。',anchor:'a'}]);expect(numbered.some(s=>s.kind==='list'&&s.text.includes('第二个例子'))).toBe(true);expect(numbered.at(-1)!.section).toContain('下一节')
    const repeated=structuredSources('m','v',[{text:'# 定义\n完全相同的正文。',anchor:'第 1 页'},{text:'# 定义\n完全相同的正文。',anchor:'第 2 页'}]);expect(new Set(repeated.map(s=>s.id)).size).toBe(repeated.length)
    const large=structuredSources('large','v',[{text:Array.from({length:8},()=>('定义。'.repeat(700))).join('\n\n'),anchor:'large.txt'}]),small=structuredSources('small','v',[{text:'另一份短资料的依据。',anchor:'small.txt'}])
    const context=selectContext([...large,...small],'定义',6000);expect(context.some(s=>s.materialId==='small')).toBe(true);expect(JSON.stringify(context).length).toBeLessThanOrEqual(6000)
  })
  it('rejects unsupported quotes and uncovered source fragments',()=>{
    const sources=structuredSources('m','v',[{text:'资料提供准确的概念定义。',anchor:'a'},{text:'另一片段说明适用条件。',anchor:'b'}]),value=lecture(sources)
    value.concepts[0]!.quote='编造的依据';expect(()=>validateLecture(value,sources)).toThrow('不是资料原文')
    const incomplete=lecture([sources[0]]);expect(()=>validateLecture(incomplete,sources)).toThrow('没有完整关联')
  })
  it('keeps one document as one chapter even though every PDF page has its own anchor',()=>{
    // 页锚点必须只做定位：一旦它同时充当章节回退键，每一页都会变成独立批次，
    // 初始化就退化成"每页一次模型调用"。
    const pages=[{text:'第一页的正文依据。',anchor:'第 1 页',name:'讲义.pdf'},{text:'第二页的正文依据。',anchor:'第 2 页',name:'讲义.pdf'}]
    const sources=structuredSources('m','v',pages)
    expect(sources.map(s=>s.anchor)).toEqual(['第 1 页 · 行 1–1 · 字符 1–9','第 2 页 · 行 1–1 · 字符 1–9'])
    // 同一文档的多页无标题正文必须落进同一批次键，否则页数直接等于模型调用数。
    expect(new Set(sources.map(s=>s.section))).toEqual(new Set(['讲义.pdf']))
    const fourPages=['第一页依据。','第二页依据。','第三页依据。','第四页依据。'].map((text,i)=>({text,anchor:`第 ${i+1} 页`,name:'讲义.pdf'}))
    expect(new Set(structuredSources('m','v',fourPages).map(s=>s.section)).size).toBe(1)
  })
  it('reuses stored fingerprints for files whose size and modification time are unchanged',async()=>{
    const s=await setup();await writeFile(join(s.folder,'lecture.md'),DOC)
    const first=await files.scanFiles(s.folder,[])
    expect(first[0]!.status).toBe('ready');expect(first[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    const material={id:'m',name:'lecture.md',fingerprint:first[0]!.fingerprint!,status:'ready' as const,accepted:true,pages:0,sources:[],path:'lecture.md',size:first[0]!.size,mtimeMs:first[0]!.mtimeMs}
    // 未变化的资料必须复用已存指纹（不再整读文件），并且与首次扫描结果一致。
    const again=await files.scanFiles(s.folder,[material])
    expect(again[0]!.fingerprint).toBe(material.fingerprint);expect(again[0]!.change).toBe('unchanged')
    // 大小与记录不符时必须重算，不能盲信已存指纹。
    const wrongSize=await files.scanFiles(s.folder,[{...material,size:1}])
    expect(wrongSize[0]!.fingerprint).toBe(material.fingerprint);expect(wrongSize[0]!.change).toBe('unchanged')
    // 内容真的变了：指纹与 change 都要跟着变。
    await writeFile(join(s.folder,'lecture.md'),DOC+'\n补充依据。')
    const modified=await files.scanFiles(s.folder,[material])
    expect(modified[0]!.fingerprint).not.toBe(material.fingerprint);expect(modified[0]!.change).toBe('changed')
    // 缺文件属性的老课程记录不得被当成"未变化"而跳过：必须重算并按真实内容判定。
    const legacy=await files.scanFiles(s.folder,[{...material,fingerprint:'stale-legacy-hash',size:undefined,mtimeMs:undefined}])
    expect(legacy[0]!.fingerprint).toBe(modified[0]!.fingerprint);expect(legacy[0]!.change).toBe('changed')
  })
  it('refreshes stored size and mtime on a parse-cache hit so fingerprint reuse keeps working',async()=>{
    const s=await setup();await writeFile(join(s.folder,'lecture.md'),DOC)
    const first=await initialize(s);expect(first.job.state).toBe('succeeded')
    // 内容不变、只改 mtime：解析缓存仍命中，但落库的 stat 必须是本次的，否则该文件以后每次扫描都整读重算。
    const later=new Date(Date.now()+60_000)
    await utimes(join(s.folder,'lecture.md'),later,later)
    const touched=await stat(join(s.folder,'lecture.md'))
    const second=await initialize(s);expect(second.job.state).toBe('succeeded')
    const stored=second.state.courses[0].materials[0]
    expect(stored.mtimeMs).toBe(touched.mtimeMs);expect(stored.size).toBe(touched.size)
    const scan=await files.scanFiles(s.folder,[{...stored,id:'reuse',name:stored.name}])
    expect(scan[0]!.change).toBe('unchanged')
  })
  it('verifies bytes before treating an upload as a duplicate',async()=>{
    const s=await setup()
    const first=await s.projects.handle('import',{courseId:s.id,name:'new.md',text:'原始正文依据。'}) as any
    expect(first.duplicate).toBe(false)
    // 经过 initialize 才会生成 material 记录（只 import 是落文件、不建记录）。
    const seeded=await initialize(s);expect(seeded.job.state).toBe('succeeded')
    const material=seeded.state.courses[0].materials.find((m:any)=>m.path===first.path)
    const second=await s.projects.handle('import',{courseId:s.id,name:'latest.md',base64:Buffer.from('完全不同的新正文依据。').toString('base64')}) as any
    expect(second.duplicate).toBe(false)
    // 模拟过期指纹：记录声称"即将上传的这份内容"已存在（盘上其实没有），且 mtime 与真实文件一致，
    // 于是扫描会直接复用这个过期指纹、判定为重复。判重必须读回字节核对，否则上传被静默丢掉。
    const bytes=Buffer.from('盘上并不存在的新上传内容，用来检验判重是否真的读过字节。')
    const stored=JSON.parse(await readFile(join(s.folder,'.syllora','course.json'),'utf8'))
    const target=stored.courses[0].materials.find((m:any)=>m.id===material.id)
    target.fingerprint=sha(bytes)
    await writeFile(join(s.folder,'.syllora','course.json'),JSON.stringify(stored))
    const again=await s.projects.handle('import',{courseId:s.id,name:'latest.md',base64:bytes.toString('base64')}) as any
    expect(again.duplicate).toBe(false)
    expect(await readFile(join(s.folder,again.path),'utf8')).toBe('盘上并不存在的新上传内容，用来检验判重是否真的读过字节。')
  })
  it('does not invent a chapter for a line that is a wrapped formula or a plain enumeration',()=>{
    const raw='1.1 问题背景\n问题背景的正文依据。\n\n2 = ℎ𝑖 ⋅ (𝑧𝑖 − 𝑧𝑛𝑎)2。整体等效抗弯刚度𝐷为：\n\n12 + ℎ𝑖(𝑧𝑖 − 𝑧𝑛𝑎)2]\n\n3.2 符号说明\n符号说明的正文依据。\n\n假设1：边界条件成立。\n4. 假设各层材料均为理想线弹性材料。\n'
    const sources=structuredSources('m','v',[{text:raw,anchor:'第 6 页',name:'讲义.pdf'}])
    // 真正的章节标题仍然是标题。
    expect(sources.some(s=>s.kind==='heading'&&s.text.includes('问题背景'))).toBe(true)
    expect(sources.some(s=>s.kind==='heading'&&s.text.includes('符号说明'))).toBe(true)
    // 折行公式不得成为标题：每个公式标题都会变成一次额外的模型调用，并把文档重新切碎。
    expect(sources.some(s=>s.kind==='heading'&&s.text.includes('整体等效抗弯刚度'))).toBe(false)
    expect(sources.some(s=>s.kind==='heading'&&/^\s*12\s*\+/.test(s.text))).toBe(false)
    expect(sources.find(s=>s.text.includes('整体等效抗弯刚度'))!.section).toBe('1.1 问题背景')
    // 没有中文标题的编号行只算正文/列表，不当章节。
    expect(sources.some(s=>s.kind==='heading'&&s.text.includes('边界条件成立'))).toBe(false)
    expect(sources.some(s=>s.kind==='heading'&&s.text.includes('理想线弹性材料'))).toBe(false)
    // 整份文档的章节数应等于真实标题数（2），不是公式数。
    expect(new Set(sources.map(s=>s.section))).toEqual(new Set(['1.1 问题背景','3.2 符号说明']))
  })
  it('keeps a failed concurrent run consistent: failure recorded, nothing published, progress matches what finished',async()=>{
    const FOUR='# 第一章\n\n甲的完整正文依据。\n\n# 第二章\n\n乙的完整正文依据。\n\n# 第三章\n\n丙的完整正文依据。\n\n# 第四章\n\n丁的完整正文依据。\n'
    const s=await setup()
    await writeFile(join(s.folder,'lecture.md'),FOUR)
    // 冷缓存 + 并发 3 + 单章必败：现有回归只覆盖"全部成功"，一旦并发退化成串行也测不出来。
    const client:StructuredCallClient={async *stream(options){
      const message=(options.messages.at(-1) as any).content[0].text
      const sources=JSON.parse(message.slice(message.indexOf('所选资料：\n')+'所选资料：\n'.length))
      await new Promise(r=>setTimeout(r,40))
      if(String(sources[0].section)==='第二章')throw new Error('合成章节失败')
      yield {type:'text-delta',text:JSON.stringify(lecture(sources))}
    }}
    const app=join(s.root,'failure-app')
    const projects=new SylloraProjects(app,{config:async()=>({...config,maxConcurrency:3}),client:()=>client})
    await projects.handle('preferences',{consent:true})
    const id=(await projects.handle('openCourse',{path:s.folder}) as any).id
    const scan=await projects.handle('scan',{courseId:id}) as any
    const ready=scan.files.filter((f:any)=>f.status==='ready')
    const job=await projects.handle('initialize',{courseId:id,requestId:randomUUID(),paths:ready.map((f:any)=>f.path),fingerprints:Object.fromEntries(ready.map((f:any)=>[f.path,f.fingerprint]))}) as any
    const settled=await settle(projects,job.jobId)
    expect(settled.job.state).toBe('failed')
    expect(settled.job.progress.failures.join(' ')).toContain('第二章')
    // 失败作业不得发布 revision，也不得留下知识点。
    expect(settled.state.courses[0].revision).toBeUndefined();expect(settled.state.courses[0].points).toEqual([])
    // 进度只统计真正落盘的章节：并发 3 时另外两章会完成并写入缓存，第二章不计入。
    const rescanned=await files.scanFiles(s.folder,settled.state.courses[0].materials)
    expect(rescanned.every(f=>f.status==='ready')).toBe(true)
    expect(settled.job.progress.done).toBeLessThan(4)
    expect(settled.job.progress.total).toBe(4)
  })
  it('organizes chapters concurrently up to the configured limit and still publishes every chapter',async()=>{
    const FOUR='# 第一章\n\n甲的完整正文依据。\n\n# 第二章\n\n乙的完整正文依据。\n\n# 第三章\n\n丙的完整正文依据。\n\n# 第四章\n\n丁的完整正文依据。\n'
    const s=await setup(undefined,undefined,3)
    await writeFile(join(s.folder,'lecture.md'),FOUR)
    let inFlight=0,peak=0,calls=0
    // 每个调用都停住 60ms 再返回：串行时 peak 恒为 1，并发时才会大于 1。
    const client:StructuredCallClient={async *stream(options){
      const message=(options.messages.at(-1) as any).content[0].text
      const sources=JSON.parse(message.slice(message.indexOf('所选资料：\n')+'所选资料：\n'.length))
      calls++;inFlight++;peak=Math.max(peak,inFlight)
      await new Promise(r=>setTimeout(r,60))
      inFlight--
      yield {type:'text-delta',text:JSON.stringify(lecture(sources))}
    }}
    const app=join(s.root,'concurrent-app')
    const projects=new SylloraProjects(app,{config:async()=>({...config,maxConcurrency:3}),client:()=>client})
    await projects.handle('preferences',{consent:true})
    const id=(await projects.handle('openCourse',{path:s.folder}) as any).id
    const scan=await projects.handle('scan',{courseId:id}) as any
    const files=scan.files.filter((f:any)=>f.status==='ready')
    const job=await projects.handle('initialize',{courseId:id,requestId:randomUUID(),paths:files.map((f:any)=>f.path),fingerprints:Object.fromEntries(files.map((f:any)=>[f.path,f.fingerprint]))}) as any
    const settled=await settle(projects,job.jobId)
    expect(settled.job.state).toBe('succeeded')
    const state=await projects.handle('state',{}) as any
    const chapters=state.courses[0].points.map((p:any)=>p.chapter)
    expect(new Set(chapters)).toEqual(new Set(['第一章','第二章','第三章','第四章']))
    expect(calls).toBe(4)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(3)
  })
  it('migrates old courses with their identifiers and evidence, refuses existing destinations and keeps the original snapshot',async()=>{
    const s=await setup(),id=randomUUID(),pointId=randomUUID(),materialId=randomUUID(),sourceId=randomUUID(),questionId=randomUUID()
    const old:Course={id,name:'旧课程',timezone:'Asia/Shanghai',archived:false,materials:[{id:materialId,name:'旧讲义.pdf',fingerprint:'fingerprint',status:'ready',accepted:true,pages:1,sources:[{id:sourceId,materialId,anchor:'第 1 页',text:'单位矩阵的主对角线元素为一。'}]}],points:[{id:pointId,name:'单位矩阵',chapter:'矩阵',sourceIds:[sourceId]}],scope:[pointId],plan:null,draft:null,questions:[{id:questionId,pointId,taskId:randomUUID(),slot:0,family:'f',stem:'题干',options:['一','二','三','四'],answer:0,explanation:'解释',sourceIds:[sourceId],quote:'主对角线元素为一',status:'valid',assisted:false}],attempts:[{id:randomUUID(),questionId,option:0,correct:true,assisted:false,at:1,sequence:0}],messages:[],actions:[],drafts:{prompt:'草稿',answers:[]},changes:[],notice:null,createdAt:0}
    const oldJob={id:randomUUID(),requestId:randomUUID(),courseId:id,kind:'outline',state:'succeeded',message:'完成',createdAt:0,model:'fixture',calls:3,inputTokens:null,outputTokens:null}
    const bytes=JSON.stringify({version:1,courses:[old],jobs:[oldJob],calls:3,consent:true});await writeFile(join(s.app,'syllora.json'),bytes)
    const destination=join(s.root,'migration');await mkdir(destination);await s.projects.handle('migrateCourse',{courseId:id,path:destination})
    const stored=JSON.parse(await readFile(join(destination,'.syllora','course.json'),'utf8')).courses[0];expect(stored.attempts).toEqual(old.attempts);expect(stored.points).toEqual(old.points);expect(stored.materials[0].missingOriginal).toBe(true);expect(evidence(stored,pointId).state).toBe(evidence(old,pointId).state)
    expect(await readFile(join(s.app,'syllora.json'),'utf8')).toBe(bytes)
    expect(JSON.parse(await readFile(join(destination,'.syllora','course.json'),'utf8')).jobs).toEqual([oldJob])
    await expect(s.projects.handle('migrateCourse',{courseId:id,path:s.folder})).rejects.toThrow('不会覆盖')
  })
  it('copies encrypted model settings into the application root and preserves an existing shared configuration',async()=>{
    const s=await setup();await writeFile(join(s.folder,'.syllora','config.yaml'),'llm:\n  model: fixture-model\n');await writeFile(join(s.folder,'.syllora','credentials.json'),'encrypted-placeholder')
    await migrateSharedSettings(s.app,[s.folder]);expect(await readFile(join(s.app,'.syllora','config.yaml'),'utf8')).toContain('fixture-model');expect(await readFile(join(s.app,'.syllora','credentials.json'),'utf8')).toBe('encrypted-placeholder')
    await writeFile(join(s.folder,'.syllora','config.yaml'),'different-model');await migrateSharedSettings(s.app,[s.folder]);expect(await readFile(join(s.app,'.syllora','config.yaml'),'utf8')).toContain('fixture-model')
  })
  it('migrates a legacy retained PDF without changing identifiers or deleting the old original',async()=>{
    const s=await setup(),legacy=new SylloraService(s.app,{pdf:async()=>({total:1,pages:[{num:1,text:'旧 PDF 解析正文保留来源依据。'}]})}),legacyId=randomUUID(),bytes=Buffer.from('legacy-pdf-original')
    await legacy.handle('create',{name:'旧 PDF',requestId:legacyId});const imported=await legacy.handle('import',{courseId:legacyId,name:'旧讲义.pdf',base64:bytes.toString('base64')}) as any
    const old=await legacy.handle('state',{}) as any,destination=join(s.root,'legacy-pdf-course');await mkdir(destination)
    await s.projects.handle('migrateCourse',{courseId:legacyId,path:destination})
    const current=(await s.projects.handle('state',{}) as any).courses.find((c:any)=>c.id===legacyId),material=current.materials[0]
    expect(material.id).toBe(imported.id);expect(material.sources).toEqual(old.courses[0].materials[0].sources);expect(material.missingOriginal).toBe(false)
    expect((await s.projects.readMaterialFile(legacyId,material.id)).data).toEqual(bytes);expect(await readFile(join(s.app,'files',`${material.id}.pdf`))).toEqual(bytes)
  })
})


describe('application-managed course directories',()=>{
  it('creates isolated course folders, deduplicates a request and restores uploads after restart',async()=>{
    const s=await setup(),managed=join(s.root,'executable','.syllora'),projects=new SylloraProjects(s.app,{managedCoursesRoot:managed})
    const requestId=randomUUID(),input={requestId,name:'同名课程',icon:'math',timezone:'Asia/Shanghai'}
    const first=await projects.handle('createCourse',input) as any
    const replay=await projects.handle('createCourse',input) as any
    expect(first).toMatchObject({id:requestId,path:join(managed,requestId),created:true});expect(replay).toMatchObject({id:requestId,created:false})
    await expect(projects.handle('createCourse',{...input,name:'另一课程'})).rejects.toMatchObject({code:'REQUEST_CONFLICT'})
    const second=await projects.handle('createCourse',{...input,requestId:randomUUID()}) as any
    await projects.handle('import',{courseId:first.id,name:'notes.md',text:'# 甲章\n\n第一门课的材料。'})
    await projects.handle('import',{courseId:second.id,name:'notes.md',text:'# 乙章\n\n第二门课的材料。'})
    expect(await readFile(join(first.path,'sources','notes.md'),'utf8')).toContain('第一门课')
    expect(await readFile(join(second.path,'sources','notes.md'),'utf8')).toContain('第二门课')
    await projects.handle('rename',{courseId:first.id,name:'改名后的课程'})
    const restarted=new SylloraProjects(s.app,{managedCoursesRoot:managed}),state=await restarted.handle('state',{}) as any
    expect(state.courses.find((c:any)=>c.id===first.id)).toMatchObject({name:'改名后的课程',icon:'math',folder:first.path})
    expect(state.courses.filter((c:any)=>c.id===requestId)).toHaveLength(1)
    expect((await restarted.handle('scan',{courseId:first.id}) as any).files[0].path).toBe('sources/notes.md')
  })
  it('copies old course originals, lectures and history before updating the registry, leaving old files intact',async()=>{
    const s=await setup();await writeFile(join(s.folder,'lecture.md'),DOC);const published=await initialize(s)
    const managed=join(s.root,'executable','.syllora'),projects=new SylloraProjects(s.app,{managedCoursesRoot:managed}),state=await projects.handle('state',{}) as any
    const course=state.courses.find((c:any)=>c.id===s.id)
    expect(course).toMatchObject({id:s.id,folder:join(managed,s.id),revision:published.state.courses[0].revision})
    expect(await readFile(join(managed,s.id,'lecture.md'),'utf8')).toBe(DOC)
    expect(await readFile(join(s.folder,'lecture.md'),'utf8')).toBe(DOC)
    expect((await projects.handle('lectures',{courseId:s.id}) as any).lectures).toHaveLength(2)
    expect(state.projects[0].error).toBeNull()
    const registry=JSON.parse(await readFile(join(s.app,'.syllora','projects.json'),'utf8'));expect(registry[0].path).toBe(join(managed,s.id))
    expect((await new SylloraProjects(s.app,{managedCoursesRoot:managed}).handle('state',{}) as any).courses[0].revision).toBe(course.revision)
  })
  it('recovers the registry if a crash occurs after copying and publishing the managed folder',async()=>{
    const s=await setup();await writeFile(join(s.folder,'lecture.md'),DOC)
    const registryPath=join(s.app,'.syllora','projects.json'),oldRegistry=await readFile(registryPath,'utf8'),managed=join(s.root,'application','.syllora')
    await new SylloraProjects(s.app,{managedCoursesRoot:managed}).handle('state',{})
    // A crash before registry commit cannot have started the relocated service yet.
    await writeFile(join(managed,s.id,'.syllora','course.json'),await readFile(join(s.folder,'.syllora','course.json')))
    await writeFile(registryPath,oldRegistry)
    const recovered=await new SylloraProjects(s.app,{managedCoursesRoot:managed}).handle('state',{}) as any
    expect(recovered.courses[0].folder).toBe(join(managed,s.id));expect(recovered.projects[0].error).toBeNull()
    expect(await readFile(join(managed,s.id,'lecture.md'),'utf8')).toBe(DOC)
  })
  it('keeps a legacy course usable when registry registration fails and retries safely on restart',async()=>{
    const s=await setup();await writeFile(join(s.folder,'lecture.md'),DOC);const managed=join(s.root,'executable','.syllora')
    const failing=new SylloraProjects(s.app,{managedCoursesRoot:managed,registerProject:async()=>{throw new Error('registration fixture failed')}})
    const state=await failing.handle('state',{}) as any
    expect(state.courses[0].folder).toBe(s.folder);expect(state.projects[0].error).toContain('迁移未完成')
    expect(await stat(join(managed,s.id)).catch(()=>null)).toBeNull()
    const recovered=await new SylloraProjects(s.app,{managedCoursesRoot:managed}).handle('state',{}) as any
    expect(recovered.courses[0].folder).toBe(join(managed,s.id));expect(recovered.projects[0].error).toBeNull()
    expect(await readFile(join(s.folder,'lecture.md'),'utf8')).toBe(DOC)
  })
  it('does not overwrite an existing destination or follow a linked storage root',async()=>{
    const s=await setup(),managed=join(s.root,'executable','.syllora');await mkdir(join(managed,s.id),{recursive:true});await writeFile(join(managed,s.id,'keep.txt'),'untouched')
    const state=await new SylloraProjects(s.app,{managedCoursesRoot:managed}).handle('state',{}) as any
    expect(state.courses[0].folder).toBe(s.folder);expect(state.projects[0].error).toContain('不会覆盖')
    expect(await readFile(join(managed,s.id,'keep.txt'),'utf8')).toBe('untouched')
    const linked=join(s.root,'linked');await symlink(managed,linked,process.platform==='win32'?'junction':'dir')
    await expect(new SylloraProjects(s.app,{managedCoursesRoot:linked}).handle('createCourse',{requestId:randomUUID(),name:'拒绝链接'})).rejects.toMatchObject({code:'INVALID_FOLDER'})
  })
  it('allows explicitly reported usable PDF pages by default while keeping missing-page diagnostics',async()=>{
    const s=await setup(undefined,async()=>({total:2,pages:[{num:1,text:'这一页有完整的定义与依据。'},{num:2,text:''}]}));await writeFile(join(s.folder,'lecture.pdf'),'fixture')
    const started=await s.projects.handle('initialize',{courseId:s.id,requestId:randomUUID(),paths:['lecture.pdf']}) as any
    const result=await settle(s.projects,started.jobId)
    expect(result.job.state).toBe('succeeded');expect(result.state.courses[0].materials[0].accepted).toBe(true)
    expect(result.state.courses[0].materials[0].pageIssues).toEqual([{num:2,reason:'blank-page'}])
  })
})

describe('PRD 需求一：课程顺序持久化',()=>{
  async function threeCourses(){await mkdir(temp,{recursive:true});const root=await mkdtemp(join(temp,'order-'));roots.push(root)
    const app=join(root,'app'),projects=new SylloraProjects(app,{config:async()=>config})
    const a=join(root,'甲课'),b=join(root,'乙课'),c=join(root,'丙课');await mkdir(a);await mkdir(b);await mkdir(c)
    const first=await projects.handle('openCourse',{path:a}) as {id:string}
    const second=await projects.handle('openCourse',{path:b}) as {id:string}
    const third=await projects.handle('openCourse',{path:c}) as {id:string}
    return {root,projects,first:first.id,second:second.id,third:third.id}
  }
  const orderOf=async(projects:SylloraProjects)=>((await projects.handle('state',{}) as any).projects as Array<{id:string}>).map(p=>p.id)

  it('persists an explicit course order and survives a restart',async()=>{
    const s=await threeCourses()
    // remember() 置顶：最后打开的排最前。
    expect(await orderOf(s.projects)).toEqual([s.third,s.second,s.first])
    const saved=await s.projects.handle('reorderCourses',{courseIds:[s.first,s.second,s.third]}) as {saved:boolean;order:string[]}
    expect(saved.saved).toBe(true)
    expect(saved.order).toEqual([s.first,s.second,s.third])
    expect(await orderOf(s.projects)).toEqual([s.first,s.second,s.third])
    // 重启后顺序保持（写在 projects.json，不是内存态）。
    const restarted=new SylloraProjects(join(s.root,'app'),{config:async()=>config})
    expect(await orderOf(restarted)).toEqual([s.first,s.second,s.third])
  })

  it('rejects an order that is not a permutation of the open courses',async()=>{
    const s=await threeCourses()
    await expect(s.projects.handle('reorderCourses',{courseIds:[s.first,s.second]})).rejects.toThrow()
    await expect(s.projects.handle('reorderCourses',{courseIds:[s.first,s.first,s.third]})).rejects.toThrow()
    await expect(s.projects.handle('reorderCourses',{courseIds:[s.first,s.second,randomUUID()]})).rejects.toThrow()
    // 顺序未被半途改写。
    expect(await orderOf(s.projects)).toEqual([s.third,s.second,s.first])
  })

  it('keeps a newly opened course on top regardless of the saved order',async()=>{
    const s=await threeCourses()
    await s.projects.handle('reorderCourses',{courseIds:[s.first,s.second,s.third]})
    const d=join(s.root,'丁课');await mkdir(d)
    const fourth=await s.projects.handle('openCourse',{path:d}) as {id:string}
    // 待确认事项 1（建议值）：新打开课程仍置顶，手动排序只调整既有课程相对顺序。
    expect((await orderOf(s.projects))[0]).toBe(fourth.id)
    const tail=(await orderOf(s.projects)).slice(1)
    expect(tail).toEqual([s.first,s.second,s.third])
  })
})
