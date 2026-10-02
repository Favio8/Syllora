/**
 * FL-21：SPA 静态托管（`syllora serve` 自带 Web UI，与 dsh
 * `host/frontend-static` 同语义）：防目录穿越、未命中回落 index.html（SPA
 * 路由）、MIME 映射、index tap 注入启动参数（FL-30：token 由这里注入
 * `window.__SYLLORA__`，同源页面无需跨域读取）。dist 根不存在时返回 null，
 * 宿主保持旧行为（纯 API 404）。
 * @module @syllora/cli/lib/static-host
 */

import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

export interface StaticHostOptions {
  /** Static dist root（apps/web 的 export 产物目录）。 */
  root: string
  /** 注入 `window.__SYLLORA__` 的启动参数；null 不注入。 */
  bootstrap?: Record<string, unknown> | null
  /** CR-16：未携带会话 Cookie 时回退交付的票据页；null 表示不做事先换票。 */
  bootstrapPage?: string | null
}

export interface StaticHit {
  status: number
  body: Buffer | string
  contentType: string
  /** C-12：附加响应头（缓存策略 / 安全头）。 */
  headers?: Record<string, string>
}

export interface StaticHost {
  /** 处理一个 GET/HEAD 路径；返回 null 表示交回调用方的默认 404。
   *  `handoff.sessionCookie` 非空表示请求已持有会话凭据（CR-16），此时交付
   *  真正的 SPA 而不是票据页。 */
  respond(pathname: string, handoff?: { sessionCookie?: string }): Promise<StaticHit | null>
}

/** 从票据页里取回注入的 CSP nonce（页面由本模块生成，字符集可控）。 */
function nonceOf(page: string): string {
  return /<script nonce="([0-9a-f]+)">/.exec(page)?.[1] ?? ''
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

function contentTypeOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot >= 0 ? MIME[path.slice(dot).toLowerCase()] ?? 'application/octet-stream' : 'application/octet-stream'
}

/** 注入启动参数：紧跟 `<head>` 之后（旧导出没有 `<head>` 时整体前置）。注意
 *  CR-16 之后这里只放非凭据参数（发现文件桥）。访问 token 绝不再进 HTML，
 *  宿主的 token 门禁与 /api/session 的换票链路见 bin.ts。 */
function withBootstrapTap(html: string, bootstrap: Record<string, unknown> | null): string {
  if (bootstrap === null) return html
  const json = JSON.stringify(bootstrap).replace(/</g, '\\u003c')
  const tap = `<script>window.__SYLLORA__=${json}</script>`
  const headIndex = html.indexOf('<head>')
  return headIndex >= 0
    ? html.slice(0, headIndex + 6) + tap + html.slice(headIndex + 6)
    : tap + html
}

/**
 * CR-16：会话票据页。HTML 里绝不内嵌访问 token——页面脚本把本地发现文件
 * (host.json) 里的 token 作为头部字段提交给 `/api/session`，换取 HttpOnly
 * 会话 Cookie，之后由 Cookie 授权 `/api/*`。未持凭据的本机进程 `curl /`
 * 只能拿到一个不含任何凭据的表单页。
 * `nonce` 用于脚本 CSP 白名单（调用方保证只含随机十六进制字符）。
 */
export function sessionBootstrapPage(nonce: string): string {
  const script = [
    'const run=async()=>{',
    "  let token='';",
    '  try{',
    '    const b=globalThis.__SYLLORA_BOOTSTRAP__;',
    "    if(b&&typeof b.token==='string')token=b.token;",
    "    else if(b&&typeof b.hostConfigUrl==='string'){",
    "      const cfg=await fetch(b.hostConfigUrl,{cache:'no-store'});",
    '      const parsed=await cfg.json();',
    "      if(parsed&&typeof parsed.token==='string')token=parsed.token;",
    '    }',
    '  }catch{}',
    '  if(token){',
    "    try{await fetch('/api/session',{method:'POST',headers:{'x-syllora-token':token}})}catch{}",
    '  }',
    "  location.replace('/');",
    '};',
    'void run();',
  ].join('\n')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Syllora</title></head><body><p>正在建立本机会话…</p><script nonce="${nonce}">${script}</script><noscript><p>请在本地发现文件中取 token，并以 <code>Authorization: Bearer &lt;token&gt;</code> 调用接口。</p></noscript></body></html>`
}

/** `/api/session` 的发现文件桥（仅回环请求可达，用于本机浏览器/桌面壳握手）。 */
export function sessionHandshakeBootstrap(hostConfigUrl: string): Record<string, unknown> {
  return { hostConfigUrl }
}

export async function createStaticHost(options: StaticHostOptions): Promise<StaticHost | null> {
  const root = resolve(options.root)
  if ((await stat(root).catch(() => null))?.isDirectory() !== true) return null
  const indexCache = new Map<string, string>()

  return {
    async respond(pathname: string, handoff: { sessionCookie?: string } = {}): Promise<StaticHit | null> {
      // 只接受安全路径：解码后必须仍然落在 dist 根内（防穿越，403 语义）。
      let decoded: string
      try {
        decoded = decodeURIComponent(pathname)
      } catch {
        return { status: 400, body: JSON.stringify({ error: { code: 'bad-request', message: 'malformed path', details: null } }), contentType: MIME['.json']! }
      }
      if (decoded.includes('\0')) return { status: 400, body: JSON.stringify({ error: { code: 'bad-request', message: 'malformed path', details: null } }), contentType: MIME['.json']! }
      const candidate = resolve(root, `.${decoded.replaceAll('\\', '/')}`)
      if (candidate !== root && !candidate.startsWith(root + sep)) {
        return { status: 403, body: JSON.stringify({ error: { code: 'forbidden', message: 'path traversal is not allowed', details: null } }), contentType: MIME['.json']! }
      }
      let filePath = candidate
      const info = await stat(filePath).catch(() => null)
      if (info === null || info.isDirectory()) {
        // SPA 回落：无扩展名的路由未命中 → index.html。
        if (info === null && /\.[A-Za-z0-9]+$/.test(decoded)) return null
        filePath = join(root, 'index.html')
        const indexInfo = await stat(filePath).catch(() => null)
        if (indexInfo === null || !indexInfo.isFile()) return null
      }
      const file = await readFile(filePath).catch(() => null)
      if (file === null) return null
      // CR-16：没有会话 Cookie 的首次请求交付票据页——页面从发现文件桥取
      // token、换成 HttpOnly 会话 Cookie 后再 location.replace('/') 回到真正的
      // SPA。HTML 本身不含任何凭据，本机 curl 拿不到可用 token。
      const isHtml = filePath.toLowerCase().endsWith('.html')
      if (isHtml && options.bootstrapPage != null && (handoff.sessionCookie ?? '') === '') {
        return {
          status: 200,
          body: options.bootstrapPage,
          contentType: MIME['.html']!,
          headers: {
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; script-src 'nonce-" + nonceOf(options.bootstrapPage) + "'; connect-src 'self'; style-src 'unsafe-inline'",
          },
        }
      }
      let body: Buffer | string = file
      if (isHtml) {
        // index.html 按 (root, mtime) 缓存 tap 注入结果，避免每请求重读重注入。
        const cacheKey = `${filePath}:${(await stat(filePath)).mtimeMs}`
        let injected = indexCache.get(cacheKey)
        if (injected === undefined) {
          injected = withBootstrapTap(file.toString('utf8'), options.bootstrap ?? null)
          if (indexCache.size > 8) indexCache.clear()
          indexCache.set(cacheKey, injected)
        }
        body = injected
      }
      // C-12：缓存与安全响应头——旧实现完全缺失：① HTML 不缓存（tap 注入的
      // token 每次启动都可能变，缓存会让旧 token 复用）；② 带 hash 的静态资产
      // 长缓存（Next export 的 chunk 名含内容 hash，内容变则名变）；③ 全局禁
      // MIME 嗅探（.svg 等内联场景的纵深防御）。
      const headers: Record<string, string> = { 'X-Content-Type-Options': 'nosniff' }
      if (filePath.toLowerCase().endsWith('.html')) {
        headers['Cache-Control'] = 'no-cache, must-revalidate'
      } else if (/-[0-9a-zA-Z_-]{8,}\.(?:js|css|woff2?)$/.test(filePath)) {
        headers['Cache-Control'] = 'public, max-age=31536000, immutable'
      } else {
        headers['Cache-Control'] = 'public, max-age=3600'
      }
      return { status: 200, body, contentType: contentTypeOf(filePath), headers }
    },
  }
}
