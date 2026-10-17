import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';

const temporary = mkdtempSync(path.join(os.tmpdir(), 'jagaai-api-test-'));
process.env.JAGAAI_DATA_DIR = temporary;
process.env.AI_MODE = 'fixture';
let server: Server;
let base: string;
let manager: string;
let guard: string;
let resident: string;
let outsider: string;
let report: any;
let incident: any;
let evidenceIncidentId: string;
let store: typeof import('../../packages/shared/store.ts');

async function call(route: string, cookie = '', body?: any, method?: string) {
  const headers: Record<string,string> = cookie ? { cookie } : {};
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}${route}`, {
    method: method || (body === undefined ? 'GET' : 'POST'), headers,
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body)
  });
  const contentType = response.headers.get('content-type') || '';
  const value = contentType.includes('application/json') ? await response.json() : await response.arrayBuffer();
  return { status: response.status, value, response };
}
async function login(email: string) {
  const res = await call('/auth/login', '', { email, password: 'JagaLocal!2026' });
  assert.equal(res.status, 200, JSON.stringify(res.value));
  const cookie = res.response.headers.get('set-cookie');
  assert.ok(cookie?.includes('HttpOnly'));
  return cookie!.split(';')[0];
}
before(async () => {
  const api = await import('../../apps/api/src/index.ts');
  store = await import('../../packages/shared/store.ts');
  server = api.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}/api`;
  manager = await login('manager@jaga.local');
  guard = await login('guard@jaga.local');
  resident = await login('resident@jaga.local');
  const other = store.get<any>('users', 'user_other');
  outsider = await login(other.email);
});
after(async () => {
  if (server) await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
  store?.db.close();
  // The resolved target is an OS temporary directory created by this suite.
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('jagaai-api-test-'));
  rmSync(temporary, { recursive: true, force: true });
});

test('requires authentication and rejects invalid credentials', async () => {
  assert.equal((await call('/bootstrap')).status, 401);
  assert.equal((await call('/auth/login', '', {email:'manager@jaga.local',password:'incorrect'})).status, 401);
  assert.equal((await call('/me', resident)).value.role, 'resident');
});

test('resident report validates fields and stores a private photograph', async () => {
  const bad = new FormData();
  bad.set('category','maintenance'); bad.set('locationId','loc_north'); bad.set('description','');
  assert.equal((await call('/reports', resident, bad)).status, 400);
  const form = new FormData();
  form.set('category','maintenance'); form.set('locationId','loc_north');
  form.set('timeFrom',new Date(Date.now()-3600000).toISOString());
  form.set('timeTo',new Date().toISOString());
  form.set('description','Lamp near North Gate is flickering. Please inspect it.');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/a5eEAAAAASUVORK5CYII=', 'base64');
  form.append('photos',new Blob([png],{type:'image/png'}),'lamp.png');
  const res = await call('/reports', resident, form);
  assert.equal(res.status,201,JSON.stringify(res.value));
  report = res.value;
  assert.equal(report.status,'submitted');
  assert.equal(report.photoIds.length,1);
  assert.ok((await call('/reports',manager)).value.some((r:any)=>r.id===report.id));
});

test('report visibility is constrained by owner, assignment and township', async () => {
  assert.equal((await call(`/reports/${report.id}`,resident)).status,200);
  assert.ok([403,404].includes((await call(`/reports/${report.id}`,guard)).status));
  assert.ok([403,404].includes((await call(`/reports/${report.id}`,outsider)).status));
  const photo = await call(`/media/${report.photoIds[0]}/access`,resident);
  assert.equal(photo.status,200,JSON.stringify(photo.value));
  const route = photo.value.url.replace(/^\/api/,'');
  assert.equal((await call(route,resident)).status,200);
  assert.ok([401,403,404].includes((await call(route)).status));
  assert.ok([403,404].includes((await call(route,guard)).status));
});

test('another resident in the same township cannot access the report or photograph',async()=>{
  const source=store.get<any>('users','user_resident');
  store.put('users',{...source,id:'user_second_resident',email:'second@jaga.local',name:'Synthetic second resident'});
  const second=await login('second@jaga.local');
  assert.equal((await call(`/reports/${report.id}`,second)).status,404);
  assert.equal((await call(`/media/${report.photoIds[0]}/access`,second)).status,404);
  assert.ok(!(await call('/reports',second)).value.some((r:any)=>r.id===report.id));
});

test('management links and assigns exactly one official incident', async () => {
  const create = await call('/incidents',manager,{title:'Inspect North Gate lamp',category:'maintenance',locationId:'loc_north',priority:'normal',reportId:report.id});
  assert.equal(create.status,201,JSON.stringify(create.value));
  incident=create.value;
  const assigned=await call(`/incidents/${incident.id}/assignments`,manager,{assigneeId:'user_guard'});
  assert.ok([200,201].includes(assigned.status),JSON.stringify(assigned.value));
  assert.equal((await call(`/reports/${report.id}`,resident)).value.incidentId,incident.id);
  const invalid = await call(`/incidents/${incident.id}/assignments`,resident,{assigneeId:'user_guard'});
  assert.ok([403,404].includes(invalid.status));
});

test('guard state transitions and management close produce resident feedback', async () => {
  const prematurely=await call(`/incidents/${incident.id}/updates`,guard,{action:'resolve',note:'Done',visibility:'public'});
  assert.ok([400,409].includes(prematurely.status));
  for (const [action,note] of [['accept','I am taking this task.'],['arrive','At the North Gate.'],['resolve','Lamp repaired and tested.']]) {
    const result=await call(`/incidents/${incident.id}/updates`,guard,{action,note,visibility:'public'});
    assert.equal(result.status,200,JSON.stringify(result.value));
  }
  assert.ok([403,404].includes((await call(`/incidents/${incident.id}/updates`,guard,{action:'close',note:'close',visibility:'public'})).status));
  assert.equal((await call(`/incidents/${incident.id}/updates`,manager,{action:'close',note:'Repair reviewed.',visibility:'public'})).status,200);
  assert.equal((await call(`/incidents/${incident.id}`,manager)).value.status,'closed');
  const publicReport=(await call(`/reports/${report.id}`,resident)).value;
  assert.ok(JSON.stringify(publicReport).includes('Lamp repaired and tested'));
});

test('internal incident notes never leak through resident endpoints', async () => {
  const marker='INTERNAL-ONLY-PRIVATE-TEST-4831';
  assert.equal((await call(`/incidents/${incident.id}/updates`,manager,{action:'note',note:marker,visibility:'internal'})).status,200);
  for (const route of ['/bootstrap','/reports',`/reports/${report.id}`,'/incidents',`/incidents/${incident.id}`]) {
    const result=await call(route,resident);
    assert.ok(!JSON.stringify(result.value).includes(marker),`internal note leaked through ${route}`);
  }
});

test('residents and guards cannot browse CCTV or global search', async () => {
  for (const cookie of [resident,guard]) {
    assert.equal((await call('/video-search',cookie,{query:'person'})).status,403);
    assert.equal((await call('/videos',cookie)).status,403);
    assert.equal((await call('/audit',cookie)).status,403);
    const boot=(await call('/bootstrap',cookie)).value;
    assert.equal((boot.videos || []).length,0);
    assert.equal((boot.segments || []).length,0);
  }
});

test('simultaneous activity registrations do not exceed capacity', async () => {
  const create=await call('/activities',manager,{title:'Capacity test session',type:'safety_training',description:'Synthetic integration activity.',locationId:'loc_club',startAt:new Date(Date.now()+3600000).toISOString(),endAt:new Date(Date.now()+7200000).toISOString(),capacity:1,points:30});
  assert.equal(create.status,201,JSON.stringify(create.value));
  const activity=create.value;
  const attempts=await Promise.all([call(`/activities/${activity.id}/register`,resident,{}),call(`/activities/${activity.id}/register`,guard,{})]);
  assert.equal(attempts.filter(r=>r.status===200||r.status===201).length,1,JSON.stringify(attempts));
  assert.equal(store.list<any>('registrations','township_serenia').filter(r=>r.activityId===activity.id&&r.status==='registered').length,1);
});

test('repeated attendance verification creates one points ledger entry', async () => {
  const activityId='activity_integration_attendance';
  store.put('activities',{id:activityId,townshipId:'township_serenia',title:'Past synthetic training',type:'safety_training',locationId:'loc_club',startAt:new Date(Date.now()-7200000).toISOString(),endAt:new Date(Date.now()-3600000).toISOString(),capacity:5,points:30,status:'published',createdAt:store.now()});
  store.put('registrations',{id:`${activityId}_user_resident`,townshipId:'township_serenia',activityId,userId:'user_resident',status:'registered',createdAt:store.now()});
  const results=await Promise.all([call(`/activities/${activityId}/attendance`,manager,{userId:'user_resident'}),call(`/activities/${activityId}/attendance`,manager,{userId:'user_resident'})]);
  assert.ok(results.every(r=>r.status===200),JSON.stringify(results));
  const txns=store.list<any>('pointTransactions','township_serenia').filter(t=>t.activityId===activityId&&t.userId==='user_resident');
  assert.equal(txns.length,1);
  assert.equal(txns[0].delta,30);
  assert.ok((await call('/me/points',resident)).value.some((t:any)=>t.id===txns[0].id));
});

test('cancelling an awarded activity preserves the award and records one reversal',async()=>{
  const activityId='activity_integration_attendance';
  assert.equal((await call(`/activities/${activityId}/cancel`,manager,{reason:'Synthetic correction after award.'})).status,200);
  const ledger=store.list<any>('pointTransactions','township_serenia').filter(t=>t.activityId===activityId&&t.userId==='user_resident');
  assert.equal(ledger.filter(t=>t.delta===30).length,1);
  assert.equal(ledger.filter(t=>t.delta===-30).length,1);
  assert.equal(ledger.reduce((total,t)=>total+t.delta,0),0);
  await call(`/activities/${activityId}/cancel`,manager,{reason:'Repeated cancellation.'});
  assert.equal(store.list<any>('pointTransactions','township_serenia').filter(t=>t.activityId===activityId&&t.userId==='user_resident'&&t.delta<0).length,1);
});

test('cancelled activities and future attendance do not award points', async () => {
  const create=await call('/activities',manager,{title:'Future synthetic event',type:'briefing',description:'Cancelled event test.',locationId:'loc_club',startAt:new Date(Date.now()+3600000).toISOString(),endAt:new Date(Date.now()+7200000).toISOString(),capacity:3,points:10});
  const activity=create.value;
  await call(`/activities/${activity.id}/register`,resident,{});
  const future=await call(`/activities/${activity.id}/attendance`,manager,{userId:'user_resident'});
  assert.ok([400,409].includes(future.status));
  assert.equal((await call(`/activities/${activity.id}/cancel`,manager,{reason:'Synthetic test cancellation'})).status,200);
  const cancelled=await call(`/activities/${activity.id}/attendance`,manager,{userId:'user_resident'});
  assert.ok([400,409].includes(cancelled.status));
});

test('deactivation invalidates existing login sessions and issued media tickets', async () => {
  const ticket=await call(`/media/${report.photoIds[0]}/access`,resident);
  assert.equal(ticket.status,200);
  assert.equal((await call('/members/user_resident',manager,{membershipStatus:'disabled'},'PATCH')).status,200);
  assert.ok([401,403].includes((await call('/me',resident)).status));
  assert.ok([401,403].includes((await call(ticket.value.url.replace(/^\/api/,''),resident)).status));
  assert.equal((await call('/members/user_resident',manager,{membershipStatus:'active'},'PATCH')).status,200);
  resident=await login('resident@jaga.local');
});

test('member records never disclose password material', async () => {
  const members=await call('/members',manager);
  assert.equal(members.status,200);
  assert.ok(!JSON.stringify(members.value).includes('passwordHash'));
  assert.ok(!JSON.stringify((await call('/bootstrap',manager)).value).includes('passwordHash'));
  assert.equal((await call('/members/user_manager',manager,{membershipStatus:'disabled'},'PATCH')).status,409);
});

test('cross-site mutations and non-local Host headers are rejected',async()=>{
  const response=await fetch(`${base}/incidents`,{method:'POST',headers:{cookie:manager,'Content-Type':'application/json',Origin:'https://external.example'},body:JSON.stringify({title:'forged',category:'maintenance',locationId:'loc_north'})});
  assert.equal(response.status,403);
  const hostStatus=await new Promise<number|undefined>((resolve,reject)=>{
    const request=httpRequest(`${base}/health`,{headers:{Host:'external.example'}},response=>{response.resume();resolve(response.statusCode);});
    request.once('error',reject);request.end();
  });
  assert.equal(hostStatus,403);
});

test('bad video format cannot enter the analysis queue', async () => {
  const form=new FormData();
  form.set('cameraId','cam_north'); form.set('recordedAt',new Date().toISOString());
  form.append('file',new Blob(['this is not MP4'],{type:'video/mp4'}),'fake.mp4');
  const res=await call('/videos',manager,form);
  assert.equal(res.status,400,JSON.stringify(res.value));
});

test('relative-time search explicitly requests confirmation', async () => {
  const search=await call('/video-search',manager,{query:'person walking yesterday'});
  assert.equal(search.status,200,JSON.stringify(search.value));
  assert.equal(search.value.needsConfirmation,true);
  assert.ok(search.value.parsed?.timeFrom);
});

test('synthetic footage produces real searchable timestamps, merged alerts and restricted guard clips',async()=>{
  const {createFixtures}=await import('../../scripts/create-fixtures.ts');
  const {processNextJob}=await import('../../apps/worker/src/engine.ts');
  const {probeVideo}=await import('../../apps/worker/src/video.ts');
  await createFixtures();
  while (await processNextJob('integration-video-worker')) { /* Bounded fixture queue of three jobs. */ }
  assert.equal(store.list<any>('segments','township_serenia').length,7);
  assert.equal(store.list<any>('alerts','township_serenia').length,2);
  assert.ok(store.list<any>('analysisJobs','township_serenia').every(j=>j.status==='completed'));
  const bicycle=store.get<any>('videos','video_fixture_bicycle');
  const search=await call('/video-search',manager,{query:'bicycle',locationId:'loc_club',timeFrom:bicycle.recordedAt,timeTo:new Date(Date.parse(bicycle.recordedAt)+60000).toISOString()});
  assert.equal(search.status,200);
  assert.equal(search.value.results.length,2);
  assert.ok(search.value.results.every((r:any)=>r.videoId===bicycle.id&&r.analysisMode==='fixture'));
  for (const result of search.value.results) assert.equal(Date.parse(result.absoluteStartAt),Date.parse(result.video.recordedAt)+result.startSec*1000);
  const alert=store.list<any>('alerts','township_serenia').find(a=>a.eventType==='possible_fall');
  const reviewed=await call(`/alerts/${alert.id}/review`,manager,{decision:'confirm'});
  assert.equal(reviewed.status,200,JSON.stringify(reviewed.value));
  evidenceIncidentId=reviewed.value.incidentId;
  assert.equal((await call(`/incidents/${reviewed.value.incidentId}/assignments`,manager,{assigneeId:'user_guard'})).status,201);
  const access=await call('/media/media_fixture_fall/access',guard);
  assert.equal(access.status,200,JSON.stringify(access.value));
  assert.equal(access.value.isClip,true);
  const clipId=access.value.url.match(/\/media\/([^/]+)\/content/)[1];
  assert.notEqual(clipId,'media_fixture_fall');
  const clip=store.get<any>('media',clipId);
  const meta=await probeVideo(clip.path);
  assert.ok(meta.durationSec<=3.1,`guard clip unexpectedly includes ${meta.durationSec} seconds`);
  const route=access.value.url.replace(/^\/api/,'');
  const response=await fetch(`${base}${route}`,{headers:{cookie:guard,Range:'bytes=0-63'}});
  assert.equal(response.status,206);
  assert.equal((await response.arrayBuffer()).byteLength,64);
  assert.ok([403,404].includes((await call(route,resident)).status));
  const managerAccess=await call('/media/media_fixture_fall/access',manager);
  assert.equal((await call(managerAccess.value.url.replace(/^\/api/,''),guard)).status,403);
  const queue=await call('/videos/video_fixture_fall/analyze',manager,{});
  assert.equal(queue.status,202);
  assert.equal(queue.value.status,'completed');
  assert.equal(store.list<any>('alerts','township_serenia').length,2);
  // A valid MP4 upload must enter the normal upload path, never the fixture path.
  const uploaded=new FormData(); uploaded.set('cameraId','cam_north'); uploaded.set('recordedAt',store.now());
  uploaded.append('file',new Blob([readFileSync(store.get<any>('media','media_fixture_walking').path)],{type:'video/mp4'}),'authorised-demo-copy.mp4');
  const upload=await call('/videos',manager,uploaded);
  assert.equal(upload.status,201,JSON.stringify(upload.value));
  assert.equal(upload.value.source,'upload');
  const noResult=await call('/video-search',manager,{query:'unmatchedspaceship'});
  assert.equal(noResult.value.results.length,0);
  assert.equal(noResult.value.coverage.unanalysedVideos,1);
  assert.match(noResult.value.notice,/not establish|not happen/);
});

test('reassignment revokes a previous guard’s incident and evidence access',async()=>{
  const oldAccess=await call('/media/media_fixture_fall/access',guard);
  assert.equal(oldAccess.status,200);
  for (const action of ['accept','arrive','resolve']) assert.equal((await call(`/incidents/${evidenceIncidentId}/updates`,guard,{action,note:`Synthetic ${action}`,visibility:'public'})).status,200);
  assert.equal((await call(`/incidents/${evidenceIncidentId}/updates`,manager,{action:'close',note:'Reviewed synthetic evidence.',visibility:'public'})).status,200);
  assert.equal((await call(`/incidents/${evidenceIncidentId}/updates`,manager,{action:'reopen',note:'Assign another staff member for follow-up.',visibility:'public'})).status,200);
  const source=store.get<any>('users','user_guard');
  store.put('users',{...source,id:'user_new_guard',email:'newguard@jaga.local',name:'Synthetic replacement guard'});
  const newGuard=await login('newguard@jaga.local');
  assert.equal((await call(`/incidents/${evidenceIncidentId}/assignments`,manager,{assigneeId:'user_new_guard'})).status,201);
  const marker='NEW-ASSIGNMENT-PRIVATE-ONLY-674';
  await call(`/incidents/${evidenceIncidentId}/updates`,manager,{action:'note',note:marker,visibility:'internal'});
  const oldIncident=await call(`/incidents/${evidenceIncidentId}`,guard);
  assert.equal(oldIncident.status,404);
  assert.ok(!JSON.stringify(oldIncident.value).includes(marker));
  assert.equal((await call('/media/media_fixture_fall/access',guard)).status,404);
  assert.ok([403,404].includes((await call(oldAccess.value.url.replace(/^\/api/,''),guard)).status));
  assert.equal((await call(`/incidents/${evidenceIncidentId}`,newGuard)).status,200);
  assert.equal((await call('/media/media_fixture_fall/access',newGuard)).status,200);
});

test('creating an incident cannot silently overturn a dismissed AI alert',async()=>{
  const alert=store.list<any>('alerts','township_serenia').find(a=>a.eventType==='prolonged_lying');
  assert.equal((await call(`/alerts/${alert.id}/review`,manager,{decision:'dismiss',reason:'Synthetic annotation excluded from this review.'})).status,200);
  const create=await call('/incidents',manager,{title:'Cannot reverse review implicitly',category:'safety',locationId:'loc_lake',priority:'normal',alertId:alert.id});
  assert.equal(create.status,409);
  assert.equal(store.get<any>('alerts',alert.id).reviewStatus,'dismissed');
});
