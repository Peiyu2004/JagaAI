import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,copyFileSync,writeFileSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import type {Server} from 'node:http';

const temporary=mkdtempSync(path.join(os.tmpdir(),'jagaai-privacy-'));
process.env.JAGAAI_DATA_DIR=temporary; process.env.AI_MODE='fixture';
let store:typeof import('../../packages/shared/store.ts'), worker:typeof import('../../apps/worker/src/privacy.ts');
let server:Server,base:string,manager:string,staff:string,resident:string,guard:string,outsider:string,otherResident:string;
let incident:any,report:any,evidence:any,draft:any,receipt:any,maskedFixture:string,sourceFixture:string;
async function call(route:string,cookie=manager,body?:any){const response=await fetch(`${base}${route}`,{method:body===undefined?'GET':'POST',headers:{cookie,...(body!==undefined&&!(body instanceof FormData)?{'content-type':'application/json'}:{})},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});return{status:response.status,value:await response.json(),response}}
async function login(email:string){const r=await call('/auth/login','',{email,password:'JagaLocal!2026'});assert.equal(r.status,200);return r.response.headers.get('set-cookie')!.split(';')[0]}
const endpoint=(suffix='')=>`/incidents/${incident.id}/privacy/${draft.id}${suffix}`;
async function upload(bytes=readFileSync(sourceFixture)) {const f=new FormData();f.set('description','Internal test photo; do not expose this description.');f.set('photos',new Blob([bytes],{type:'image/png'}),'qa.png');const r=await call(`/incidents/${incident.id}/evidence`,staff,f);assert.equal(r.status,201,JSON.stringify(r.value));return r.value[0]}
async function prepare(e=evidence){const r=await call(`/incidents/${incident.id}/evidence/${e.id}/privacy`,manager,{});assert.equal(r.status,202);return r.value}
async function fakeDetector(_input:string,output:string,masks:any[]){copyFileSync(maskedFixture,output);return{width:320,height:180,regions:[],counts:{face:0,plate:0,manual:masks.length},models:{fixture:'test double'},method:'opaque-rectangle-v1',metadataStripped:true}}
async function finishDraft(target=draft){for(let i=0;i<30;i++){const row=store.get<any>('privacyDrafts',target.id);if(row.status==='ready')return row;store.put('privacyDrafts',{...row,nextAttemptAt:undefined});await worker.processNextPrivacy('test-worker',fakeDetector)}throw Error('Target job did not finish')}
async function preview(cookie=staff){const r=await call(endpoint('/view'),cookie,{});assert.equal(r.status,200,JSON.stringify(r.value));return r.value}
const sharePayload=(view=receipt)=>({revision:draft.revision,receipt:view.receipt,reviewed:true,caption:'[Synthetic QA] Inspection result screenshot.'});
before(async()=>{
  const api=await import('../../apps/api/src/index.ts');store=await import('../../packages/shared/store.ts');worker=await import('../../apps/worker/src/privacy.ts');
  server=api.app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));base=`http://127.0.0.1:${(server.address()as any).port}/api`;
  manager=await login('manager@jaga.local');staff=await login('maintenance@jaga.local');resident=await login('resident@jaga.local');guard=await login('guard@jaga.local');outsider=await login('other@jaga.local');
  const original=store.get<any>('users','user_resident');store.put('users',{...original,id:'resident_other',email:'resident-other@jaga.local'});otherResident=await login('resident-other@jaga.local');
  sourceFixture=path.join(temporary,'source.png');maskedFixture=path.join(temporary,'masked.jpg');
  execFileSync(process.env.PRIVACY_PYTHON||'python',['-c',"from PIL import Image;import sys;im=Image.new('RGB',(320,180));p=im.load();[(p.__setitem__((x,y),((x*7)%256,(y*5)%256,((x+y)*3)%256))) for y in range(180) for x in range(320)];exif=Image.Exif();exif[270]='PRIVATE EXIF TEST';im.save(sys.argv[1],exif=exif);im.save(sys.argv[2],'JPEG')",sourceFixture,maskedFixture],{windowsHide:true});
  report=(await call('/reports',resident,{category:'maintenance',locationId:'loc_parking_b',description:'Synthetic privacy screenshot test',timeFrom:'2026-10-14T13:00:00Z',timeTo:'2026-10-14T13:00:05Z'})).value;
  incident=(await call('/incidents',manager,{title:'Synthetic privacy test incident',category:'maintenance',locationId:'loc_parking_b',priority:'normal',reportId:report.id})).value;
  assert.equal((await call(`/incidents/${incident.id}/assignments`,manager,{assigneeId:'user_maintenance'})).status,201);
});
after(async()=>{await new Promise<void>(r=>server.close(()=>r()));store.db.close();assert.equal(path.dirname(temporary),path.resolve(os.tmpdir()));assert.ok(path.basename(temporary).startsWith('jagaai-privacy-'));rmSync(temporary,{recursive:true,force:true})});

test('staff photo upload atomically queues a private local masking job and never shares the original',async()=>{
  evidence=await upload();draft=store.get<any>('privacyDrafts',`privacy_${evidence.id}`);assert.equal(draft.status,'queued');assert.equal(draft.incidentId,incident.id);
  assert.equal((await call(`/media/${evidence.mediaId}/access`,resident)).status,404);
  assert.deepEqual((await call(`/reports/${report.id}`,resident)).value.sharedScreenshots,[]);
  const repeated=await prepare();assert.equal(repeated.revision,draft.revision);assert.equal(store.list('privacyDrafts').length,1);
});
test('real offline detector writes opaque manual masks and removes source EXIF',async()=>{
  const source=store.get<any>('media',evidence.mediaId),output=path.join(store.mediaDir,'real-masked.jpg');
  const result=await worker.runPrivacyDetector(source.path,output,[{x:.25,y:.25,w:.25,h:.25}]);
  assert.equal(result.counts.manual,1);assert.equal(result.metadataStripped,true);assert.equal(result.method,'opaque-rectangle-v1');
  const check=JSON.parse(execFileSync(process.env.PRIVACY_PYTHON||'python',['-c',"from PIL import Image;import json,sys;im=Image.open(sys.argv[1]);print(json.dumps({'pixel':im.getpixel((120,70)),'exif':dict(im.getexif())}))",output],{encoding:'utf8',windowsHide:true}));
  assert.deepEqual(check.exif,{});assert.ok(check.pixel.every((v:number,i:number)=>Math.abs(v-[27,41,35][i])<4));
  assert.ok(!readFileSync(output).includes(Buffer.from('PRIVATE EXIF TEST')));draft=await finishDraft();
});
test('private masking drafts and previews are isolated by role, incident, assignment and township',async()=>{
  for(const cookie of [resident,otherResident,guard,outsider]) {assert.ok([403,404].includes((await call(`/incidents/${incident.id}/privacy`,cookie)).status));assert.ok([403,404].includes((await call(endpoint('/view'),cookie,{})).status))}
  assert.equal((await call(`/media/${draft.previewMediaId}/access`,resident)).status,404);
  assert.equal((await call(`/media/${draft.previewMediaId}/access`,guard)).status,404);
  assert.equal((await call(`/media/${draft.previewMediaId}/access`,staff)).status,200);
});
test('sharing requires current preview, explicit acknowledgement and a session-bound receipt',async()=>{
  assert.equal((await call(endpoint('/share'),staff,{...sharePayload({receipt:'fake'}),reviewed:false})).status,409);
  assert.equal((await call(endpoint('/share'),staff,sharePayload({receipt:'fake'}))).status,403);
  receipt=await preview();const secondSession=await login('maintenance@jaga.local');
  assert.equal((await call(endpoint('/share'),secondSession,sharePayload())).status,403);
  assert.equal((await call(endpoint('/share'),manager,sharePayload())).status,403);
});
test('published screenshots expose only the reviewed copy and public caption to linked residents',async()=>{
  const r=await call(endpoint('/share'),staff,sharePayload());assert.equal(r.status,201);
  const publicReport=(await call(`/reports/${report.id}`,resident)).value,publicIncident=(await call(`/incidents/${incident.id}`,resident)).value;
  assert.equal(publicReport.sharedScreenshots.length,1);assert.equal(publicReport.sharedScreenshots[0].mediaId,draft.previewMediaId);assert.deepEqual(publicIncident.evidence,[]);
  for(const hidden of [evidence.id,draft.id,draft.sourceMediaId,draft.sourceHash,evidence.description,JSON.stringify(draft.models)]) assert.ok(!JSON.stringify({publicReport,publicIncident}).includes(hidden));
  assert.equal((await call(`/media/${evidence.mediaId}/access`,resident)).status,404);
  assert.equal((await call(`/media/${draft.previewMediaId}/access`,otherResident)).status,404);
  const access=await call(`/media/${draft.previewMediaId}/access`,resident);assert.equal(access.status,200);
  const content=await fetch(new URL(access.value.url,base),{headers:{cookie:resident,Range:'bytes=0-63'}});assert.equal(content.status,206);assert.equal((await content.arrayBuffer()).byteLength,64);
});
test('exact share retries are idempotent and cannot silently change the public caption',async()=>{
  assert.equal((await call(endpoint('/share'),staff,sharePayload())).status,201);
  assert.equal(store.list('screenshotShares').length,1);assert.equal(store.list<any>('incidentUpdates').filter(u=>u.action==='screenshot_shared').length,1);
  assert.equal((await call(endpoint('/share'),staff,{...sharePayload(),caption:'Changed caption'})).status,409);
});
test('withdrawal hides the copy and immediately invalidates previously issued resident tickets',async()=>{
  const access=(await call(`/media/${draft.previewMediaId}/access`,resident)).value;
  assert.equal((await call(endpoint('/withdraw'),staff,{})).status,200);
  assert.deepEqual((await call(`/reports/${report.id}`,resident)).value.sharedScreenshots,[]);
  assert.equal((await fetch(new URL(access.url,base),{headers:{cookie:resident}})).status,404);
  assert.equal((await call(`/media/${draft.previewMediaId}/access`,resident)).status,404);
});
test('mask edits invalidate the prior revision, receipts, publication and old copy access',async()=>{
  assert.equal((await call(endpoint('/share'),staff,sharePayload())).status,403);receipt=await preview();
  await call(endpoint('/share'),staff,sharePayload());const old={...draft},oldReceipt=receipt;
  const invalid=await call(endpoint('/masks'),staff,{revision:draft.revision,manualMasks:[{x:0,y:0,w:2,h:1}]});assert.equal(invalid.status,400);
  const updated=await call(endpoint('/masks'),staff,{revision:draft.revision,manualMasks:[{x:.1,y:.2,w:.2,h:.3}]});assert.equal(updated.status,202);assert.equal(updated.value.revision,old.revision+1);
  assert.deepEqual((await call(`/reports/${report.id}`,resident)).value.sharedScreenshots,[]);
  assert.ok([404,410].includes((await call(`/media/${old.previewMediaId}/access`,staff)).status));
  draft=await finishDraft(updated.value);assert.equal(draft.counts.manual,1);
  assert.equal((await call(endpoint('/share'),staff,{...sharePayload(oldReceipt),revision:old.revision})).status,409);
  receipt=await preview();assert.equal((await call(endpoint('/share'),staff,sharePayload())).status,201);
});
test('source changes fail closed even with a valid old preview or already issued resident ticket',async()=>{
  const access=(await call(`/media/${draft.previewMediaId}/access`,resident)).value,source=store.get<any>('media',evidence.mediaId),bytes=readFileSync(source.path);
  writeFileSync(source.path,Buffer.concat([bytes,Buffer.from('changed')]));
  assert.equal((await call(endpoint('/share'),staff,sharePayload())).status,409);
  assert.equal((await fetch(new URL(access.url,base),{headers:{cookie:resident}})).status,404);
  assert.deepEqual((await call(`/reports/${report.id}`,resident)).value.sharedScreenshots,[]);writeFileSync(source.path,bytes);
});
test('reassignment revokes the previous staff preview and publishing access',async()=>{
  const access=(await call(`/media/${draft.previewMediaId}/access`,staff)).value;
  await call(`/incidents/${incident.id}/assignments`,manager,{assigneeId:'user_guard'});
  assert.equal((await call(endpoint('/view'),staff,{})).status,404);assert.equal((await call(endpoint('/share'),staff,sharePayload())).status,404);
  assert.equal((await fetch(new URL(access.url,base),{headers:{cookie:staff}})).status,404);
  assert.equal((await call(endpoint('/view'),guard,{})).status,200);
  await call(`/incidents/${incident.id}/assignments`,manager,{assigneeId:'user_maintenance'});
});
test('detector failures have bounded retries and never publish or substitute the source photo',async()=>{
  const e=await upload(),row=await prepare(e);for(let i=0;i<3;i++){const current=store.get<any>('privacyDrafts',row.id);store.put('privacyDrafts',{...current,nextAttemptAt:undefined});await worker.processNextPrivacy('failing-worker',async()=>{throw Error('Detector unavailable')})}
  const failed=store.get<any>('privacyDrafts',row.id);assert.equal(failed.status,'failed');assert.equal(failed.attemptCount,3);assert.equal(failed.previewMediaId,undefined);
  assert.equal(store.list<any>('screenshotShares').filter(s=>s.draftId===row.id).length,0);assert.equal((await call(`/media/${e.mediaId}/access`,resident)).status,404);
  const retry=await call(`/incidents/${incident.id}/evidence/${e.id}/privacy`,staff,{retry:true});assert.equal(retry.value.attemptCount,0);
  await finishDraft(retry.value);
});
test('live worker leases cannot be stolen and a lost lease cannot commit a preview',async()=>{
  const e=await upload(),row=await prepare(e);const current=store.get<any>('privacyDrafts',row.id);
  store.put('privacyDrafts',{...current,status:'processing',leaseOwner:'live',leaseUntil:new Date(Date.now()+60_000).toISOString()});
  assert.equal(await worker.processNextPrivacy('other-worker',fakeDetector),false);
  store.put('privacyDrafts',{...current,status:'processing',leaseOwner:'dead',leaseUntil:new Date(Date.now()-1000).toISOString()});
  await worker.processNextPrivacy('recovering-worker',async(input,output,masks)=>{await fakeDetector(input,output,masks);store.put('privacyDrafts',{...store.get<any>('privacyDrafts',row.id),leaseOwner:'replacement'});return{width:320,height:180}});
  assert.equal(store.get<any>('privacyDrafts',row.id).previewMediaId,undefined);
  assert.equal(store.get<any>('privacyDrafts',row.id).leaseOwner,'replacement');
});
test('expiry removes masked media and coordinates while retaining the human sharing audit',async()=>{
  const previewPath=store.get<any>('media',draft.previewMediaId).path;
  const expiry=Date.now()+8*86400_000;await worker.cleanupPrivacy(expiry);const engine=await import('../../apps/worker/src/engine.ts');await engine.cleanupExpired(expiry);
  assert.equal(existsSync(previewPath),false);assert.equal(store.get<any>('privacyDrafts',draft.id).status,'expired');assert.equal(store.get<any>('privacyDrafts',draft.id).manualMasks,undefined);
  assert.ok(store.list<any>('auditLogs').some(a=>a.action==='privacy.share'));assert.ok(store.list('screenshotShares').length>0);
  assert.deepEqual((await call(`/reports/${report.id}`,resident)).value.sharedScreenshots,[]);
});
