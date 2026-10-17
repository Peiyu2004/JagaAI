import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { dataDir } from '../../../packages/shared/store.ts';
import { validateAnalysis, type AnalysisResult } from './schema.ts';

export const fixtureSpecs = [
  { key: 'walking', title: 'Synthetic demo: evening walk', cameraId: 'cam_north', locationId: 'loc_north', durationSec: 24 },
  { key: 'bicycle', title: 'Synthetic demo: bicycle movement', cameraId: 'cam_club', locationId: 'loc_club', durationSec: 24 },
  { key: 'fall', title: 'Synthetic demo: safe posture change', cameraId: 'cam_lake', locationId: 'loc_lake', durationSec: 36 },
] as const;
export const manifestSchema = z.object({
  version: z.literal(1), synthetic: z.literal(true),
  entries: z.array(z.object({
    key: z.enum(['walking', 'bicycle', 'fall']), videoId: z.string(), mediaId: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), durationSec: z.number().positive(),
  }).strict()).max(3),
}).strict();
export const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

export async function verifyFixture(video: any, filePath: string) {
  if (video.source !== 'synthetic_fixture') throw new Error('Local vision model required: this upload cannot use predefined synthetic demo analysis. Set AI_MODE=ollama and configure an installed local vision model.');
  const manifest = manifestSchema.parse(JSON.parse(await readFile(path.join(dataDir, 'fixtures', 'manifest.json'), 'utf8')));
  const entry = manifest.entries.find(item => item.videoId === video.id && item.mediaId === video.mediaId && item.key === video.fixtureKey);
  const spec = fixtureSpecs.find(item => item.key === entry?.key);
  if (!entry || !spec || entry.sha256 !== sha256(await readFile(filePath)) ||
      entry.durationSec !== spec.durationSec || Math.abs(video.durationSec - spec.durationSec) > 0.1) {
    throw new Error('Synthetic demo hash or manifest mismatch. Regenerate the local fixtures; uploaded footage requires a local vision model.');
  }
  return spec.key;
}

/** Predefined annotations describe the authored animation; they are not visual model inference. */
export function fixtureAnalysis(key: string, startSec: number, endSec: number): AnalysisResult {
  const duration = endSec - startSec;
  const notice = 'Predefined synthetic demo annotation; no visual AI inference. ';
  const observations: AnalysisResult['observations'] = [];
  const candidateEvents: AnalysisResult['candidateEvents'] = [];
  const addObservation = (from: number, to: number, description: string) => {
    const start = Math.max(startSec, from), end = Math.min(endSec, to);
    if (start < end) observations.push({ startSec: start - startSec, endSec: end - startSec, description: notice + description });
  };
  let summary: string;
  if (key === 'walking') {
    summary = notice + 'An animated person walks along the path. No candidate fall event is annotated.';
    addObservation(0, 24, 'A blue animated person walks from left to right on the North Gate path.');
  } else if (key === 'bicycle') {
    summary = notice + 'An animated person moves a bicycle across the Clubhouse walkway. Permission and ownership are unknown.';
    addObservation(0, 24, 'A yellow bicycle and blue animated person move together from left to right.');
  } else if (key === 'fall') {
    summary = notice + 'A safely authored animation changes from standing to horizontal, then remains lying on the Lakeside path.';
    addObservation(0, 6, 'An animated person is standing.');
    addObservation(6, 9, 'An animated person changes from standing to horizontal on the ground; possible fall candidate.');
    addObservation(9, 36, 'The animated person remains horizontal on the ground over successive frames.');
    for (const event of [
      { type: 'possible_fall' as const, from: 6, to: 9, evidence: 'The authored animation changes from a standing posture to a horizontal posture.' },
      { type: 'prolonged_lying' as const, from: 9, to: 36, evidence: 'The authored animation remains horizontal for multiple seconds and across successive overlapping segments.' },
    ]) {
      const start = Math.max(startSec, event.from), end = Math.min(endSec, event.to);
      if (end > start && (event.type !== 'prolonged_lying' || end - start >= 3)) candidateEvents.push({
        type: event.type, startSec: start - startSec, endSec: end - startSec,
        evidence: notice + event.evidence,
        uncertainties: ['This is an illustrative animation, not real CCTV or validated fall detection.', 'No injury, identity, intent or responsibility can be established.'],
      });
    }
  } else throw new Error('Unsupported synthetic fixture key.');
  return validateAnalysis({ summary, observations, candidateEvents }, duration);
}
