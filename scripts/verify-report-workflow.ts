/** Read-only assertions after the synthetic workflow has been exercised through the browser. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
const base = 'http://127.0.0.1:4000/api', manifest = JSON.parse(await readFile('data/report-workflow-demo/manifest.json', 'utf8'));
const prior = existsSync('output/verification/report-workflow-smoke.json') ? JSON.parse(await readFile('output/verification/report-workflow-smoke.json', 'utf8')) : undefined;
const reportId = process.argv.find(a => a.startsWith('--report='))?.slice(9) || prior?.reportId || manifest.reportId;
async function login(email: string) {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'JagaLocal!2026' }) });
  assert.equal(r.status, 200); return r.headers.get('set-cookie')!.split(';')[0];
}
async function get(route: string, cookie: string) {
  const response = await fetch(`${base}${route}`, { headers: { cookie } });
  return { status: response.status, data: await response.json() };
}
const manager = await login('manager@jaga.local'), resident = await login('resident@jaga.local'), staff = await login('maintenance@jaga.local'), guard = await login('guard@jaga.local');
const retrieval = (await get(`/reports/${encodeURIComponent(reportId)}/retrieval`, manager)).data;
assert.equal(retrieval.job.status, 'completed'); assert.ok(retrieval.dispatch);
const approved = retrieval.candidates.find((c: any) => c.reviewStatus === 'approved'); assert.ok(approved); assert.equal(approved.startSec, 2); assert.equal(approved.endSec, 7);
const incident = (await get(`/incidents/${retrieval.dispatch.incidentId}`, manager)).data;
assert.equal(incident.status, 'closed'); assert.equal(incident.evidence.length, 1);
const evidence = incident.evidence[0]; assert.equal(evidence.reviewedClip, true); assert.equal(evidence.candidateId, approved.id);
const assignment = incident.assignments.find((a: any) => a.id === retrieval.dispatch.assignmentId); assert.equal(assignment.team, 'property'); assert.equal(assignment.status, 'resolved');
assert.ok(['accept', 'arrive', 'resolve', 'close'].every(action => incident.updates.some((u: any) => u.action === action)));
assert.equal((await get(`/reports/${encodeURIComponent(reportId)}/retrieval`, resident)).status, 403);
assert.equal((await get(`/reports/${encodeURIComponent(reportId)}/retrieval`, staff)).status, 403);
assert.equal((await get(`/media/${evidence.mediaId}/access`, guard)).status, 404);
const original = (await get(`/videos/${approved.videoId}`, manager)).data;
assert.equal((await get(`/media/${original.mediaId}/access`, staff)).status, 404);
const access = await get(`/media/${evidence.mediaId}/access`, staff); assert.equal(access.status, 200); assert.equal(access.data.isClip, true);
const playback = await fetch(new URL(access.data.url, base), { headers: { cookie: staff, Range: 'bytes=0-63' } }); assert.equal(playback.status, 206); assert.equal((await playback.arrayBuffer()).byteLength, 64);
const publicReport = (await get(`/reports/${encodeURIComponent(reportId)}`, resident)).data, publicIncident = (await get(`/incidents/${incident.id}`, resident)).data;
assert.equal(publicReport.status, 'resolved'); assert.equal(publicIncident.status, 'closed'); assert.deepEqual(publicIncident.evidence, []);
for (const hidden of [approved.id, evidence.mediaId, approved.reviewNote, assignment.instructions]) assert.ok(!JSON.stringify({ publicReport, publicIncident }).includes(hidden));
const bootstrap = (await get('/bootstrap', manager)).data, segments = bootstrap.segments.filter((s: any) => s.videoId === approved.videoId);
assert.ok(segments.length && segments.every((s: any) => s.analysisMode === 'ollama' && s.model === 'qwen3-vl:2b'));
const audits = (await get('/audit', manager)).data;
assert.ok(audits.some((a: any) => a.action === 'video.analyze' && a.targetId === approved.videoId && a.actorId === 'local-report-worker'));
const result = { verifiedAt: new Date().toISOString(), syntheticQAOnly: true, realWorldIncident: false, browserAutomatedReview: true,
  reportId, reportNumber: publicReport.number, videoId: approved.videoId, incidentId: incident.id, assignmentId: assignment.id,
  automaticRetrievalMs: Date.parse(retrieval.job.updatedAt) - Date.parse(publicReport.createdAt),
  originalDurationSec: original.durationSec, approvedSourceInterval: [approved.startSec, approved.endSec], models: segments.map((s: any) => ({ model: s.model, digest: s.modelDigest })),
  workerTriggeredAnalysisVerified: true, managerReviewRecorded: true, propertyTeamDispatched: true, completionAndClosureVerified: true,
  residentPrivateEvidenceHidden: true, propertyOriginalRecordingDenied: true, privateClipRangePlaybackVerified: true,
  publicUpdates: publicReport.publicUpdates, retrievalCoverage: retrieval.job.coverage };
await mkdir('output/verification', { recursive: true }); await writeFile('output/verification/report-workflow-smoke.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
