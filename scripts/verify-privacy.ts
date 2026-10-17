/** Read-only verification after the labelled screenshot demo has been exercised in the browser. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const base='http://127.0.0.1:4000/api', manifest=JSON.parse(await readFile('data/privacy-demo/manifest.json','utf8'));
async function login(email:string){const r=await fetch(`${base}/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:'JagaLocal!2026'})});assert.equal(r.status,200);return r.headers.get('set-cookie')!.split(';')[0]}
async function get(route:string,cookie:string){const r=await fetch(`${base}${route}`,{headers:{cookie}});return{status:r.status,value:await r.json()}}
const manager=await login('manager@jaga.local'),resident=await login('resident@jaga.local'),staff=await login('maintenance@jaga.local'),guard=await login('guard@jaga.local');
const review=(await get(`/incidents/${manifest.incidentId}/privacy`,manager)).value;
const share=review.shares.find((s:any)=>s.status==='published');assert.ok(share,'Complete the labelled demo sharing step first.');
const draft=review.drafts.find((d:any)=>d.id===share.draftId);assert.equal(draft.status,'ready');assert.equal(draft.revision,share.revision);assert.ok(draft.counts.face>=1);assert.ok(draft.counts.plate>=1);assert.ok(draft.counts.manual>=1);
assert.equal(draft.models.face.file,'face_detection_yunet_2023mar.onnx');assert.equal(draft.models.plate.file,'yolo-v9-t-640-license-plates-end2end.onnx');
const report=(await get(`/reports/${manifest.reportId}`,resident)).value;assert.equal(report.sharedScreenshots.length,1);assert.equal(report.sharedScreenshots[0].mediaId,share.mediaId);
for(const hidden of [draft.sourceMediaId,draft.sourceHash,draft.evidenceId,JSON.stringify(draft.regions),JSON.stringify(draft.models)])assert.ok(!JSON.stringify(report).includes(hidden));
assert.equal((await get(`/incidents/${manifest.incidentId}/privacy`,resident)).status,403);
assert.equal((await get(`/media/${draft.sourceMediaId}/access`,resident)).status,404);assert.equal((await get(`/media/${share.mediaId}/access`,guard)).status,404);assert.equal((await get(`/media/${share.mediaId}/access`,staff)).status,200);
const access=await get(`/media/${share.mediaId}/access`,resident);assert.equal(access.status,200);
const streamed=await fetch(new URL(access.value.url,base),{headers:{cookie:resident}});assert.equal(streamed.status,200);assert.equal(streamed.headers.get('content-type'),'image/jpeg');
const bytes=Buffer.from(await streamed.arrayBuffer());assert.ok(!bytes.includes(Buffer.from('TEST PRIVATE METADATA MUST BE REMOVED')));
await mkdir('output/verification',{recursive:true});const imagePath=path.resolve('output/verification/privacy-shared-qa.jpg');await writeFile(imagePath,bytes);
const pixels=JSON.parse(execFileSync(process.env.PRIVACY_PYTHON||'python',['-c',"from PIL import Image;import json,sys;im=Image.open(sys.argv[1]);a=json.loads(sys.argv[2]);p=[im.getpixel(((r['x1']+r['x2'])//2,(r['y1']+r['y2'])//2)) for r in a];print(json.dumps({'pixels':p,'exifCount':len(im.getexif()),'size':im.size}))",imagePath,JSON.stringify(draft.regions)],{encoding:'utf8',windowsHide:true}));
assert.equal(pixels.exifCount,0);assert.ok(pixels.pixels.every((rgb:number[])=>rgb.every((v,i)=>Math.abs(v-[27,41,35][i])<4)));
const result={verifiedAt:new Date().toISOString(),syntheticWorkflow:true,publicTestImagery:true,browserAutomatedReview:true,reportNumber:manifest.reportNumber,reportId:manifest.reportId,incidentId:manifest.incidentId,
  automaticMaskedCopy:true,counts:draft.counts,models:draft.models,revision:draft.revision,manualMaskApplied:true,staffReviewedAndShared:true,onlyMaskedResidentMedia:true,residentOriginalDenied:true,unassignedGuardDenied:true,
  metadataStripped:true,opaqueMaskPixelsVerified:true,publicCaption:share.caption,imageSize:pixels.size,
  limitations:'One composite public test image; not a held-out Malaysian CCTV accuracy/recall evaluation. Still screenshot sharing only.'};
await writeFile('output/verification/privacy-smoke.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
