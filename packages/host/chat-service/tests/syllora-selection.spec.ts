import { describe,expect,it } from 'vitest';
import { readingText, selectionBelongs } from '../src/syllora-selection.ts';
import { generationFailure } from '../src/syllora-jobs.ts';
import { z } from 'zod';
describe('rendered reading selections',()=>{
  it('accepts bold, links and inline code without loosening literal punctuation',()=>{
    const sources=[{text:'这是 **线性相关** 的解释，[查看定义](https://example.test)，使用 `A+B`。'}];
    expect(selectionBelongs(sources,'这是 线性相关 的解释，查看定义，使用 A+B。')).toBe(true);
    expect(selectionBelongs(sources,'这是线性无关的解释')).toBe(false);
    expect(selectionBelongs(sources,'A-B')).toBe(false);
    expect(selectionBelongs(sources,'')).toBe(false);
  });
  it('handles cross-paragraph selections, GFM tables and literal code blocks',()=>{
    expect(selectionBelongs([{text:'**第一段**。'},{text:'_第二段_。'}],'第一段。\n第二段。')).toBe(true);
    expect(readingText('| 名称 | 值 |\n|---|---|\n| 单位 | **1** |')).toBe('名称值单位1');
    expect(readingText('```js\nconst x = a * b;\n```')).toBe('const x = a * b;');
  });
  it('does not expose hidden image labels or raw HTML as selectable text',()=>{
    expect(readingText('正文 ![隐藏图片](a.png)')).toBe('正文 ');
  });
});
describe('safe output diagnostics',()=>{
  it('distinguishes JSON and schema failures without publishing upstream content',()=>{
    expect(generationFailure(new Error('outer',{cause:new Error('响应中未找到合法 JSON')})).code).toBe('OUTPUT_NOT_JSON');
    const parsed=z.object({ok:z.boolean()}).safeParse({ok:'private-value'});
    if(parsed.success)throw new Error('fixture unexpectedly passed');
    const error=generationFailure(new Error('outer',{cause:parsed.error}));
    expect(error.code).toBe('OUTPUT_SCHEMA_INVALID');expect(error.message).not.toContain('private-value');
  });
});
