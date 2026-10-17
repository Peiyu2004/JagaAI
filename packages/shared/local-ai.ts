import { createHash } from 'node:crypto';

export const visionModel = () => process.env.OLLAMA_MODEL || process.env.JAGAAI_OLLAMA_MODEL || 'qwen3-vl:2b';
export const embeddingModel = () => process.env.OLLAMA_EMBEDDING_MODEL || 'qwen3-embedding:0.6b';
export const analysisMode = () => process.env.AI_MODE || process.env.JAGAAI_AI_MODE || 'fixture';
export class LocalAIError extends Error { status = 503; }

export function localEndpoint(route: string, base = process.env.OLLAMA_URL || process.env.JAGAAI_OLLAMA_URL || 'http://127.0.0.1:11434') {
  const url = new URL(base);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new LocalAIError('Ollama must use a loopback HTTP address, for example http://127.0.0.1:11434.');
  }
  return new URL(route, url);
}

export async function localRequest(route: string, body?: unknown, signal?: AbortSignal, timeout = 180_000): Promise<any> {
  const endpoint = localEndpoint(route);
  try {
    const response = await fetch(endpoint, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeout)]),
      headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as { error?: unknown };
      throw new LocalAIError(`Local model request failed (${response.status}). ${typeof detail.error === 'string' ? detail.error.slice(0, 500) : 'Check that the required models are installed; run npm run ai:setup.'}`);
    }
    const result = await response.json();
    if (result.error) throw new LocalAIError('The local model could not complete this request. Check the local runtime log.');
    return result;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof LocalAIError) throw error;
    throw new LocalAIError('Local AI is unavailable or timed out. Run npm run ai:setup, then npm run dev. No cloud fallback is used.');
  }
}

export async function installedModels(signal?: AbortSignal) {
  const data = await localRequest('/api/tags', undefined, signal, 5000);
  if (!Array.isArray(data.models)) throw new LocalAIError('Invalid local model inventory.');
  return data.models as { name: string; digest: string; size?: number }[];
}
export async function modelDigest(name: string, signal?: AbortSignal) {
  if (/(?:[:/-])cloud(?:$|[:/-])/i.test(name)) throw new LocalAIError('Cloud model names are disabled. Use an installed on-device model.');
  const model = (await installedModels(signal)).find(m => m.name === name || m.name === `${name}:latest`);
  if (!model?.digest) throw new LocalAIError(`Local model ${name} is not installed. Run npm run ai:setup.`);
  if ((model as any).remote_model || (model as any).remote_host) throw new LocalAIError('Remote model aliases are disabled. Use an installed on-device model.');
  return model.digest;
}
export function normalizeVector(input: unknown): number[] {
  if (!Array.isArray(input) || input.length < 2 || input.length > 8192 || !input.every(v => typeof v === 'number' && Number.isFinite(v))) throw new LocalAIError('Local embedding model returned an invalid vector.');
  const length = Math.hypot(...input);
  if (!Number.isFinite(length) || length < 1e-12) throw new LocalAIError('Local embedding model returned a zero vector.');
  return input.map(v => v / length);
}
export async function embedTexts(texts: string[], query = false, signal?: AbortSignal) {
  const model = embeddingModel(), digest = await modelDigest(model, signal);
  const input = texts.map(text => query ? `Instruct: Given a surveillance video search query, retrieve descriptions of the relevant visible scene, people, objects and actions.\nQuery: ${text}` : text);
  const data = await localRequest('/api/embed', { model, input, truncate: false, keep_alive: 0, options: { num_ctx: 4096 } }, signal);
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) throw new LocalAIError('Local embedding model returned the wrong number of vectors.');
  const vectors = data.embeddings.map(normalizeVector) as number[][];
  if (vectors.some(v => v.length !== vectors[0].length) || await modelDigest(model, signal) !== digest) throw new LocalAIError('The embedding model changed during indexing. Retry with a stable local model.');
  return { vectors, model, digest, dimension: vectors[0]?.length || 0 };
}
export const contentHash = (text: string) => createHash('sha256').update(text).digest('hex');
export const segmentText = (segment: any): string => [segment.summary, ...(segment.observations || []).map((o: any) => o.description)].join('\n').slice(0, 12_000);
export function cosine(a: number[], b: number[]) {
  if (a.length !== b.length) throw new LocalAIError('Embedding dimensions differ. Rebuild the local index.');
  return a.reduce((sum, value, i) => sum + value * b[i], 0);
}
