import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { StructuredCallClient } from '@syllora/course-builder'
import { SylloraProjects } from '../src/syllora-projects.ts'

/**
 * 笔记 RPC 契约：正文存 `{课程文件夹}/notes/{id}.md`、元数据存 `notes/index.json`，
 * `[[双链]]` 在保存时解析；笔记目录不进入课程资料扫描，删除课程也不清理它。
 */

const temp = resolve('..', 'tmp', 'syllora-notes-tests'), roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) { if (!root.startsWith(temp)) throw new Error('unsafe test cleanup'); await rm(root, { recursive: true, force: true }) } })

interface Note { id: string; title: string; wikilinks: string[]; createdAt: number; updatedAt: number }

async function setup(options: { withModel?: boolean; client?: StructuredCallClient } = {}) {
  await mkdir(temp, { recursive: true })
  const root = await mkdtemp(join(temp, 'case-')), folder = join(root, 'course')
  roots.push(root)
  await mkdir(folder)
  // 笔记 AI 的入参校验发生在模型调用之前：给一个"看起来已配置"的 config 就能单独测校验分支。
  const projects = new SylloraProjects(join(root, 'app'), options.withModel
    ? { ...(options.client ? { client: () => options.client! } : {}), config: async () => ({ providerId: 'fixture', model: 'fixture-model', baseUrl: 'http://127.0.0.1:9/v1', protocol: 'openai' as const, apiKey: 'fixture', apiKeyEnv: null, temperature: 0.3, maxConcurrency: 1, defaultMode: 'quick' as const }) }
    : {})
  const opened = await projects.handle('openCourse', { path: folder }) as { id: string }
  return { root, folder, projects, id: opened.id }
}

const list = async (s: Awaited<ReturnType<typeof setup>>) =>
  (await s.projects.handle('notes/list', { courseId: s.id }) as { notes: Note[] }).notes
const create = async (s: Awaited<ReturnType<typeof setup>>, title: string) =>
  (await s.projects.handle('notes/create', { courseId: s.id, title }) as { meta: Note }).meta
const notePath = (s: Awaited<ReturnType<typeof setup>>, id: string) => join(s.folder, 'notes', `${id}.md`)

describe('course notes', () => {
  it('creates a Markdown note under the course folder and lists it', async () => {
    const s = await setup()
    const note = await create(s, '线性代数复习')
    expect(note.title).toBe('线性代数复习')
    expect(note.wikilinks).toEqual([])
    expect(await readFile(notePath(s, note.id), 'utf8')).toContain('# 线性代数复习')
    expect((await list(s)).map(item => item.title)).toEqual(['线性代数复习'])
  })

  it('parses [[wikilinks]] on save, renames on title change and keeps the body intact', async () => {
    const s = await setup()
    const a = await create(s, '笔记A')
    const b = await create(s, '笔记B')
    const body = '# 笔记B\n\n复习时回看 [[笔记A]]，以及重复的 [[笔记A]] 与自链 [[笔记B]]。\n'
    const saved = await s.projects.handle('notes/update', { courseId: s.id, noteId: b.id, content: body }) as { meta: Note }
    // 同一目标重复出现只记一次；自链也照实记录（连线由前端按「目标必须是已有笔记」裁掉）。
    expect(saved.meta.wikilinks).toEqual(['笔记A', '笔记B'])
    const renamed = await s.projects.handle('notes/update', { courseId: s.id, noteId: b.id, title: '笔记B（改）' }) as { meta: Note }
    expect(renamed.meta.title).toBe('笔记B（改）')
    expect(renamed.meta.wikilinks).toEqual(['笔记A', '笔记B'])
    const read = await s.projects.handle('notes/read', { courseId: s.id, noteId: b.id }) as { content: string; meta: Note }
    expect(read.content).toBe(body)
    expect(read.meta.updatedAt).toBeGreaterThanOrEqual(read.meta.createdAt)
    expect((await list(s)).length).toBe(2)
  })

  it('takes the target before the pipe for [[target|alias]] links', async () => {
    const s = await setup()
    const b = await create(s, '笔记B')
    const body = '# 笔记B\n\n见 [[笔记A|单位矩阵]] 与 [[笔记C]]，别名里的竖线不当目标。\n'
    const saved = await s.projects.handle('notes/update', { courseId: s.id, noteId: b.id, content: body }) as { meta: Note }
    expect(saved.meta.wikilinks).toEqual(['笔记A', '笔记C'])
  })

  it('deletes the body and the index entry together', async () => {
    const s = await setup()
    const note = await create(s, '临时笔记')
    expect((await s.projects.handle('notes/delete', { courseId: s.id, noteId: note.id }) as { deleted: boolean }).deleted).toBe(true)
    expect(await stat(notePath(s, note.id)).catch(() => null)).toBeNull()
    expect(await list(s)).toEqual([])
    await expect(s.projects.handle('notes/read', { courseId: s.id, noteId: note.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('笔记 AI：选段类动作缺选区、自定义缺指令都在调用模型前拒绝', async () => {
    const s = await setup({ withModel: true })
    const note = await create(s, '线性代数复习')
    await expect(s.projects.handle('notes/suggest', { courseId: s.id, noteId: note.id, title: '线性代数复习', action: 'rewrite' }))
      .rejects.toMatchObject({ code: 'SELECTION_REQUIRED' })
    await expect(s.projects.handle('notes/suggest', { courseId: s.id, noteId: note.id, title: '线性代数复习', action: 'custom', instruction: '   ' }))
      .rejects.toMatchObject({ code: 'INSTRUCTION_REQUIRED' })
    // 无资料时"续写/总结"这类以资料为依据的动作仍被挡（保持原行为）
    await expect(s.projects.handle('notes/suggest', { courseId: s.id, noteId: note.id, title: '线性代数复习', action: 'continue', prefix: '矩阵' }))
      .rejects.toMatchObject({ code: 'NO_USABLE_SOURCE' })
  })

  it('rejects foreign course IDs, unknown notes and traversal-shaped note IDs', async () => {
    const s = await setup()
    const note = await create(s, '边界笔记')
    await expect(s.projects.handle('notes/list', { courseId: randomUUID() })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(s.projects.handle('notes/update', { courseId: s.id, noteId: randomUUID(), content: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(s.projects.handle('notes/read', { courseId: s.id, noteId: '../../course' })).rejects.toThrow()
    await expect(s.projects.handle('notes/delete', { courseId: s.id, noteId: '../index' })).rejects.toThrow()
    expect(await readFile(notePath(s, note.id), 'utf8')).toContain('边界笔记')
  })

  it('keeps the notes folder out of the course material scan', async () => {
    const s = await setup()
    await create(s, '不会被当成资料')
    const scan = await s.projects.handle('scan', { courseId: s.id }) as { files: Array<{ path: string; status: string }> }
    expect(scan.files).toEqual([])
  })

  it('keeps notes on disk when the course products are deleted', async () => {
    const s = await setup()
    const note = await create(s, '保留的笔记')
    await s.projects.handle('delete', { courseId: s.id, confirmed: true })
    expect(await readFile(notePath(s, note.id), 'utf8')).toContain('保留的笔记')
    expect((await s.projects.handle('state', {}) as { projects: unknown[] }).projects).toEqual([])
  })
})

describe('note write recovery and concurrency',()=>{
  it('keeps all concurrently created notes in the durable index',async()=>{
    const s=await setup();
    const notes=await Promise.all(Array.from({length:20},(_,i)=>create(s,`并发 ${i}`)));
    expect(new Set((await list(s)).map(note=>note.id))).toEqual(new Set(notes.map(note=>note.id)));
    const restart=new SylloraProjects(join(s.root,'app'));
    expect((await restart.handle('notes/list',{courseId:s.id}) as any).notes).toHaveLength(20);
  });
  it('rejects a stale version without overwriting the current Markdown',async()=>{
    const s=await setup(),note=await create(s,'版本保护');const payload={courseId:s.id,noteId:note.id};
    const initial=await s.projects.handle('notes/read',payload) as any;
    await s.projects.handle('notes/update',{...payload,baseVersion:initial.version,content:'最新正文'});
    await expect(s.projects.handle('notes/update',{...payload,baseVersion:initial.version,content:'旧页面正文'})).rejects.toMatchObject({code:'VERSION_CONFLICT'});
    expect((await s.projects.handle('notes/read',payload) as any).content).toBe('最新正文');
  });
  it('recovers complete UUID documents omitted from an interrupted index',async()=>{
    const s=await setup();const note=await create(s,'完整文档');
    await writeFile(join(s.folder,'notes','index.json'),'[]');
    expect((await list(s)).map(item=>item.id)).toContain(note.id);
    expect(JSON.parse(await readFile(join(s.folder,'notes','index.json'),'utf8'))).toHaveLength(1);
  });
});

describe('笔记 AI 输出', () => {
  it('allows a complete structured Markdown response beyond the old length limit', async () => {
    const text = '## 扩写\n\n' + '完整讲解。'.repeat(900) + '\n\n```js\nconst x = 1;\n```';
    const s = await setup({ withModel: true, client: { async *stream(options) {
      expect(options.maxTokens).toBeGreaterThanOrEqual(8000);
      yield { type: 'text-delta', text: JSON.stringify({ text, sourceIds: [] }) };
    } } });
    const note = await create(s, '笔记'); const before = await readFile(notePath(s, note.id), 'utf8');
    const result = await s.projects.handle('notes/suggest', { courseId: s.id, action: 'expand', selection: '解释基础概念', body: '解释基础概念' }) as { text: string };
    expect(result.text).toBe(text);
    expect(await readFile(notePath(s, note.id), 'utf8')).toBe(before);
  });
  it('reports provider truncation specifically and does not modify the note', async () => {
    const s = await setup({ withModel: true, client: { async *stream() {
      yield { type: 'text-delta', text: '{"text":"未完成' };
      yield { type: 'finish', reason: { kind: 'max-tokens' } };
    } } });
    const note = await create(s, '笔记'); const before = await readFile(notePath(s, note.id), 'utf8');
    await expect(s.projects.handle('notes/suggest', { courseId: s.id, action: 'expand', selection: '基础概念' })).rejects.toMatchObject({ code: 'NOTE_OUTPUT_TRUNCATED' });
    expect(await readFile(notePath(s, note.id), 'utf8')).toBe(before);
  });
});
