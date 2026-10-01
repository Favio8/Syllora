import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LectureReader, MaterialInitialization, MaterialPreview, ProjectDialog } from '../src/components/syllora-project-ui';
import type { CourseView } from '../src/types/syllora';
vi.mock('../src/lib/api',()=>({api:{pickWorkspaceDirectory:vi.fn(),browseDirectory:vi.fn()}}));
afterEach(()=>vi.unstubAllGlobals());
const course={id:'course',materials:[],folder:'D:/course',revision:'revision',archived:false} as unknown as CourseView;
describe('course project UI',()=>{
  it('inspects files without initiating model calls and submits only selected supported inputs',async()=>{
    const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({result:{files:[{path:'first.md',status:'ready',size:1024,change:'added',fingerprint:'one'},{path:'second.txt',status:'ready',size:512,change:'changed',fingerprint:'two'},{path:'image.png',status:'unsupported',size:100,change:'added',fingerprint:null,reason:'仅支持文本'}],missing:[]}})});vi.stubGlobal('fetch',fetch);const onRun=vi.fn().mockResolvedValue({jobId:'j'});
    render(<MaterialInitialization course={course} epoch={0} busy={false} running={false} onRun={onRun}/>);
    await screen.findByText('first.md');expect(onRun).not.toHaveBeenCalled();expect(screen.getByRole('checkbox',{name:/image.png/})).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox',{name:/second.txt/}));fireEvent.click(screen.getByRole('button',{name:/更新课程讲义 · 1 份资料/}));
    expect(onRun).toHaveBeenCalledWith('initialize',expect.objectContaining({paths:['first.md'],fingerprints:{'first.md':'one'},acceptPartial:false}));
  });
  it('renders teaching notes, distinguishes raw evidence and opens source references without loading external images',async()=>{
    const source=vi.fn();vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({result:{lectures:[{id:'l',chapter:'矩阵',intro:{text:'章节导读',sourceIds:['s']},concepts:[{name:'单位矩阵',text:'**整理解释**\n\n![外部图](https://example.com/image.png)\n\n<script>window.bad=true</script>',quote:'主对角线元素为一',sourceIds:['s']}],examples:[],connections:[],analogies:[]}]}})}));
    const result=render(<LectureReader course={course} onSource={source}/>);await screen.findByRole('heading',{name:'单位矩阵'});
    expect(result.container.querySelector('img')).toBeNull();expect(result.container.querySelector('script')).toBeNull();expect(screen.getByText('原文依据')).toBeVisible();fireEvent.click(screen.getAllByRole('button',{name:'原文 1'})[0]!);expect(source).toHaveBeenCalledWith('s');
  });
  it('opens a chosen existing directory and reports an actionable folder error',async()=>{
    const onOpen=vi.fn().mockRejectedValue(new Error('文件夹已不存在'));render(<ProjectDialog onClose={()=>{}} onOpen={onOpen}/>);fireEvent.change(screen.getByLabelText('课程文件夹路径'),{target:{value:'D:/course'}});fireEvent.click(screen.getByRole('button',{name:'打开此课程'}));
    await waitFor(()=>expect(onOpen).toHaveBeenCalledWith('D:/course'));expect(await screen.findByRole('alert')).toHaveTextContent('文件夹已不存在');
  });
  it('loads an original with bearer authentication and revokes the local preview when closed',async()=>{
    Object.assign(window,{__SYLLORA__:{token:'fixture-token'}});const createObjectURL=vi.fn().mockReturnValue('blob:fixture'),revokeObjectURL=vi.fn();
    vi.stubGlobal('URL',class extends URL {static createObjectURL=createObjectURL;static revokeObjectURL=revokeObjectURL});const fetch=vi.fn().mockResolvedValue({ok:true,blob:async()=>new Blob(['PDF'],{type:'application/pdf'})});vi.stubGlobal('fetch',fetch);
    render(<MaterialPreview url="/api/syllora/material-file?courseId=course&materialId=material" name="讲义.pdf" version="v1"/>);fireEvent.click(screen.getByRole('button',{name:'预览原文件'}));await screen.findByRole('dialog',{name:'原文件预览'});
    expect(fetch).toHaveBeenCalledWith(expect.not.stringContaining('fixture-token'),expect.objectContaining({headers:{Authorization:'Bearer fixture-token'}}));expect(screen.getByTitle('PDF 原文件')).toHaveAttribute('src','blob:fixture');expect(screen.getByRole('link',{name:'下载原文件'})).toHaveAttribute('download','讲义.pdf');fireEvent.click(screen.getByRole('button',{name:'关闭原文件预览'}));expect(revokeObjectURL).toHaveBeenCalledWith('blob:fixture');delete (window as any).__SYLLORA__;
  });
});
