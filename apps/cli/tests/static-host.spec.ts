/**
 * FL-21：静态托管语义——文件命中、SPA 回落 index.html、目录穿越 403、
 * 坏路径 400、tap 注入 bootstrap（token）。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStaticHost, sessionBootstrapPage } from '../src/lib/static-host.ts'

// stat 需要可注入：下面有一条用例要确定性地模拟「读到内容之后文件被并发删除」。
// `{ spy: true }` 让 vitest 用 spy 替换该内置模块的导出，源码模块导入到的是同一个 spy。
vi.mock('node:fs/promises', { spy: true })

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeDist(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'syllora-static-'))
  roots.push(root)
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true }).catch(() => undefined)
    await writeFile(join(root, name), content, 'utf8')
  }
  return root
}

describe('createStaticHost', () => {
  it('dist 缺失时返回 null（宿主保持纯 API 行为）', async () => {
    const host = await createStaticHost({ root: join(await mkdtemp(join(tmpdir(), 'syllora-empty-')), 'nope') })
    expect(host).toBeNull()
  })

  it('命中文件并给出正确 MIME', async () => {
    const root = await makeDist({ 'index.html': '<html><head></head><body>ok</body></html>', 'app.js': 'console.log(1)' })
    const host = (await createStaticHost({ root }))!
    const html = await host.respond('/')
    expect(html?.status).toBe(200)
    expect(html?.contentType).toContain('text/html')
    const js = await host.respond('/app.js')
    expect(js?.contentType).toContain('text/javascript')
  })

  it('SPA 回落：无扩展名路由未命中 → index.html', async () => {
    const root = await makeDist({ 'index.html': '<html><head><title>t</title></head></html>' })
    const host = (await createStaticHost({ root }))!
    const hit = await host.respond('/some/spa/route')
    expect(hit?.status).toBe(200)
    expect(String(hit?.body)).toContain('<title>t</title>')
  })

  it('有扩展名但文件不存在 → null（交回 404）', async () => {
    const root = await makeDist({ 'index.html': 'x' })
    const host = (await createStaticHost({ root }))!
    expect(await host.respond('/missing.png')).toBeNull()
  })

  it('读到 HTML 之后文件被并发删除（缓存用的 stat 失败）不得让 respond 抛异常', async () => {
    // 回归：index.html 的 tap 注入缓存键要读一次 mtime，旧实现直接 await stat，
    // 文件在 readFile 与 stat 之间被删/被重建（Next export 覆盖 dist）时该
    // rejection 会逃逸成未处理的 rejection——宿主进程被 Node 直接终止。
    const root = await makeDist({ 'index.html': '<html><head></head><body>ok</body></html>' })
    const host = (await createStaticHost({ root }))!
    const fs = await import('node:fs/promises')
    const mocked = vi.mocked(fs.stat)
    const real = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).stat
    // 按目标路径注入，而不是按调用次序：对 index.html 的第一次 stat 是「文件是否存在」，
    // 第二次才是 tap 注入缓存键要的 mtime——只让第二次失败。
    let indexStats = 0
    mocked.mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
      const target = String(args[0]).replaceAll('\\', '/').toLowerCase()
      if (target.endsWith('/index.html')) {
        indexStats += 1
        if (indexStats >= 2) throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      }
      return real(...args)
    }) as typeof fs.stat)
    try {
      const hit = await host.respond('/index.html')
      expect(indexStats).toBeGreaterThanOrEqual(2)
      expect(hit?.status).toBe(200)
      expect(String(hit?.body)).toContain('<body>ok</body>')
    } finally {
      mocked.mockReset()
    }
  })

  it('目录穿越 → 403，不解码后再穿越', async () => {
    const root = await makeDist({ 'index.html': 'x' })
    const host = (await createStaticHost({ root }))!
    await writeFile(join(root, 'secret.txt'), 's', 'utf8')
    const outside = root.replace(/[\\/]+$/, '') + '\\..\\..\\..\\Windows\\win.ini'
    for (const path of ['/%2e%2e/%2e%2e/etc/passwd', outside.replaceAll('\\', '/').replace(root, '')]) {
      const hit = await host.respond(path)
      expect(hit === null || hit.status === 403).toBe(true)
    }
  })

  it('FL-30：index.html 注入 bootstrap tap（token）', async () => {
    const root = await makeDist({ 'index.html': '<html><head><meta charset="utf-8"></head><body></body></html>' })
    const host = (await createStaticHost({ root, bootstrap: { token: 'tk-123' } }))!
    const hit = await host.respond('/')
    expect(String(hit?.body)).toContain('window.__SYLLORA__={"token":"tk-123"}')
  })

  it('CR-16：未持会话时交付不含凭据的票据页，持会话才交付真正的 SPA', async () => {
    const root = await makeDist({ 'index.html': '<html><head></head><body>real-spa</body></html>' })
    const nonce = 'abc123'
    const host = (await createStaticHost({
      root,
      bootstrap: { sessionUrl: '/api/session' },
      bootstrapPage: sessionBootstrapPage(nonce),
    }))!
    const ticket = (await host.respond('/'))!
    // 票据页不能含任何访问凭据，也不是真正的 SPA。
    expect(String(ticket.body)).not.toContain('real-spa')
    expect(String(ticket.body)).toContain('/api/session')
    expect(ticket.headers?.['Cache-Control']).toBe('no-store')
    expect(ticket.headers?.['Content-Security-Policy']).toContain(`'nonce-${nonce}'`)
    // SPA 回落同样被拦在票据页之后（深链接未持会话也不下发真页面）。
    expect(String((await host.respond('/deep/route'))?.body)).not.toContain('real-spa')

    const spa = (await host.respond('/', { sessionCookie: 'granted' }))!
    expect(String(spa.body)).toContain('real-spa')
    expect(String(spa.body)).toContain('window.__SYLLORA__={"sessionUrl":"/api/session"}')
    // 静态资源（非 HTML）不受门禁影响。
    const js = await makeDist({ 'index.html': 'x', 'app.js': 'console.log(1)' })
    const jsHost = (await createStaticHost({ root: js, bootstrapPage: sessionBootstrapPage(nonce) }))!
    expect((await jsHost.respond('/app.js'))?.status).toBe(200)
  })

  it('bootstrap 为 null 时不注入', async () => {
    const root = await makeDist({ 'index.html': '<html><head></head></html>' })
    const host = (await createStaticHost({ root, bootstrap: null }))!
    expect(String((await host.respond('/'))?.body)).not.toContain('__SYLLORA__')
  })

  it('C-12：HTML no-cache、hash 资产 immutable、全局 nosniff', async () => {
    const root = await makeDist({
      'index.html': '<html><head></head><body></body></html>',
      '_next/static/chunks/main-1a2b3c4d5e.js': 'console.log(1)',
      'plain.js': 'console.log(2)',
    })
    const host = (await createStaticHost({ root, bootstrap: { token: 'tk' } }))!
    const html = (await host.respond('/'))!
    expect(html.headers?.['Cache-Control']).toBe('no-cache, must-revalidate')
    expect(html.headers?.['X-Content-Type-Options']).toBe('nosniff')
    const hashed = (await host.respond('/_next/static/chunks/main-1a2b3c4d5e.js'))!
    expect(hashed.headers?.['Cache-Control']).toBe('public, max-age=31536000, immutable')
    expect(hashed.headers?.['X-Content-Type-Options']).toBe('nosniff')
    const plain = (await host.respond('/plain.js'))!
    expect(plain.headers?.['Cache-Control']).toBe('public, max-age=3600')
  })
})
