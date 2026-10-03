import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareReviewMode } from '../src/lib/review-mode.ts'

const roots: string[] = []
async function root() { const value = await mkdtemp(join(tmpdir(), 'syllora-review-test-')); roots.push(value); return value }
afterEach(async () => { for (const value of roots.splice(0)) await rm(value, { recursive: true, force: true }) })
describe('review filesystem and origin boundaries', () => {
  it('preserves ordinary startup and requires an explicit isolated root', async () => {
    expect(await prepareReviewMode({})).toBeNull()
    expect(await prepareReviewMode({ SYLLORA_REVIEW_PUBLIC: '1' })).toBeNull()
    await expect(prepareReviewMode({ SYLLORA_REVIEW_MODE: '1' })).rejects.toThrow('ROOT')
  })
  it('isolates settings and courses and accepts only exact production or local origins', async () => {
    const value = await root()
    const env = { SYLLORA_REVIEW_MODE: '1', SYLLORA_REVIEW_ROOT: value, SYLLORA_ALLOWED_ORIGINS: 'https://syllora.vercel.app', SYLLORA_DATA_DIR: 'outside' }
    const review = (await prepareReviewMode(env))!
    expect(review.publicAccess).toBe(false)
    expect(env.SYLLORA_DATA_DIR).toBe(join(value, 'data'))
    expect(review.acceptsOrigin('https://syllora.vercel.app')).toBe(true)
    expect(review.acceptsOrigin('https://preview-syllora.vercel.app')).toBe(false)
    expect(review.acceptsOrigin('https://syllora.vercel.app.attacker.test')).toBe(false)
    expect(review.acceptsOrigin('http://localhost:3000')).toBe(true)
    expect(review.acceptsOrigin('null')).toBe(false)
    await expect(review.workspace(join(value, 'data'))).rejects.toThrow('课程目录')
    await expect(review.browse('..')).rejects.toThrow('课程目录')
  })
  it('opens public access only with an explicit review flag', async () => {
    const value = await root()
    expect((await prepareReviewMode({ SYLLORA_REVIEW_MODE: '1', SYLLORA_REVIEW_ROOT: value, SYLLORA_REVIEW_PUBLIC: 'true' }))!.publicAccess).toBe(false)
    expect((await prepareReviewMode({ SYLLORA_REVIEW_MODE: '1', SYLLORA_REVIEW_ROOT: value, SYLLORA_REVIEW_PUBLIC: '1' }))!.publicAccess).toBe(true)
  })
  it('hides outside junctions, files and dangling links while allowing course directories', async () => {
    const value = await root()
    const outside = await root()
    const review = (await prepareReviewMode({ SYLLORA_REVIEW_MODE: '1', SYLLORA_REVIEW_ROOT: value }))!
    await mkdir(join(review.coursesRoot, 'allowed'))
    await writeFile(join(review.coursesRoot, 'plain.txt'), 'sample')
    await symlink(outside, join(review.coursesRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(review.workspace(join(review.coursesRoot, 'escape'))).rejects.toThrow('课程目录')
    const listing = await review.browse(null)
    expect(listing.parent).toBeNull()
    expect(listing.entries.map(v => v.name)).toEqual(['allowed'])
  })
  it('rejects aliased credential and course roots', async () => {
    const value = await root()
    await mkdir(join(value, 'data'))
    await symlink(join(value, 'data'), join(value, 'courses'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(prepareReviewMode({ SYLLORA_REVIEW_MODE: '1', SYLLORA_REVIEW_ROOT: value })).rejects.toThrow('aliases')
  })
})
