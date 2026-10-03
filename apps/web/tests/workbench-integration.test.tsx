import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { ApiError, api } from '../src/lib/api'
import { logicalRequest, readingService, workbenchRpc } from '../src/features/workbench/services'
import PreferencesEditor from '../src/features/workbench/components/PreferencesEditor'
import Home from '../src/features/workbench/components/Home'
import { projectWorkspace } from '../src/features/workbench/projection'
import { publicCourse, type Course } from '../../../packages/host/chat-service/src/syllora-domain'
import { editDraft } from '../src/components/syllora-drafts'
import { recoverDrafts, saveDraftRecovery } from '../src/features/workbench/draftRecovery'
const response=(result:unknown,ok=true)=>({ok,status:ok?200:409,json:async()=>result})
beforeEach(()=>{sessionStorage.clear();vi.stubGlobal('crypto',webcrypto);(window as any).__SYLLORA__={token:'fixture-token'}})
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();delete (window as any).__SYLLORA__})
describe('unified workbench service and preferences',()=>{
  it('recovers an unsaved course draft after refresh without recreating deleted courses',()=>{const cache=editDraft(editDraft({},'a','未发送输入',{}),'deleted','不应复活',{});expect(saveDraftRecovery(cache)).toBe(true);const courses=[{id:'a',drafts:{prompt:'',answers:[],version:0}}];const recovered=recoverDrafts({},courses);expect(recovered.a?.prompt).toBe('未发送输入');expect(recovered.a?.revision).not.toBe(recovered.a?.savedRevision);expect(recovered.deleted).toBeUndefined();const accepted=recoverDrafts({},[{id:'a',drafts:{prompt:'未发送输入',answers:[],version:1}}]);expect(accepted.a?.revision).toBe(accepted.a?.savedRevision);expect(accepted.a?.baseVersion).toBe(1)})
  it('keeps the in-memory draft when browser recovery storage fails',()=>{const draft=editDraft({},'a','保留输入',{});vi.spyOn(Object.getPrototypeOf(sessionStorage),'setItem').mockImplementation(()=>{throw new Error('quota')});expect(saveDraftRecovery(draft)).toBe(false);expect(draft.a?.prompt).toBe('保留输入')})
  it('authenticates Syllora actions and generic provider RPC with their respective envelopes',async()=>{
    const fetch=vi.fn(async(url:string)=>response(url.includes('/syllora/')?{result:{saved:true}}:{ok:true,result:{providers:[]}}));vi.stubGlobal('fetch',fetch)
    expect(await workbenchRpc('preferences',{consent:false})).toEqual({saved:true});await api.settings()
    for(const [,init] of fetch.mock.calls as any)expect(init.headers.Authorization).toBe('Bearer fixture-token')
  })
  it.each(['CONSENT_REQUIRED','MODEL_NOT_CONFIGURED','VERSION_CONFLICT','INVALID_SOURCE'])('retains a classified %s error',async code=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response({error:{code,message:'明确错误'}},false)))
    await expect(workbenchRpc('generate')).rejects.toMatchObject({code,message:'明确错误',status:409})
  })
  it('rejects malformed and unsuccessful RPC envelopes',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response({ok:false})));await expect(workbenchRpc('state')).rejects.toBeInstanceOf(ApiError)
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response({})));await expect(workbenchRpc('state')).rejects.toMatchObject({code:'INVALID_RESPONSE'})
  })
  it('recovers an accepted generation after a lost response by querying its original job',async()=>{
    let id='';const fetch=vi.fn(async(url:string,init:RequestInit)=>{if(url.endsWith('/generate')){id=JSON.parse(String(init.body)).payload.requestId;throw new TypeError('connection lost')}return response({result:{courses:[],jobs:[{id:'original',courseId:'recovery',requestId:id,state:'running'}]}})});vi.stubGlobal('fetch',fetch)
    expect(await logicalRequest('generate',{courseId:'recovery',kind:'answer',prompt:'question'})).toMatchObject({jobId:'original'})
    expect(fetch.mock.calls.filter(([url])=>url.endsWith('/generate'))).toHaveLength(1)
  })
  it('reuses the idempotency ID on retry when both generation and query are unavailable',async()=>{
    const ids:string[]=[];let offline=true;vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{if(url.endsWith('/generate'))ids.push(JSON.parse(String(init.body)).payload.requestId);if(offline)throw new TypeError('offline');return response({result:{jobId:'recovered'}})}))
    const payload={courseId:'retry',kind:'answer',prompt:'same logical question'};await expect(logicalRequest('generate',payload)).rejects.toThrow('offline');offline=false;await logicalRequest('generate',payload);expect(ids[0]).toBe(ids[1])
  })
  it('keeps unsaved preferences and original version on polling and conflict, then explicitly reloads',async()=>{
    const initial={name:'学习者',theme:'light' as const,dailyMinutes:40,revision:0},latest={...initial,name:'另页',dailyMinutes:60,revision:1};const payloads:any[]=[]
    vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>{const payload=JSON.parse(String(init.body)).payload;payloads.push(payload);return response(payload.baseVersion===undefined?{result:latest}:{error:{code:'VERSION_CONFLICT',message:'版本冲突'}},payload.baseVersion===undefined)}))
    const view=render(<PreferencesEditor initial={initial} onSaved={async()=>{}}/>);fireEvent.change(screen.getByLabelText('用户名称'),{target:{value:'本页草稿'}});view.rerender(<PreferencesEditor initial={latest} onSaved={async()=>{}}/>);
    expect(screen.getByLabelText('用户名称')).toHaveValue('本页草稿');fireEvent.click(screen.getByRole('button',{name:'保存偏好'}));await screen.findByText('版本冲突');expect(payloads[0]).toMatchObject({baseVersion:0,name:'本页草稿'});expect(screen.getByLabelText('用户名称')).toHaveValue('本页草稿');fireEvent.click(screen.getByRole('button',{name:'加载最新设置'}));await waitFor(()=>expect(screen.getByLabelText('用户名称')).toHaveValue('另页'))
  })
  it('preserves edits typed during a delayed successful preference save',async()=>{
    let finish!:(value:unknown)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise(resolve=>{finish=resolve})));const initial={name:'学习者',theme:'light' as const,dailyMinutes:40,revision:0};render(<PreferencesEditor initial={initial} onSaved={async()=>{}}/>);
    fireEvent.change(screen.getByLabelText('用户名称'),{target:{value:'发送版本'}});fireEvent.click(screen.getByRole('button',{name:'保存偏好'}));fireEvent.change(screen.getByLabelText('用户名称'),{target:{value:'之后输入'}});finish(response({result:{...initial,name:'发送版本',revision:1}}));await waitFor(()=>expect(screen.getByRole('button',{name:'保存偏好'})).not.toBeDisabled());expect(screen.getByLabelText('用户名称')).toHaveValue('之后输入')
  })
  it('uses empty real activity for old snapshots and preserves all five evidence states',()=>{
    const states=['未评估','待验证','待加强','初步掌握','复测通过'] as const
    const course={id:'c',name:'旧课程',timezone:'Asia/Shanghai',createdAt:Date.now(),archived:false,materials:[],points:states.map((_,i)=>({id:String(i),name:String(i),chapter:'章',sourceIds:[]})),scope:[],plan:null,draft:null,questions:[],attempts:[],messages:[],actions:[],drafts:{prompt:'',answers:[]},changes:[],notice:null} satisfies Course
    const actual=publicCourse(course,Date.now());states.forEach((state,i)=>actual.evidence[String(i)]={...actual.evidence[String(i)]!,state});const display=projectWorkspace({courses:[actual],jobs:[],settings:{consent:false,calls:0}});expect(display.courses[0]!.points.map(point=>point.state)).toEqual(states);expect(display.activity).toEqual([]);expect(display.courses[0]!.icon).toBe('notebook')
  })
  it('does not offer a future or blocked task as a runnable home target',()=>{
    const course={id:'c',name:'未来课程',chapter:'章',color:'blue' as const,subtitle:'',symbol:'',materials:[],messages:[],points:[],tasks:[{id:'future',title:'未来任务',kind:'学习' as const,minutes:20,completed:false,available:false}]};const study=vi.fn();render(<Home data={{version:1,courses:[course],preferences:{name:'同学',dailyMinutes:40,compact:false}}} selected="c" onCourse={vi.fn()} onCreate={vi.fn()} onCourses={vi.fn()} onMaterials={vi.fn()} onStudy={study}/>);expect(screen.getByRole('button',{name:'学习活动：未来任务'})).toBeDisabled();expect(screen.getByText('0 项待完成')).toBeVisible();expect(study).not.toHaveBeenCalled()
  })
  it('cancels the accepted reading job when a selection is invalidated while awaiting acceptance',async()=>{
    const controller=new AbortController(),calls:string[]=[];let accept!:(value:unknown)=>void;vi.stubGlobal('fetch',vi.fn(async(url:string)=>{calls.push(url);if(url.endsWith('/generate'))return new Promise(resolve=>{accept=resolve});return response({result:{saved:true}})}));const pending=readingService.assist({id:'m',courseId:'c',revision:'v',name:'notes',title:'notes',content:'真实正文',source:'published',sources:[{id:'s',anchor:'段落1',text:'真实正文'}]},'真实','explain',controller.signal);await waitFor(()=>expect(accept).toBeDefined());controller.abort();accept(response({result:{jobId:'accepted'}}));await expect(pending).rejects.toThrow('取消');expect(calls).toContain('/api/syllora/cancel')
  })
})

