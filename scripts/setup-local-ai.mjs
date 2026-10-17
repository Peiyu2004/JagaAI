import { existsSync, createReadStream, createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { root, ensureLocalAI } from './local-runtime.mjs';

process.chdir(root);
if (existsSync('.env')) process.loadEnvFile('.env');
if (process.platform !== 'win32') throw new Error('This portable installer targets Windows x64. Install local Ollama manually on this platform.');
const version = 'v0.40.4', checksum = '7485a1172f8527db4342a63521b9342fc466185ff0855da378cc864ecf6354cf';
const runtimeDir = path.join(root, '.runtime'), zip = path.join(runtimeDir, 'ollama-windows-amd64.zip');
await mkdir(runtimeDir, { recursive: true });
if (!existsSync(path.join(runtimeDir, 'ollama', 'ollama.exe'))) {
  if (!existsSync(zip)) {
    console.log(`Downloading official portable Ollama ${version} (1.47 GB).`);
    const response = await fetch(`https://github.com/ollama/ollama/releases/download/${version}/ollama-windows-amd64.zip`);
    if (!response.ok || !response.body) throw new Error('Official runtime download failed.');
    await pipeline(Readable.fromWeb(response.body), createWriteStream(zip));
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(zip)) hash.update(chunk);
  if (hash.digest('hex') !== checksum) throw new Error('Runtime checksum mismatch. Remove the incomplete .runtime/ollama-windows-amd64.zip and run setup again.');
  execFileSync('powershell.exe', ['-NoProfile', '-File', path.join(root, 'scripts', 'unpack-local-ai.ps1'), zip, path.join(runtimeDir, 'ollama')], { windowsHide: true, stdio: 'inherit' });
}
const runtime = await ensureLocalAI();
try {
  for (const model of [process.env.OLLAMA_MODEL || 'qwen3-vl:2b', process.env.OLLAMA_EMBEDDING_MODEL || 'qwen3-embedding:0.6b']) {
    console.log(`Installing ${model} in the local model store…`);
    const response = await fetch(`${runtime.base}/api/pull`, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }) });
    if (!response.ok || !response.body) throw new Error(`Could not download ${model}.`);
    let buffer = '', lastStatus = '', lastProgress = -1;
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const item = JSON.parse(line);
        if (item.error) throw new Error(item.error);
        const progress = item.total ? Math.floor(100 * Number(item.completed || 0) / item.total / 10) * 10 : -1;
        if (item.status !== lastStatus || progress > lastProgress) { console.log(`${model}: ${item.status}${progress >= 0 ? ` ${progress}%` : ''}`); lastStatus = item.status; lastProgress = progress; }
      }
    }
  }
  const inventory = await (await fetch(`${runtime.base}/api/tags`, { redirect: 'error' })).json();
  await writeFile(path.join(runtimeDir, 'installed-models.json'), JSON.stringify({ version, checksum, installedAt: new Date().toISOString(), models: inventory.models }, null, 2));
  if (!existsSync('.env')) await writeFile('.env', 'HOST=127.0.0.1\nPORT=4000\nAI_MODE=ollama\nOLLAMA_URL=http://127.0.0.1:11434\nOLLAMA_MODEL=qwen3-vl:2b\nOLLAMA_EMBEDDING_MODEL=qwen3-embedding:0.6b\n');
  console.log('Local AI is ready. Run npm run dev. Video frames and search queries remain on this machine.');
} finally { runtime.stop(); }
