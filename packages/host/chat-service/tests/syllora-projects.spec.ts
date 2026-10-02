import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { StructuredCallClient } from '@syllora/course-builder'
import { SylloraProjects, migrateSharedSettings } from '../src/syllora-projects.ts'
import { SylloraService } from '../src/syllora.ts'
import { selectContext, structuredSources, within } from '../src/syllora-files.ts'
import * as files from '../src/syllora-files.ts'
import { evidence, type Course } from '../src/syllora-domain.ts'
import { validateLecture } from '../src/syllora-initialize.ts'
import type { ResolvedChatConfig } from '../src/config.ts'

const temp=resolve('..','tmp','course-folder-tests'),roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0)){if(!root.startsWith(temp))throw new Error('unsafe test cleanup');await rm(root,{recursive:true,force:true})}})
const config:ResolvedChatConfig={providerId:'fixture',model:'fixture',baseUrl:'http://localhost:9999/v1',apiKey:'fixture-only',apiKeyEnv:null,temperature:0,maxConcurrency:1,defaultMode:'quick'}
function lecture(sources:any[]) {
  return {chapter:sources[0].section.split(' / ').at(-1).slice(0,60),intro:{text:'按资料整理的章节导读。',sourceIds:sources.map(s=>s.id)},concepts:sources.filter(s=>s.text.length>=4&&s.kind!=='heading').map((s,i)=>({name:`${s.section.split(' / ').at(-1).slice(0,45)} 概念 ${i+1}`,text:'概念解释来自所附资料。',sourceIds:[s.id],quote:s.text.slice(0,Math.min(40,s.text.length))})),examples:[],connections:[],analogies:[]}
}
async function setup(change?:(sources:any[],call:number)=>Promise<unknown>|unknown,pdf?:NonNullable<ConstructorParameters<typeof SylloraProjects>[1]>['pdf']) {
  await mkdir(temp,{recursive:true});const root=await mkdtemp(join(temp,'case-'));roots.push(root)
  const folder=join(root,'course');await mkdir(folder)
  let calls=0
  const client:StructuredCallClient={async *stream(options){const raw=JSON.stringify(options.messages);const message=(options.messages.at(-1) as any).content[0].text;const sources=JSON.parse(message.slice(message.indexOf('所选资料：\n')+'所选资料：\n'.length));calls++;yield {type:'text-delta',text:JSON.stringify(change?await change(sources,calls):lecture(sources))};expect(raw).not.toContain('fixture-only')}}
  const app=join(root,'app'), projects=new SylloraProjects(app,{config:async()=>config,client:()=>client,...(pdf?{pdf}:{})})
  await projects.handle('preferences',{consent:true})
  const course=await projects.handle('openCourse',{path:folder}) as {id:string}
  return {root,folder,app,projects,id:course.id,calls:()=>calls,client}
}
async function settle(projects:SylloraProjects,jobId:string){for(let i=0;i<400;i++){const state=await projects.handle('state',{}) as any;const job=state.jobs.find((j:any)=>j.id===jobId);if(job&&job.state!=='running')return {state,job};await new Promise(r=>setTimeout(r,10))}throw new Error('initialization did not settle')}
async function initialize(s:Awaited<ReturnType<typeof setup>>,acceptPartial=false){const scan=await s.projects.handle('scan',{courseId:s.id}) as any;const files=scan.files.filter((f:any)=>f.status==='ready');const job=await s.projects.handle('initialize',{courseId:s.id,requestId:randomUUID(),paths:files.map((f:any)=>f.path),fingerprints:Object.fromEntries(files.map((f:any)=>[f.path,f.fingerprint])),acceptPartial}) as any;return settle(s.projects,job.jobId)}
const DOC='# 第一章\n\n单位矩阵的主对角线元素为一，其余元素为零。\n\n# 第二章\n\n矩阵乘法需要检查左矩阵列数与右矩阵行数是否相等。\n'
describe('course folder initialization',()=>{
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
    const s=await setup(sources=>{const result=lecture(sources);if(invalid&&result.chapter==='第二章')result.concepts[0]!.quote='不在资料中的错误依据';return result})
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
  it('revoking shared consent cancels running calls across course folders',async()=>{
    let entered!:()=>void,release!:()=>void;const start=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r)
    const s=await setup(async sources=>{entered();await gate;return lecture(sources)});await writeFile(join(s.folder,'lecture.md'),DOC)
    const job=await s.projects.handle('initialize',{courseId:s.id,requestId:randomUUID(),paths:['lecture.md']}) as any;await start;await s.projects.handle('preferences',{consent:false});release()
    const result=await settle(s.projects,job.jobId);expect(result.job.state).toBe('cancelled');expect(result.state.settings.consent).toBe(false);expect(result.state.courses[0].revision).toBeUndefined()
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
