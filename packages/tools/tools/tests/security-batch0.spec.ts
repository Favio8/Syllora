/**
 * 批次 0 安全修复的对抗用例（PRD 需求四增补的修复验收）：
 *  - CR-02：声明 mode 后，越模式的工具必须被拒（quick 调 write_note）。
 *  - CR-03：课程内 notes.md 被植链后写笔记必须被拒，且不产生课程外写入。
 *  - CR-17：悬空符号链接不能让 write_file 在工作区外创建文件。
 *  - CR-21：资料根内植入指向外部的链接时，resolveSourceRef 拒绝。
 *  - CR-22：排除目录不依赖 .source-root.json 直接生效（可读他课目录/扫 node_modules 被堵）。
 *  - CR-18/CR-19：fetch_url 正文与 LSP 投影能进模型消息体。
 * 本地适配：文件符号链接在 Windows 上需开发者模式/提权（本机 EPERM），
 * tryLink 失败即跳过对应用例；junction 形态的同类越界由 path-safety.spec.ts
 * 常跑覆盖。模式表本地已无 socratic 条目，未知模式 fail-closed 到只读子集。
 */

import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentToolRegistry, resolveSourceRef, ToolResult } from '../src/index.ts'
import type { ToolContext } from '../src/handlers.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

/** 课程夹具：courseDir 就是项目根（in-place 布局）。 */
async function setup(): Promise<{ root: string; courseDir: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), 'syllora-sec-'))
  roots.push(root)
  const courseDir = join(root, 'ws')
  const outside = join(root, 'outside')
  await mkdir(join(courseDir, '.syllora'), { recursive: true })
  await mkdir(join(courseDir, 'docs'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(courseDir, 'docs', 'a.md'), '# 标题\n第一行内容。\n', 'utf8')
  await writeFile(join(outside, 'secret.md'), '课程外的机密正文\n', 'utf8')
  return { root, courseDir, outside }
}

/** Windows 上创建文件符号链接需要开发者模式/提权；不可用时跳过该用例。 */
async function tryLink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, 'file')
    return (await lstat(path)).isSymbolicLink()
  } catch {
    return false
  }
}

describe('CR-02 mode policy at dispatch', () => {
  it('rejects a tool the declared mode does not allow', async () => {
    const { courseDir } = await setup()
    const registry = agentToolRegistry(courseDir, courseDir)
    const ctx: ToolContext = { courseDir, workspaceRoot: courseDir, mode: 'quick', approval: async () => 'allow' }
    const result = await registry.execute('write_note', { content: '越模式写入' }, ctx)
    expect(result.status).toBe('rejected')
    expect(result.error).toBe('TOOL_NOT_ALLOWED_IN_MODE')
    // 未声明的模式（本地模式表已无 socratic）fail-closed 到只读子集，同样拒绝。
    const legacy: ToolContext = { courseDir, workspaceRoot: courseDir, mode: 'socratic', approval: async () => 'allow' }
    const fallback = await registry.execute('write_note', { content: '未声明模式的越权写入' }, legacy)
    expect(fallback.status).toBe('rejected')
    expect(fallback.error).toBe('TOOL_NOT_ALLOWED_IN_MODE')
  })

  it('still allows the tools the mode whitelists', async () => {
    const { courseDir } = await setup()
    const registry = agentToolRegistry(courseDir, courseDir)
    const ctx: ToolContext = { courseDir, workspaceRoot: courseDir, mode: 'quick' }
    const result = await registry.execute('read_source', { path: 'docs/a.md' }, ctx)
    expect(result.status).toBe('success')
  })

  it('keeps legacy callers working when no mode is declared', async () => {
    const { courseDir } = await setup()
    const registry = agentToolRegistry(courseDir, courseDir)
    const ctx: ToolContext = { courseDir, workspaceRoot: courseDir, approval: async () => 'allow' }
    const result = await registry.execute('write_note', { content: '未声明模式的旧调用方' }, ctx)
    expect(result.status).toBe('success')
  })
})

describe('CR-03 write_note symlink containment', () => {
  it('refuses to follow a planted notes.md symlink outside the course', async () => {
    const { courseDir, outside } = await setup()
    const victim = join(outside, 'victim.md')
    await writeFile(victim, '原始内容\n', 'utf8')
    if (!(await tryLink(victim, join(courseDir, '.syllora', 'notes.md')))) return // 平台不支持链接
    const registry = agentToolRegistry(courseDir, courseDir)
    const result = await registry.execute('write_note', { content: '越界写入' }, { courseDir, workspaceRoot: courseDir, approval: async () => 'allow' })
    expect(result.status).not.toBe('success')
    // 关键断言：课程外目标未被写入。
    expect(await readFile(victim, 'utf8')).toBe('原始内容\n')
  })

  it('refuses a dangling notes.md symlink instead of creating the target', async () => {
    const { courseDir, outside } = await setup()
    const dangling = join(outside, 'created-outside.md')
    if (!(await tryLink(dangling, join(courseDir, '.syllora', 'notes.md')))) return
    const registry = agentToolRegistry(courseDir, courseDir)
    const result = await registry.execute('write_note', { content: '不该被创建' }, { courseDir, workspaceRoot: courseDir, approval: async () => 'allow' })
    expect(result.status).not.toBe('success')
    await expect(lstat(dangling)).rejects.toThrow()
  })
})

describe('CR-17 write_file symlink containment', () => {
  it('refuses a dangling symlink rather than creating a file outside the workspace', async () => {
    const { courseDir, outside } = await setup()
    const dangling = join(outside, 'escaped.md')
    const planted = join(courseDir, 'planted.md')
    if (!(await tryLink(dangling, planted))) return
    const registry = agentToolRegistry(courseDir, courseDir)
    const result = await registry.execute('write_file', { path: 'planted.md', content: '逃逸内容' }, { courseDir, workspaceRoot: courseDir, approval: async () => 'allow' })
    expect(result.status).not.toBe('success')
    await expect(lstat(dangling)).rejects.toThrow()
  })
})

describe('CR-21 source ref containment', () => {
  it('rejects a source ref that resolves outside the material root', async () => {
    const { courseDir, outside } = await setup()
    if (!(await tryLink(join(outside, 'secret.md'), join(courseDir, 'docs', 'linked.md')))) return
    await expect(resolveSourceRef(courseDir, 'docs/linked.md')).rejects.toThrow(/符号链接/)
  })

  it('keeps normal in-root reads working', async () => {
    const { courseDir } = await setup()
    expect(await resolveSourceRef(courseDir, 'docs/a.md')).toContain('a.md')
  })
})

describe('CR-22 excluded directories without the binding file', () => {
  it('rejects node_modules and other-course state directories', async () => {
    const { courseDir } = await setup()
    await mkdir(join(courseDir, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(courseDir, 'node_modules', 'pkg', 'readme.md'), '包内文档\n', 'utf8')
    await mkdir(join(courseDir, 'courses', 'other'), { recursive: true })
    await writeFile(join(courseDir, 'courses', 'other', 'notes.md'), '别的课程笔记\n', 'utf8')
    // 没有 .source-root.json（旧实现据此把排除集判为死代码）。
    await expect(resolveSourceRef(courseDir, 'node_modules/pkg/readme.md')).rejects.toThrow()
    await expect(resolveSourceRef(courseDir, 'courses/other/notes.md')).rejects.toThrow()
  })
})

describe('CR-18/CR-19 model-visible data whitelist', () => {
  it('feeds the fetched page body back to the model', () => {
    const result = new ToolResult('success', '已获取 200', { url: 'https://example.com', status: 200, contentType: 'text/html', body: '网页正文内容' })
    expect(result.toToolMessage()).toContain('网页正文内容')
  })

  it('feeds LSP locations and hover text back to the model', () => {
    const locations = new ToolResult('success', 'LSP goToDefinition', { kind: 'locations', locations: [{ uri: 'file:///a.ts', range: {} }] })
    expect(locations.toToolMessage()).toContain('file:///a.ts')
    const hover = new ToolResult('success', 'LSP hover', { kind: 'hover', hover: { contents: '函数说明' } })
    expect(hover.toToolMessage()).toContain('函数说明')
  })
})
