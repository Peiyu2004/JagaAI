/** Creates labelled local QA data only. It never approves evidence or dispatches a work order. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
const base = 'http://127.0.0.1:4000/api', directory = 'data/report-workflow-demo', manifestPath = `${directory}/manifest.json`;
async function login(email: string) {
  const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'JagaLocal!2026' }) });
  assert.equal(response.status, 200); return response.headers.get('set-cookie')!.split(';')[0];
}
const manager = await login('manager@jaga.local'), resident = await login('resident@jaga.local');
async function request(route: string, cookie: string, body?: any) {
  const response = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
}
const ai = await request('/ai/status', manager); assert.ok(ai.visionReady && ai.embeddingReady, 'Install both local models before creating this demo.');
let manifest: any = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : {};
if (!manifest.videoId) {
  const source = 'data/semantic-demo/synthetic-red-white.mp4';
  assert.ok(existsSync(source), 'First prepare the labelled animation with npm run demo:semantic.');
  const localDay = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), recordedAt = new Date(Date.parse(`${localDay}T21:00:00+08:00`) - 86400000).toISOString();
  const form = new FormData(); form.set('cameraId', 'cam_parking_b'); form.set('recordedAt', recordedAt); form.set('title', 'Synthetic resident-triggered retrieval test');
  form.set('file', new Blob([await readFile(source)], { type: 'video/mp4' }), 'synthetic-report-retrieval.mp4');
  const video = await request('/videos', manager, form); manifest = { synthetic: true, videoId: video.id, recordedAt, originalDurationSec: video.durationSec };
  console.log(`Uploaded ${video.id}. No manual analysis request was sent.`);
}
if (!manifest.reportId || process.argv.includes('--new-report')) {
  const report = await request('/reports', resident, { locationId: 'loc_parking_b', category: 'maintenance',
    timeFrom: new Date(Date.parse(manifest.recordedAt) + 2000).toISOString(), timeTo: new Date(Date.parse(manifest.recordedAt) + 7000).toISOString(),
    description: '[Synthetic workflow demo] A person in red clothing is near a white vehicle in Zone B Parking. Please inspect the parking area. Damage and responsibility are unknown.' });
  manifest = { ...manifest, reportId: report.id, reportNumber: report.number, createdAt: new Date().toISOString() };
  await mkdir(directory, { recursive: true }); await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Resident report ${report.number} submitted; automatic retrieval is ${report.aiRetrieval.status}.`);
}
let last = '', result: any;
for (let attempt = 0; attempt < 120; attempt++) {
  result = await request(`/reports/${manifest.reportId}/retrieval`, manager);
  const state = JSON.stringify({ status: result.job?.status, message: result.job?.message, error: result.job?.lastError });
  if (state !== last) { console.log(state); last = state; }
  if (result.job?.status === 'completed') break;
  if (['failed', 'cancelled'].includes(result.job?.status)) throw Error(state);
  await sleep(5000);
}
assert.equal(result.job?.status, 'completed', 'The worker did not finish within 10 minutes.');
assert.ok(result.candidates.length > 0, 'No candidate footage was available.');
assert.ok(result.candidates.every((c: any) => c.startSec >= 2 && c.endSec <= 7));
manifest.candidateIds = result.candidates.map((c: any) => c.id); manifest.readyAt = new Date().toISOString();
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`Ready for manual review: ${manifest.reportNumber}, ${result.candidates.length} candidate clip(s), bounded to 2–7s of the original 8s animation.`);
