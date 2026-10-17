import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporary = mkdtempSync(path.join(os.tmpdir(), 'jagaai-report-workflow-'));
process.env.JAGAAI_DATA_DIR = temporary; process.env.AI_MODE = 'ollama';
process.env.OLLAMA_MODEL = 'workflow-vision'; process.env.OLLAMA_EMBEDDING_MODEL = 'workflow-embedding';
let server: Server, model: Server, base: string, manager: string, resident: string, guard: string, maintenance: string, outsider: string;
let store: typeof import('../../packages/shared/store.ts');
let retrieval: typeof import('../../apps/worker/src/report-retrieval.ts');
let engine: typeof import('../../apps/worker/src/engine.ts');
let indexer: typeof import('../../apps/worker/src/indexer.ts');
let videoTools: typeof import('../../apps/worker/src/video.ts');
let original: any, report: any, candidate: any, preview: any, dispatch: any;
let embedCalls = 0, visionCalls = 0, onEmbed: (() => void) | undefined, digest = 'embedding-v1';
const recordedAt = '2026-10-14T13:00:00.000Z';
async function call(route: string, cookie = manager, body?: any, method?: string) {
  const response = await fetch(`${base}${route}`, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { cookie, ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
  const value = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.arrayBuffer();
  return { status: response.status, value, response };
}
async function login(email: string) { const r = await call('/auth/login', '', { email, password: 'JagaLocal!2026' }); assert.equal(r.status, 200, JSON.stringify(r.value)); return r.response.headers.get('set-cookie')!.split(';')[0]; }
async function createReport(extra: any = {}) {
  const r = await call('/reports', resident, { locationId: 'loc_parking_b', category: 'maintenance', description: 'A person in red near a white car; inspect the parking area.',
    timeFrom: '2026-10-14T13:00:00.500Z', timeTo: '2026-10-14T13:00:01.500Z', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.value)); return r.value;
}
function jobFor(id: string) { return store.get<any>('reportSearchJobs', `retrieval_${id}`); }
function focus(id: string) {
  for (const job of store.list<any>('reportSearchJobs')) if (['queued', 'waiting_media', 'waiting_analysis', 'waiting_index'].includes(job.status)) store.put('reportSearchJobs', { ...job, nextAttemptAt: new Date(job.reportId === id ? 0 : Date.now() + 86400000).toISOString() });
}
async function runReport(id: string) { focus(id); assert.equal(await retrieval.processNextReportSearch('test-report-worker'), true); return jobFor(id); }
async function uploaded(cameraId = 'cam_parking_b') {
  const file = path.join(store.mediaDir, 'source-for-tests.mp4');
  if (!existsSync(file)) await videoTools.runFfmpeg(['-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=8:d=2', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
  const form = new FormData(); form.set('cameraId', cameraId); form.set('recordedAt', recordedAt); form.set('file', new Blob([readFileSync(file)], { type: 'video/mp4' }), 'test.mp4');
  const r = await call('/videos', manager, form); assert.equal(r.status, 201, JSON.stringify(r.value)); return r.value;
}
before(async () => {
  model = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'workflow-vision', digest: 'vision-v1' }, { name: 'workflow-embedding', digest }] })); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === '/api/chat') { visionCalls++; res.end(JSON.stringify({ done_reason: 'stop', message: { content: JSON.stringify({ description: 'A person in a red shirt is beside a white car.', uncertainty: 'Synthetic HTTP inference double; not an accuracy test.' }) } })); return; }
    if (req.url === '/api/embed') { embedCalls++; const hook = onEmbed; onEmbed = undefined; hook?.(); res.end(JSON.stringify({ embeddings: body.input.map(() => [1, 0, 0]) })); return; }
    res.end('{}');
  }).listen(0, '127.0.0.1'); await new Promise<void>(r => model.once('listening', r));
  process.env.OLLAMA_URL = `http://127.0.0.1:${(model.address() as any).port}`;
  const api = await import('../../apps/api/src/index.ts'); store = await import('../../packages/shared/store.ts');
  retrieval = await import('../../apps/worker/src/report-retrieval.ts'); engine = await import('../../apps/worker/src/engine.ts'); indexer = await import('../../apps/worker/src/indexer.ts'); videoTools = await import('../../apps/worker/src/video.ts');
  server = api.app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  manager = await login('manager@jaga.local'); resident = await login('resident@jaga.local'); guard = await login('guard@jaga.local'); maintenance = await login('maintenance@jaga.local'); outsider = await login('other@jaga.local');
});
after(async () => { await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => model.close(() => r()))]); store.db.close(); assert.equal(path.dirname(temporary), path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith('jagaai-report-workflow-')); rmSync(temporary, { recursive: true, force: true }); });

test('resident submission atomically queues a private, exact-location retrieval without waiting for AI', async () => {
  original = await uploaded(); report = await createReport();
  assert.equal(report.aiRetrieval.status, 'queued'); assert.equal(jobFor(report.id).status, 'queued');
  assert.equal(embedCalls, 0); assert.equal(visionCalls, 0);
  assert.equal(jobFor(report.id).scope.locationId, report.locationId); assert.equal(jobFor(report.id).scope.timeFrom, report.timeFrom);
  const bad = await call('/reports', resident, { category: 'maintenance', locationId: 'loc_parking_b', description: 'invalid range', timeFrom: '2026-01-01T00:00:00Z', timeTo: '2026-03-01T00:00:00Z' }); assert.equal(bad.status, 400);
});
test('report retrieval schedules real VLM analysis once, then waits for its independent index', async () => {
  assert.equal((await runReport(report.id)).status, 'waiting_analysis');
  const count = store.list<any>('analysisJobs').filter(j => j.videoId === original.id).length;
  await runReport(report.id); assert.equal(store.list<any>('analysisJobs').filter(j => j.videoId === original.id).length, count);
  assert.equal(embedCalls, 0); await engine.processNextJob('analysis-worker'); assert.equal(visionCalls, 4);
  assert.equal(store.get<any>('videos', original.id).status, 'completed');
  assert.equal((await runReport(report.id)).status, 'waiting_index');
  await indexer.processNextIndex('index-worker');
  assert.equal(jobFor(report.id).nextAttemptAt <= new Date().toISOString(), true);
  assert.equal((await runReport(report.id)).status, 'completed');
  const result = await call(`/reports/${report.id}/retrieval`); assert.equal(result.value.candidates.length, 1); candidate = result.value.candidates[0];
  assert.equal(candidate.startSec, 0.5); assert.equal(candidate.endSec, 1.5); assert.equal(candidate.reviewStatus, 'pending_review');
  assert.equal(store.list('reportDispatches').length, 0); assert.equal(store.get<any>('reports', report.id).incidentId, undefined);
});
test('resident, field staff and other townships cannot read or mutate candidate review data', async () => {
  for (const cookie of [resident, guard, maintenance, outsider]) {
    assert.equal((await call(`/reports/${report.id}/retrieval`, cookie)).status, 403);
    assert.equal((await call(`/reports/${report.id}/candidates/${candidate.id}/view`, cookie, {})).status, 403);
    assert.equal((await call(`/reports/${report.id}/retrieval`, cookie, {})).status, 403);
  }
  assert.equal((await call('/reports/report_other/retrieval')).status, 404);
  const publicReport = (await call(`/reports/${report.id}`, resident)).value;
  assert.equal(publicReport.aiRetrieval.status, 'awaiting_review'); assert.equal(publicReport.candidates, undefined); assert.equal(publicReport.scope, undefined);
  assert.ok(!JSON.stringify((await call('/bootstrap', resident)).value).includes(candidate.id));
});
test('dispatch is blocked until a human has opened and approved the clip', async () => {
  const payload = { candidateIds: [candidate.id], assigneeId: 'user_maintenance', title: 'Inspect test parking', instructions: 'Inspect the parking area.' };
  assert.equal((await call(`/reports/${report.id}/dispatch`, manager, payload)).status, 409);
  assert.equal((await call(`/reports/${report.id}/candidates/${candidate.id}/review`, manager, { decision: 'approve', note: 'Reviewed', reviewed: true, receipt: 'fabricated' })).status, 403);
  assert.equal(store.get<any>('reports', report.id).incidentId, undefined);
});
test('preview creates an authorised bounded clip and a reviewer-session-bound receipt', async () => {
  const r = await call(`/reports/${report.id}/candidates/${candidate.id}/view`, manager, {}); assert.equal(r.status, 200, JSON.stringify(r.value)); preview = r.value;
  const media = store.get<any>('media', preview.video.mediaId), probe = await videoTools.probeVideo(media.path);
  assert.ok(probe.durationSec <= 1.1); assert.equal(media.sourceStartSec, 0.5); assert.notEqual(media.id, original.mediaId);
  for (const cookie of [resident, guard, maintenance]) assert.equal((await call(`/media/${media.id}/access`, cookie)).status, 404);
  const secondSession = await login('manager@jaga.local');
  const body = { decision: 'approve', note: 'Reviewed privately', reviewed: true, receipt: preview.receipt };
  assert.equal((await call(`/reports/${report.id}/candidates/${candidate.id}/review`, secondSession, body)).status, 403);
  assert.equal((await call(`/reports/${report.id}/candidates/${candidate.id}/review`, manager, { ...body, reviewed: false })).status, 400);
});
test('changed descriptions invalidate an earlier review receipt and cannot attach stale candidates', async () => {
  const old = store.get<any>('segments', candidate.segmentId); store.put('segments', { ...old, summary: `${old.summary} changed` });
  assert.equal((await call(`/reports/${report.id}/candidates/${candidate.id}/review`, manager, { decision: 'approve', note: 'Human note', reviewed: true, receipt: preview.receipt })).status, 409);
  store.put('segments', old);
  const camera = store.get<any>('cameras', 'cam_parking_b'); store.put('cameras', { ...camera, locationId: 'loc_north' });
  assert.equal((await call(`/reports/${report.id}/candidates/${candidate.id}/view`, manager, {})).status, 409); store.put('cameras', camera);
});
test('human approval is audited and cannot be silently overturned', async () => {
  const body = { decision: 'approve', note: 'INTERNAL-REVIEW-4821: relevant colour and proximity; responsibility unknown.', reviewed: true, receipt: preview.receipt };
  const r = await call(`/reports/${report.id}/candidates/${candidate.id}/review`, manager, body); assert.equal(r.status, 200); assert.equal(r.value.reviewedBy, 'user_manager');
  assert.equal((await call(`/reports/${report.id}/candidates/${candidate.id}/review`, manager, body)).status, 200);
  assert.equal((await call(`/reports/${report.id}/candidates/${candidate.id}/review`, manager, { ...body, note: 'Changed review meaning' })).status, 409);
  assert.equal((await call(`/reports/${report.id}/candidates/${candidate.id}/review`, manager, { ...body, decision: 'dismiss' })).status, 409);
});
test('invalid dispatch assignees roll back incident creation, evidence grants and report linking together', async () => {
  const before = store.list('incidents').length;
  const r = await call(`/reports/${report.id}/dispatch`, manager, { candidateIds: [candidate.id], assigneeId: 'user_resident', title: 'Inspect synthetic parking', instructions: 'Onsite inspection needed.' });
  assert.equal(r.status, 400); assert.equal(store.list('incidents').length, before);
  assert.equal(store.get<any>('media', preview.video.mediaId).incidentId, undefined); assert.equal(store.get<any>('reports', report.id).incidentId, undefined);
});
test('approved evidence, case link and property work order commit once on repeated dispatch', async () => {
  const payload = { candidateIds: [candidate.id], assigneeId: 'user_maintenance', title: 'Inspect synthetic parking', category: 'maintenance', priority: 'normal', instructions: 'PRIVATE-WORK-7391: inspect the area and verify the resident report.' };
  const r = await call(`/reports/${report.id}/dispatch`, manager, payload); assert.equal(r.status, 201, JSON.stringify(r.value)); dispatch = r.value;
  assert.equal(dispatch.assignment.team, 'property'); assert.equal(dispatch.incident.evidence.length, 1); assert.equal(dispatch.incident.evidence[0].mediaId, preview.video.mediaId);
  const repeated = await call(`/reports/${report.id}/dispatch`, manager, payload); assert.equal(repeated.status, 200); assert.equal(repeated.value.assignment.id, dispatch.assignment.id);
  assert.equal(store.list<any>('incidentEvidence').filter(e => e.candidateId === candidate.id).length, 1);
  assert.equal(store.list<any>('assignments').filter(a => a.incidentId === dispatch.incident.id).length, 1);
  const residentView = JSON.stringify((await call(`/incidents/${dispatch.incident.id}`, resident)).value);
  assert.ok(!residentView.includes('INTERNAL-REVIEW-4821')); assert.ok(!residentView.includes('PRIVATE-WORK-7391')); assert.ok(!residentView.includes(preview.video.mediaId));
});
test('property staff can play only the assigned approved clip, and reassignment revokes old tickets', async () => {
  assert.equal((await call(`/incidents/${dispatch.incident.id}`, maintenance)).status, 200);
  assert.equal((await call('/videos', maintenance)).status, 403); assert.equal((await call('/video-search', maintenance, { query: 'red' })).status, 403);
  assert.equal((await call(`/media/${original.mediaId}/access`, maintenance)).status, 404);
  const ticket = await call(`/media/${preview.video.mediaId}/access`, maintenance); assert.equal(ticket.status, 200);
  const content = await fetch(new URL(ticket.value.url, base), { headers: { cookie: maintenance, Range: 'bytes=0-63' } }); assert.equal(content.status, 206); assert.equal((await content.arrayBuffer()).byteLength, 64);
  assert.equal((await call(`/media/${preview.video.mediaId}/access`, guard)).status, 404);
  const member = store.get<any>('users', 'user_maintenance'); store.put('users', { ...member, id: 'replacement_property', email: 'replacement@jaga.local' });
  assert.equal((await call(`/incidents/${dispatch.incident.id}/assignments`, manager, { assigneeId: 'replacement_property' })).status, 201);
  assert.equal((await call(ticket.value.url.replace(/^\/api/, ''), maintenance)).status, 404);
  maintenance = await login('replacement@jaga.local');
});
test('property completion and management closure update the resident without exposing private footage', async () => {
  for (const action of ['accept', 'arrive', 'resolve']) assert.equal((await call(`/incidents/${dispatch.incident.id}/updates`, maintenance, { action, note: `Synthetic property ${action}.`, visibility: 'public' })).status, 200);
  assert.equal((await call(`/incidents/${dispatch.incident.id}/updates`, manager, { action: 'close', note: 'Property result reviewed.', visibility: 'public' })).status, 200);
  const result = (await call(`/reports/${report.id}`, resident)).value; assert.equal(result.status, 'resolved'); assert.ok(result.publicUpdates.length > 2);
  assert.equal((await call(`/reports/${report.id}/retrieval`, manager, {})).status, 409);
});
test('no camera footage stays in a waiting state and a later upload wakes the durable report job', async () => {
  const waiting = await createReport({ locationId: 'loc_club' }); assert.equal((await runReport(waiting.id)).status, 'waiting_media');
  assert.equal(await retrieval.processNextReportSearch('worker-no-spin'), false);
  const retry = await call(`/reports/${waiting.id}/retrieval`, manager, {}); assert.equal(retry.value.id, jobFor(waiting.id).id); assert.ok(Date.parse(retry.value.nextAttemptAt) <= Date.now());
  await uploaded('cam_club'); assert.ok(Date.parse(jobFor(waiting.id).nextAttemptAt) <= Date.now());
  assert.equal((await runReport(waiting.id)).status, 'waiting_analysis');
  store.put('reportSearchJobs', { ...jobFor(waiting.id), status: 'cancelled' });
});
test('closing a report during async search cancels publication, and live leases cannot be stolen', async () => {
  const next = await createReport();
  onEmbed = () => { store.put('reports', { ...store.get<any>('reports', next.id), status: 'rejected' }); };
  assert.equal((await runReport(next.id)).status, 'cancelled'); assert.equal(store.list<any>('reportCandidates').filter(c => c.reportId === next.id).length, 0);
  const leased = await createReport(); const job = jobFor(leased.id);
  store.put('reportSearchJobs', { ...job, status: 'processing', leaseOwner: 'live-owner', leaseUntil: new Date(Date.now() + 30000).toISOString() });
  assert.equal(await retrieval.processNextReportSearch('competing-owner'), false);
  store.put('reportSearchJobs', { ...jobFor(leased.id), leaseUntil: new Date(Date.now() - 1000).toISOString() });
  assert.equal(await retrieval.processNextReportSearch('replacement-owner'), true); assert.equal(jobFor(leased.id).status, 'completed');
});
test('embedding model changes rebuild a stale index before publishing new report candidates', async () => {
  digest = 'embedding-v2'; const next = await createReport();
  assert.equal((await runReport(next.id)).status, 'waiting_index'); assert.equal(jobFor(next.id).attemptCount, 0);
  await indexer.processNextIndex('model-upgrade-indexer'); assert.equal((await runReport(next.id)).status, 'completed');
  const current = store.list<any>('segmentEmbeddings').find(e => e.videoId === original.id); assert.equal(current.digest, digest);
});
test('camera registration is applied before vector ranking so invalid cameras cannot consume the top results', async () => {
  const segment = store.list<any>('segments').find(s => s.videoId === original.id), embedding = store.get<any>('segmentEmbeddings', segment.id), source = store.get<any>('videos', original.id);
  store.put('segmentEmbeddings', { ...embedding, vector: [0, 1, 0] });
  for (let i = 0; i < 10; i++) {
    store.put('videos', { ...source, id: `invalid-video-${i}`, cameraId: `unregistered-${i}` });
    store.put('segments', { ...segment, id: `invalid-segment-${i}`, videoId: `invalid-video-${i}`, cameraId: `unregistered-${i}` });
    store.put('segmentEmbeddings', { ...embedding, id: `invalid-segment-${i}`, segmentId: `invalid-segment-${i}`, videoId: `invalid-video-${i}`, vector: [1, 0, 0] });
  }
  const next = await createReport(); const job = await runReport(next.id); assert.equal(job.status, 'completed');
  const matches = (await call(`/reports/${next.id}/retrieval`)).value.candidates; assert.equal(matches.length, 1); assert.equal(matches[0].videoId, original.id);
  for (let i = 0; i < 10; i++) { store.remove('videos', `invalid-video-${i}`); store.remove('segments', `invalid-segment-${i}`); store.remove('segmentEmbeddings', `invalid-segment-${i}`); }
  store.put('segmentEmbeddings', embedding);
});
test('a dismissed candidate cannot be dispatched; a fresh reviewed generation can link an existing incident', async () => {
  const next = await createReport(); await runReport(next.id);
  let c = (await call(`/reports/${next.id}/retrieval`)).value.candidates[0];
  let viewed = (await call(`/reports/${next.id}/candidates/${c.id}/view`, manager, {})).value;
  assert.equal((await call(`/reports/${next.id}/candidates/${c.id}/review`, manager, { decision: 'dismiss', reviewed: true, note: 'Synthetic unrelated candidate.', receipt: viewed.receipt })).status, 200);
  assert.equal((await call(`/reports/${next.id}/dispatch`, manager, { candidateIds: [c.id], assigneeId: 'user_maintenance', title: 'Inspect parking report', instructions: 'Inspection.' })).status, 409);
  assert.equal((await call(`/reports/${next.id}`, resident)).value.status, 'submitted');
  await call(`/reports/${next.id}/retrieval`, manager, {}); await runReport(next.id);
  assert.equal((await call(`/reports/${next.id}/candidates/${c.id}/view`, manager, {})).status, 409);
  c = (await call(`/reports/${next.id}/retrieval`)).value.candidates[0]; viewed = (await call(`/reports/${next.id}/candidates/${c.id}/view`, manager, {})).value;
  await call(`/reports/${next.id}/candidates/${c.id}/review`, manager, { decision: 'approve', reviewed: true, note: 'Synthetic reviewed candidate for existing case.', receipt: viewed.receipt });
  const existing = (await call('/incidents', manager, { title: 'Existing property inspection', category: 'maintenance', locationId: 'loc_parking_b' })).value;
  const count = store.list('incidents').length;
  const result = await call(`/reports/${next.id}/dispatch`, manager, { candidateIds: [c.id], incidentId: existing.id, assigneeId: 'user_maintenance', instructions: 'Follow up the linked resident report.' });
  assert.equal(result.status, 201, JSON.stringify(result.value)); assert.equal(result.value.incident.id, existing.id); assert.equal(store.list('incidents').length, count);
});
test('expired recordings remove preview files and AI text while preserving the human case history', async () => {
  const media = store.get<any>('media', preview.video.mediaId);
  store.put('videos', { ...store.get<any>('videos', original.id), expiresAt: '2020-01-01T00:00:00Z' }); await engine.cleanupExpired();
  assert.equal(existsSync(media.path), false); assert.equal(store.get<any>('reportCandidates', candidate.id).summary, undefined);
  assert.equal(store.get<any>('reportCandidates', candidate.id).reviewStatus, 'approved'); assert.ok(store.get<any>('reportCandidates', candidate.id).expiredAt);
  const evidence = store.get<any>('incidentEvidence', `evidence_${candidate.id}`); assert.equal(evidence.aiSummary, undefined); assert.equal(evidence.unavailable, true);
  assert.equal((await call(`/reports/${report.id}/candidates/${candidate.id}/view`, manager, {})).status, 410);
});
