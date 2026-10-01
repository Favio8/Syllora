import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/syllora-files.ts',async importOriginal=>{
  const actual=await importOriginal<typeof import('../src/syllora-files.ts')>()
  return {...actual,removeProducts:vi.fn(actual.removeProducts),atomicJson:vi.fn(actual.atomicJson)}
})
import { SylloraProjects } from '../src/syllora-projects.ts'
import { atomicJson, removeProducts } from '../src/syllora-files.ts'
const roots:string[]=[]
afterEach(async()=>{vi.clearAllMocks();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
async function setup(options:NonNullable<ConstructorParameters<typeof SylloraProjects>[1]>={}) {
  const root=await mkdtemp(join(tmpdir(),'syllora-delete-recovery-'));roots.push(root)
  const app=join(root,'app'),folder=join(root,'course');await mkdir(folder)
  await writeFile(join(folder,'original.txt'),'仅供自动测试的原始资料')
  const projects=new SylloraProjects(app,options);const opened=await projects.handle('openCourse',{path:folder}) as {id:string}
  return {projects,app,folder,id:opened.id}
}
describe('durable course deletion recovery',()=>{
  it('rejects a generation request paused before Job creation instead of recreating deleted state',async()=>{
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
    const s=await setup({config:async()=>{entered();await gate;return {providerId:'fixture',model:'fixture',baseUrl:'http://127.0.0.1:9/v1',apiKey:'fixture-only',apiKeyEnv:null,temperature:0,maxConcurrency:1,defaultMode:'quick'}}});
    const pending=s.projects.handle('generate',{courseId:s.id,requestId:'00000000-0000-4000-8000-000000000001',kind:'answer',prompt:'合成问题'});
    await started;await s.projects.handle('delete',{courseId:s.id,confirmed:true});release();
    await expect(pending).rejects.toMatchObject({code:'DELETING'});
    expect(await readFile(join(s.folder,'.syllora','course.json'),'utf8').catch(()=>null)).toBeNull();
    expect((await s.projects.handle('state',{}) as any).projects).toEqual([]);
  })

  it('rejects concurrent deletion while the original cleanup is running',async()=>{
    const s=await setup(),actual=await vi.importActual<typeof import('../src/syllora-files.ts')>('../src/syllora-files.ts');
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
    vi.mocked(removeProducts).mockImplementationOnce(async(root,names)=>{entered();await gate;return actual.removeProducts(root,names)});
    const first=s.projects.handle('delete',{courseId:s.id,confirmed:true});await started;
    try {await expect(s.projects.handle('delete',{courseId:s.id,confirmed:true})).rejects.toMatchObject({code:'DELETING'})}
    finally {release()}
    expect(await first).toEqual({saved:true});expect(removeProducts).toHaveBeenCalledTimes(1);
    expect((await s.projects.handle('state',{}) as any).projects).toEqual([]);
  })

  it('blocks learning and reopening across a restart after partial cleanup and offers safe retry',async()=>{
    const s=await setup();await mkdir(join(s.folder,'.syllora','revisions'));await writeFile(join(s.folder,'.syllora','revisions','fixture.txt'),'generated')
    const actual=await vi.importActual<typeof import('../src/syllora-files.ts')>('../src/syllora-files.ts')
    vi.mocked(removeProducts).mockImplementationOnce(async root=>{await actual.removeProducts(root,['revisions']);throw Object.assign(new Error('fixture disk failure'),{code:'EIO'})})
    await expect(s.projects.handle('delete',{courseId:s.id,confirmed:true})).rejects.toMatchObject({code:'DELETE_INCOMPLETE'})
    expect(await readFile(join(s.folder,'original.txt'),'utf8')).toContain('原始资料')
    const registry=JSON.parse(await readFile(join(s.app,'.syllora','projects.json'),'utf8'));expect(registry[0].deletion).toBe('failed')
    const restarted=new SylloraProjects(s.app)
    await expect(restarted.handle('rename',{courseId:s.id,name:'cannot write'})).rejects.toMatchObject({code:'DELETING'})
    await expect(restarted.handle('openCourse',{path:s.folder})).rejects.toMatchObject({code:'DELETING'})
    const state=await restarted.handle('state',{}) as any;expect(state.courses).toEqual([]);expect(state.projects[0]).toMatchObject({id:s.id,deletion:'failed',error:expect.stringContaining('删除未完成')})
    expect(await restarted.handle('delete',{courseId:s.id,confirmed:true})).toEqual({saved:true})
    expect((await restarted.handle('state',{}) as any).projects).toEqual([])
    expect(await readFile(join(s.folder,'original.txt'),'utf8')).toContain('原始资料')
    expect(await readFile(join(s.folder,'.syllora','course.json'),'utf8').catch(()=>null)).toBeNull()
  })
  it('does not start cleanup if persisting the deletion intent fails',async()=>{
    const s=await setup()
    vi.mocked(atomicJson).mockImplementationOnce(async()=>{throw Object.assign(new Error('fixture registry failure'),{code:'ENOSPC'})})
    await expect(s.projects.handle('delete',{courseId:s.id,confirmed:true})).rejects.toMatchObject({code:'STORAGE_ERROR'})
    expect(removeProducts).not.toHaveBeenCalled()
    expect((await s.projects.handle('state',{}) as any).courses[0].id).toBe(s.id)
    expect(JSON.parse(await readFile(join(s.app,'.syllora','projects.json'),'utf8'))[0].deletion).toBeUndefined()
  })
  it('keeps the pending marker if final registry removal cannot be persisted',async()=>{
    const s=await setup();const actual=await vi.importActual<typeof import('../src/syllora-files.ts')>('../src/syllora-files.ts')
    vi.mocked(atomicJson).mockImplementation(async(path,value)=>{
      if(path===join(s.app,'.syllora','projects.json')&&Array.isArray(value)&&(value.length===0||value[0]?.deletion==='failed'))throw Object.assign(new Error('fixture registry failure'),{code:'EIO'})
      return actual.atomicJson(path,value)
    })
    await expect(s.projects.handle('delete',{courseId:s.id,confirmed:true})).rejects.toMatchObject({code:'DELETE_INCOMPLETE'})
    expect(JSON.parse(await readFile(join(s.app,'.syllora','projects.json'),'utf8'))[0].deletion).toBe('pending')
    const restarted=new SylloraProjects(s.app)
    await expect(restarted.handle('openCourse',{path:s.folder})).rejects.toMatchObject({code:'DELETING'})
    vi.mocked(atomicJson).mockImplementation(actual.atomicJson)
    await restarted.handle('delete',{courseId:s.id,confirmed:true})
    expect((await restarted.handle('state',{}) as any).projects).toEqual([])
    expect(await readFile(join(s.folder,'original.txt'),'utf8')).toContain('原始资料')
  })
})
