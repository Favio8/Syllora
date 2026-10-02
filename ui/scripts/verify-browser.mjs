import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, extname, sep, dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const ui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(ui, '..');
const artifacts = process.env.UI_ARTIFACTS || await mkdtemp(join(tmpdir(), 'syllora-ui-browser-'));
await mkdir(artifacts, { recursive: true });
const { chromium } = createRequire(resolve(repo, 'apps/web/package.json'))('playwright-core');
const root = resolve(repo, 'ui/out');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = resolve(root, '.' + path, path.endsWith('/') ? 'index.html' : '');
    if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    const content = await readFile(file); res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }); res.end(content);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
const checks = [], errors = [], externalRequests = [], businessRequests = [];
async function check(name, operation) {
  try { await operation(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); }
}
async function waitFor(operation) {
  let last;
  for (let i = 0; i < 50; i++) { try { return await operation(); } catch (e) { last = e; await new Promise(r => setTimeout(r, 100)); } }
  throw last;
}
async function fresh() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
  context.on('page', page => { page.on('pageerror', error => errors.push(error.message)); page.on('request', req => { if (req.url().startsWith(url) && new URL(req.url()).pathname.startsWith('/api/')) businessRequests.push(req.url()); if (!req.url().startsWith(url) && !req.url().startsWith('data:')) externalRequests.push(req.url()); }); });
  const page = await context.newPage(); await page.goto(url); await page.locator('.home-content').waitFor();
  return { context, page };
}
const chat = p => p.getByRole('textbox', { name: '向 Syllora 提问', exact: true });
async function user(p, item) {
  const button = p.getByRole('button', { name: '用户', exact: true });
  if (!await button.isVisible()) await p.getByRole('button', { name: '打开导航', exact: true }).click();
  await button.click(); await p.getByRole('menuitem', { name: item, exact: true }).click();
}
async function create(p, name) {
  await p.getByRole('button', { name: '新建课程', exact: true }).first().click();
  await p.getByRole('textbox', { name: '课程名称', exact: true }).fill(name);
  await p.getByRole('radio', { name: '数学', exact: true }).check();
  await p.getByRole('button', { name: '创建课程', exact: true }).click();
  await p.getByRole('button', { name, exact: true }).waitFor();
}
async function selectText(p) {
  const paragraph = p.locator('.reading-paper > p').first();
  await paragraph.scrollIntoViewIfNeeded();
  const points = await paragraph.evaluate(el => {
    const text = el.firstChild;
    const first = document.createRange(), last = document.createRange();
    first.setStart(text, 0); first.setEnd(text, 1);
    last.setStart(text, text.length - 1); last.setEnd(text, text.length);
    const a = first.getBoundingClientRect(), b = last.getBoundingClientRect();
    return { sx: a.left + 1, sy: a.top + a.height / 2, ex: b.right - 1, ey: b.top + b.height / 2 };
  });
  await p.mouse.click(points.sx, points.sy); await p.mouse.move(points.sx, points.sy);
  await p.mouse.down(); await p.mouse.move(points.ex, points.ey, { steps: 18 }); await p.mouse.up();
  await p.getByRole('toolbar', { name: '选中文字操作', exact: true }).waitFor();
}
async function uploadText(p, name, content) {
  const chooser = p.waitForEvent('filechooser');
  if (await p.locator('.reader-toolbar').count()) await p.locator('.reader-toolbar').getByRole('button', { name: '添加资料', exact: true }).click();
  else await p.locator('.composer-actions').getByRole('button', { name: '添加资料', exact: true }).click();
  await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(content) });
  await waitFor(async () => assert(await p.evaluate(name => JSON.parse(localStorage.getItem('syllora-ui.workspace.v1')).courses.some(c => c.materials.some(m => m.name === name)), name)));
}
try {
  browser = await chromium.launch({ ...(process.env.SYLLORA_BROWSER ? { executablePath: process.env.SYLLORA_BROWSER } : { channel: 'msedge' }), headless: true });
  await check('draft survives course, reading-mode, home and reload switches', async () => {
    const { context, page: p } = await fresh();
    try {
      await p.getByRole('button', { name: '继续学习', exact: true }).click();
      await chat(p).fill('Synthetic unsent draft A');
      await p.getByRole('button', { name: '概率论与数理统计', exact: true }).click();
      await chat(p).fill('Synthetic unsent draft B');
      await p.getByRole('button', { name: '线性代数', exact: true }).click();
      assert.equal(await chat(p).inputValue(), 'Synthetic unsent draft A');
      await p.getByRole('button', { name: '辅助阅读', exact: true }).click();
      await p.getByRole('button', { name: '对话学习', exact: true }).click();
      assert.equal(await chat(p).inputValue(), 'Synthetic unsent draft A');
      await p.getByRole('button', { name: '返回主页', exact: true }).click();
      await p.getByRole('button', { name: '继续学习', exact: true }).click();
      assert.equal(await chat(p).inputValue(), 'Synthetic unsent draft A');
      await p.reload(); await p.locator('.home-content').waitFor();
      await p.getByRole('button', { name: '继续学习', exact: true }).click();
      assert.equal(await chat(p).inputValue(), 'Synthetic unsent draft A');
    } finally { await context.close(); }
  });
  await check('failed persistence retains submitted draft and shows error', async () => {
    const { context, page: p } = await fresh();
    try {
      await p.getByRole('button', { name: '继续学习', exact: true }).click();
      await chat(p).fill('Synthetic quota draft');
      await p.evaluate(() => { Storage.prototype.setItem = function() { throw new DOMException('Synthetic quota exceeded', 'QuotaExceededError'); }; });
      await p.getByRole('button', { name: '发送消息', exact: true }).click();
      await p.locator('.error-banner').waitFor();
      assert.equal(await chat(p).inputValue(), 'Synthetic quota draft');
      assert.equal(await p.locator('.message.user').count(), 0);
    } finally { await context.close(); }
  });
  await check('preset send preserves unrelated draft and new typing survives reply', async () => {
    const { context, page: p } = await fresh();
    try {
      await p.getByRole('button', { name: '继续学习', exact: true }).click();
      await chat(p).fill('Synthetic unrelated draft');
      await p.getByRole('button', { name: '用直观例子解释', exact: false }).click();
      assert.equal(await chat(p).inputValue(), 'Synthetic unrelated draft');
      await chat(p).fill('Synthetic next prompt');
      await waitFor(async () => assert.equal(await p.locator('.thinking').count(), 0));
      assert.equal(await chat(p).inputValue(), 'Synthetic next prompt');
      await p.getByRole('button', { name: '发送消息', exact: true }).click();
      await waitFor(async () => assert.equal(await chat(p).inputValue(), ''));
      await chat(p).fill('Synthetic while replying');
      await waitFor(async () => assert.equal(await p.locator('.thinking').count(), 0));
      assert.equal(await chat(p).inputValue(), 'Synthetic while replying');
    } finally { await context.close(); }
  });
  await check('real same-origin pages retain and refresh each others courses', async () => {
    const { context, page: a } = await fresh();
    try {
      const b = await context.newPage(); await b.goto(url); await b.locator('.home-content').waitFor();
      await create(a, 'Synthetic Tab A'); await create(b, 'Synthetic Tab B');
      await waitFor(async () => assert.equal(await a.getByRole('button', { name: 'Synthetic Tab B', exact: true }).count(), 1));
      assert.equal(await b.getByRole('button', { name: 'Synthetic Tab A', exact: true }).count(), 1);
      await a.reload(); await a.locator('.home-content').waitFor();
      assert.equal(await a.getByRole('button', { name: 'Synthetic Tab A', exact: true }).count(), 1);
      assert.equal(await a.getByRole('button', { name: 'Synthetic Tab B', exact: true }).count(), 1);
    } finally { await context.close(); }
  });
  await check('stale settings retain draft, reject save, and explicitly reload', async () => {
    const { context, page: a } = await fresh();
    try {
      const b = await context.newPage(); await b.goto(url); await b.locator('.home-content').waitFor();
      await user(a, '设置'); await a.getByRole('textbox', { name: '你的称呼', exact: true }).fill('Synthetic A');
      await user(b, '设置'); await b.getByRole('textbox', { name: '你的称呼', exact: true }).fill('Synthetic B');
      await b.getByRole('button', { name: '保存偏好', exact: true }).click();
      await b.getByText('学习偏好已保存。', { exact: true }).waitFor();
      await a.getByRole('button', { name: '保存偏好', exact: true }).click();
      await a.getByRole('dialog').getByRole('alert').waitFor();
      assert.equal(await a.getByRole('textbox', { name: '你的称呼', exact: true }).inputValue(), 'Synthetic A');
      assert.equal(await b.evaluate(() => JSON.parse(localStorage.getItem('syllora-ui.workspace.v1')).preferences.name), 'Synthetic B');
      await a.setViewportSize({ width: 360, height: 844 });
      const saveBounds = await a.getByRole('button', { name: '保存偏好', exact: true }).boundingBox();
      assert(saveBounds.y >= 0 && saveBounds.y + saveBounds.height <= 844);
      await a.screenshot({ path: resolve(artifacts, 'settings-conflict-mobile.png'), fullPage: true });
      await a.getByRole('button', { name: '加载最新设置', exact: true }).click();
      assert.equal(await a.getByRole('textbox', { name: '你的称呼', exact: true }).inputValue(), 'Synthetic B');
      await a.getByRole('textbox', { name: '你的称呼', exact: true }).fill('Recovered user');
      await a.getByRole('button', { name: '保存偏好', exact: true }).click();
      await a.getByText('学习偏好已保存。', { exact: true }).waitFor();
    } finally { await context.close(); }
  });
  await check('stale model config rejects; synthetic key stays session-only', async () => {
    const { context, page: a } = await fresh();
    try {
      const b = await context.newPage(); await b.goto(url); await b.locator('.home-content').waitFor();
      for (const p of [a, b]) {
        await user(p, '设置'); await p.getByRole('button', { name: '模型配置', exact: true }).click();
        await p.getByRole('textbox', { name: '接口地址', exact: true }).fill('https://synthetic.example/v1');
        await p.getByRole('textbox', { name: '模型名称', exact: true }).fill(p === a ? 'stale-model' : 'current-model');
      }
      await b.getByLabel('API 密钥', { exact: true }).fill('synthetic-session-only');
      await b.getByRole('button', { name: '保存配置', exact: true }).click();
      await b.getByText('配置已保存。当前对话与阅读仍使用演示服务。', { exact: true }).waitFor();
      await a.getByRole('button', { name: '保存配置', exact: true }).click();
      await a.getByRole('dialog').getByRole('alert').waitFor();
      assert.equal(await a.getByRole('textbox', { name: '模型名称', exact: true }).inputValue(), 'stale-model');
      assert.equal(await b.evaluate(() => localStorage.getItem('syllora-ui.workspace.v1').includes('synthetic-session-only')), false);
      assert.equal(await b.evaluate(() => sessionStorage.getItem('syllora-ui.api-key')), 'synthetic-session-only');
      assert.equal(await a.evaluate(() => sessionStorage.getItem('syllora-ui.api-key')), null);
      await a.getByRole('button', { name: '加载最新设置', exact: true }).click();
      assert.equal(await a.getByRole('textbox', { name: '模型名称', exact: true }).inputValue(), 'current-model');
    } finally { await context.close(); }
  });
  await check('mouse selection explains and searches; collapse keeps result; switching clears it', async () => {
    const { context, page: p } = await fresh();
    try {
      await p.getByRole('button', { name: '辅助阅读', exact: true }).click(); await p.locator('.reading-paper').waitFor();
      await selectText(p); await p.getByRole('button', { name: 'AI解释', exact: true }).click();
      await p.locator('.reading-explanation').waitFor();
      assert((await p.locator('.reading-explanation').innerText()).includes('独立方向'));
      await p.getByRole('button', { name: '关闭阅读结果', exact: true }).click();
      await p.getByRole('button', { name: '展开阅读助手', exact: true }).click();
      assert.equal(await p.locator('.reading-explanation').count(), 1);
      await selectText(p); await p.getByRole('button', { name: 'AI搜索', exact: true }).click();
      await p.locator('.reading-search-results article').first().waitFor();
      assert.equal(await p.locator('.reading-search-results article').count(), 3);
      const selector = p.getByRole('combobox', { name: '选择阅读资料', exact: true });
      await selector.click(); await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter');
      await waitFor(async () => assert((await p.locator('.reading-paper').innerText()).includes('课堂笔记')));
      assert.equal(await p.locator('.reading-search-results').count(), 0);
      await selector.click(); await p.keyboard.press('Escape');
      assert.equal(await p.getByRole('listbox').count(), 0);
      await p.screenshot({ path: resolve(artifacts, 'reading-desktop.png'), fullPage: true });
    } finally { await context.close(); }
  });
  await check('late reading reply cannot appear after course switch', async () => {
    const { context, page: p } = await fresh();
    try {
      await p.getByRole('button', { name: '辅助阅读', exact: true }).click(); await p.locator('.reading-paper').waitFor();
      await selectText(p); await p.getByRole('button', { name: 'AI解释', exact: true }).click();
      await p.getByRole('button', { name: '概率论与数理统计', exact: true }).click();
      await waitFor(async () => assert((await p.locator('.reading-paper').innerText()).includes('条件概率')));
      await new Promise(resolve => setTimeout(resolve, 700));
      assert.equal(await p.locator('.reading-explanation').count(), 0);
      assert.equal(await p.locator('.reading-quote').count(), 0);
    } finally { await context.close(); }
  });
  await check('cross-tab source removal clears old answer and text can be re-added', async () => {
    const { context, page: a } = await fresh();
    try {
      await create(a, 'Synthetic sources');
      await uploadText(a, 'synthetic-source.txt', 'Synthetic original paragraph with enough words for selection.');
      await a.getByRole('button', { name: '辅助阅读', exact: true }).click(); await a.locator('.reading-paper').waitFor();
      const b = await context.newPage(); await b.goto(url); await b.locator('.home-content').waitFor();
      await b.getByRole('button', { name: '资料库', exact: true }).click();
      await b.getByRole('textbox', { name: '搜索课程或资料', exact: true }).fill('synthetic-source');
      await selectText(a); await a.getByRole('button', { name: 'AI解释', exact: true }).click();
      await b.getByRole('button', { name: '移除资料 synthetic-source.txt', exact: true }).click();
      await b.getByRole('button', { name: '确认移除', exact: true }).click();
      await a.getByRole('heading', { name: '添加一份资料，开始阅读', exact: true }).waitFor();
      await new Promise(resolve => setTimeout(resolve, 700));
      assert.equal(await a.locator('.reading-explanation').count(), 0);
      assert.equal(await a.locator('.reading-quote').count(), 0);
      assert.equal(await a.locator('.reading-pending').count(), 0);
      await uploadText(a, 'synthetic-replacement.md', '# Synthetic replacement\n\nFresh text after source removal.\n\n<script>throw new Error("never executes")</script>');
      await waitFor(async () => assert((await a.locator('.reading-paper').innerText()).includes('Fresh text after source removal.')));
      assert.equal(await a.locator('.reading-paper script').count(), 0);
    } finally { await context.close(); }
  });
  await check('settings dropdown focus, Escape, themes and input boundaries work', async () => {
    const { context, page: p } = await fresh();
    try {
      await user(p, '设置');
      const bounds = await p.getByRole('dialog', { name: '设置', exact: true }).boundingBox();
      assert.equal(bounds.width, 860); assert.equal(bounds.height, 620);
      const field = p.getByRole('textbox', { name: '你的称呼', exact: true });
      const rect = await field.boundingBox();
      assert.equal(await field.evaluate(el => getComputedStyle(el).cursor), 'default');
      for (const [x, y] of [[rect.x - 2, rect.y + rect.height / 2], [rect.x + rect.width + 2, rect.y + rect.height / 2], [rect.x + 12, rect.y - 2], [rect.x + 12, rect.y + rect.height + 2]]) {
        await field.evaluate(el => el.blur()); await p.mouse.click(x, y);
        assert.equal(await field.evaluate(el => el === document.activeElement), false);
      }
      await field.click(); await p.keyboard.press('Tab'); await p.keyboard.press('Shift+Tab');
      assert.equal(await field.evaluate(el => el === document.activeElement), true);
      await p.getByRole('button', { name: '模型配置', exact: true }).click();
      const format = p.getByRole('combobox', { name: '接口格式', exact: true });
      await format.click(); assert.equal(await p.getByRole('listbox').evaluate(el => !!el.closest('dialog')), true);
      await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter');
      assert((await format.innerText()).includes('原生接口'));
      await format.click(); await p.keyboard.press('Escape');
      assert.equal(await p.getByRole('dialog', { name: '设置', exact: true }).count(), 1);
      assert.equal(await format.evaluate(el => el === document.activeElement), true);
      await p.getByRole('button', { name: '显示与交互', exact: true }).click();
      await p.getByRole('radio', { name: '深色外观', exact: true }).check();
      assert.equal(await p.locator('html').getAttribute('data-theme'), 'light');
      await p.getByRole('button', { name: '保存外观', exact: true }).click();
      await waitFor(async () => assert.equal(await p.locator('html').getAttribute('data-theme'), 'dark'));
      await p.screenshot({ path: resolve(artifacts, 'settings-dark.png'), fullPage: true });
      await p.keyboard.press('Escape'); await p.reload(); await p.locator('.home-content').waitFor();
      assert.equal(await p.locator('html').getAttribute('data-theme'), 'dark');
      const contrast = await p.locator('.home-content h1').first().evaluate(el => {
        const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => n / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
        const foreground = luminance(getComputedStyle(el).color), background = luminance(getComputedStyle(document.body).backgroundColor);
        return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
      });
      assert(contrast >= 4.5);
      await p.screenshot({ path: resolve(artifacts, 'home-dark.png'), fullPage: true });
    } finally { await context.close(); }
  });
  await check('mobile widths keep navigation, reader and settings inside viewport', async () => {
    const { context, page: p } = await fresh();
    try {
      assert.equal(await p.locator('.view-stage').evaluate(el => getComputedStyle(el).animationName), 'none');
      for (const width of [1024, 760, 390, 360]) {
        await p.setViewportSize({ width, height: 844 });
        assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await p.getByRole('button', { name: '对话学习', exact: true }).click(); await chat(p).waitFor();
        assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await p.getByRole('button', { name: '辅助阅读', exact: true }).click(); await p.locator('.reading-paper').waitFor();
        assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await user(p, '设置');
        const bounds = await p.getByRole('dialog', { name: '设置', exact: true }).boundingBox();
        assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
        if (width === 360) await p.screenshot({ path: resolve(artifacts, 'settings-mobile.png'), fullPage: true });
        await p.keyboard.press('Escape');
      }
      await p.screenshot({ path: resolve(artifacts, 'reading-mobile.png'), fullPage: true });
    } finally { await context.close(); }
  });
  await check('practice stays demonstrative, task persistence and reset remain functional', async () => {
    const { context, page: p } = await fresh();
    try {
      await p.getByRole('button', { name: '对话学习', exact: true }).click();
      await p.getByRole('button', { name: '标记完成：理解向量的线性相关性', exact: true }).click();
      await p.getByRole('button', { name: '取消完成：理解向量的线性相关性', exact: true }).waitFor();
      await p.locator('.composer-actions').getByRole('button', { name: '练习', exact: true }).click();
      const dialog = p.getByRole('dialog'); await dialog.getByRole('radio').first().check();
      await dialog.getByRole('button', { name: '查看解释', exact: true }).click();
      assert((await dialog.innerText()).includes('回答正确'));
      await p.keyboard.press('Escape'); await chat(p).fill('Synthetic reset draft');
      await p.reload(); await p.locator('.home-content').waitFor(); await p.getByRole('button', { name: '对话学习', exact: true }).click();
      assert.equal(await p.getByRole('button', { name: '取消完成：理解向量的线性相关性', exact: true }).count(), 1);
      assert.equal(await chat(p).inputValue(), 'Synthetic reset draft');
      await user(p, '设置'); await p.getByRole('button', { name: '数据管理', exact: true }).click();
      await p.getByRole('button', { name: '恢复初始演示数据', exact: true }).click();
      await p.getByRole('button', { name: '确认恢复', exact: true }).click();
      await waitFor(async () => assert.equal(await p.getByRole('dialog').count(), 0));
      assert.equal(await chat(p).inputValue(), '');
      assert.equal(await p.getByRole('button', { name: '标记完成：理解向量的线性相关性', exact: true }).count(), 1);
      assert.equal(await p.locator('.rail-courses button').count(), 3);
    } finally { await context.close(); }
  });
  await check('no business API or unexpected external requests', async () => {
    assert.equal(businessRequests.length, 0);
    assert(externalRequests.every(address => ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(new URL(address).hostname)));
  });
  console.log(JSON.stringify({ artifacts, checks, errors, businessRequests, externalRequests: [...new Set(externalRequests)] }, null, 2));
  await writeFile(resolve(artifacts, 'browser-report.json'), JSON.stringify({ artifacts, checks, errors, businessRequests, externalRequests: [...new Set(externalRequests)] }, null, 2));
  if (checks.some(c => !c.passed) || errors.length) process.exitCode = 1;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
