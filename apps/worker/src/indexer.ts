import { get, list, now, put, transaction } from '../../../packages/shared/store.ts';
import { contentHash, embedTexts, segmentText } from '../../../packages/shared/local-ai.ts';
import { wakeReportSearches } from '../../../packages/shared/video-jobs.ts';

export const activeSegments = (video: any) => list<any>('segments', video.townshipId).filter(s => s.videoId === video.id && s.analysisVersion === video.analysisVersion && s.analysisMode === 'ollama');
export function queueIndex(video: any, retry = false) {
  const id = `index_${video.id}`, previous = get<any>('indexJobs', id);
  if (previous && ['queued', 'processing'].includes(previous.status)) return previous;
  if (previous?.status === 'completed' && !retry) return previous;
  return put('indexJobs', { id, townshipId: video.townshipId, videoId: video.id, status: 'queued', attemptCount: 0, createdAt: now(), updatedAt: now() });
}
export async function processNextIndex(owner: string) {
  const job = transaction(() => {
    for (const item of list<any>('indexJobs')) {
      if (!(item.status === 'queued' && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= Date.now())) && !(item.status === 'processing' && (!item.leaseUntil || Date.parse(item.leaseUntil) <= Date.now()))) continue;
      const video = get<any>('videos', item.videoId);
      if (!video || video.status === 'expired' || Date.parse(video.expiresAt) <= Date.now() || item.attemptCount >= 3) {
        put('indexJobs', { ...item, status: 'failed', lastError: 'Video unavailable or index retry limit reached.', updatedAt: now() }); continue;
      }
      const claimed = { ...item, status: 'processing', leaseOwner: owner, leaseUntil: new Date(Date.now() + 30_000).toISOString(), attemptCount: item.attemptCount + 1, updatedAt: now() };
      put('indexJobs', claimed); return claimed;
    }
  });
  if (!job) return false;
  const abort = new AbortController();
  const heartbeat = setInterval(() => {
    try { transaction(() => {
      const current = get<any>('indexJobs', job.id);
      if (current?.status !== 'processing' || current.leaseOwner !== owner || Date.parse(current.leaseUntil) <= Date.now()) { abort.abort(new Error('Index lease lost.')); return; }
      put('indexJobs', { ...current, leaseUntil: new Date(Date.now() + 30_000).toISOString(), updatedAt: now() });
    }); } catch { abort.abort(new Error('Unable to renew index lease.')); }
  }, 5000);
  heartbeat.unref();
  try {
    const video = get<any>('videos', job.videoId);
    if (!video) throw new Error('Video no longer exists.');
    const segments = activeSegments(video);
    if (!segments.length) throw new Error('No VLM descriptions are available. Analyse the video with the local vision model first.');
    const rows: any[] = [];
    for (let i = 0; i < segments.length; i += 4) {
      const batch = segments.slice(i, i + 4), result = await embedTexts(batch.map(segmentText), false, abort.signal);
      batch.forEach((s, n) => rows.push({ id: s.id, segmentId: s.id, townshipId: s.townshipId, videoId: s.videoId,
        model: result.model, digest: result.digest, dimension: result.dimension, vector: result.vectors[n], contentHash: contentHash(segmentText(s)), createdAt: now() }));
      transaction(() => {
        const current = get<any>('indexJobs', job.id);
        if (current?.leaseOwner === owner && current.status === 'processing' && Date.parse(current.leaseUntil) > Date.now()) put('indexJobs', { ...current, progress: { completedSegments: rows.length, totalSegments: segments.length }, updatedAt: now() });
      });
    }
    transaction(() => {
      const current = get<any>('indexJobs', job.id), latest = get<any>('videos', job.videoId);
      if (abort.signal.aborted || current?.leaseOwner !== owner || current.status !== 'processing' || Date.parse(current.leaseUntil) <= Date.now() || !latest || latest.status === 'expired' || Date.parse(latest.expiresAt) <= Date.now() || latest.analysisVersion !== video.analysisVersion || rows.some(r => r.digest !== rows[0].digest || r.dimension !== rows[0].dimension || r.model !== rows[0].model) || segments.some(s => { const fresh = get('segments', s.id); return !fresh || contentHash(segmentText(fresh)) !== rows.find(r => r.id === s.id).contentHash; })) throw new Error('Video or descriptions changed before indexing completed.');
      for (const row of rows) put('segmentEmbeddings', row);
      put('indexJobs', { ...current, status: 'completed', leaseUntil: undefined, leaseOwner: undefined, lastError: undefined, model: rows[0].model, digest: rows[0].digest, updatedAt: now() });
      wakeReportSearches(latest);
    });
  } catch (error) {
    transaction(() => {
    const current = get<any>('indexJobs', job.id);
    if (current?.status === 'processing' && current.leaseOwner === owner && Date.parse(current.leaseUntil) > Date.now()) put('indexJobs', { ...current, status: current.attemptCount >= 3 ? 'failed' : 'queued',
      lastError: (error instanceof Error ? error.message : 'Indexing failed.').slice(0, 1500), nextAttemptAt: new Date(Date.now() + 30_000).toISOString(), leaseUntil: undefined, leaseOwner: undefined, updatedAt: now() });
    });
  } finally { clearInterval(heartbeat); }
  return true;
}
