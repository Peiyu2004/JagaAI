import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporary=mkdtempSync(path.join(os.tmpdir(),'jagaai-worker-test-'));
process.env.JAGAAI_DATA_DIR=temporary;
process.env.AI_MODE='fixture';
const store=await import('../../packages/shared/store.ts');
const engine=await import('../../apps/worker/src/engine.ts');
const {runFfmpeg}=await import('../../apps/worker/src/video.ts');
const {localOllamaEndpoint}=await import('../../apps/worker/src/ollama.ts');
const {verifyFixture}=await import('../../apps/worker/src/fixtures.ts');

after(()=>{
  store.db.close();
  assert.equal(path.dirname(temporary),path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('jagaai-worker-test-'));
  rmSync(temporary,{recursive:true,force:true});
});
function seedJob(id:string, extra:Record<string,unknown>={}) {
  const videoId=`video_${id}`;
  store.put('videos',{id:videoId,townshipId:'test_township',status:'queued',recordedAt:store.now(),durationSec:2,expiresAt:new Date(Date.now()+3600000).toISOString(),source:'upload'});
  return store.put('analysisJobs',{id,townshipId:'test_township',videoId,status:'queued',attemptCount:0,analysisVersion:'local-v2',createdAt:store.now(),updatedAt:store.now(),...extra});
}

test('worker claim is exclusive while a live lease remains',()=>{
  seedJob('job_exclusive');
  const first=engine.claimJob('worker-one');
  assert.equal(first?.id,'job_exclusive');
  assert.equal(first?.attemptCount,1);
  assert.equal(engine.claimJob('worker-two'),undefined);
  assert.equal(engine.heartbeatJob(first!.id,'wrong-owner'),false);
  assert.equal(engine.heartbeatJob(first!.id,'worker-one'),true);
  store.put('analysisJobs',{...store.get('analysisJobs',first!.id),status:'completed'});
});

test('an interrupted expired lease is recovered with another bounded attempt',()=>{
  seedJob('job_recovery',{status:'processing',attemptCount:1,leaseOwner:'crashed-worker',leaseUntil:new Date(Date.now()-1000).toISOString()});
  const recovered=engine.claimJob('replacement-worker');
  assert.equal(recovered?.id,'job_recovery');
  assert.equal(recovered?.attemptCount,2);
  assert.equal(recovered?.leaseOwner,'replacement-worker');
  store.put('analysisJobs',{...recovered!,status:'completed'});
});

test('worker stops reclaiming after three interrupted attempts',()=>{
  seedJob('job_maximum',{status:'processing',attemptCount:3,leaseOwner:'crashed-worker',leaseUntil:new Date(Date.now()-1000).toISOString()});
  assert.equal(engine.claimJob('replacement-worker'),undefined);
  assert.equal(store.get<any>('analysisJobs','job_maximum').status,'failed');
  assert.match(store.get<any>('analysisJobs','job_maximum').lastError,/Maximum attempts/);
});

test('already completed analysis is not repeated after a duplicate queue request',()=>{
  const job=seedJob('job_completed');
  store.put('videos',{...store.get('videos',job.videoId),status:'completed',analysisVersion:'local-v2',analysisMode:'fixture'});
  assert.equal(engine.claimJob('worker-repeat'),undefined);
  assert.equal(store.get<any>('analysisJobs',job.id).status,'completed');
});

test('unanalysed real upload fails explicitly without invented demo observations',async()=>{
  const file=path.join(store.mediaDir,'ordinary-upload.mp4');
  await runFfmpeg(['-f','lavfi','-i','color=c=gray:s=320x180:r=5:d=2','-an','-c:v','libx264','-pix_fmt','yuv420p',file]);
  const job=seedJob('job_real_upload');
  store.put('media',{id:'media_real_upload',townshipId:'test_township',kind:'video',videoId:job.videoId,path:file,contentType:'video/mp4'});
  store.put('videos',{...store.get('videos',job.videoId),mediaId:'media_real_upload'});
  assert.equal(await engine.processNextJob('worker-upload'),true);
  assert.equal(store.get<any>('analysisJobs',job.id).status,'failed');
  assert.match(store.get<any>('analysisJobs',job.id).lastError,/Local vision model required/);
  assert.equal(store.list<any>('segments').filter(s=>s.videoId===job.videoId).length,0);
  assert.equal(store.list<any>('alerts').filter(a=>a.videoId===job.videoId).length,0);
  await assert.rejects(verifyFixture({source:'upload'},file),/Local vision model required/);
});

test('retention cleanup deletes original and thumbnail files and search records',async()=>{
  const original=path.join(store.mediaDir,'expired.mp4'), thumbnail=path.join(store.mediaDir,'expired.jpg');
  writeFileSync(original,'local fixture'); writeFileSync(thumbnail,'local thumbnail fixture');
  store.put('videos',{id:'video_expired',townshipId:'test_township',status:'completed',mediaId:'media_expired',expiresAt:new Date(Date.now()-1000).toISOString()});
  for (const [id,file,kind] of [['media_expired',original,'video'],['thumb_expired',thumbnail,'thumbnail']]) store.put('media',{id,townshipId:'test_township',videoId:'video_expired',path:file,kind});
  store.put('segments',{id:'segment_expired',townshipId:'test_township',videoId:'video_expired'});
  store.put('alerts',{id:'alert_expired',townshipId:'test_township',videoId:'video_expired'});
  await engine.cleanupExpired();
  assert.equal(existsSync(original),false); assert.equal(existsSync(thumbnail),false);
  assert.equal(store.get('segments','segment_expired'),undefined);
  assert.equal(store.get('alerts','alert_expired'),undefined);
  assert.equal(store.get<any>('videos','video_expired').status,'expired');
});

test('AI endpoints are restricted to loopback and reject disguised remote URLs',()=>{
  assert.equal(localOllamaEndpoint('http://127.0.0.1:11434').href,'http://127.0.0.1:11434/api/generate');
  assert.equal(localOllamaEndpoint('http://[::1]:11434').hostname,'[::1]');
  for (const value of ['https://127.0.0.1','http://example.com','http://127.0.0.1.example.com','http://user@127.0.0.1','http://127.0.0.1:11434/redirect','http://localhost:11434','http://127.0.0.1?url=https://example.com']) assert.throws(()=>localOllamaEndpoint(value),value);
});
