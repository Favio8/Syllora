import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const root = process.env.UI_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript');
const storage = new Map();
let rejectWrite = false;
let queue = Promise.resolve();
const localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem(key, value) { if (rejectWrite) throw new Error('Synthetic quota exceeded'); storage.set(key, value); },
  removeItem: key => storage.delete(key),
};
const locks = { request(name, operation) {
  const result = queue.then(operation);
  queue = result.catch(() => {});
  return result;
} };
function tab() {
  const cache = new Map();
  const context = vm.createContext({ localStorage, sessionStorage: { removeItem() {} }, navigator: { locks }, structuredClone, crypto: { randomUUID }, setTimeout, clearTimeout, console, URL });
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const localRequire = name => {
      if (!name.startsWith('@/') && !name.startsWith('.')) return require(name);
      const path = name.startsWith('@/') ? resolve(root, 'src', name.slice(2)) : resolve(dirname(file), name);
      const target = [path + '.ts', path + '/index.ts'].find(existsSync);
      if (!target) throw new Error(`Cannot resolve ${name}`);
      return load(target);
    };
    vm.runInContext(`(function(require,module,exports){${source}\n})`, context, { filename: file })(localRequire, module, module.exports);
    return module.exports;
  }
  return load(resolve(root, 'src/services/mock.ts')).mockService;
}
const checks = [];
async function check(name, operation) {
  try { await operation(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); }
}
const a = tab(), b = tab();
await Promise.all([a.load(), b.load()]);
await check('independent tabs preserve both created courses', async () => {
  await a.createCourse('Tab A synthetic course', 'math');
  await b.createCourse('Tab B synthetic course', 'code');
  const data = await a.load();
  assert(data.courses.some(c => c.name === 'Tab A synthetic course'));
  assert(data.courses.some(c => c.name === 'Tab B synthetic course'));
});
await check('concurrent mutations preserve every course', async () => {
  await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).createCourse(`Concurrent synthetic ${i}`, 'notebook')));
  assert.equal((await b.load()).courses.filter(c => c.name.startsWith('Concurrent synthetic')).length, 8);
});
await check('stale preferences reject without changing current data', async () => {
  const old = await a.load();
  await b.savePreferences({ ...old.preferences, dailyMinutes: 60 }, old.preferencesVersion ?? 0);
  await assert.rejects(a.savePreferences({ ...old.preferences, dailyMinutes: 45 }, old.preferencesVersion ?? 0), /其他页面/);
  assert.equal((await a.load()).preferences.dailyMinutes, 60);
});
await check('stale API configuration rejects', async () => {
  const old = await a.load();
  const config = { baseUrl: 'https://synthetic.example/v1', model: 'synthetic-model', format: 'compatible', temperature: 0.7 };
  await b.saveApiConfig(config, old.apiConfigVersion ?? 0);
  await assert.rejects(a.saveApiConfig({ ...config, model: 'stale-model' }, old.apiConfigVersion ?? 0), /其他页面/);
  assert.equal((await a.load()).apiConfig.model, 'synthetic-model');
});
await check('storage failure does not claim a saved mutation', async () => {
  const old = await a.load(); rejectWrite = true;
  try { await assert.rejects(a.createCourse('Must not be saved', 'math'), /quota/); }
  finally { rejectWrite = false; }
  assert.equal(JSON.stringify(await a.load()), JSON.stringify(old));
});
await check('delayed reply cannot resurrect a deleted course', async () => {
  const created = await a.createCourse('Deleted synthetic course', 'math');
  const course = created.courses.at(-1);
  const reply = a.reply(course.id, 'Synthetic prompt');
  await tab().deleteCourse(course.id);
  await assert.rejects(reply, /找不到/);
  assert(!(await a.load()).courses.some(c => c.id === course.id));
});
await check('reset invalidates old preference and API versions', async () => {
  const old = await a.load();
  await b.reset();
  await assert.rejects(a.savePreferences(old.preferences, old.preferencesVersion ?? 0), /其他页面/);
  await assert.rejects(a.saveApiConfig(old.apiConfig, old.apiConfigVersion ?? 0), /其他页面/);
});
await check('existing version-one snapshots migrate without losing courses', async () => {
  const existing = await a.load();
  delete existing.preferencesVersion; delete existing.apiConfigVersion; delete existing.revision;
  localStorage.setItem('syllora-ui.workspace.v1', JSON.stringify(existing));
  const migrated = tab();
  assert.equal((await migrated.load()).courses.length, existing.courses.length);
  const saved = await migrated.savePreferences({ ...existing.preferences, name: 'Migrated user' }, 0);
  assert.equal(saved.preferencesVersion, 1);
});
await check('invalid preferences do not modify a stored snapshot', async () => {
  const old = await a.load();
  await assert.rejects(a.savePreferences({ ...old.preferences, dailyMinutes: 0 }, old.preferencesVersion ?? 0), /5–480/);
  await assert.rejects(a.savePreferences({ ...old.preferences, name: ' ' }, old.preferencesVersion ?? 0), /1–16/);
  assert.equal(JSON.stringify(await a.load()), JSON.stringify(old));
});
console.log(JSON.stringify({ passed: checks.filter(c => c.passed).length, failed: checks.filter(c => !c.passed).length, checks }, null, 2));
if (checks.some(c => !c.passed)) process.exitCode = 1;
