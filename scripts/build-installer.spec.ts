/**
 * 安装包构建包装的课程目录保全（`apps/desktop/scripts/build-installer.mjs`）。
 *
 * 起因是一次真实事故：`electron-builder --win` 整体重建 `dist/win-unpacked`，
 * 而课程目录默认就在 `<exe 目录>/.syllora/`，三门课的资料被一起删掉。这里守住
 * 包装脚本的两条关键行为：**崩溃遗留的暂存必须能合并回去**、**--preserve-only
 * 绝不能搬运现网数据**（早期版本会先搬走再退出，等于自己制造事故）。
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const temp = resolve('tmp', 'build-installer-tests')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** 造一个临时 dist 树：<dist>/win-unpacked 与可选的 stash。 */
function scratch(): string {
  const root = join(temp, `case-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(join(root, 'dist', 'win-unpacked'), { recursive: true })
  roots.push(root)
  return join(root, 'dist')
}

function writeCourse(dir: string, id: string, marker: string) {
  mkdirSync(join(dir, id, '.syllora'), { recursive: true })
  writeFileSync(join(dir, id, '.syllora', 'course.json'), JSON.stringify({ version: 1, marker, courses: [] }), 'utf8')
}

function run(dist: string, args: string[]) {
  return spawnSync(process.execPath, [resolve('apps/desktop/scripts/build-installer.mjs'), ...args], {
    cwd: resolve('.'), encoding: 'utf8', env: { ...process.env, SYLLORA_DESKTOP_DIST: dist },
  })
}

describe('构建包装的课程目录保全', () => {
  it('把上次构建遗留的暂存合并回 unpacked，并清掉已落地的暂存', () => {
    const dist = scratch()
    const stash = join(dist, '.syllora-stash-1700000000000-win')
    writeCourse(join(stash, 'syllora'), 'course-a', 'from-stash')
    writeCourse(join(stash, 'syllora'), 'course-b', 'from-stash')

    const result = run(dist, ['--preserve-only'])
    expect(result.status).toBe(0)
    expect(existsSync(join(dist, 'win-unpacked', '.syllora', 'course-a', '.syllora', 'course.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(dist, 'win-unpacked', '.syllora', 'course-b', '.syllora', 'course.json'), 'utf8')).marker).toBe('from-stash')
    // 已全部落地：暂存目录不残留。
    expect(readdirSync(dist).filter(name => name.startsWith('.syllora-stash-'))).toEqual([])
    expect(result.stdout).toContain('已还原 2 项')
  })

  it('两边都有同一门课时保留 unpacked 里的版本，并留下暂存供人工核对', () => {
    const dist = scratch()
    writeCourse(join(dist, 'win-unpacked', '.syllora'), 'course-a', 'live')
    const stash = join(dist, '.syllora-stash-1700000000000-win')
    writeCourse(join(stash, 'syllora'), 'course-a', 'from-stash')
    writeCourse(join(stash, 'syllora'), 'course-b', 'from-stash')

    const result = run(dist, ['--preserve-only'])
    expect(result.status).toBe(0)
    // 目标里的课程不被旧副本覆盖。
    expect(JSON.parse(readFileSync(join(dist, 'win-unpacked', '.syllora', 'course-a', '.syllora', 'course.json'), 'utf8')).marker).toBe('live')
    // 缺失的 course-b 补上，冲突的暂存保留。
    expect(JSON.parse(readFileSync(join(dist, 'win-unpacked', '.syllora', 'course-b', '.syllora', 'course.json'), 'utf8')).marker).toBe('from-stash')
    expect(existsSync(stash)).toBe(true)
    expect(result.stdout).toContain('目标已有同名的项')
  })

  it('--preserve-only 不搬运正在使用的数据（早期版本会先搬走再退出）', () => {
    const dist = scratch()
    writeCourse(join(dist, 'win-unpacked', '.syllora'), 'course-a', 'live')
    const result = run(dist, ['--preserve-only'])
    expect(result.status).toBe(0)
    expect(existsSync(join(dist, 'win-unpacked', '.syllora', 'course-a', '.syllora', 'course.json'))).toBe(true)
    expect(readdirSync(dist).filter(name => name.startsWith('.syllora-stash-'))).toEqual([])
    expect(result.stdout).toContain('无课程目录需要搬运')
  })
})
