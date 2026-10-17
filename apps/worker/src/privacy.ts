import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { get, list, put, remove, transaction, uid, now, audit, mediaDir } from '../../../packages/shared/store.ts';
import { privacySource } from '../../../packages/shared/privacy.ts';
import { safeOutputPath, safeMediaPath } from './video.ts';

export async function runPrivacyDetector(source: string, output: string, manualMasks: any[]) {
  const inputPath = await safeMediaPath(mediaDir, source), outputPath = await safeOutputPath(mediaDir, output);
  return new Promise<any>((resolve, reject) => {
    const child = execFile(process.env.PRIVACY_PYTHON || 'python', [path.resolve('scripts/privacy-detector.py')], { timeout: 120_000, maxBuffer: 256*1024, windowsHide: true,
      env: { ...process.env, OMP_NUM_THREADS: '2' } }, (error, stdout) => {
      let result: any;
      try { result = JSON.parse(stdout); } catch { reject(new Error('Local privacy detector unavailable. Check Python dependencies and run npm run privacy:setup.')); return; }
      if (error || result.error) { reject(new Error(result.error || 'Local privacy detector failed; no screenshot was shared.')); return; }
      if (!Number.isInteger(result.width) || result.width <= 0 || !Number.isInteger(result.height) || result.height <= 0 || !Array.isArray(result.regions) || result.method !== 'opaque-rectangle-v1' || result.metadataStripped !== true) { reject(new Error('Invalid privacy detector result.')); return; }
      resolve(result);
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify({ inputPath, outputPath, modelDir: path.resolve('.runtime/privacy-models'), manualMasks }));
  });
}
export async function processNextPrivacy(owner: string, detector = runPrivacyDetector) {
  const job = transaction(() => {
    for (const row of list<any>('privacyDrafts').sort((a,b) => a.updatedAt.localeCompare(b.updatedAt))) {
      if (!(row.status === 'queued' && (!row.nextAttemptAt || Date.parse(row.nextAttemptAt) <= Date.now()) || row.status === 'processing' && Date.parse(row.leaseUntil || 0) <= Date.now())) continue;
      if (Date.parse(row.expiresAt) <= Date.now()) { put('privacyDrafts', { ...row, status: 'expired', updatedAt: now() }); continue; }
      if (row.attemptCount >= 3) { put('privacyDrafts', { ...row, status:'failed', lastError:'Local masking attempt limit reached. Check the models and retry.', updatedAt:now() }); continue; }
      const claimed = { ...row, status:'processing', attemptCount:row.attemptCount+1, leaseOwner:owner, leaseUntil:new Date(Date.now()+150_000).toISOString(), updatedAt:now() };
      put('privacyDrafts', claimed); return claimed;
    }
  });
  if (!job) return false;
  const output = path.join(mediaDir, `${uid('privacy_work')}.jpg`);
  let committed = false;
  const lease = () => { const current=get<any>('privacyDrafts',job.id); return current?.status==='processing' && current.revision===job.revision && current.leaseOwner===owner && Date.parse(current.leaseUntil)>Date.now() ? current : undefined; };
  const timer=setInterval(() => { try { transaction(() => { const current=lease(); if (current) put('privacyDrafts',{...current,leaseUntil:new Date(Date.now()+150_000).toISOString()}); }); } catch { /* Commit still requires a live lease. */ } },5000); timer.unref();
  try {
    const source = get<any>('media', job.sourceMediaId), before = privacySource(source);
    if (source.townshipId !== job.townshipId || source.incidentId !== job.incidentId || before.hash !== job.sourceHash) throw Error('Source photo changed. Prepare a fresh privacy copy.');
    const result = await detector(before.path, output, job.manualMasks);
    transaction(() => {
      const current=lease(); if (!current) throw Error('Privacy worker lease lost.');
      const latest=get<any>('media',job.sourceMediaId);
      if (privacySource(latest).hash !== job.sourceHash || Date.parse(job.expiresAt)<=Date.now() || latest.townshipId!==job.townshipId) throw Error('The source changed or expired during masking.');
      if (!existsSync(output)) throw Error('No masked screenshot was produced.');
      const media = put('media',{id:uid('media_masked'),townshipId:job.townshipId,incidentId:job.incidentId,kind:'photo',contentType:'image/jpeg',path:output,
        privacyDraftId:job.id,privacyRevision:job.revision,expiresAt:job.expiresAt,createdAt:now()});
      put('privacyDrafts',{...current,status:'ready',previewMediaId:media.id,width:result.width,height:result.height,regions:result.regions,counts:result.counts,models:result.models,method:result.method,metadataStripped:result.metadataStripped,lastError:undefined,leaseOwner:undefined,leaseUntil:undefined,updatedAt:now()});
      audit({id:'local-privacy-worker',townshipId:job.townshipId},'privacy.ready','privacyDrafts',job.id); committed=true;
    });
  } catch (error) {
    transaction(() => { const current=lease(); if (current) put('privacyDrafts',{...current,status:current.attemptCount>=3?'failed':'queued',lastError:(error instanceof Error?error.message:'Local masking failed.').slice(0,1000),nextAttemptAt:new Date(Date.now()+15_000).toISOString(),leaseOwner:undefined,leaseUntil:undefined,updatedAt:now()}); });
  } finally { clearInterval(timer); if (!committed) await unlink(output).catch(() => {}); }
  return true;
}
export async function cleanupPrivacy(at=Date.now()) {
  transaction(() => {
    for (const draft of list<any>('privacyDrafts')) if (Date.parse(draft.expiresAt)<=at || !get('media',draft.sourceMediaId)) {
      const { regions, manualMasks, ...history } = draft;
      put('privacyDrafts',{...history,status:'expired',updatedAt:new Date(at).toISOString()});
      for (const share of list<any>('screenshotShares',draft.townshipId).filter(s=>s.draftId===draft.id && s.status==='published')) put('screenshotShares',{...share,status:'expired'});
      for (const media of list<any>('media',draft.townshipId).filter(m=>m.privacyDraftId===draft.id)) put('media',{...media,unavailable:true});
    }
    for (const view of list<any>('privacyViews').filter(v=>Date.parse(v.expiresAt)<=at)) remove('privacyViews',view.id);
  });
  const references=new Set(list<any>('media').map(m=>m.path));
  for (const entry of await readdir(mediaDir)) if (entry.startsWith('privacy_work_') && !references.has(path.join(mediaDir,entry))) {
    const filename=path.join(mediaDir,entry);
    if (at-(await stat(filename)).mtimeMs>10*60_000) await unlink(await safeMediaPath(mediaDir,filename));
  }
}
