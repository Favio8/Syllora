import { mkdir, realpath, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isLoopbackOrigin } from './http-guards.ts'

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

export interface ReviewMode {
  readonly root: string
  readonly coursesRoot: string
  readonly publicAccess: boolean
  acceptsOrigin(origin: string | undefined): boolean
  cors(request: IncomingMessage, response: ServerResponse): void
  workspace(path: string): Promise<string>
  browse(path: string | null): Promise<{ path: string; parent: string | null; entries: Array<{ name: string; path: string }> }>
}

/** A dedicated Host uses its own home, settings and courses; no caller can select another root. */
export async function prepareReviewMode(env: NodeJS.ProcessEnv = process.env): Promise<ReviewMode | null> {
  if (env.SYLLORA_REVIEW_MODE !== '1') return null
  if (!env.SYLLORA_REVIEW_ROOT?.trim()) throw new Error('SYLLORA_REVIEW_ROOT is required in review mode')
  const requested = resolve(env.SYLLORA_REVIEW_ROOT)
  await mkdir(requested, { recursive: true })
  const root = await realpath(requested)
  for (const [key, name] of [['SYLLORA_HOME', 'home'], ['SYLLORA_DATA_DIR', 'data'], ['SYLLORA_COURSES_DIR', 'courses']] as const) {
    const directory = join(root, name)
    await mkdir(directory, { recursive: true })
    const canonical = await realpath(directory)
    if (!inside(root, canonical) || relative(directory, canonical) !== '') throw new Error('Review data directory escapes or aliases another directory')
    env[key] = canonical
  }
  const coursesRoot = env.SYLLORA_COURSES_DIR!
  const origins = new Set<string>()
  for (const value of (env.SYLLORA_ALLOWED_ORIGINS ?? '').split(',').map(v => v.trim()).filter(Boolean)) {
    const parsed = new URL(value)
    if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' || (parsed.protocol !== 'https:' && !isLoopbackOrigin(value))) {
      throw new Error('Allowed review origins must be exact HTTPS origins or loopback URLs')
    }
    origins.add(parsed.origin)
  }
  const workspace = async (path: string): Promise<string> => {
    const canonical = await realpath(resolve(path))
    if (!inside(coursesRoot, canonical)) throw new Error('评审环境只能访问评审课程目录')
    return canonical
  }
  return {
    root, coursesRoot, workspace, publicAccess: env.SYLLORA_REVIEW_PUBLIC === '1',
    acceptsOrigin: origin => isLoopbackOrigin(origin) || (origin !== undefined && origins.has(origin)),
    cors(request, response) {
      response.setHeader('Cache-Control', 'private, no-store')
      response.setHeader('Vary', 'Origin')
      response.setHeader('Referrer-Policy', 'no-referrer')
      response.setHeader('X-Content-Type-Options', 'nosniff')
      const origin = request.headers.origin
      if (origin && (isLoopbackOrigin(origin) || origins.has(origin))) {
        response.setHeader('Access-Control-Allow-Origin', origin)
        response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS')
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, x-syllora-token, x-material-filename, ngrok-skip-browser-warning')
        response.setHeader('Access-Control-Max-Age', '300')
      }
    },
    async browse(path) {
      const canonical = await workspace(path?.trim() ? (isAbsolute(path) ? path : resolve(coursesRoot, path)) : coursesRoot)
      const entries: Array<{ name: string; path: string }> = []
      for (const entry of await readdir(canonical, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        try {
          const target = await workspace(join(canonical, entry.name))
          if ((await stat(target)).isDirectory()) entries.push({ name: entry.name, path: target })
        } catch { /* Hide escaping or dangling links. */ }
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      return { path: canonical, parent: canonical === coursesRoot ? null : resolve(canonical, '..'), entries }
    },
  }
}
