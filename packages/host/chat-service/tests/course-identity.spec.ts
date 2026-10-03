/**
 * B1：chat/agent 端点的课程身份解析。历史契约是「课程文件夹名」，两门不同
 * 路径、同名文件夹的课程会共用同一个 chat 课程（会话与消息互相串入）。本套
 * 断言 UUID 解析、同名文件夹互不串入、以及旧 basename 客户端的兼容读取。
 *
 * 本地适配：本地 `resolveCourseDir` 额外拒绝含 `..`、以 `.` 开头的 id，
 * 命中 UUID 时大小写归一，其余回落 basename 相等判定（见 src/course.ts）。
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { CourseNotFoundError, createCourseService, resolveCourseDir } from '../src/course.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

/** 造一个课程目录：可选地写入 .syllora/course.json（含课程 UUID）。 */
async function courseFixture(name: string, courseId: string | null): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'syllora-course-'))
  roots.push(root)
  const dir = join(root, name)
  await mkdir(join(dir, '.syllora'), { recursive: true })
  if (courseId !== null) {
    await writeFile(
      join(dir, '.syllora', 'course.json'),
      JSON.stringify({ version: 1, courses: [{ id: courseId, name }], jobs: [], calls: 0, consent: false }),
      'utf8',
    )
  }
  return dir
}

describe('resolveCourseDir', () => {
  it('resolves a course by its UUID', async () => {
    const id = randomUUID()
    const dir = await courseFixture('高数', id)
    expect(await resolveCourseDir(dir, id)).toBe(dir)
    // 大小写不敏感（UUID 由多个入口产生，平台亦有大小写差异）。
    expect(await resolveCourseDir(dir, id.toUpperCase())).toBe(dir)
  })

  it('keeps two same-named folders in separate courses', async () => {
    const idA = randomUUID()
    const idB = randomUUID()
    const dirA = await courseFixture('高数', idA)
    const dirB = await courseFixture('高数', idB)

    expect(await resolveCourseDir(dirA, idA)).toBe(dirA)
    expect(await resolveCourseDir(dirB, idB)).toBe(dirB)
    // 交叉解析必须失败：不再因为文件夹同名而互相命中。
    expect(await resolveCourseDir(dirA, idB)).toBeNull()
    expect(await resolveCourseDir(dirB, idA)).toBeNull()
  })

  it('still accepts the legacy basename client for the same folder', async () => {
    const id = randomUUID()
    const dir = await courseFixture('代数', id)
    expect(await resolveCourseDir(dir, '代数')).toBe(dir)
  })

  it('rejects traversal, separators, hidden ids and unknown names', async () => {
    const dir = await courseFixture('代数', randomUUID())
    for (const bad of ['', '  ', '..', '../代数', 'a/b', 'a\\b', '.hidden', '别课']) {
      expect(await resolveCourseDir(dir, bad)).toBeNull()
    }
  })

  it('resolves without a course.json only by basename (pre-migration courses)', async () => {
    const dir = await courseFixture('新课程', null)
    expect(await resolveCourseDir(dir, randomUUID())).toBeNull()
    expect(await resolveCourseDir(dir, '新课程')).toBe(dir)
  })

  it('returns null for a missing workspace root', async () => {
    expect(await resolveCourseDir(join(tmpdir(), `missing-${randomUUID()}`), '代数')).toBeNull()
  })
})

/** 无法解析的 id 必须以 CourseNotFoundError 收口（courseDirOf 的对外表现）。 */
describe('CourseNotFoundError', () => {
  it('rejects unknown ids through the course service surface', async () => {
    const id = randomUUID()
    const dir = await courseFixture('代数', id)
    const service = createCourseService(async () => null)
    for (const bad of [randomUUID(), '../代数', '别课']) {
      await expect(service.syllabus(dir, bad)).rejects.toBeInstanceOf(CourseNotFoundError)
    }
    // 正对照：正确 id 仍可命中，证明上面的拒绝来自身份解析而非服务不可用。
    await expect(service.syllabus(dir, id)).resolves.toMatchObject({ version: '1.0.0' })
  })
})
