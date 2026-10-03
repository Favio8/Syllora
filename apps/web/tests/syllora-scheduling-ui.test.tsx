import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Syllora from '../src/components/Syllora'
import { addDate, buildPlan, localDate, publicCourse, recordNext, type Course } from '../../../packages/host/chat-service/src/syllora-domain'

vi.mock('../src/components/settings/ModelsSection',()=>({default:()=>null}))
beforeEach(()=>{Element.prototype.scrollIntoView=vi.fn();vi.stubGlobal('matchMedia',vi.fn(()=>({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()})));HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','')};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open')}})
afterEach(()=>{sessionStorage.clear();vi.unstubAllGlobals()})
function fixture():Course {
  return {id:'c',name:'合成 UI 课程',timezone:'Asia/Shanghai',archived:false,createdAt:Date.now(),materials:[{id:'m',name:'fixture.txt',fingerprint:'fixture',status:'ready',accepted:true,pages:0,sources:[{id:'s',materialId:'m',anchor:'段落 1',text:'合成来源'}]}],points:[{id:'p',name:'旧知识点',chapter:'章',sourceIds:['s']}],scope:['p'],plan:null,draft:null,questions:[],attempts:[],messages:[],actions:[],drafts:{prompt:'',answers:[]},changes:[],notice:null}
}
function state(course:Course) {
  return {courses:[publicCourse(course,Date.now())],jobs:[],settings:{consent:false,calls:0}}
}
describe('PRD scheduled actions and material recovery UI',()=>{
  it('keeps unsaved settings and the original base version when another page saves, then loads new values only explicitly',async()=>{
    const course=fixture();const requests:any[]=[];const fetch=vi.fn(async(url:string,options?:RequestInit)=>{if(url.endsWith('/learningSettings')){const payload=JSON.parse(String(options?.body)).payload;requests.push(payload);return {ok:false,json:async()=>({error:{code:'VERSION_CONFLICT',message:'学习设置已被另一页面修改'}})}}return {ok:true,json:async()=>({result:state(course)})}});vi.stubGlobal('fetch',fetch);
    render(<Syllora/>);fireEvent.click(await screen.findByRole('button',{name:/合成 UI 课程.*个知识点/}));await screen.findByText('合成 UI 课程',{exact:true});fireEvent.click(screen.getByRole('tab',{name:'复习'}));fireEvent.click(screen.getByText('复习间隔设置'));fireEvent.change(screen.getByLabelText('首次补强与复测（小时）'),{target:{value:'48'}});fireEvent.change(screen.getByLabelText('会话闲置关闭（分钟）'),{target:{value:'45'}});
    const oldCalls=fetch.mock.calls.length;course.learningSettings={revision:1,reviewHours:[72,120,240],sessionIdleMinutes:60};await waitFor(()=>expect(fetch.mock.calls.length).toBeGreaterThan(oldCalls),{timeout:3000});
    expect(screen.getByLabelText('首次补强与复测（小时）')).toHaveValue(48);expect(screen.getByLabelText('会话闲置关闭（分钟）')).toHaveValue(45);expect(screen.getByText(/你的未保存输入和原修订号已保留/)).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'保存未来复习间隔'}));await screen.findByText('学习设置已被另一页面修改');expect(requests[0]).toMatchObject({baseVersion:0,reviewHours:[48,72,168],sessionIdleMinutes:45});
    fireEvent.click(screen.getByRole('button',{name:'放弃草稿并载入最新设置'}));expect(screen.getByLabelText('首次补强与复测（小时）')).toHaveValue(72);expect(screen.getByLabelText('会话闲置关闭（分钟）')).toHaveValue(60);
  })
  it('updates a clean form on polling and does not discard a subsequent edit while its own successful save catches up',async()=>{
    const course=fixture(),requests:any[]=[];const fetch=vi.fn(async(url:string,options?:RequestInit)=>{if(url.endsWith('/learningSettings')){requests.push(JSON.parse(String(options?.body)).payload);return {ok:true,json:async()=>({result:{saved:true}})}}return {ok:true,json:async()=>({result:state(course)})}});vi.stubGlobal('fetch',fetch);render(<Syllora/>);fireEvent.click(await screen.findByRole('button',{name:/合成 UI 课程.*个知识点/}));await screen.findByText('合成 UI 课程',{exact:true});fireEvent.click(screen.getByRole('tab',{name:'复习'}));fireEvent.click(screen.getByText('复习间隔设置'));
    course.learningSettings={revision:1,reviewHours:[48,96,240],sessionIdleMinutes:45};await waitFor(()=>expect(screen.getByLabelText('首次补强与复测（小时）')).toHaveValue(48),{timeout:3000});fireEvent.change(screen.getByLabelText('首次补强与复测（小时）'),{target:{value:'60'}});fireEvent.click(screen.getByRole('button',{name:'保存未来复习间隔'}));await waitFor(()=>expect(requests).toHaveLength(1));await waitFor(()=>expect(screen.getByRole('button',{name:'保存未来复习间隔'})).not.toBeDisabled());fireEvent.change(screen.getByLabelText('首次补强与复测（小时）'),{target:{value:'72'}});
    const before=fetch.mock.calls.length;course.learningSettings={revision:2,reviewHours:[60,96,240],sessionIdleMinutes:45};await waitFor(()=>expect(fetch.mock.calls.length).toBeGreaterThan(before),{timeout:3000});expect(screen.getByLabelText('首次补强与复测（小时）')).toHaveValue(72);expect(screen.queryByText(/你的未保存输入和原修订号已保留/)).toBeNull();fireEvent.click(screen.getByRole('button',{name:'保存未来复习间隔'}));await waitFor(()=>expect(requests).toHaveLength(2));expect(requests[1]).toMatchObject({baseVersion:2,reviewHours:[72,96,240]})
  })
  it('validates editable future intervals and preserves unsaved input after a storage failure',async()=>{
    const course=fixture();const fetch=vi.fn(async(url:string)=>url.endsWith('/learningSettings')?{ok:false,json:async()=>({error:{message:'合成保存失败'}})}:{ok:true,json:async()=>({result:state(course)})});vi.stubGlobal('fetch',fetch);
    render(<Syllora/>);fireEvent.click(await screen.findByRole('button',{name:/合成 UI 课程.*个知识点/}));await screen.findByText('合成 UI 课程',{exact:true});fireEvent.click(screen.getByRole('tab',{name:'复习'}));fireEvent.click(screen.getByText('复习间隔设置'));
    const input=screen.getByLabelText('首次补强与复测（小时）');fireEvent.change(input,{target:{value:'12'}});fireEvent.click(screen.getByRole('button',{name:'保存未来复习间隔'}));
    expect(screen.getByText('请输入不递减的三个整数小时，范围 24–8760。')).toBeVisible();expect(fetch.mock.calls.every(([url])=>!url.endsWith('/learningSettings'))).toBe(true);
    fireEvent.change(input,{target:{value:'48'}});fireEvent.click(screen.getByRole('button',{name:'保存未来复习间隔'}));await screen.findByText('合成保存失败');expect(input).toHaveValue(48);
  })

  it('shows grouped original wrong answers with source and dispute actions',async()=>{
    const course=fixture();course.questions.push({id:'q',pointId:'p',taskId:'old',slot:0,family:'fixture',stem:'合成错题：单位矩阵保持什么？',options:['向量','答案 B','答案 C','答案 D'],answer:0,explanation:'合成解析：单位矩阵保持原向量。',sourceIds:['s'],quote:'合成来源',status:'valid',assisted:false});
    course.attempts.push({id:'attempt',questionId:'q',option:1,correct:false,assisted:false,at:Date.now(),sequence:0});
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({result:state(course)})}));
    render(<Syllora/>);fireEvent.click(await screen.findByRole('button',{name:/合成 UI 课程.*个知识点/}));await screen.findByText('合成 UI 课程',{exact:true});fireEvent.click(screen.getByRole('tab',{name:'复习'}));
    fireEvent.click(screen.getByText('错题记录 · 1 题'));
    expect(screen.getByRole('heading',{name:'合成错题：单位矩阵保持什么？'})).toBeVisible();
    expect(screen.getByText('你的选项 B：答案 B')).toBeVisible();expect(screen.getByText('正确选项 A：向量')).toBeVisible();
    expect(screen.getByRole('button',{name:'查看错题依据'})).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'报告此题问题'}));
    expect(screen.getByRole('dialog',{name:'题目报错'})).toBeVisible();
  })
  it('offers an explicitly confirmed retry for an interrupted course deletion',async()=>{
    const state={courses:[],jobs:[],settings:{consent:false,calls:0},projects:[{id:'deleting',path:'synthetic',name:'待清理课程',error:'课程删除未完成',deletion:'failed'}]};
    const fetch=vi.fn(async(url:string,options?:RequestInit)=>{
      if(url.endsWith('/delete')) {expect(JSON.parse(String(options?.body)).payload).toMatchObject({courseId:'deleting',confirmed:true});state.projects=[];return {ok:true,json:async()=>({result:{saved:true}})}}
      return {ok:true,json:async()=>({result:state})};
    });vi.stubGlobal('fetch',fetch);vi.spyOn(window,'confirm').mockReturnValue(true);
    render(<Syllora/>);fireEvent.click(screen.getByRole('button',{name:'我的课程'}));fireEvent.click(await screen.findByRole('button',{name:'重试删除课程'}));fireEvent.click(screen.getByRole('button',{name:/^重试删除$/}));
    await waitFor(()=>expect(screen.queryByRole('button',{name:'重试删除课程'})).toBeNull());
    expect(fetch.mock.calls.some(([url])=>url.endsWith('/delete'))).toBe(true);
  })

  it('shows a future availability time and disables premature task execution',async()=>{
    const course=fixture();course.plan=buildPlan(course,{scope:['p'],dailyMinutes:40,days:7,restDays:[]},Date.now(),()=> 'task')
    course.plan.tasks[0]!.date=addDate(localDate(Date.now(),course.timezone),1);recordNext(course,Date.now(),()=> 'action','plan')
    const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({result:state(course)})});vi.stubGlobal('fetch',fetch)
    render(<Syllora/>);fireEvent.click(await screen.findByRole('button',{name:/合成 UI 课程.*个知识点/}));await screen.findByRole('heading',{name:'等待已确认任务的计划日期'})
    expect(screen.getByRole('button',{name:/^继续/})).toBeDisabled()
    expect(screen.getByText(/可执行时间：/)).toBeVisible()
    // 任务列表已移入「计划管理」整页：先在工作台断言下一步卡片，再点入口看任务状态
    fireEvent.click(screen.getByRole('button',{name:/^计划管理/}))
    expect(screen.getByRole('button',{name:/旧知识点.*待开始/})).toBeDisabled()
    expect(fetch.mock.calls.every(([url])=>url==='/api/syllora/state'||/\/course\/graph$/.test(String(url)))).toBe(true)
  })
  it('offers explicit source recovery and hides generation on a blocked active task',async()=>{
    const course=fixture();course.plan=buildPlan(course,{scope:['p'],dailyMinutes:40,days:7,restDays:[]},Date.now(),()=> 'task')
    course.plan.tasks[0]!.status='in_progress';course.points[0]!.sourceIds=['removed']
    course.points.push({id:'replacement',chapter:'补充章',name:'补充知识点',sourceIds:['s']})
    recordNext(course,Date.now(),()=> 'action','material')
    const fetch=vi.fn(async(url:string,options?:RequestInit)=>{
      if(url.endsWith('/restorePointSources')) {
        const p=JSON.parse(String(options?.body)).payload
        expect(p).toMatchObject({courseId:'c',pointId:'p',replacementPointId:'replacement'})
        course.points[0]!.sourceIds=['s'];recordNext(course,Date.now(),()=> 'recovered','material')
        return {ok:true,json:async()=>({result:{saved:true}})}
      }
      return {ok:true,json:async()=>({result:state(course)})}
    });vi.stubGlobal('fetch',fetch)
    render(<Syllora/>);fireEvent.click(await screen.findByRole('button',{name:/合成 UI 课程.*个知识点/}));await screen.findByRole('heading',{name:'补充资料后继续当前知识点'})
    expect(screen.queryByRole('button',{name:'获取资料讲解'})).toBeNull()
    expect(screen.getByRole('button',{name:'确认关联并恢复学习'})).toBeDisabled()
    fireEvent.click(screen.getByRole('combobox',{name:'补充资料中的知识点'}));fireEvent.click(screen.getByRole('option',{name:'补充章 · 补充知识点'}))
    fireEvent.click(screen.getByRole('button',{name:'确认关联并恢复学习'}))
    await waitFor(()=>expect(screen.getByRole('heading',{name:'继续当前任务'})).toBeVisible())
    fireEvent.click(screen.getByRole('button',{name:/^练习$/}));expect(screen.getByRole('button',{name:'获取资料讲解'})).toBeEnabled()
  })
})



