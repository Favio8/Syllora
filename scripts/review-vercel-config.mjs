import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const saved = JSON.parse((await readFile(new URL('.syllora-review/runtime.json', root), 'utf8')).replace(/^\uFEFF/, ''));
const origin = new URL(saved.apiUrl);
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid review API origin');
const config = {
  framework: null,
  installCommand: 'pnpm install --frozen-lockfile --filter web...',
  buildCommand: 'pnpm build:web',
  outputDirectory: 'apps/web/out',
  build: { env: { NEXT_PUBLIC_SYLLORA_API_URL: origin.origin, NEXT_PUBLIC_SYLLORA_REVIEW_PUBLIC: saved.publicAccess === true ? '1' : '0' } },
  routes: [
    { src: '/api/(session(?:/logout)?|syllora/material-file|syllora/material-document|syllora/notes/asset)', dest: `${origin.origin}/api/$1`, transforms: [{ type: 'request.headers', op: 'set', target: { key: 'ngrok-skip-browser-warning' }, args: '1' }], headers: { 'Cache-Control': 'private, no-store', 'x-vercel-enable-rewrite-caching': '0' } },
    { handle: 'filesystem' },
    { src: '/(.*)', dest: '/index.html' },
  ],
};
await writeFile(new URL('vercel.json', root), JSON.stringify(config, null, 2) + '\n');
console.log(`Vercel configuration ready for ${origin.origin}; project: ${fileURLToPath(root)}`);
