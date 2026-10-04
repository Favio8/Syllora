import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CourseView } from '../src/types/syllora';
const mocks=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('../src/features/workbench/services',()=>({workbenchRpc:mocks.rpc}));
import { usePlanningDraft } from '../src/features/workbench/usePlanningDraft';

const course=(id='a')=>({id,scope:['p'],points:[{id:'p'},{id:'q'}],draft:null,plan:null,archived:false}) as CourseView;
beforeEach(()=>{localStorage.clear();mocks.rpc.mockReset();vi.useFakeTimers();});
afterEach(()=>{vi.useRealTimers();localStorage.clear();});
describe('course planning draft recovery',()=>{
  it('keeps a saved selection while older polling data catches up, and isolates courses',async()=>{
    mocks.rpc.mockResolvedValue({revision:1});const a=course(),b=course('b');
    const hook=renderHook(({value})=>usePlanningDraft(value),{initialProps:{value:a}});
    act(()=>{hook.result.current.setScope(['q']);hook.result.current.setEstimates({q:'35'});});
    await act(async()=>{expect(await hook.result.current.savePlanning()).toBe(true);});
    hook.rerender({value:{...a}});expect(hook.result.current.scope).toEqual(['q']);
    hook.rerender({value:b});expect(hook.result.current.scope).toEqual(['p']);
    hook.rerender({value:a});expect(hook.result.current.scope).toEqual(['q']);expect(hook.result.current.estimates).toEqual({q:'35'});
    hook.unmount();const restored=renderHook(()=>usePlanningDraft(a));expect(restored.result.current.scope).toEqual(['q']);
  });
  it('preserves failed edits across remount instead of overwriting them from the server',async()=>{
    mocks.rpc.mockRejectedValue(new Error('配置已被另一页面更新'));
    const hook=renderHook(()=>usePlanningDraft(course()));act(()=>hook.result.current.setScope([]));
    await act(async()=>{expect(await hook.result.current.savePlanning()).toBe(false);});
    expect(hook.result.current.planningStatus).toContain('另一页面');hook.unmount();
    const restored=renderHook(()=>usePlanningDraft(course()));expect(restored.result.current.scope).toEqual([]);
  });
  it('serializes edits made during an in-flight save and submits their new revision',async()=>{
    let release!:(value:{revision:number})=>void;
    mocks.rpc.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve})).mockResolvedValue({revision:2});
    const hook=renderHook(()=>usePlanningDraft(course()));act(()=>hook.result.current.setScope(['q']));
    let first!:Promise<boolean>;act(()=>{first=hook.result.current.savePlanning();});
    act(()=>hook.result.current.setEstimates({q:'45'}));
    await act(async()=>{release({revision:1});await first;expect(await hook.result.current.savePlanning()).toBe(true);});
    expect(mocks.rpc.mock.calls[1][1]).toMatchObject({baseVersion:1,scope:['q'],estimates:{q:45}});
    expect(hook.result.current.planningStatus).toBe('已保存');
  });
  it('autosaves after the debounce and does not send invalid minute values',async()=>{
    mocks.rpc.mockResolvedValue({revision:1});const hook=renderHook(()=>usePlanningDraft(course()));
    act(()=>hook.result.current.setEstimates({p:'35'}));await act(async()=>{await vi.advanceTimersByTimeAsync(450)});
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    act(()=>hook.result.current.setEstimates({p:'2'}));await act(async()=>{expect(await hook.result.current.savePlanning()).toBe(false)});
    expect(mocks.rpc).toHaveBeenCalledTimes(1);expect(hook.result.current.estimates.p).toBe('2');
  });
  it('explicitly reads the newest server revision on reload and retains edits if that read fails',async()=>{
    const a=course(),hook=renderHook(()=>usePlanningDraft(a));act(()=>hook.result.current.setScope([]));
    mocks.rpc.mockRejectedValueOnce(new Error('暂时断线'));
    await act(async()=>{await hook.result.current.reloadPlanning();});expect(hook.result.current.scope).toEqual([]);
    mocks.rpc.mockResolvedValueOnce({courses:[{...a,planningDraft:{revision:3,scope:['q'],estimates:{q:55}}}]});
    await act(async()=>{await hook.result.current.reloadPlanning();});
    expect(hook.result.current.scope).toEqual(['q']);expect(hook.result.current.estimates).toEqual({q:'55'});
    expect(mocks.rpc.mock.calls.at(-1)?.[0]).toBe('state');
  });
});
