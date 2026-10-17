import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export async function ensureLocalAI() {
  const base = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
  const url = new URL(base);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Local AI requires a loopback HTTP URL.');
  const ready = async () => { try { return (await fetch(new URL('/api/tags', url), { signal: AbortSignal.timeout(1500), redirect: 'error' })).ok; } catch { return false; } };
  if (await ready()) return { stop() {}, base: url.origin, reused: true };
  const binary = path.join(root, '.runtime', 'ollama', process.platform === 'win32' ? 'ollama.exe' : 'ollama');
  if (!existsSync(binary)) throw new Error('Portable Ollama is not installed. Run npm run ai:setup first.');
  mkdirSync(path.join(root, '.runtime', 'models'), { recursive: true });
  const fd = openSync(path.join(root, '.runtime', 'ollama.log'), 'a');
  const child = spawn(binary, ['serve'], { cwd: root, windowsHide: true, env: { ...process.env,
    OLLAMA_HOST: url.host, OLLAMA_MODELS: path.join(root, '.runtime', 'models'), OLLAMA_NO_CLOUD: '1',
    OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_CONTEXT_LENGTH: '4096', OLLAMA_MAX_QUEUE: '8',
  }, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  let startupError;
  child.on('error', error => { startupError = error; });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await ready()) return { base: url.origin, reused: false, stop: () => child.kill() };
    if (startupError || child.exitCode !== null) throw startupError || new Error('Local AI stopped. See .runtime/ollama.log.');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  child.kill(); throw new Error('Local AI did not start. See .runtime/ollama.log.');
}
