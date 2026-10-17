import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const base = 'http://127.0.0.1:4000/api';
const manifest = JSON.parse(await readFile('data/semantic-demo/manifest.json', 'utf8')) as { key: string; videoId: string }[];
const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'manager@jaga.local', password: 'JagaLocal!2026' }) });
assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie')!.split(';')[0];
async function request(route: string, body?: unknown) {
  const response = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
}
let last = '', ready = false;
for (let attempt = 0; attempt < 120; attempt++) {
  const bootstrap = await request('/bootstrap');
  const states = manifest.map(m => { const v = bootstrap.videos.find((v: any) => v.id === m.videoId), index = bootstrap.indexJobs.find((j: any) => j.videoId === m.videoId); return { ...m, analysis: v?.status, index: index?.status, error: v?.lastError || index?.lastError }; });
  const state = JSON.stringify(states); if (state !== last) { console.log(state); last = state; }
  assert.ok(!states.some(s => s.analysis === 'failed' || s.index === 'failed'), `A real-model job failed: ${state}`);
  if (states.every(s => s.analysis === 'completed' && s.index === 'completed')) { ready = true; break; }
  await sleep(5000);
}
assert.ok(ready, 'Real model indexing did not complete within 10 minutes.');
const tests = [{ query: '穿红色衣服的人靠近白色汽车', expected: 'red-white' }, { query: 'A person wearing a blue shirt next to a dark car', expected: 'blue-dark' }, { query: '昨晚8点到10点在B区停车场穿红衣的人', expected: 'red-white' }];
const observations = [];
for (const item of tests) {
  const start = performance.now(); let result = await request('/video-search', { query: item.query, mode: 'semantic', locationId: 'loc_parking_b' });
  if (result.needsConfirmation) { assert.ok(result.parsed.timeFrom.endsWith('T12:00:00.000Z')); assert.ok(result.parsed.timeTo.endsWith('T14:00:00.000Z')); result = await request('/video-search', { query: item.query, mode: 'semantic', confirmRelativeDate: true, timeFrom: result.parsed.timeFrom, timeTo: result.parsed.timeTo }); }
  assert.equal(result.mode, 'semantic');
  const ranked = result.results.map((r: any) => ({ key: manifest.find(m => m.videoId === r.videoId)?.key, videoId: r.videoId, score: r.score, summary: r.summary, observations: r.observations, model: r.model, modelDigest: r.modelDigest }));
  assert.equal(ranked[0]?.key, item.expected, JSON.stringify(ranked));
  observations.push({ query: item.query, elapsedMs: Math.round(performance.now() - start), coverage: result.coverage, parsed: result.parsed, ranked });
  console.log(JSON.stringify({ query: item.query, elapsedMs: observations.at(-1)!.elapsedMs, first: ranked[0].key, scores: ranked.map((r: any) => [r.key, r.score]) }));
}
const first = observations[0].ranked[0], video = await request(`/videos/${first.videoId}`), access = await request(`/media/${video.mediaId}/access`);
const playback = await fetch(new URL(access.url, base).href, { headers: { cookie, Range: 'bytes=0-63' }, redirect: 'error' });
assert.equal(playback.status, 206); assert.equal((await playback.arrayBuffer()).byteLength, 64);
const result = { generatedAt: new Date().toISOString(), syntheticTestOnly: true, independentAccuracyEvaluation: false, ai: await request('/ai/status'), observations, privatePlaybackRangeVerified: true };
await mkdir('output/verification', { recursive: true });
await writeFile(path.resolve('output/verification/local-ai-smoke.json'), JSON.stringify(result, null, 2));
console.log('Real local VLM + multilingual embeddings + semantic search + private playback passed on the labelled synthetic clips.');
