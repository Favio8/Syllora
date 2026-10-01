import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs/promises')>()
  return {...actual,rename:vi.fn(actual.rename)}
})
import { atomicJson } from '../src/syllora-files.ts'
import { writeAtomic } from '../../../storage/storage-json/src/atomic.ts'
import { saveProgressBoard } from '@syllora/course-builder'
import { saveProvider, settingsPayload } from '../src/settings.ts'
const roots:string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
describe('atomic snapshot replacement',()=>{
  it.each(['workspace','legacy-progress'])('retries transient replacement on the %s storage path',async kind=>{
    const root=await mkdtemp(join(tmpdir(),'syllora-common-storage-'));roots.push(root);const path=join(root,kind==='workspace'?'workspace.json':'progress.md');
    const board={overallMastery:0,dueCount:0,lastUpdatedAt:null,concepts:[]};
    if(kind==='workspace')await writeAtomic(path,'original');else await saveProgressBoard(path,board,new Date('2026-10-01T00:00:00Z'));
    const previous=await readFile(path,'utf8'),mocked=vi.mocked(rename),before=mocked.mock.calls.length;
    mocked.mockImplementationOnce(async()=>{expect(await readFile(path,'utf8')).toBe(previous);throw Object.assign(new Error('busy fixture'),{code:'EPERM'})});
    if(kind==='workspace')await writeAtomic(path,'replacement');else await saveProgressBoard(path,board,new Date('2026-10-02T00:00:00Z'));
    expect(mocked.mock.calls.length-before).toBe(2);expect(await readFile(path,'utf8')).not.toBe(previous);expect(await readdir(root)).toEqual([kind==='workspace'?'workspace.json':'progress.md']);
  })
  it('bounds transient replacement retries and retains the original workspace snapshot on exhaustion',async()=>{
    const root=await mkdtemp(join(tmpdir(),'syllora-common-storage-'));roots.push(root);const path=join(root,'workspace.json');await writeAtomic(path,'original');
    const mocked=vi.mocked(rename),before=mocked.mock.calls.length;
    for(let attempt=0;attempt<6;attempt++)mocked.mockImplementationOnce(async()=>{throw Object.assign(new Error('persistent fixture'),{code:'EPERM'})});
    await expect(writeAtomic(path,'replacement')).rejects.toMatchObject({code:'EPERM'});expect(mocked.mock.calls.length-before).toBe(6);
    expect(await readFile(path,'utf8')).toBe('original');expect(await readdir(root)).toEqual(['workspace.json']);
  })

  it('retries a transient Windows denial when replacing shared provider configuration',async()=>{
    const root=await mkdtemp(join(tmpdir(),'syllora-config-storage-'));roots.push(root);
    const provider={id:'fixture',name:'Original fixture',model:'fixture',baseUrl:'http://127.0.0.1:9/v1'};
    await saveProvider(root,provider);const path=join(root,'.syllora','config.yaml');
    vi.mocked(rename).mockImplementationOnce(async()=>{expect(await readFile(path,'utf8')).toContain('Original fixture');throw Object.assign(new Error('busy fixture'),{code:'EPERM'})});
    await saveProvider(root,{...provider,name:'Replacement fixture',overwrite:true});
    expect((await settingsPayload(root)).providers.find(provider=>provider.id==='fixture')?.name).toBe('Replacement fixture');
    expect(await readdir(join(root,'.syllora'))).toEqual(['config.yaml']);
  })
  it('retains the previous provider configuration when replacement permanently fails',async()=>{
    const root=await mkdtemp(join(tmpdir(),'syllora-config-storage-'));roots.push(root);
    const provider={id:'fixture',name:'Original fixture',model:'fixture',baseUrl:'http://127.0.0.1:9/v1'};await saveProvider(root,provider);
    vi.mocked(rename).mockImplementationOnce(async()=>{throw Object.assign(new Error('fixture write failure'),{code:'EIO'})});
    await expect(saveProvider(root,{...provider,name:'Replacement fixture',overwrite:true})).rejects.toMatchObject({code:'EIO'});
    expect((await settingsPayload(root)).providers.find(provider=>provider.id==='fixture')?.name).toBe('Original fixture');
    expect(await readdir(join(root,'.syllora'))).toEqual(['config.yaml']);
  })

  it('retries a transient Windows denial while retaining the previous target',async()=>{
    const root=await mkdtemp(join(tmpdir(),'syllora-storage-'));roots.push(root);const path=join(root,'course.json')
    await atomicJson(path,{value:'original'})
    const mocked=vi.mocked(rename),before=mocked.mock.calls.length
    mocked.mockImplementationOnce(async()=>{expect(JSON.parse(await readFile(path,'utf8'))).toEqual({value:'original'});throw Object.assign(new Error('busy fixture'),{code:'EPERM'})})
    await atomicJson(path,{value:'replacement'})
    expect(mocked.mock.calls.length-before).toBe(2);expect(JSON.parse(await readFile(path,'utf8'))).toEqual({value:'replacement'})
    expect(await readdir(root)).toEqual(['course.json'])
  })
  it('cleans its temporary file when serialization fails while retaining the previous snapshot',async()=>{
    const root=await mkdtemp(join(tmpdir(),'syllora-storage-'));roots.push(root);const path=join(root,'course.json');
    await atomicJson(path,{value:'original'});const cyclic:any={};cyclic.self=cyclic;
    await expect(atomicJson(path,cyclic)).rejects.toThrow();
    expect(JSON.parse(await readFile(path,'utf8'))).toEqual({value:'original'});expect(await readdir(root)).toEqual(['course.json']);
  })
  it('does not delete the durable target or leave temporary files after a permanent failure',async()=>{
    const root=await mkdtemp(join(tmpdir(),'syllora-storage-'));roots.push(root);const path=join(root,'course.json')
    await atomicJson(path,{value:'original'})
    vi.mocked(rename).mockImplementationOnce(async()=>{throw Object.assign(new Error('disk failure fixture'),{code:'EIO'})})
    await expect(atomicJson(path,{value:'replacement'})).rejects.toMatchObject({code:'EIO'})
    expect(JSON.parse(await readFile(path,'utf8'))).toEqual({value:'original'});expect(await readdir(root)).toEqual(['course.json'])
  })
})
