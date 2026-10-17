import { audit, list, put, uid, now } from './store.ts';
import { analysisMode, visionModel } from './local-ai.ts';
export const ANALYSIS_VERSION = 'local-v2';
export class WorkflowError extends Error { constructor(public status: number, message: string) { super(message); } }
export function raise(status: number, message: string): never { throw new WorkflowError(status, message); }

export function wakeReportSearches(video: any) {
  const start = Date.parse(video.recordedAt), end = start + video.durationSec * 1000;
  for (const job of list<any>('reportSearchJobs', video.townshipId)) {
    if (['waiting_media', 'waiting_analysis', 'waiting_index'].includes(job.status) && job.scope.locationId === video.locationId && start < Date.parse(job.scope.timeTo) && end > Date.parse(job.scope.timeFrom)) put('reportSearchJobs', { ...job, nextAttemptAt: now() });
  }
}

// Call while holding the caller's store transaction.
export function queueVideo(video: any, user: { id: string; townshipId: string }, retry = false, reanalyze = false) {
  retry ||= reanalyze;
  const jobs = list('analysisJobs', user.townshipId).filter(j => j.videoId === video.id && j.analysisVersion === ANALYSIS_VERSION);
  const upToDate = video.status === 'completed' && video.analysisVersion === ANALYSIS_VERSION && video.analysisMode === analysisMode() && (analysisMode() !== 'ollama' || video.analysisModel === visionModel());
  const existing = jobs.find(j => ['queued', 'processing'].includes(j.status) || (j.status === 'completed' && upToDate && !reanalyze));
  if (existing) return existing;
  const failed = jobs.find(j => j.status === 'failed');
  if (failed && failed.attemptCount >= 3 && !retry) raise(409, 'Analysis has reached its three-attempt limit. Upload again after correcting the local model configuration.');
  if (list('analysisJobs', user.townshipId).filter(j => ['queued', 'processing'].includes(j.status)).length >= 50) raise(429, 'The local analysis queue is full.');
  const job = failed ? { ...failed, attemptCount: retry ? 0 : failed.attemptCount, status: 'queued', lastError: undefined, progress: undefined, leaseOwner: undefined, leaseUntil: undefined, nextAttemptAt: undefined, updatedAt: now() } : { id: uid('job'), townshipId: user.townshipId, videoId: video.id, status: 'queued', attemptCount: 0, analysisVersion: ANALYSIS_VERSION, createdAt: now(), updatedAt: now() };
  put('analysisJobs', job);
  put('videos', { ...video, status: 'queued', lastError: undefined });
  audit(user, failed ? 'video.retry' : 'video.analyze', 'videos', video.id);
  return job;
}
