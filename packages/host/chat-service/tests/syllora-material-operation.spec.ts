import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SylloraProjects } from '../src/syllora-projects.ts'
import * as files from '../src/syllora-files.ts'
import { SylloraService } from '../src/syllora.ts'
import type { StructuredCallClient } from '@syllora/course-builder'
const roots:string[]=[]
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
const config={providerId:'fixture',model:'fixture',baseUrl:'http://127.0.0.1:9/v1',apiKey:'fixture-only',apiKeyEnv:null,temperature:0,maxConcurrency:1,digest:false,defaultMode:'quick' as const}
function lecture(sources:any[]){return {chapter:sources[0].section.split(' / ').at(-1).slice(0,60),intro:{text:'合成章节导读',sourceIds:sources.map(source=>source.id)},concepts:sources.filter(source=>source.kind!=='heading'&&source.text.length>=4).map((source,i)=>({name:`合成概念 ${i}`,text:'合成解释',sourceIds:[source.id],quote:source.text.slice(0,40)})),examples:[],connections:[],analogies:[]}}
async function settle(projects:SylloraProjects,jobId:string){for(let i=0;i<300;i++){const state=await projects.handle('state',{}) as any,job=state.jobs.find((job:any)=>job.id===jobId);if(job&&job.state!=='running')return {state,job};await new Promise(resolve=>setTimeout(resolve,10))}throw new Error('fixture Job did not settle')}
async function seeded(configProvider:()=>Promise<typeof config>=async()=>config) {
 const root=await mkdtemp(join(tmpdir(),'syllora-material-boundary-'));roots.push(root);const folder=join(root,'course');await mkdir(folder);await writeFile(join(folder,'a.md'),'# 甲章\n\n合成甲章依据。');await writeFile(join(folder,'b.md'),'# 乙章\n\n合成乙章依据。');const client:StructuredCallClient={async *stream(options){const text=(options.messages.at(-1) as any).content[0].text;yield {type:'text-delta',text:JSON.stringify(lecture(JSON.parse(text.split('所选资料：\n')[1])))}}};const projects=new SylloraProjects(join(root,'app'),{config:configProvider,client:()=>client});await projects.handle('preferences',{consent:true});const {id}=await projects.handle('openCourse',{path:folder}) as {id:string};const job=await projects.handle('initialize',{courseId:id,requestId:randomUUID(),paths:['a.md','b.md']}) as {jobId:string};const result=await settle(projects,job.jobId);expect(result.job.state).toBe('succeeded');return {root,folder,projects,id,course:result.state.courses.find((course:any)=>course.id===id)}
}
describe('material deletion course operation isolation',()=>{
 it('keeps the guard through cleanup itself while another course remains usable',async()=>{
  const s=await seeded(),original=files.removeProducts;let entered!:()=>void,release!:()=>void;const start=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);vi.spyOn(files,'removeProducts').mockImplementationOnce(async(root,names)=>{entered();await gate;await original(root,names)});const deletion=s.projects.handle('deleteMaterial',{courseId:s.id,materialId:s.course.materials[0].id,confirmed:true}).then(value=>value,error=>error);await start;
  try {await expect(s.projects.handle('initialize',{courseId:s.id,requestId:randomUUID(),paths:['b.md']})).rejects.toMatchObject({code:'COURSE_BUSY'});await expect(s.projects.handle('delete',{courseId:s.id,confirmed:true})).rejects.toMatchObject({code:'COURSE_BUSY'});const other=join(s.root,'other');await mkdir(other);await writeFile(join(other,'b.md'),'# 独立章\n\n另一课程的合成定义。');const opened=await s.projects.handle('openCourse',{path:other}) as {id:string};const job=await s.projects.handle('initialize',{courseId:opened.id,requestId:randomUUID(),paths:['b.md']}) as {jobId:string};expect((await settle(s.projects,job.jobId)).job.state).toBe('succeeded')}
  finally {release();expect(await deletion).toEqual({saved:true})}
  const job=await s.projects.handle('initialize',{courseId:s.id,requestId:randomUUID(),paths:['b.md']}) as {jobId:string};const result=await settle(s.projects,job.jobId);const course=result.state.courses.find((course:any)=>course.id===s.id);expect(result.job.state).toBe('succeeded');expect((await stat(join(s.folder,'.syllora','revisions',course.revision))).isDirectory()).toBe(true)
 })
 it('does not delete a material while an initialization is paused before Job creation',async()=>{
  let pause=false,entered!:()=>void,release!:()=>void;const start=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);const s=await seeded(async()=>{if(pause){entered();await gate}return config});pause=true;const pending=s.projects.handle('initialize',{courseId:s.id,requestId:randomUUID(),paths:['b.md']}).then(value=>value as {jobId:string});await start;
  try {await expect(s.projects.handle('deleteMaterial',{courseId:s.id,materialId:s.course.materials[0].id,confirmed:true})).rejects.toMatchObject({code:'COURSE_BUSY'});const state=await s.projects.handle('state',{}) as any;expect(state.courses[0].materials[0].status).toBe('ready');expect(state.courses[0].revision).toBe(s.course.revision)}finally{pause=false;release()}
  const job=await pending;expect((await settle(s.projects,job.jobId)).job.state).toBe('succeeded')
 })

 it.each(['initialize','outline'])('blocks %s from publishing a revision while material deletion drains an old worker',async route=>{
  const root=await mkdtemp(join(tmpdir(),'syllora-material-operation-'));roots.push(root);const folder=join(root,'course');await mkdir(folder);const a='# 甲章\n\n仅供测试的甲资料定义。',b='# 乙章\n\n仅供测试的乙资料定义。';await writeFile(join(folder,'a.md'),a);await writeFile(join(folder,'b.md'),b);
  let pause=false,paused=false,oldEntered!:()=>void,releaseOld!:()=>void,drainEntered!:()=>void,releaseDrain!:()=>void;const oldStart=new Promise<void>(resolve=>oldEntered=resolve),oldGate=new Promise<void>(resolve=>releaseOld=resolve),drainStart=new Promise<void>(resolve=>drainEntered=resolve),drainGate=new Promise<void>(resolve=>releaseDrain=resolve);
  const client:StructuredCallClient={async *stream(options){const text=(options.messages.at(-1) as any).content[0].text,sources=JSON.parse(text.split('所选资料：\n')[1]);if(pause&&!paused){paused=true;oldEntered();await oldGate}yield {type:'text-delta',text:JSON.stringify(lecture(sources))}}};
  const projects=new SylloraProjects(join(root,'app'),{config:async()=>config,client:()=>client});await projects.handle('preferences',{consent:true});const {id}=await projects.handle('openCourse',{path:folder}) as {id:string};const first=await projects.handle('initialize',{courseId:id,requestId:randomUUID(),paths:['a.md','b.md']}) as {jobId:string};const seeded=await settle(projects,first.jobId);expect(seeded.job.state).toBe('succeeded');const material=seeded.state.courses[0].materials.find((material:any)=>material.path==='a.md');
  pause=true;await writeFile(join(folder,'a.md'),a+' 新的甲章合成依据。');await projects.handle('initialize',{courseId:id,requestId:randomUUID(),paths:['a.md']});await oldStart;
  const original=SylloraService.prototype.settleJobs;vi.spyOn(SylloraService.prototype,'settleJobs').mockImplementationOnce(async function(this:SylloraService){drainEntered();await drainGate;await original.call(this)});
  const deletion=projects.handle('deleteMaterial',{courseId:id,materialId:material.id,confirmed:true}).then(value=>value,error=>error);await drainStart;
  let concurrent:any,published:string|undefined,existedAfterDeletion:boolean|undefined;
  try {
   concurrent=await projects.handle(route==='outline'?'generate':'initialize',{courseId:id,requestId:randomUUID(),...(route==='outline'?{kind:'outline'}:{paths:['b.md']})}).catch(error=>error);
   if(!(concurrent instanceof Error)){const raced=await settle(projects,concurrent.jobId);expect(raced.job.state).toBe('succeeded');published=raced.state.courses[0].revision;expect((await stat(join(folder,'.syllora','revisions',published!))).isDirectory()).toBe(true)}
  } finally {releaseOld();releaseDrain();expect(await deletion).toEqual({saved:true})}
  if(published)existedAfterDeletion=!!(await stat(join(folder,'.syllora','revisions',published)).catch(()=>null));
  expect(concurrent,`concurrent ${route} published ${published}; revision exists after deletion: ${existedAfterDeletion}`).toMatchObject({code:'COURSE_BUSY'});
  const later=await projects.handle('initialize',{courseId:id,requestId:randomUUID(),paths:['b.md']}) as {jobId:string};const recovered=await settle(projects,later.jobId);expect(recovered.job.state).toBe('succeeded');expect((await stat(join(folder,'.syllora','revisions',recovered.state.courses[0].revision))).isDirectory()).toBe(true);expect(await readFile(join(folder,'b.md'),'utf8')).toBe(b)
 })
})
