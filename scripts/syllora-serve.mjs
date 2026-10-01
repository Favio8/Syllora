import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env, SYLLORA_HOME: process.env.SYLLORA_HOME ?? resolve(root, '.syllora-home'), SYLLORA_DATA_DIR: process.env.SYLLORA_DATA_DIR ?? resolve(root, '.syllora-data') };
const child = spawn(process.execPath, ['--import', 'tsx', 'apps/cli/src/bin.ts', 'serve', ...process.argv.slice(2)], {cwd: root, env: {...env, TSX_TSCONFIG_PATH: resolve(root,'tsconfig.base.json')}, stdio:'inherit', windowsHide:true});
child.on('exit',code=>{process.exitCode=code??1});
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
