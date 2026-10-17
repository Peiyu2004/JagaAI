import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { get, list, put, now, mediaDir } from './store.ts';
import { raise } from './video-jobs.ts';

export type PrivacyMask = { x: number; y: number; w: number; h: number };
export function privacySource(media: any) {
  if (!media || media.kind !== 'photo' || media.unavailable || media.expiresAt && Date.parse(media.expiresAt) <= Date.now() || !existsSync(media.path)) raise(410, 'The source photo is no longer available.');
  const root = realpathSync(mediaDir), file = realpathSync(media.path), relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !statSync(file).isFile()) raise(410, 'The source photo is unavailable.');
  return { path: file, hash: createHash('sha256').update(readFileSync(file)).digest('hex') };
}
export function privacyMasks(value: unknown): PrivacyMask[] {
  if (!Array.isArray(value) || value.length > 40) raise(400, 'Use at most 40 additional privacy masks.');
  return value.map((box: any) => {
    if (!box || Object.keys(box).some(k => !['x','y','w','h'].includes(k)) || ![box.x,box.y,box.w,box.h].every(v => typeof v === 'number' && Number.isFinite(v)) || box.x < 0 || box.y < 0 || box.w <= 0 || box.h <= 0 || box.x + box.w > 1.000001 || box.y + box.h > 1.000001) raise(400, 'Mask coordinates must be valid normalized rectangles inside the image.');
    return { x: box.x, y: box.y, w: box.w, h: box.h };
  });
}
export function queuePrivacyPhoto(evidence: any, actor: any, retry = false, masks?: PrivacyMask[]) {
  if (evidence.kind !== 'photo' || evidence.townshipId !== actor.townshipId) raise(400, 'Choose an authorised still evidence photo.');
  const media = get<any>('media', evidence.mediaId);
  if (!media || media.townshipId !== actor.townshipId || media.incidentId !== evidence.incidentId) raise(404, 'Evidence photo not found.');
  const source = privacySource(media), id = `privacy_${evidence.id}`, previous = get<any>('privacyDrafts', id);
  if (previous && !retry && masks === undefined && previous.sourceHash === source.hash) return previous;
  if (previous?.status === 'processing' && Date.parse(previous.leaseUntil) > Date.now()) raise(409, 'The local privacy worker is processing this photo.');
  for (const share of list<any>('screenshotShares', actor.townshipId).filter(s => s.draftId === id && s.status === 'published')) put('screenshotShares', { ...share, status: 'withdrawn', withdrawnAt: now(), withdrawnBy: actor.id });
  for (const old of list<any>('media', actor.townshipId).filter(m => m.privacyDraftId === id)) put('media', { ...old, unavailable: true });
  return put('privacyDrafts', { id, townshipId: actor.townshipId, incidentId: evidence.incidentId, evidenceId: evidence.id, sourceMediaId: media.id,
    sourceHash: source.hash, revision: (previous?.revision || 0) + 1, status: 'queued', attemptCount: 0, manualMasks: masks ?? previous?.manualMasks ?? [],
    expiresAt: media.expiresAt || previous?.expiresAt || new Date(Date.now() + 7*86400_000).toISOString(), requestedBy: actor.id, createdAt: previous?.createdAt || now(), updatedAt: now() });
}
export function currentPrivacyCopy(media: any) {
  const draft = media?.privacyDraftId && get<any>('privacyDrafts', media.privacyDraftId);
  if (!draft || draft.status !== 'ready' || draft.previewMediaId !== media.id || draft.revision !== media.privacyRevision || draft.townshipId !== media.townshipId || Date.parse(draft.expiresAt) <= Date.now()) return undefined;
  try { const source = get<any>('media', draft.sourceMediaId); if (source?.townshipId !== draft.townshipId || privacySource(source).hash !== draft.sourceHash) return undefined; } catch { return undefined; }
  return draft;
}
export function residentScreenshots(incidentId: string, townshipId: string) {
  return list<any>('screenshotShares', townshipId).filter(s => s.incidentId === incidentId && s.status === 'published').flatMap(s => {
    const media = get<any>('media', s.mediaId);
    return media && !media.unavailable && existsSync(media.path) && currentPrivacyCopy(media) && (!media.expiresAt || Date.parse(media.expiresAt) > Date.now()) ? [{ id: `shared_${createHash('sha256').update(s.id).digest('hex').slice(0,24)}`, mediaId: s.mediaId, caption: s.caption, sharedAt: s.sharedAt, privacyMasked: true }] : [];
  });
}
