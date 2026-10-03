/**
 * serve 主循环集成覆盖（历史缺口：bin.ts 的 HTTP 边界此前只有单测，无任何
 * 集成用例触达）。以子进程起真实 serve（tsx 源码形态，--port 0 随机端口，
 * 临时 SYLLORA_HOME + SYLLORA_WEB_DIST），断言：
 *   1. /api/health 免 token 可达；
 *   2. RPC 无 token / 错 token → 401，正确 token → 200（门禁顺序）；
 *   3. 恶意 Origin → 403（先于 token 判定）；
 *   4. GET /api/* → 405（方法守卫）；
 *   5. 静态托管：/ 交付票据页（CR-16：页面不含凭据）、无扩展名路由 SPA
 *      回落、编码穿越不泄漏；
 *   5b. 编码穿越（裸 socket 版）：直发未经客户端归一化的路径，验证服务端自身；
 *   6. 上传路由边界：无工作区 → 409（先于 busboy 解析）；
 *   7. C-1 回归：优雅关停（SIGINT）后 host.json 与 host.lock 真正删除；
 *   8. 实例锁自愈：同一 home 下强杀残留 lock 后重启可抢回。
 *
 * 平台注意（POSIX）：tsx CLI 与它拉起的 bin.ts 是两个进程，`child.kill()`
 * 只打到 wrapper 上。因此 POSIX 下 spawn 用 `detached` 让 serve 自成进程组，
 * 信号按组发（`process.kill(-pid, sig)`），保证真正跑 serve 的进程收到；
 * Windows 无进程组语义，`child.kill()` 即强杀且实测会带走监听（无孤儿）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fixturePdf } from "../../../scripts/syllora-fixture.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const baseTsconfig = resolve(repoRoot, "tsconfig.base.json");
const binTs = join(repoRoot, "apps", "cli", "src", "bin.ts");

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const isWin = process.platform === "win32";

interface HostHandle {
  child: ChildProcess;
  home: string;
  dist: string;
  port: number;
  token: string;
  /** 真正跑 serve 的进程 pid（host.json 记录的是 bin.ts 的 pid）。 */
  pid: number;
}

const homes: string[] = [];

async function startHost(reuseHome?: string): Promise<HostHandle> {
  const home = reuseHome ?? mkdtempSync(join(tmpdir(), "syllora-serve-it-"));
  if (reuseHome === undefined) homes.push(home);
  const dist = join(home, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<html><head><meta charset=\"utf-8\"></head><body>sc-ui</body></html>", "utf8");
  writeFileSync(join(dist, "app.js"), "console.log('sc')\n", "utf8");
  // 穿越金丝雀：放在 dist 的上一级。静态托管的根包含校验一旦被移除，
  // `/..%2fcanary-secret.txt` 这类路径就能把它读出来——断言它永不被下发，
  // 比只断言状态码更能抓住回归。
  writeFileSync(join(home, "canary-secret.txt"), "CANARY-SECRET-DO-NOT-SERVE", "utf8");
  // 复用同一 home（实例锁自愈用例）时，上一实例强杀残留的 host.json 会让就绪
  // 轮询立刻读到陈旧端口/token——先删掉，只认新实例写的那份。
  rmSync(join(home, "host.json"), { force: true });
  const child = spawn(process.execPath, [tsxCli, "--tsconfig", baseTsconfig, binTs, "serve", "--port", "0"], {
    env: { ...process.env, SYLLORA_HOME: home, SYLLORA_WEB_DIST: dist },
    stdio: ["ignore", "pipe", "pipe"],
    // POSIX：serve 自成进程组，后续才能整组收信号（见文件头说明）。
    ...(isWin ? {} : { detached: true }),
  });
  let stderr = "";
  child.stderr?.on("data", d => { stderr += d });
  const hostJsonPath = join(home, "host.json");
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (existsSync(hostJsonPath)) {
      try {
        // host.json 由 writeFile 非原子写入——全量负载下轮询可能读到写了一半的
        // 文件，解析失败时下一轮再试（端口/token 就绪前不返回）。
        const cfg = JSON.parse(readFileSync(hostJsonPath, "utf8")) as { port?: number; token?: string | null; pid?: number };
        if (typeof cfg.port === "number" && typeof cfg.token === "string" && typeof cfg.pid === "number") {
          return { child, home, dist, port: cfg.port, token: cfg.token, pid: cfg.pid };
        }
      } catch {
        // 半写状态：继续轮询。
      }
    }
    await sleep(150);
  }
  child.kill();
  throw new Error(`serve 未在 40s 内就绪。stderr: ${stderr.slice(-800)}`);
}

/** 强杀整棵 serve 进程树（不留清理机会）：POSIX 杀进程组，Windows 杀 wrapper。 */
function killHard(h: HostHandle): void {
  if (isWin) {
    h.child.kill();
    return;
  }
  try {
    process.kill(-h.child.pid, "SIGKILL");
  } catch {
    h.child.kill("SIGKILL");
  }
}

/** 优雅信号：POSIX 直发真正跑 serve 的进程（host.json 的 pid），Windows 直接强杀。
 *  不依赖 tsx wrapper 的信号中继——wrapper 自己收到 SIGINT 会先退，内层的清理
 *  时序不该押在 wrapper 的存活上；组信号只作内层已消失时的兜底。 */
function signalGracefully(h: HostHandle, signal: "SIGINT" | "SIGTERM"): void {
  if (isWin) {
    h.child.kill();
    return;
  }
  try {
    process.kill(h.pid, signal);
    return;
  } catch {
    // 内层已退或不可信号：退回进程组。
  }
  try {
    process.kill(-h.child.pid, signal);
  } catch {
    h.child.kill(signal);
  }
}

function stop(h: HostHandle | undefined): void {
  if (h === undefined) return;
  if (h.child.exitCode === null && h.child.signalCode === null) killHard(h);
}

async function waitForExit(child: ChildProcess, timeoutMs = 20_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", done);
      reject(new Error(`子进程 ${child.pid} 未在 ${timeoutMs}ms 内退出`));
    }, timeoutMs);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", done);
  });
}

/**
 * 裸 socket 发一个未经 WHATWG URL 归一化的请求。fetch/undici 的 URL 解析器会把
 * `%2e%2e` 当 double-dot 段归一化掉（请求根本到不了服务端），只有裸 socket 才能
 * 验证服务端自己对编码点号的处理。
 */
async function rawGet(target: string): Promise<{ status: number; body: string }> {
  const sock = net.connect(host!.port, "127.0.0.1");
  return new Promise((resolvePromise, rejectPromise) => {
    let raw = "";
    sock.setTimeout(8_000, () => {
      sock.destroy();
      rejectPromise(new Error(`raw request timed out: ${target}`));
    });
    sock.on("data", chunk => { raw += chunk.toString("utf8"); });
    sock.on("error", rejectPromise);
    sock.on("close", () => {
      const status = Number(/^HTTP\/1\.\d (\d+)/.exec(raw)?.[1] ?? 0);
      const split = raw.indexOf("\r\n\r\n");
      resolvePromise({ status, body: split < 0 ? "" : raw.slice(split + 4) });
    });
    sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${host!.port}\r\nConnection: close\r\n\r\n`);
  });
}

/** 轮询等文件消失（优雅关停的清理可能在 wrapper 退出之后才落盘）。 */
async function waitForGone(path: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(path)) return true;
    await sleep(100);
  }
  return false;
}

/** 读锁里的 pid；锁同样非原子写入，半写状态重试几次。 */
async function readLockPid(home: string): Promise<number> {
  for (let i = 0; i < 20; i += 1) {
    try {
      const raw = JSON.parse(readFileSync(join(home, "host.lock"), "utf8")) as { pid?: number };
      if (typeof raw.pid === "number" && raw.pid > 0) return raw.pid;
    } catch {
      // 半写状态：稍等再试。
    }
    await sleep(100);
  }
  return 0;
}

let host: HostHandle | undefined;

beforeAll(async () => {
  host = await startHost();
}, 60_000);

afterAll(() => {
  stop(host);
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const base = (): string => `http://127.0.0.1:${host!.port}`;
const auth = (token: string | null = host!.token): Record<string, string> => ({
  "content-type": "application/json",
  ...(token === null ? {} : { authorization: `Bearer ${token}` }),
});

describe("serve HTTP 边界（集成）", () => {
  it('requires authentication for diagnostics and returns only a bounded log tail', async () => {
    const logs=join(host!.home,'logs'), name='host-9999-12-31.log'
    mkdirSync(logs,{recursive:true});writeFileSync(join(logs,name),'prefix-removed\n'+'x'.repeat(300*1024)+'\nrecent-log-tail')
    const denied=await fetch(`${base()}/api/diagnostics.logs`,{method:'POST',headers:auth(null),body:JSON.stringify({payload:{}})})
    expect(denied.status).toBe(401)
    const response=await fetch(`${base()}/api/diagnostics.logs`,{method:'POST',headers:auth(),body:JSON.stringify({payload:{}})})
    const body=await response.json() as any
    expect(response.status).toBe(200);expect(body.result.files.length).toBeLessThanOrEqual(7)
    const file=body.result.files.find((f:{name:string})=>f.name===name)
    expect(file.truncated).toBe(true);expect(file.text.endsWith('recent-log-tail')).toBe(true)
    expect(file.text).not.toContain('prefix-removed');expect(Buffer.byteLength(file.text)).toBeLessThan(257*1024)
  })
  it('previews initialized PDF originals with authentication, ownership and version checks',async()=>{
    const previewHost=await startHost(),previewBase=()=>`http://127.0.0.1:${previewHost.port}`,previewAuth=()=>({authorization:`Bearer ${previewHost.token}`,'content-type':'application/json'})
    const mock=createServer((request,response)=>{
      let raw='';request.on('data',part=>raw+=String(part));request.on('end',()=>{
        try {
          const last=JSON.parse(raw).messages.at(-1).content,text=typeof last==='string'?last:last.map((p:{text?:string})=>p.text??'').join('')
          const sources=JSON.parse(text.slice(text.indexOf('所选资料：\n')+'所选资料：\n'.length)) as Array<{id:string;text:string}>
          const output={chapter:'PDF fixture',intro:{text:'Local test fixture.',sourceIds:sources.map(s=>s.id)},concepts:[{name:'Original PDF',text:'Local test fixture.',quote:sources[0]!.text.trim().slice(0,20),sourceIds:[sources[0]!.id]}],examples:[],connections:[],analogies:[]}
          response.writeHead(200,{'Content-Type':'text/event-stream'});response.end(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta:{content:JSON.stringify(output)},finish_reason:null}]})}\n\ndata: [DONE]\n\n`)
        } catch {response.writeHead(500);response.end('fixture failed')}
      })
    })
    await new Promise<void>(r=>mock.listen(0,'127.0.0.1',r))
    const rpc=async(method:string,payload:unknown)=>{
      const response=await fetch(`${previewBase()}/api/${method}`,{method:'POST',headers:previewAuth(),body:JSON.stringify({payload}),signal:AbortSignal.timeout(20000)})
      const body=await response.json() as any;expect(body.error).toBeUndefined();return body.result
    }
    try {
      const port=(mock.address() as {port:number}).port
      await rpc('settings.saveProvider',{id:'preview-fixture',name:'Local preview fixture',model:'fixture',baseUrl:`http://127.0.0.1:${port}/v1`})
      await rpc('settings.setCredential',{providerId:'preview-fixture',apiKey:'fixture-only'})
      await rpc('settings.activateProvider',{providerId:'preview-fixture'})
      await rpc('syllora/preferences',{consent:true})
      const folder=join(previewHost.home,'preview-course');mkdirSync(folder)
      const course=await rpc('syllora/openCourse',{path:folder}),courseId=course.id
      const bytes=fixturePdf(['Original PDF preview integration.'])
      const uploaded=await rpc('syllora/import',{courseId,name:'讲义.pdf',base64:bytes.toString('base64')})
      const started=await rpc('syllora/initialize',{courseId,requestId:randomUUID(),paths:[uploaded.path]})
      let state:any
      for(let i=0;i<200;i++){state=await rpc('syllora/state',{});if(state.jobs.find((j:any)=>j.id===started.jobId)?.state!=='running')break;await sleep(50)}
      expect(state.jobs.find((j:any)=>j.id===started.jobId).state).toBe('succeeded')
      const material=state.courses.find((c:any)=>c.id===courseId).materials[0],url=`${previewBase()}${material.previewUrl}`
      expect((await fetch(url)).status).toBe(401)
      const response=await fetch(url,{headers:previewAuth()});expect(response.status).toBe(200);expect(response.headers.get('Content-Type')).toBe('application/pdf');expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
      const head=await fetch(url,{method:'HEAD',headers:previewAuth()});expect(head.status).toBe(200);expect((await head.arrayBuffer()).byteLength).toBe(0)
      expect((await fetch(url.replace(material.id,randomUUID()),{headers:previewAuth()})).status).toBe(404)
      expect((await fetch(`${previewBase()}/api/syllora/material-file?courseId=%25&materialId=${material.id}`,{headers:previewAuth()})).status).toBe(400)
      expect((await fetch(url,{headers:{...previewAuth(),Origin:'https://evil.example'}})).status).toBe(403)
      writeFileSync(join(folder,uploaded.path),fixturePdf(['Changed PDF.']))
      expect((await fetch(url,{headers:previewAuth()})).status).toBe(409)
      await rpc('syllora/deleteMaterial',{courseId,materialId:material.id,confirmed:true})
      expect((await fetch(url,{headers:previewAuth()})).status).toBe(404);expect(existsSync(join(folder,uploaded.path))).toBe(true)
    } finally {stop(previewHost);await new Promise<void>((resolve,reject)=>mock.close(e=>e?reject(e):resolve()))}
  },30000)
  it("courses.* 按 courseId 解析课程根，而不是 lastOpenedPath", async () => {
    // 回归：`syllora/openCourse` 会把 lastOpenedPath 设成刚打开的那门课
    // （bin.ts registerProject），而工作台切课只改前端 state、不再 openCourse。
    // 若 courses.* 用 lastOpenedPath 当课程根，courseDirOf 的
    // `courseId === basename(workspaceRoot)` 等值校验就会让另一门课的每个请求
    // 都失败——表现为面板进度/掌握度报错、@ 引用资料为空、/sync /build 失败。
    const coursesHost = await startHost();
    const coursesRpc = async (method: string, payload: unknown): Promise<any> => {
      const response = await fetch(`http://127.0.0.1:${coursesHost.port}/api/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${coursesHost.token}`, "content-type": "application/json" },
        body: JSON.stringify({ payload }),
        signal: AbortSignal.timeout(20_000),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    try {
      const first = join(coursesHost.home, "course-alpha");
      const second = join(coursesHost.home, "course-beta");
      mkdirSync(first);
      mkdirSync(second);
      const alpha = (await coursesRpc("syllora/openCourse", { path: first })).body.result;
      const beta = (await coursesRpc("syllora/openCourse", { path: second })).body.result;
      expect(alpha.id).not.toBe(beta.id);
      // 打开第二门课后 lastOpenedPath 已指向它；此时两门课都要能用。
      const alphaId = basename(first);
      const betaId = basename(second);
      expect(alphaId).not.toBe(betaId);
      // 打开第二门课后 lastOpenedPath 已指向它；此时第一门课的每个课程作用域端点
      // 都必须仍按自己的文件夹名解析课程根，而不是落到 beta 上。
      for (const method of ["courses.progress", "courses.mastery", "courses.files", "courses.syllabus"]) {
        const result = await coursesRpc(method, { courseId: alphaId });
        expect(result.body.error?.message ?? "", `${method} 不该失败`).toBe("");
        expect(result.status, `${method} 应返回 200`).toBe(200);
      }
      // 第二门课本身也要能用（口径对称，避免只修一侧）
      const betaProgress = await coursesRpc("courses.progress", { courseId: betaId });
      expect(betaProgress.body.error?.message ?? "").toBe("");
      expect(betaProgress.status).toBe(200);
      // ensure 是 AgentChat 的骨架自愈路径（api.ensureCourse → courses.ensure），
      // 切课后不能静默失效
      const ensured = await coursesRpc("courses.ensure", { courseId: alphaId });
      expect(ensured.body.error?.message ?? "").toBe("");
      expect(ensured.body.result).toEqual({ ensured: true });
    } finally { stop(coursesHost); }
  }, 60_000);

  it("health 免 token 可达", async () => {
    const res = await fetch(`${base()}/api/health`, { signal: AbortSignal.timeout(8_000) });
    expect(res.status).toBe(200);
  }, 15_000);

  it("RPC 无 token / 错 token → 401，正确 token → 200", async () => {
    const none = await fetch(`${base()}/api/workspaces.list`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(8_000) });
    expect(none.status).toBe(401);
    const wrong = await fetch(`${base()}/api/workspaces.list`, { method: "POST", headers: auth("wrong-token"), body: "{}", signal: AbortSignal.timeout(8_000) });
    expect(wrong.status).toBe(401);
    const ok = await fetch(`${base()}/api/workspaces.list`, { method: "POST", headers: auth(), body: "{}", signal: AbortSignal.timeout(8_000) });
    expect(ok.status).toBe(200);
  }, 15_000);

  it("恶意 Origin → 403（先于 token 判定）", async () => {
    const res = await fetch(`${base()}/api/workspaces.list`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: "{}",
      signal: AbortSignal.timeout(8_000),
    });
    expect(res.status).toBe(403);
  }, 15_000);

  it("GET /api/* → 405（方法守卫）", async () => {
    const res = await fetch(`${base()}/api/workspaces.list`, { headers: auth(), signal: AbortSignal.timeout(8_000) });
    expect(res.status).toBe(405);
  }, 15_000);

  it("CR-16：静态页面不再内嵌访问 token（本机进程 curl / 拿不到凭据）", async () => {
    const page = await fetch(`${base()}/`, { signal: AbortSignal.timeout(8_000) });
    expect(page.status).toBe(200);
    const html = await page.text();
    // 票据页：不含任何凭据（旧实现把 token 注入 window.__SYLLORA__，任意本机
    // 进程 curl / 即可提取 token 并调用全部 /api/*）。
    expect(html).not.toContain(host!.token);
    expect(html).toContain("/api/session");
    expect(page.headers.get("cache-control")).toBe("no-store");

    // 换票端点要求持有 token：无凭据 → 401，正确凭据 → 下发 HttpOnly 会话 Cookie。
    const denied = await fetch(`${base()}/api/session`, { method: "POST", signal: AbortSignal.timeout(8_000) });
    expect(denied.status).toBe(401);
    const granted = await fetch(`${base()}/api/session`, {
      method: "POST",
      headers: { "x-syllora-token": host!.token },
      signal: AbortSignal.timeout(8_000),
    });
    expect(granted.status).toBe(200);
    const cookie = granted.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("syllora_session=");
    expect(cookie).toContain("HttpOnly");

    // 持会话 Cookie 可取真正的 SPA。
    const session = cookie.split(";")[0]!;
    const spa = await fetch(`${base()}/`, { headers: { cookie: session }, signal: AbortSignal.timeout(8_000) });
    expect(await spa.text()).toContain("sc-ui");

    // 会话 Cookie 同样能授权 /api/*。
    const api = await fetch(`${base()}/api/workspaces.list`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session },
      body: "{}",
      signal: AbortSignal.timeout(8_000),
    });
    expect(api.status).toBe(200);

    // 伪造 Cookie 不放行。
    const forged = await fetch(`${base()}/api/workspaces.list`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "syllora_session=deadbeef" },
      body: "{}",
      signal: AbortSignal.timeout(8_000),
    });
    expect(forged.status).toBe(401);

    const js = await fetch(`${base()}/app.js`, { signal: AbortSignal.timeout(8_000) });
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
  }, 15_000);

  it("失效的会话 Cookie 回落到票据页（宿主重启换密钥后自愈）", async () => {
    // Cookie 不区分端口：宿主重启换了会话密钥后，浏览器仍会带上旧 Cookie。
    // 旧实现只看"Cookie 非空"就交付真 SPA，于是页面加载成功但所有 /api/* 401，
    // 用户卡在"缺少或错误的访问令牌"且没有恢复入口。
    const stale = await fetch(`${base()}/`, { headers: { cookie: "syllora_session=deadbeef" }, signal: AbortSignal.timeout(8_000) });
    expect(stale.status).toBe(200);
    const html = await stale.text();
    expect(html).toContain("/api/session");
    expect(html).not.toContain("sc-ui");
  }, 15_000);

  it("SPA 回落：无扩展名路由返回票据页（未持会话）", async () => {
    const spa = await fetch(`${base()}/some/deep/route`, { signal: AbortSignal.timeout(8_000) });
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("/api/session");
  }, 15_000);

  it("CR-01/CR-15：正常完成的请求不会被误判为客户端断连", async () => {
    // CR-15：SSE 回合在客户端保持连接、正常读完的情况下必须跑完并回 done 帧。
    // 旧实现把断连监听注册在 body 读取之后，现代 Node 下 'close' 已触发、
    // 监听器永不执行；而 CR-01 的 upload 端点更严重——正常上传被判成
    // 「客户端已消失」，临时文件被删、响应不发。
    // 这里用真实 POST（请求体完整送达后连接仍由服务端收尾）验证两处判定。
    const res = await fetch(`${base()}/api/workspaces.list`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-syllora-token": host!.token },
      body: JSON.stringify({ payload: {} }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { ok?: boolean }).ok).toBe(true);

    // upload 路由（multipart，`/api/courses/<id>/sources`）：显式无边界体的
    // POST 在旧实现下会先命中 clientGone，响应永不发出。现在必须拿到明确的
    // 结构化响应（无工作区 409，或解析失败 400），而不是超时。
    const upload = await fetch(`${base()}/api/courses/it-course/sources`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x", "x-syllora-token": host!.token },
      body: "--x--",
      signal: AbortSignal.timeout(15_000),
    });
    expect([400, 409]).toContain(upload.status);
  }, 30_000);

  it("编码穿越不泄漏文件内容（403 或被归一化为 SPA 回落）", async () => {
    // 实测两种服务端形态都安全：
    //  - `%2e%2e` 被 WHATWG URL 解析器在客户端归一化成 `/etc/passwd`，落 dist
    //    根内无此文件 → SPA 回落 200（index.html，无穿越目标内容）；
    //  - `..%2f` / `%2e%2e%2f` 保留编码到达服务端 → 显式 403。
    for (const path of ["/%2e%2e/%2e%2e/%2e%2e/etc/passwd", "/..%2f..%2fetc/passwd", "/%2e%2e%2f%2e%2e%2fetc/passwd"]) {
      const res = await fetch(`${base()}${path}`, { signal: AbortSignal.timeout(8_000) });
      const body = await res.text();
      // 任何形态都不得带出穿越目标的文件内容。
      expect([200, 400, 403]).toContain(res.status);
      expect(body).not.toContain("root:");
      // CR-16：未持会话的 200 是票据页（不含 sc-ui），持会话才是真 SPA。
      if (res.status === 200) expect(body).toContain("/api/session");
    }
  }, 15_000);

  it("编码穿越：裸 socket 直发未归一化路径也不泄漏文件内容", async () => {
    // 上一个用例里 `%2e%2e` 是被**客户端** URL 解析器归一化的，服务端那条路径
    // 压根没收到——证明不了服务端自己的行为。这里用裸 socket 把原始字节发给
    // 服务端：当前由 bin.ts 的 `new URL()` 归一化 + static-host 的根包含校验两
    // 道防线负责（任一道被移除都会在这里现形：归一化没了 → 解码成 `..` → 穿越）。
    for (const target of ["/%2e%2e/%2e%2e/%2e%2e/etc/passwd", "/%2e%2e%2f%2e%2e%2fetc/passwd", "/..%2f..%2fetc/passwd"]) {
      const { status, body } = await rawGet(target);
      // 归一化后落 dist 内 → SPA 回落 200；带编码斜杠的穿越 → 服务端 403；
      // 解码失败/空路径 → 400；带扩展名未命中 → 404。任何形态都不得泄内容。
      expect([200, 400, 403, 404]).toContain(status);
      expect(body).not.toContain("root:");
      // CR-16：同上——200 是票据页，凭据不在页面里。
      if (status === 200) expect(body).toContain("/api/session");
    }
  }, 15_000);

  it("目录穿越够不到 dist 上一级的金丝雀文件", async () => {
    // 金丝雀放在 home/（dist 的上一级）。三种写法：被客户端/服务端归一化成
    // dist 内路径（404 或 SPA 回落）、保留编码到达服务端（必须 403）。任一种
    // 都不该把金丝雀内容带出来——根包含校验被移除时这条会红。
    for (const target of ["/%2e%2e/canary-secret.txt", "/..%2fcanary-secret.txt", "/%2e%2e%2fcanary-secret.txt"]) {
      const { status, body } = await rawGet(target);
      expect([200, 400, 403, 404]).toContain(status);
      expect(body).not.toContain("CANARY-SECRET-DO-NOT-SERVE");
    }
  }, 15_000);

  it("上传路由：无工作区 → 409（先于 busboy 解析）", async () => {
    const res = await fetch(`${base()}/api/courses/it-course/sources`, {
      method: "POST",
      headers: { authorization: `Bearer ${host!.token}`, "content-type": "multipart/form-data; boundary=----x" },
      body: "------x--",
      signal: AbortSignal.timeout(8_000),
    });
    expect(res.status).toBe(409);
  }, 15_000);

  it("上传落盘按 courseId 解析课程根，不写进 lastOpenedPath 指向的别处", async () => {
    // 回归：工作台先开课程 A、再开另一个工作区 B 后，lastOpenedPath 停在 B。
    // 旧实现按 lastOpenedPath 落盘——文件写进 B/sources，而落盘后触发的
    // sync(courseId) 又按 courseId 在 A 上构建，于是「上传成功但课程里没有东西」。
    const uploadHost = await startHost();
    const uploadBase = `http://127.0.0.1:${uploadHost.port}`;
    const uploadRpc = async (method: string, payload: unknown): Promise<any> => {
      const response = await fetch(`${uploadBase}/api/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${uploadHost.token}`, "content-type": "application/json" },
        body: JSON.stringify({ payload }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await response.json()) as any;
      expect(body.error).toBeUndefined();
      return body.result;
    };
    try {
      const courseFolder = join(uploadHost.home, "upload-course");
      const otherWorkspace = join(uploadHost.home, "upload-other-workspace");
      mkdirSync(courseFolder);
      mkdirSync(otherWorkspace);
      const course = await uploadRpc("syllora/openCourse", { path: courseFolder });
      // 把 lastOpenedPath 移到别处：此后所有「按 lastOpenedPath 落盘」的实现都会露馅。
      await uploadRpc("syllora/openCourse", { path: otherWorkspace });
      const form = new FormData();
      form.append("file", new Blob(["upload probe"]), "probe.txt");
      const response = await fetch(`${uploadBase}/api/courses/${course.id}/sources`, {
        method: "POST",
        headers: { authorization: `Bearer ${uploadHost.token}` },
        body: form,
        signal: AbortSignal.timeout(20_000),
      });
      expect(response.status).toBe(200);
      expect(existsSync(join(courseFolder, "sources", "probe.txt"))).toBe(true);
      expect(existsSync(join(otherWorkspace, "sources", "probe.txt"))).toBe(false);
    } finally {
      stop(uploadHost);
    }
  }, 30_000);
});

describe("serve 关停与实例锁", () => {
  it("C-1 回归：优雅关停后 host.json 与 host.lock 均被删除", async () => {
    if (isWin) return; // Windows 无信号语义，SIGINT 被映射为强杀
    const target = host!;
    const exiting = waitForExit(target.child);
    signalGracefully(target, "SIGINT");
    await exiting;
    expect(await waitForGone(join(target.home, "host.json"))).toBe(true);
    expect(await waitForGone(join(target.home, "host.lock"))).toBe(true);
  }, 30_000);

  it("实例锁自愈：同一 home 下强杀残留 lock 后重启可抢回", async () => {
    // 专用实例：关停用例已把共享实例优雅关停（lock 已删），不能复用它的 home。
    const stale = await startHost();
    try {
      const up = await fetch(`http://127.0.0.1:${stale.port}/api/health`, { signal: AbortSignal.timeout(8_000) });
      expect(up.status).toBe(200);
      const stalePidBefore = await readLockPid(stale.home);
      expect(stalePidBefore).toBeGreaterThan(0);

      const exiting = waitForExit(stale.child);
      killHard(stale);
      await exiting;
      // 强杀跳过清理：lock 残留，且锁里的 pid 已随进程消失。
      expect(existsSync(join(stale.home, "host.lock"))).toBe(true);
      const stalePid = await readLockPid(stale.home);
      expect(stalePid).toBe(stalePidBefore);

      // 同一 home 重启：acquireHostInstanceLock 发现陈旧 pid → 抢走锁并起服务。
      const second = await startHost(stale.home);
      try {
        const health = await fetch(`http://127.0.0.1:${second.port}/api/health`, { signal: AbortSignal.timeout(8_000) });
        expect(health.status).toBe(200);
        // 锁已易主（不是残留的旧 pid）——这条才是"自愈"的实质断言。
        expect(await readLockPid(stale.home)).not.toBe(stalePid);
      } finally {
        stop(second);
      }
    } finally {
      // 断言失败也要收掉这个专用实例，别把 serve 进程留给后续测试/CI。
      stop(stale);
    }
  }, 60_000);
});
