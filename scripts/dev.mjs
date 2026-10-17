import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureLocalAI } from './local-runtime.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
if (existsSync('.env')) process.loadEnvFile('.env');
process.env.HOST = '127.0.0.1';
const ports = [Number(process.env.PORT || 4000), 5173];
for (const port of ports) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error(`Port ${port} is occupied. Close the earlier JagaAI session or use its existing local page.`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  }).catch(error => { console.error(error.message); process.exit(1); });
}

const commands = [
  ['API', ['--import', 'tsx', 'apps/api/src/index.ts']],
  ['Worker', ['--import', 'tsx', 'apps/worker/src/index.ts']],
  ['Web', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1']]
];
const children = [];
const runtime = process.env.AI_MODE === 'ollama' ? await ensureLocalAI() : undefined;
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  runtime?.stop();
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 600).unref();
}
for (const [name, args] of commands) {
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
  children.push(child);
  child.on('error', error => { console.error(`${name}: ${error.message}`); stop(1); });
  child.on('exit', code => { if (!stopping) { console.error(`${name} stopped (${code}).`); stop(code || 1); } });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
console.log('\nJagaAI is running locally: http://127.0.0.1:5173\nPress Ctrl+C to stop all three services.\n');
