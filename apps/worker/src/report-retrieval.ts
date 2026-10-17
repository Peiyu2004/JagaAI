import { existsSync } from 'node:fs';
import { get, list, now, put, transaction, audit } from '../../../packages/shared/store.ts';
import { analysisMode, contentHash, segmentText, modelDigest, embeddingModel } from '../../../packages/shared/local-ai.ts';
import { ANALYSIS_VERSION, queueVideo, raise } from '../../../packages/shared/video-jobs.ts';
import { footageInScope, coverageOf, semanticSearch } from '../../api/src/semantic-search.ts';
import { queueIndex } from './indexer.ts';

const waiting = ['queued', 'waiting_media', 'waiting_analysis', 'waiting_index'];
const service = (townshipId: string) => ({ id: 'local-report-worker', townshipId });
export const sourceKey = (video: any) => contentHash(JSON.stringify([video.mediaId, video.recordedAt, video.durationSec, video.locationId]));
export function reportScope(report: any) {
  let from = Date.parse(report.timeFrom), to = Date.parse(report.timeTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to - from > 31 * 86400_000) raise(400, 'Choose an ordered report time range of at most 31 days.');
  if (from === to) { from -= 120_000; to += 120_000; }
  return { locationId: report.locationId, timeFrom: new Date(from).toISOString(), timeTo: new Date(to).toISOString(), timeZone: 'Asia/Kuala_Lumpur' };
}
export function queueReportSearch(report: any, retry = false) {
  const id = `retrieval_${report.id}`, previous = get<any>('reportSearchJobs', id);
  if (!reportActive(report)) raise(409, 'Reopen the linked incident before requesting another retrieval.');
  if (previous && retry && ['waiting_media', 'waiting_analysis', 'waiting_index'].includes(previous.status)) return put('reportSearchJobs', { ...previous, retryDependencies: true, nextAttemptAt: now(), updatedAt: now() });
  if (previous && (!retry || [...waiting, 'processing'].includes(previous.status))) return previous;
  return put('reportSearchJobs', { id, reportId: report.id, townshipId: report.townshipId, generation: (previous?.generation || 0) + 1,
    status: 'queued', attemptCount: 0, retryDependencies: retry, scope: reportScope(report), query: report.description,
    createdAt: now(), updatedAt: now() });
}
export function retrievalSummary(report: any) {
  const job = get<any>('reportSearchJobs', `retrieval_${report.id}`);
  if (!job) return { status: 'not_requested' };
  const statuses: Record<string, string> = { queued: 'queued', processing: 'searching', waiting_media: 'staff_review', waiting_analysis: 'analysing', waiting_index: 'indexing', completed: 'awaiting_review', failed: 'staff_review', cancelled: 'cancelled' };
  return { status: report.incidentId ? 'linked_to_incident' : statuses[job.status] || 'staff_review', updatedAt: job.updatedAt };
}
function reportActive(report: any) {
  if (!report || ['resolved', 'rejected'].includes(report.status)) return false;
  const incident = report.incidentId && get<any>('incidents', report.incidentId);
  return !incident || !['resolved', 'closed'].includes(incident.status);
}
export function candidateSource(candidate: any) {
  const job = get<any>('reportSearchJobs', `retrieval_${candidate.reportId}`), video = get<any>('videos', candidate.videoId);
  const report = get<any>('reports', candidate.reportId), camera = video && get<any>('cameras', video.cameraId);
  const segment = get<any>('segments', candidate.segmentId), media = video && get<any>('media', video.mediaId);
  if (!video || video.townshipId !== candidate.townshipId || video.status === 'expired' || Date.parse(video.expiresAt) <= Date.now() || !media || media.townshipId !== candidate.townshipId || media.unavailable || media.expiresAt && Date.parse(media.expiresAt) <= Date.now() || !existsSync(media.path)) raise(410, 'The source recording is unavailable or outside retention.');
  if (!report || report.townshipId !== candidate.townshipId || !camera || camera.townshipId !== candidate.townshipId || camera.locationId !== report.locationId || video.cameraId !== candidate.cameraId || video.locationId !== report.locationId || !job || report.description !== job.query || JSON.stringify(reportScope(report)) !== JSON.stringify(job.scope)) raise(409, 'The report or camera scope has changed. Run retrieval again.');
  if (!job || job.generation !== candidate.generation || !segment || segment.townshipId !== candidate.townshipId || segment.analysisVersion !== video.analysisVersion || contentHash(segmentText(segment)) !== candidate.descriptionHash || sourceKey(video) !== candidate.sourceKey) raise(409, 'This candidate is stale. Run retrieval again and review the new candidate.');
  return { video, media, segment };
}

/** A report schedules bounded dependencies and retrieves candidates; it never confirms incidents or dispatches staff. */
export async function processNextReportSearch(owner: string) {
  const job = transaction(() => {
    for (const item of list<any>('reportSearchJobs').sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const due = waiting.includes(item.status) && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= Date.now());
      const expired = item.status === 'processing' && (!item.leaseUntil || Date.parse(item.leaseUntil) <= Date.now());
      if (!due && !expired) continue;
      const report = get<any>('reports', item.reportId);
      if (!reportActive(report) || report.townshipId !== item.townshipId) { put('reportSearchJobs', { ...item, status: 'cancelled', leaseOwner: undefined, leaseUntil: undefined, updatedAt: now() }); continue; }
      if (item.attemptCount >= 3) { put('reportSearchJobs', { ...item, status: 'failed', lastError: 'Retrieval attempt limit reached. Check the local models and retry.', leaseOwner: undefined, leaseUntil: undefined, updatedAt: now() }); continue; }
      const claimed = { ...item, status: 'processing', leaseOwner: owner, leaseUntil: new Date(Date.now() + 30_000).toISOString(), updatedAt: now() };
      put('reportSearchJobs', claimed); return claimed;
    }
  });
  if (!job) return false;
  const abort = new AbortController();
  const lease = () => { const current = get<any>('reportSearchJobs', job.id); return current?.status === 'processing' && current.leaseOwner === owner && current.generation === job.generation && Date.parse(current.leaseUntil) > Date.now() ? current : undefined; };
  const heartbeat = setInterval(() => { try { transaction(() => { const current = lease(); if (!current) abort.abort(new Error('Report retrieval lease lost.')); else put('reportSearchJobs', { ...current, leaseUntil: new Date(Date.now() + 30_000).toISOString(), updatedAt: now() }); }); } catch { abort.abort(new Error('Unable to renew report retrieval lease.')); } }, 5000);
  heartbeat.unref();
  const defer = (status: string, coverage: any, message: string) => transaction(() => { const current = lease(); if (current) put('reportSearchJobs', { ...current, status, coverage, message, retryDependencies: false, leaseOwner: undefined, leaseUntil: undefined, nextAttemptAt: new Date(Date.now() + 15_000).toISOString(), updatedAt: now() }); });
  try {
    const cameras = new Set(list<any>('cameras', job.townshipId).filter(c => c.locationId === job.scope.locationId).map(c => c.id));
    let scope = footageInScope(job.townshipId, job.scope.locationId, job.scope.timeFrom, job.scope.timeTo, [...cameras]);
    let videos = scope.videos;
    if (videos.length > 50) raise(400, 'More than 50 recordings overlap this report. Narrow the report time range before retrieval.');
    if (!videos.length) { defer('waiting_media', { totalVideos: 0 }, 'No registered camera recordings overlap this location and time. Waiting for a local upload; staff can handle the report manually.'); return true; }
    if (analysisMode() !== 'ollama') raise(503, 'Automatic report retrieval requires the local vision and embedding models. Set AI_MODE=ollama and restart.');
    const digest = await modelDigest(embeddingModel(), abort.signal);
    scope = footageInScope(job.townshipId, job.scope.locationId, job.scope.timeFrom, job.scope.timeTo, [...cameras]); videos = scope.videos;
    if (videos.length > 50) raise(400, 'More than 50 recordings overlap this report. Narrow the report time range.');
    let pendingAnalysis = 0, failedAnalysis = 0, pendingIndex = 0, failedIndex = 0;
    transaction(() => {
      for (const input of videos) {
        const video = get<any>('videos', input.id);
        if (!video || video.status === 'expired' || Date.parse(video.expiresAt) <= Date.now()) { failedAnalysis++; continue; }
        const media = get<any>('media', video.mediaId);
        if (!media || media.unavailable || !existsSync(media.path)) { failedAnalysis++; continue; }
        if (video.analysisMode !== 'ollama' || video.analysisVersion !== ANALYSIS_VERSION || video.status !== 'completed') {
          try { const queued = queueVideo(video, service(job.townshipId), Boolean(job.retryDependencies)); if (queued.status === 'failed') failedAnalysis++; else pendingAnalysis++; }
          catch (error) { if (error instanceof Error && 'status' in error && error.status === 429) pendingAnalysis++; else failedAnalysis++; } continue;
        }
        const subset = { ...scope, segments: scope.segments.filter(s => s.videoId === video.id) };
        const coverage = coverageOf(subset, digest);
        if (!coverage.describedSegments) { failedAnalysis++; continue; }
        if (coverage.pendingSegments > 0) {
          const previous = get<any>('indexJobs', `index_${video.id}`);
          if (previous?.status === 'failed' && !job.retryDependencies) failedIndex++;
          else { queueIndex(video, true); pendingIndex++; }
        }
      }
    });
    const dependencyCoverage = { totalVideos: videos.length, pendingAnalysis, failedAnalysis, pendingIndex, failedIndex };
    if (pendingAnalysis) { defer('waiting_analysis', dependencyCoverage, 'Matching recordings are queued for real local VLM analysis.'); return true; }
    if (pendingIndex) { defer('waiting_index', dependencyCoverage, 'Visual descriptions are ready; waiting for the local semantic index.'); return true; }
    transaction(() => { const current = lease(); if (!current) throw new Error('Report retrieval lease lost.'); put('reportSearchJobs', { ...current, attemptCount: current.attemptCount + 1, lastError: undefined }); });
    const result = await semanticSearch(job.townshipId, job.query, { ...job.scope, cameraIds: [...cameras] }, abort.signal);
    const selected = result.results.filter(r => { const media = get<any>('media', r.video.mediaId); return cameras.has(r.cameraId) && media && !media.unavailable && existsSync(media.path); }).slice(0, 3);
    if (!selected.length && (failedAnalysis || failedIndex)) raise(503, 'Matching recordings could not be analysed or indexed. Check the local model errors and retry; the report can still be handled manually.');
    transaction(() => {
      const current = lease(), report = get<any>('reports', job.reportId);
      if (!current || abort.signal.aborted) throw new Error('Report retrieval lease lost.');
      if (!reportActive(report)) { put('reportSearchJobs', { ...current, status: 'cancelled', leaseOwner: undefined, leaseUntil: undefined, updatedAt: now() }); return; }
      const candidateIds: string[] = [];
      let staleCandidatesDropped = 0;
      for (const match of selected) {
        const latest = get<any>('segments', match.id), video = get<any>('videos', match.videoId);
        const camera = video && get<any>('cameras', video.cameraId), media = video && get<any>('media', video.mediaId);
        if (!latest || !video || video.status === 'expired' || Date.parse(video.expiresAt) <= Date.now() || !media || media.unavailable || !existsSync(media.path) || !camera || camera.townshipId !== job.townshipId || camera.locationId !== job.scope.locationId || contentHash(segmentText(latest)) !== contentHash(segmentText(match))) { staleCandidatesDropped++; continue; }
        const startSec = Math.max(match.startSec, (Date.parse(job.scope.timeFrom) - Date.parse(video.recordedAt)) / 1000);
        const endSec = Math.min(match.endSec, (Date.parse(job.scope.timeTo) - Date.parse(video.recordedAt)) / 1000);
        if (startSec >= endSec) { staleCandidatesDropped++; continue; }
        const id = `candidate_${contentHash(`${job.id}:${job.generation}:${match.id}`).slice(0, 24)}`, previous = get<any>('reportCandidates', id);
        put('reportCandidates', { id, townshipId: job.townshipId, reportId: job.reportId, generation: job.generation, segmentId: match.id, videoId: video.id, cameraId: match.cameraId, locationId: match.locationId,
          startSec, endSec, absoluteStartAt: new Date(Date.parse(video.recordedAt) + startSec * 1000).toISOString(), summary: match.summary,
          observations: match.observations.filter((o: any) => o.startSec >= startSec && o.startSec < endSec), uncertainties: match.uncertainties || [], score: match.score,
          descriptionHash: contentHash(segmentText(match)), sourceKey: sourceKey(video), model: match.model, embeddingModel: result.model,
          reviewStatus: previous?.reviewStatus || 'pending_review', createdAt: previous?.createdAt || now() });
        candidateIds.push(id);
      }
      if (selected.length && !candidateIds.length) throw new Error('Recordings changed during retrieval. Retrying the scoped search.');
      put('reportSearchJobs', { ...current, status: 'completed', candidateIds, coverage: { ...result.coverage, ...dependencyCoverage, staleCandidatesDropped }, partial: Boolean(failedAnalysis || failedIndex || result.coverage.pendingSegments || result.coverage.unanalysedVideos || staleCandidatesDropped),
        notice: result.notice, lastError: undefined, leaseOwner: undefined, leaseUntil: undefined, updatedAt: now() });
      audit(service(job.townshipId), 'report.retrieval_complete', 'reports', job.reportId);
    });
  } catch (error) {
    transaction(() => { const current = lease(); if (!current) return; const attempts = Math.max(current.attemptCount, job.attemptCount + 1);
      put('reportSearchJobs', { ...current, attemptCount: attempts, status: attempts >= 3 || error instanceof Error && 'status' in error ? 'failed' : 'queued',
        lastError: (error instanceof Error ? error.message : 'Local report retrieval failed.').slice(0, 1500), leaseOwner: undefined, leaseUntil: undefined, nextAttemptAt: new Date(Date.now() + 30_000).toISOString(), updatedAt: now() }); });
  } finally { clearInterval(heartbeat); }
  return true;
}
