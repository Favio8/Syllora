import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
const { migrateLegacyData, managedDirectory } = createRequire(import.meta.url)('../../desktop/src/local-data.cjs')
const temporary = resolve('..', 'tmp', 'desktop-local-data'), roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) { if (!root.startsWith(temporary)) throw new Error('Unsafe cleanup'); await rm(root, { recursive: true, force: true }) } })
async function root() { await mkdir(temporary, { recursive: true }); const path = await mkdtemp(join(temporary, 'case-')); roots.push(path); return path }
it('migrates the legacy snapshot with managed PDFs, preserving originals and existing targets', async () => {
  const path = await root(), home = join(path, 'host-home'), data = join(path, 'syllora-data')
  await mkdir(join(home, 'syllora', 'files'), { recursive: true })
  await writeFile(join(home, 'syllora', 'syllora.json'), '{"courses":[]}')
  await writeFile(join(home, 'syllora', 'files', 'abcdef.pdf'), 'original')
  expect(migrateLegacyData(home, data)).toBe(true)
  expect(await readFile(join(data, 'files', 'abcdef.pdf'), 'utf8')).toBe('original')
  expect(await readFile(join(home, 'syllora', 'files', 'abcdef.pdf'), 'utf8')).toBe('original')
  await writeFile(join(data, 'syllora.json'), 'new state')
  expect(migrateLegacyData(home, data)).toBe(false)
  expect(await readFile(join(data, 'syllora.json'), 'utf8')).toBe('new state')
})
it('opens only the three managed directories and refuses files, traversal and directory links', async () => {
  const path = await root(), home = join(path, 'host-home'), data = join(path, 'syllora-data')
  await mkdir(join(home, 'logs'), { recursive: true }); await mkdir(data)
  expect(managedDirectory(path, home)).toBe(home)
  expect(managedDirectory(path, data)).toBe(data)
  await writeFile(join(home, 'executable.exe'), 'fixture')
  expect(() => managedDirectory(path, join(home, 'executable.exe'))).toThrow()
  expect(() => managedDirectory(path, join(home, '..'))).toThrow()
  await rm(join(home, 'logs'), { recursive: true }); await symlink(data, join(home, 'logs'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => managedDirectory(path, join(home, 'logs'))).toThrow()
})
