import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseSearchTime } from '../../packages/shared/search-time.ts';

const temporary = mkdtempSync(path.join(os.tmpdir(), 'jagaai-semantic-test-'));
process.env.JAGAAI_DATA_DIR = temporary;
process.env.AI_MODE = 'ollama';
process.env.OLLAMA_MODEL = 'test-vision';
process.env.OLLAMA_EMBEDDING_MODEL = 'test-embedding';
let mock: Server, server: Server, base: string, manager: string, guard: string, resident: string;
let store: typeof import('../../packages/shared/store.ts');
let indexer: typeof import('../../apps/worker/src/indexer.ts');
let digest = 'sha256:test-one', embeddingCalls = 0, queryInput = '', redirect = false;
let duringEmbedding: (() => void) | undefined;
let generatedImages = 0, generatedCalls = 0;
async function call(route: string, cookie = manager, body?: any) {
  const r = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, value: await r.json(), response: r };
}
async function login(email: string) { const r = await call('/auth/login', '', { email, password: 'JagaLocal!2026' }); assert.equal(r.status, 200); return r.response.headers.get('set-cookie')!.split(';')[0]; }
before(async () => {
  // A deterministic local HTTP double tests integration boundaries. Real-model smoke results are recorded separately.
  mock = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'test-embedding', digest }, { name: 'test-vision', digest: 'vision-one' }] })); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === '/api/generate' || req.url === '/api/chat') {
      generatedImages = body.images?.length || body.messages?.[0]?.images?.length || 0;
      generatedCalls++;
      const answer = JSON.stringify({ description: 'A grey test scene.', uncertainty: 'Synthetic test output from the HTTP double.' });
      res.end(JSON.stringify({ response: answer, message: { content: answer }, done_reason: 'stop' })); return;
    }
    if (req.url === '/api/embed') {
      if (redirect) { res.writeHead(307, { location: 'https://example.com/api/embed' }); res.end(); return; }
      embeddingCalls++; duringEmbedding?.();
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      if (inputs[0].startsWith('Instruct:')) queryInput = inputs[0];
      res.end(JSON.stringify({ model: 'test-embedding', embeddings: inputs.map((t: string) => /red|红/.test(t) ? [1, 0, 0] : [0, 1, 0]) })); return;
    }
    res.statusCode = 404; res.end('{}');
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => mock.once('listening', resolve));
  process.env.OLLAMA_URL = `http://127.0.0.1:${(mock.address() as any).port}`;
  store = await import('../../packages/shared/store.ts'); indexer = await import('../../apps/worker/src/indexer.ts');
  const { app } = await import('../../apps/api/src/index.ts');
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  manager = await login('manager@jaga.local'); guard = await login('guard@jaga.local'); resident = await login('resident@jaga.local');
});
after(async () => { await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => mock.close(() => r()))]); store.db.close(); assert.equal(path.dirname(temporary), path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith('jagaai-semantic-test-')); rmSync(temporary, { recursive: true, force: true }); });
function video(id: string, extra = {}) {
  const v = store.put('videos', { id, townshipId: 'township_serenia', cameraId: 'cam_parking_b', locationId: 'loc_parking_b', recordedAt: '2026-10-14T12:00:00.000Z', durationSec: 24, status: 'completed', analysisMode: 'ollama', analysisVersion: 'local-v2', expiresAt: new Date(Date.now() + 3600000).toISOString(), ...extra });
  return v;
}
function segment(id: string, videoId: string, summary: string, extra = {}) { return store.put('segments', { id, videoId, townshipId: 'township_serenia', cameraId: 'cam_parking_b', locationId: 'loc_parking_b', startSec: 0, endSec: 15, absoluteStartAt: '2026-10-14T12:00:00.000Z', summary, observations: [], analysisMode: 'ollama', analysisVersion: 'local-v2', ...extra }); }

test('Malaysia date parser honours Chinese evening clock ranges and explicit dates', () => {
  const at = Date.parse('2026-10-15T02:00:00Z');
  for (const q of ['昨晚8点到10点在B区停车场穿红衣的人', '昨晚八点到十点穿红衣的人', 'last night 8pm to 10pm person in red']) {
    const r = parseSearchTime(q, at)!; assert.equal(r.timeFrom, '2026-10-14T12:00:00.000Z'); assert.equal(r.timeTo, '2026-10-14T14:00:00.000Z');
  }
  assert.equal(parseSearchTime('2026-10-14 20:00-22:00 a person', at)?.timeFrom, '2026-10-14T12:00:00.000Z');
  assert.equal(parseSearchTime('今天早上有人', at)?.timeTo, '2026-10-15T04:00:00.000Z');
  assert.equal(parseSearchTime('a person in red', at), undefined);
  assert.throws(() => parseSearchTime('2026-02-30 person', at));
  assert.throws(() => parseSearchTime('昨天25点到26点有人', at));
  assert.throws(() => parseSearchTime('昨晚十十点到十一点有人', at));
  assert.equal(parseSearchTime('last night 1am to 3am a person', at)?.timeFrom, '2026-10-14T17:00:00.000Z');
  assert.equal(parseSearchTime('昨晚凌晨1点到3点有人', at)?.timeFrom, '2026-10-14T17:00:00.000Z');
  assert.ok(!parseSearchTime('Yesterday 8PM to 10PM red car', at)?.visualQuery.includes('8PM'));
});
test('semantic model health and indexing remain management-only', async () => {
  for (const cookie of [guard, resident]) {
    assert.equal((await call('/ai/status', cookie)).status, 403);
    assert.equal((await call('/ai/index', cookie, {})).status, 403);
    assert.equal((await call('/video-search', cookie, { query: '红衣', mode: 'semantic' })).status, 403);
  }
  assert.equal((await call('/ai/status')).value.embeddingReady, true);
});
test('index queue persists, prevents duplicate work and stores normalized model-versioned vectors', async () => {
  const v = video('red-video'); segment('red-segment', v.id, 'A person in a red shirt approaches a white car.');
  const a = indexer.queueIndex(v), b = indexer.queueIndex(v); assert.equal(a.id, b.id);
  assert.equal(await indexer.processNextIndex('test-worker'), true);
  assert.equal(store.get<any>('indexJobs', a.id).status, 'completed');
  const vector = store.get<any>('segmentEmbeddings', 'red-segment'); assert.deepEqual(vector.vector, [1, 0, 0]); assert.equal(vector.digest, digest);
  const count = embeddingCalls; assert.equal(await indexer.processNextIndex('other-worker'), false); assert.equal(embeddingCalls, count);
});
test('Chinese queries use query instructions and retrieve VLM descriptions without keyword substitution', async () => {
  const v = video('blue-video'); segment('blue-segment', v.id, 'A person in blue stands beside a dark vehicle.'); indexer.queueIndex(v); await indexer.processNextIndex('test-worker');
  const r = await call('/video-search', manager, { query: '穿红色衣服的人靠近白车', mode: 'semantic', locationId: 'loc_parking_b' });
  assert.equal(r.status, 200, JSON.stringify(r.value)); assert.equal(r.value.results[0].id, 'red-segment'); assert.equal(r.value.mode, 'semantic');
  assert.ok(queryInput.startsWith('Instruct:')); assert.ok(queryInput.includes('Query: 穿红色'));
  assert.equal(r.value.coverage.indexedSegments, 2); assert.match(r.value.notice, /not confidence/);
  const bootstrap = (await call('/bootstrap')).value; assert.equal(bootstrap.segmentEmbeddings, undefined); assert.ok(!JSON.stringify(bootstrap).includes('"vector":'));
});
test('stale embeddings, old analyses, other townships, expired footage and nonintersecting times are excluded', async () => {
  const { contentHash, segmentText } = await import('../../packages/shared/local-ai.ts');
  for (const [id, extra] of [['expired', { expiresAt: '2020-01-01T00:00:00Z' }], ['foreign', { townshipId: 'township_other' }], ['old', {}]] as const) {
    video(id, extra); const s = segment(`${id}-segment`, id, 'red shirt', { ...(id === 'foreign' ? { townshipId: 'township_other' } : {}), ...(id === 'old' ? { analysisVersion: 'local-v1' } : {}) });
    store.put('segmentEmbeddings', { id: s.id, townshipId: s.townshipId, videoId: id, model: 'test-embedding', digest, dimension: 3, vector: [1, 0, 0], contentHash: contentHash(segmentText(s)) });
  }
  let r = await call('/video-search', manager, { query: 'red shirt', mode: 'semantic' }); assert.ok(r.value.results.every((s: any) => ['red-segment', 'blue-segment'].includes(s.id)));
  r = await call('/video-search', manager, { query: 'red shirt', mode: 'semantic', timeFrom: '2026-10-14T12:00:15Z', timeTo: '2026-10-14T12:01:00Z' }); assert.equal(r.value.results.length, 0);
  digest = 'sha256:changed'; r = await call('/video-search', manager, { query: 'red', mode: 'semantic' }); assert.equal(r.value.results.length, 0); assert.ok(r.value.coverage.pendingSegments >= 2); digest = 'sha256:test-one';
});
test('missing index is distinguished from unanalysed footage, and analysis upgrade is queueable', async () => {
  video('pending-video'); segment('pending-segment', 'pending-video', 'Someone walks.');
  video('fixture-upgrade', { analysisMode: 'fixture', analysisVersion: 'local-v1', mediaId: 'missing' });
  const r = await call('/video-search', manager, { query: 'red', mode: 'semantic' });
  assert.ok(r.value.coverage.pendingSegments >= 1); assert.ok(r.value.coverage.unanalysedVideos >= 1);
});
test('embedding redirects cannot send local query content to a remote endpoint', async () => {
  redirect = true; const r = await call('/video-search', manager, { query: 'red', mode: 'semantic' }); redirect = false;
  assert.equal(r.status, 503); assert.match(r.value.error, /No cloud fallback/);
});
test('membership revocation while embedding is in flight prevents search results from being returned', async () => {
  duringEmbedding = () => { const u = store.get<any>('users', 'user_manager'); store.put('users', { ...u, membershipStatus: 'disabled' }); };
  const r = await call('/video-search', manager, { query: 'red', mode: 'semantic' }); duringEmbedding = undefined;
  assert.equal(r.status, 403); assert.equal(r.value.results, undefined);
  store.put('users', { ...store.get<any>('users', 'user_manager'), membershipStatus: 'active' });
});
test('actual MP4 sampling reaches VLM and indexes only after validated descriptions are persisted', async () => {
  const { runFfmpeg } = await import('../../apps/worker/src/video.ts');
  const engine = await import('../../apps/worker/src/engine.ts');
  const file = path.join(store.mediaDir, 'low-fps.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=8:d=2', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
  const v = video('http-vision-test', { status: 'queued', mediaId: 'http-vision-media', durationSec: 2 });
  store.put('media', { id: 'http-vision-media', townshipId: v.townshipId, videoId: v.id, kind: 'video', contentType: 'video/mp4', path: file });
  store.put('analysisJobs', { id: 'http-vision-job', townshipId: v.townshipId, videoId: v.id, status: 'queued', analysisVersion: engine.ANALYSIS_VERSION, attemptCount: 0, createdAt: store.now(), updatedAt: store.now() });
  assert.equal(await engine.processNextJob('vision-http-worker'), true);
  const job = store.get<any>('analysisJobs', 'http-vision-job'); assert.equal(job.status, 'completed', job.lastError); assert.equal(generatedImages, 1); assert.equal(generatedCalls, 4);
  const segments = indexer.activeSegments(store.get('videos', v.id)); assert.equal(segments.length, 1); assert.equal(segments[0].model, 'test-vision');
  assert.ok(segments[0].observations.every((o: any) => o.endSec <= 2)); assert.equal(store.get('segmentEmbeddings', segments[0].id), undefined);
  while (await indexer.processNextIndex('vision-index-worker')) { /* Finite local test queue. */ }
  assert.ok(store.get('segmentEmbeddings', segments[0].id));
});
test('retention removes semantic vectors and index jobs as well as descriptions', async () => {
  const engine = await import('../../apps/worker/src/engine.ts');
  const old = store.get<any>('videos', 'red-video'); store.put('videos', { ...old, expiresAt: '2020-01-01T00:00:00.000Z' });
  await engine.cleanupExpired();
  assert.equal(store.get('segmentEmbeddings', 'red-segment'), undefined); assert.equal(store.get('indexJobs', 'index_red-video'), undefined);
});
test('an interrupted index lease is recovered and a lost lease cannot commit vectors', async () => {
  const v = video('lease-recovery'); segment('lease-segment', v.id, 'A red shirt.');
  const job = indexer.queueIndex(v); store.put('indexJobs', { ...job, status: 'processing', attemptCount: 1, leaseOwner: 'crashed', leaseUntil: new Date(Date.now() - 1000).toISOString() });
  assert.equal(await indexer.processNextIndex('replacement'), true); assert.equal(store.get<any>('indexJobs', job.id).attemptCount, 2);
  const next = video('lease-loss'); segment('lease-loss-segment', next.id, 'A person.'); const lost = indexer.queueIndex(next);
  duringEmbedding = () => { const current = store.get<any>('indexJobs', lost.id); store.put('indexJobs', { ...current, leaseOwner: 'new-owner', leaseUntil: new Date(Date.now() + 30000).toISOString() }); };
  await indexer.processNextIndex('old-owner'); duringEmbedding = undefined;
  assert.equal(store.get<any>('indexJobs', lost.id).leaseOwner, 'new-owner'); assert.equal(store.get('segmentEmbeddings', 'lease-loss-segment'), undefined);
  store.put('indexJobs', { ...store.get<any>('indexJobs', lost.id), status: 'completed' });
});
test('invalid vectors, cloud model references and unregistered query zones fail explicitly', async () => {
  const { normalizeVector, modelDigest } = await import('../../packages/shared/local-ai.ts');
  for (const v of [[0, 0], [1, NaN], [Infinity, 1], 'invalid']) assert.throws(() => normalizeVector(v));
  await assert.rejects(modelDigest('qwen-model:cloud'), /Cloud model names are disabled/);
  const r = await call('/video-search', manager, { query: 'C区停车场红衣人', mode: 'semantic' }); assert.equal(r.status, 400);
});
test('explicit reanalysis upgrades a completed video while duplicate requests share the active job', async () => {
  const before = await call('/videos/http-vision-test/analyze', manager, {}); assert.equal(before.value.status, 'completed');
  const redo = await call('/videos/http-vision-test/analyze', manager, { reanalyze: true }); assert.equal(redo.status, 202); assert.equal(redo.value.status, 'queued');
  assert.notEqual(redo.value.id, before.value.id);
  const duplicate = await call('/videos/http-vision-test/analyze', manager, { reanalyze: true }); assert.equal(duplicate.value.id, redo.value.id);
  const engine = await import('../../apps/worker/src/engine.ts'); await engine.processNextJob('reanalyze-worker');
  assert.equal(store.get<any>('analysisJobs', redo.value.id).status, 'completed');
  assert.equal(indexer.activeSegments(store.get('videos', 'http-vision-test')).length, 1);
});
