import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, stat, unlink } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import path from 'node:path';
import { dataDir, mediaDir, get, list, now, put, remove, transaction } from '../../../packages/shared/store.ts';
import { fixtureAnalysis, verifyFixture } from './fixtures.ts';
import { ollamaAnalysis } from './ollama.ts';
import { isInside, probeVideo, runFfmpeg, safeMediaPath, safeOutputPath, segmentWindows } from './video.ts';
import type { AnalysisResult } from './schema.ts';
import { analysisMode, visionModel } from '../../../packages/shared/local-ai.ts';
import { queueIndex } from './indexer.ts';

import { ANALYSIS_VERSION, wakeReportSearches } from '../../../packages/shared/video-jobs.ts';
export { ANALYSIS_VERSION } from '../../../packages/shared/video-jobs.ts';
export const LEASE_MS = 30_000;
export const MAX_ATTEMPTS = 3;
export const tempRoot = path.join(dataDir, 'temp');
const stableId = (prefix: string, ...values: (string | number)[]) => `${prefix}_${createHash('sha256').update(values.join('|')).digest('hex').slice(0, 24)}`;
export type Job = {
  id: string; townshipId: string; videoId: string; status: string; attemptCount: number;
  leaseUntil?: string; leaseOwner?: string; nextAttemptAt?: string; lastError?: string;
  createdAt: string; updatedAt: string; analysisVersion: string;
};

export function claimJob(owner: string, at = Date.now()): Job | undefined {
  return transaction(() => {
    for (const job of list<Job>('analysisJobs').sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (job.analysisVersion !== ANALYSIS_VERSION) continue;
      const reclaim = job.status === 'processing' && (!job.leaseUntil || Date.parse(job.leaseUntil) <= at);
      const queued = job.status === 'queued' && (!job.nextAttemptAt || Date.parse(job.nextAttemptAt) <= at);
      if (!reclaim && !queued) continue;
      const video = get<any>('videos', job.videoId);
      if (!video || video.status === 'expired' || Date.parse(video.expiresAt) <= at || job.attemptCount >= MAX_ATTEMPTS) {
        put('analysisJobs', { ...job, status: 'failed', leaseOwner: undefined, leaseUntil: undefined,
          lastError: !video || video.status === 'expired' || Date.parse(video.expiresAt) <= at ? 'Video is unavailable or expired.' : 'Maximum attempts reached after interrupted analysis.', updatedAt: new Date(at).toISOString() });
        if (video && video.status !== 'expired') put('videos', { ...video, status: 'failed' });
        continue;
      }
      if (video.status === 'completed' && video.analysisVersion === ANALYSIS_VERSION && video.analysisMode === analysisMode() && (analysisMode() !== 'ollama' || video.analysisModel === visionModel())) {
        put('analysisJobs', { ...job, status: 'completed', leaseOwner: undefined, leaseUntil: undefined, updatedAt: new Date(at).toISOString() });
        continue;
      }
      const claimed = { ...job, status: 'processing', attemptCount: job.attemptCount + 1,
        leaseOwner: owner, leaseUntil: new Date(at + LEASE_MS).toISOString(), updatedAt: new Date(at).toISOString(), nextAttemptAt: undefined };
      put('analysisJobs', claimed);
      put('videos', { ...video, status: 'processing' });
      return claimed;
    }
    return undefined;
  });
}

export function heartbeatJob(id: string, owner: string, at = Date.now()) {
  return transaction(() => {
    const job = get<Job>('analysisJobs', id);
    if (!job || job.status !== 'processing' || job.leaseOwner !== owner || !job.leaseUntil || Date.parse(job.leaseUntil) < at) return false;
    put('analysisJobs', { ...job, leaseUntil: new Date(at + LEASE_MS).toISOString(), updatedAt: new Date(at).toISOString() });
    return true;
  });
}

type Candidate = AnalysisResult['candidateEvents'][number] & { segmentId: string };
function mergedCandidates(candidates: Candidate[]) {
  const groups: { type: Candidate['type']; startSec: number; endSec: number; segmentIds: string[]; evidence: string[]; uncertainties: string[] }[] = [];
  for (const item of candidates.sort((a, b) => a.startSec - b.startSec)) {
    const group = groups.find(current => current.type === item.type && item.startSec <= current.endSec + 0.25 && item.endSec >= current.startSec);
    if (group) {
      group.startSec = Math.min(group.startSec, item.startSec); group.endSec = Math.max(group.endSec, item.endSec);
      group.segmentIds = [...new Set([...group.segmentIds, item.segmentId])];
      group.evidence = [...new Set([...group.evidence, item.evidence])];
      group.uncertainties = [...new Set([...group.uncertainties, ...item.uncertainties])];
    } else groups.push({ type: item.type, startSec: item.startSec, endSec: item.endSec,
      segmentIds: [item.segmentId], evidence: [item.evidence], uncertainties: item.uncertainties });
  }
  return groups;
}

async function deleteTemp(dir: string) {
  if (!isInside(tempRoot, dir)) throw new Error('Temporary cleanup target is outside its directory.');
  // The worker creates only plain directories here; refuse symlinks/junctions via resolved path.
  const { realpath } = await import('node:fs/promises');
  try {
    if (!isInside(await realpath(tempRoot), await realpath(dir))) throw new Error('Temporary cleanup target resolves outside its directory.');
    await rm(dir, { recursive: true, force: true });
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
}

export async function executeJob(job: Job, owner: string) {
  const abort = new AbortController();
  const tempDir = path.join(tempRoot, stableId('work', job.id, owner, job.attemptCount));
  const heartbeat = setInterval(() => {
    try { if (!heartbeatJob(job.id, owner)) abort.abort(new Error('Analysis lease was lost.')); }
    catch { abort.abort(new Error('Unable to renew analysis lease.')); }
  }, 5000);
  heartbeat.unref();
  try {
    const video = get<any>('videos', job.videoId);
    const media = video && get<any>('media', video.mediaId);
    if (!video || !media || media.unavailable) throw new Error('Video media is unavailable.');
    const original = await safeMediaPath(mediaDir, media.path);
    const probe = await probeVideo(original);
    if (Math.abs(probe.durationSec - video.durationSec) > 0.1 || !Number.isFinite(Date.parse(video.recordedAt))) throw new Error('Video duration or recording time is invalid.');
    const mode = process.env.AI_MODE || process.env.JAGAAI_AI_MODE || 'fixture';
    if (!['fixture', 'ollama'].includes(mode)) throw new Error('AI_MODE must be fixture or ollama.');
    const fixtureKey = mode === 'fixture' ? await verifyFixture(video, original) : undefined;
    await mkdir(tempDir, { recursive: true });
    const thumbnailDir = path.join(mediaDir, 'thumbnails');
    await mkdir(thumbnailDir, { recursive: true });
    const segments: any[] = [], thumbnails: any[] = [], candidates: Candidate[] = [];
    const windows = segmentWindows(probe.durationSec);
    for (const [index, window] of windows.entries()) {
      abort.signal.throwIfAborted();
      const duration = window.endSec - window.startSec;
      const segmentId = stableId('segment', video.id, window.startSec, window.endSec, ANALYSIS_VERSION);
      const thumbnailId = stableId('thumb', segmentId);
      const clipPath = path.join(tempDir, `segment-${index}.mp4`);
      await runFfmpeg(['-ss', String(window.startSec), '-i', original, '-t', String(duration), '-map', '0:v:0', '-an', '-vf', 'scale=640:-2', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25', clipPath], abort.signal);
      const thumbnailPath = path.join(tempDir, `thumbnail-${index}.jpg`);
      await runFfmpeg(['-ss', String(Math.min(0.5, duration / 2)), '-i', clipPath, '-frames:v', '1', '-vf', 'scale=480:-2', thumbnailPath], abort.signal);
      let analysis: AnalysisResult, model: string, digest: string | undefined;
      if (mode === 'fixture') { analysis = fixtureAnalysis(fixtureKey!, window.startSec, window.endSec); model = 'predefined-synthetic-fixture-v1'; }
      else {
        const frames: string[] = [], times: number[] = [];
        for (let i = 0; i < 4; i++) {
          const time = Math.max(0, Math.min(duration - Math.max(0.25, 1 / probe.fps), duration * i / 3));
          const framePath = path.join(tempDir, `frame-${index}-${i}.jpg`);
          await runFfmpeg(['-ss', String(Math.max(0, time)), '-i', clipPath, '-frames:v', '1', '-vf', 'scale=448:-2', framePath], abort.signal);
          frames.push(framePath); times.push(Number(time.toFixed(3)));
        }
        ({ analysis, model, digest } = await ollamaAnalysis(frames, times, duration, abort.signal));
      }
      segments.push({ id: segmentId, townshipId: video.townshipId, videoId: video.id, cameraId: video.cameraId, locationId: video.locationId,
        ...window, absoluteStartAt: new Date(Date.parse(video.recordedAt) + window.startSec * 1000).toISOString(), summary: analysis.summary,
        observations: analysis.observations.map(item => ({ ...item, startSec: item.startSec + window.startSec, endSec: item.endSec + window.startSec })),
        uncertainties: analysis.uncertainties || [], sampleCount: mode === 'ollama' ? 4 : undefined,
        thumbnailId, analysisVersion: ANALYSIS_VERSION, analysisMode: mode, model, modelDigest: digest, promptVersion: 'sample-caption-v3', createdAt: now() });
      thumbnails.push({ id: thumbnailId, townshipId: video.townshipId, kind: 'thumbnail', videoId: video.id,
        path: await safeOutputPath(mediaDir, path.join(thumbnailDir, `${thumbnailId}.jpg`)), temporaryPath: thumbnailPath, contentType: 'image/jpeg', expiresAt: video.expiresAt });
      candidates.push(...analysis.candidateEvents.map(item => ({ ...item, startSec: item.startSec + window.startSec, endSec: item.endSec + window.startSec, segmentId })));
      transaction(() => {
        const current = get<Job>('analysisJobs', job.id);
        if (current?.status === 'processing' && current.leaseOwner === owner) put('analysisJobs', { ...current, progress: { completedSegments: index + 1, totalSegments: windows.length }, updatedAt: now() });
      });
    }
    transaction(() => {
      const current = get<Job>('analysisJobs', job.id), currentVideo = get<any>('videos', video.id);
      if (abort.signal.aborted || current?.status !== 'processing' || current.leaseOwner !== owner ||
          !current.leaseUntil || Date.parse(current.leaseUntil) <= Date.now() || currentVideo?.status === 'expired' || Date.parse(video.expiresAt) <= Date.now()) {
        throw new Error('Analysis lease expired or video became unavailable before completion.');
      }
      for (const thumbnail of thumbnails) {
        const { temporaryPath, ...record } = thumbnail;
        renameSync(temporaryPath, record.path);
        put('media', record);
      }
      for (const segment of segments) put('segments', segment);
      for (const candidate of mergedCandidates(candidates)) {
        const id = stableId('alert', video.id, candidate.type, candidate.startSec, candidate.endSec, ANALYSIS_VERSION);
        const previous = get<any>('alerts', id);
        put('alerts', { ...previous, id, townshipId: video.townshipId, videoId: video.id, cameraId: video.cameraId, locationId: video.locationId,
          segmentIds: candidate.segmentIds, eventType: candidate.type, startSec: candidate.startSec, endSec: candidate.endSec,
          evidence: candidate.evidence.join(' '), evidenceSources: candidate.evidence, uncertainties: candidate.uncertainties,
          reviewStatus: previous?.reviewStatus || 'pending_review', createdAt: previous?.createdAt || now(), analysisMode: mode, analysisVersion: ANALYSIS_VERSION });
      }
      put('analysisJobs', { ...current, status: 'completed', lastError: undefined, leaseOwner: undefined, leaseUntil: undefined, updatedAt: now() });
      const completed = put('videos', { ...currentVideo, status: 'completed', lastError: undefined, analysisVersion: ANALYSIS_VERSION, analysisMode: mode, analysisModel: segments[0]?.model, analysedAt: now() });
      if (mode === 'ollama') queueIndex(completed, true);
      wakeReportSearches(completed);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Local analysis failed.';
    transaction(() => {
      const current = get<Job>('analysisJobs', job.id), video = get<any>('videos', job.videoId);
      if (current?.status !== 'processing' || current.leaseOwner !== owner) return;
      const terminal = current.attemptCount >= MAX_ATTEMPTS || message.startsWith('Local vision model required:') || video?.status === 'expired';
      put('analysisJobs', { ...current, status: terminal ? 'failed' : 'queued', lastError: message.slice(0, 1500), leaseOwner: undefined, leaseUntil: undefined,
        nextAttemptAt: terminal ? undefined : new Date(Date.now() + 5000 * 2 ** (current.attemptCount - 1)).toISOString(), updatedAt: now() });
      if (video && video.status !== 'expired') put('videos', { ...video, status: terminal ? 'failed' : 'queued', lastError: message.slice(0, 1500) });
    });
  } finally {
    clearInterval(heartbeat);
    await deleteTemp(tempDir);
  }
}

export async function processNextJob(owner: string) {
  const job = claimJob(owner);
  if (!job) return false;
  await executeJob(job, owner);
  return true;
}

export async function cleanupExpired(at = Date.now()) {
  const expiredIds = new Set(list<any>('videos').filter(video => video.expiresAt && Date.parse(video.expiresAt) <= at).map(video => video.id));
  transaction(() => {
    for (const id of expiredIds) {
      const video = get<any>('videos', id);
      if (video.status !== 'expired') put('videos', { ...video, status: 'expired', expiredAt: new Date(at).toISOString() });
      for (const job of list<Job>('analysisJobs', video.townshipId).filter(item => item.videoId === id && ['queued', 'processing'].includes(item.status))) {
        put('analysisJobs', { ...job, status: 'failed', lastError: 'Video retention period ended.', leaseOwner: undefined, leaseUntil: undefined, updatedAt: new Date(at).toISOString() });
      }
      for (const segment of list<any>('segments', video.townshipId).filter(item => item.videoId === id)) remove('segments', segment.id);
      for (const vector of list<any>('segmentEmbeddings', video.townshipId).filter(item => item.videoId === id)) remove('segmentEmbeddings', vector.id);
      for (const job of list<any>('indexJobs', video.townshipId).filter(item => item.videoId === id)) remove('indexJobs', job.id);
      for (const alert of list<any>('alerts', video.townshipId).filter(item => item.videoId === id)) remove('alerts', alert.id);
      for (const candidate of list<any>('reportCandidates', video.townshipId).filter(item => item.videoId === id && !item.expiredAt)) {
        const { summary, observations, uncertainties, score, ...history } = candidate;
        put('reportCandidates', { ...history, expiredAt: new Date(at).toISOString() });
      }
      for (const evidence of list<any>('incidentEvidence', video.townshipId).filter(item => item.videoId === id && item.reviewedClip)) {
        const { aiSummary, ...history } = evidence;
        put('incidentEvidence', { ...history, unavailable: true });
      }
    }
    for (const media of list<any>('media')) {
      if ((media.videoId && expiredIds.has(media.videoId)) || (media.expiresAt && Date.parse(media.expiresAt) <= at)) put('media', { ...media, unavailable: true });
    }
  });
  for (const view of list<any>('candidateViews').filter(item => Date.parse(item.expiresAt) <= at || get<any>('reportCandidates', item.candidateId)?.expiredAt)) remove('candidateViews', view.id);
  for (const media of list<any>('media').filter(item => item.unavailable)) {
    try {
      try { await unlink(await safeMediaPath(mediaDir, media.path)); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      remove('media', media.id);
    } catch (error) { put('media', { ...media, cleanupError: error instanceof Error ? error.message : 'Cleanup failed.' }); }
  }
  await mkdir(tempRoot, { recursive: true });
  const activeJobs = list<Job>('analysisJobs').filter(job => job.status === 'processing' && job.leaseUntil && Date.parse(job.leaseUntil) > at);
  const activeDirs = new Set(activeJobs.map(job => stableId('work', job.id, job.leaseOwner!, job.attemptCount)));
  for (const entry of await readdir(tempRoot, { withFileTypes: true })) {
    const dir = path.join(tempRoot, entry.name);
    if (entry.isDirectory() && entry.name.startsWith('work_') && !activeDirs.has(entry.name) && at - (await stat(dir)).mtimeMs > LEASE_MS * 2) await deleteTemp(dir);
  }
}
