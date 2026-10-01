import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LearningJobDiagnostics, LearningMetrics, SessionControls, useLearningExposures } from '../src/components/syllora-metrics'
import { buildPlan, publicCourse, type Course } from '../../../packages/host/chat-service/src/syllora-domain'
import { touchSession } from '../../../packages/host/chat-service/src/syllora-sessions'
function fixture() {const c:Course={id:'c',name:'合成 UI 会话',timezone:'Etc/UTC',archived:false,createdAt:Date.now(),materials:[{id:'m',name:'fixture.txt',fingerprint:'fixture',status:'ready',accepted:true,pages:0,sources:[{id:'s',materialId:'m',anchor:'段落1',text:'合成来源'}]}],points:[{id:'p',name:'知识点',chapter:'章',sourceIds:['s']}],scope:['p'],plan:null,draft:null,questions:[],attempts:[],messages:[],actions:[],drafts:{prompt:'',answers:[]},changes:[],notice:null};c.plan=buildPlan(c,{scope:['p'],dailyMinutes:40,days:7,restDays:[]},Date.now(),()=>crypto.randomUUID());c.plan.tasks[0]!.status='in_progress';return c}
afterEach(()=>vi.unstubAllGlobals())
describe('session controls and actual viewport observations',()=>{
 it('shows no fabricated rate at zero and keeps ordinary versus synthetic observations separate',()=>{
  render(<LearningMetrics course={publicCourse(fixture(),Date.now())}/>);fireEvent.click(screen.getByText('学习过程记录'));expect(screen.getByText(/普通时钟：闭环 0.*暂无可计算样本/)).toBeVisible();expect(screen.getByText(/合成验证：闭环 0.*暂无可计算样本/)).toBeVisible();expect(screen.getByText(/用户报错，不是确认错误率/)).toBeVisible()
 })
 it('labels partial token sums and unknown historical coverage without pricing or limits',()=>{
  render(<LearningJobDiagnostics jobs={[{id:'job',courseId:'c',state:'succeeded',message:'完成',model:'fixture',calls:2,inputTokens:12,outputTokens:null,usageKnownCalls:{input:1,output:0}}]}/>);fireEvent.click(screen.getByText('生成执行诊断'));expect(screen.getByText(/输入覆盖 1\/2 次，输出覆盖 0\/2 次/)).toBeVisible();expect(screen.getByText(/部分调用缺失时/)).toBeVisible();expect(screen.getByText(/输出 未取得/)).toBeVisible()
 })
 it('preserves helper input and request ID on failed save, then clears only after success',async()=>{
  const c=fixture();touchSession(c,Date.now(),()=>crypto.randomUUID(),true,c.plan!.tasks[0]!.id,true);const run=vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({saved:true});render(<SessionControls course={publicCourse(c,Date.now())} task={c.plan!.tasks[0]} busy={false} onRun={run}/>);fireEvent.click(screen.getByText('记录额外人工帮助'));const input=screen.getByLabelText('人工帮助原因');fireEvent.change(input,{target:{value:'合成操作帮助'}});fireEvent.click(screen.getByRole('button',{name:'保存人工帮助记录'}));await waitFor(()=>expect(run).toHaveBeenCalledTimes(1));expect(input).toHaveValue('合成操作帮助');fireEvent.click(screen.getByRole('button',{name:'保存人工帮助记录'}));await waitFor(()=>expect(input).toHaveValue(''));expect(run.mock.calls[0]![1]).toEqual(run.mock.calls[1]![1]);expect(run.mock.calls[0]![0]).toBe('recordHelp')
 })
 it('records only intersecting objects, deduplicates refreshes and retries a failed metadata save',async()=>{
  let observe!:IntersectionObserverCallback;vi.stubGlobal('IntersectionObserver',class {constructor(callback:IntersectionObserverCallback){observe=callback}observe(){}disconnect(){}});
  const c=fixture(),course=publicCourse(c,Date.now()),rpc=vi.fn().mockRejectedValueOnce(new Error('合成保存失败')).mockResolvedValue({saved:true});const node=document.createElement('article');node.dataset.learningId='q';node.dataset.learningKind='question';document.body.appendChild(node);
  const {rerender,unmount}=renderHook(({course})=>useLearningExposures(course,rpc,'today'),{initialProps:{course}});
  act(()=>observe([{target:node,isIntersecting:false,intersectionRatio:0} as unknown as IntersectionObserverEntry],{} as IntersectionObserver));expect(rpc).not.toHaveBeenCalled();
  await act(async()=>observe([{target:node,isIntersecting:true,intersectionRatio:1} as unknown as IntersectionObserverEntry],{} as IntersectionObserver));expect(rpc).toHaveBeenCalledTimes(1);
  rerender({course:{...course}});await act(async()=>observe([{target:node,isIntersecting:true,intersectionRatio:1} as unknown as IntersectionObserverEntry],{} as IntersectionObserver));expect(rpc).toHaveBeenCalledTimes(2);expect(rpc.mock.calls[1]).toEqual(['recordExposure',{courseId:'c',objects:[{kind:'question',id:'q'}]}]);
  rerender({course:{...course}});await act(async()=>observe([{target:node,isIntersecting:true,intersectionRatio:1} as unknown as IntersectionObserverEntry],{} as IntersectionObserver));expect(rpc).toHaveBeenCalledTimes(2);unmount();node.remove()
 })
 it('offers an explicit start for restored in-progress tasks and end for active sessions',async()=>{
  const c=fixture(),run=vi.fn().mockResolvedValue({saved:true});const view=render(<SessionControls course={publicCourse(c,Date.now())} task={c.plan!.tasks[0]} busy={false} onRun={run}/>);fireEvent.click(screen.getByRole('button',{name:'开始本次学习'}));expect(run).toHaveBeenCalledWith('start',{taskId:c.plan!.tasks[0]!.id});const session=touchSession(c,Date.now(),()=>crypto.randomUUID(),false,c.plan!.tasks[0]!.id,true)!;view.rerender(<SessionControls course={publicCourse(c,Date.now())} task={c.plan!.tasks[0]} busy={false} onRun={run}/>);fireEvent.click(screen.getByRole('button',{name:'结束本次学习'}));expect(run).toHaveBeenCalledWith('endSession',{sessionId:session.id})
 })
})
