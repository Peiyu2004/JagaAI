import { get, list, db } from '../../../packages/shared/store.ts';
import { contentHash, cosine, embedTexts, embeddingModel, installedModels, segmentText, visionModel } from '../../../packages/shared/local-ai.ts';

export function footageInScope(townshipId: string, locationId?: string, timeFrom?: string, timeTo?: string, cameraIds?: string[]) {
  const from = timeFrom ? Date.parse(timeFrom) : -Infinity, to = timeTo ? Date.parse(timeTo) : Infinity;
  if (Number.isNaN(from) || Number.isNaN(to)) throw new Error('Invalid time filter.');
  const cameras = cameraIds && new Set(cameraIds);
  const videos = list<any>('videos', townshipId).filter(v => v.status !== 'expired' && Date.parse(v.expiresAt) > Date.now() && (!locationId || v.locationId === locationId) && (!cameras || cameras.has(v.cameraId)) && Date.parse(v.recordedAt) < to && Date.parse(v.recordedAt) + v.durationSec * 1000 > from);
  const videoMap = new Map(videos.map(v => [v.id, v]));
  const segments = list<any>('segments', townshipId).filter(s => { const v = videoMap.get(s.videoId); return v && s.analysisVersion === v.analysisVersion && s.analysisMode === 'ollama' && Date.parse(v.recordedAt) + s.startSec * 1000 < to && Date.parse(v.recordedAt) + s.endSec * 1000 > from; });
  return { videos, videoMap, segments };
}
export function coverageOf(scope: ReturnType<typeof footageInScope>, digest?: string) {
  const ready = scope.segments.filter(s => {
    const e = get<any>('segmentEmbeddings', s.id);
    return e?.townshipId === s.townshipId && e.model === embeddingModel() && (!digest || e.digest === digest) && e.contentHash === contentHash(segmentText(s));
  });
  const covered = new Set(scope.segments.map(s => s.videoId));
  return { totalVideos: scope.videos.length, unanalysedVideos: scope.videos.filter(v => !covered.has(v.id)).length,
    describedSegments: scope.segments.length, indexedSegments: ready.length, pendingSegments: scope.segments.length - ready.length,
    fixtureVideos: scope.videos.filter(v => v.analysisMode === 'fixture').length };
}
export async function aiStatus(townshipId: string) {
  let models: Awaited<ReturnType<typeof installedModels>> = [], error: string | undefined;
  try { models = await installedModels(); } catch (e) { error = e instanceof Error ? e.message : 'Local AI unavailable.'; }
  const find = (name: string) => models.find(m => m.name === name || m.name === `${name}:latest`);
  return { available: !error, error, visionModel: visionModel(), embeddingModel: embeddingModel(), visionReady: Boolean(find(visionModel())),
    embeddingReady: Boolean(find(embeddingModel())), localOnly: true, coverage: coverageOf(footageInScope(townshipId), find(embeddingModel())?.digest),
    models: models.map(m => ({ name: m.name, digest: m.digest, size: m.size })) };
}
export async function semanticSearch(townshipId: string, query: string, filters: { locationId?: string; timeFrom?: string; timeTo?: string; cameraIds?: string[] }, signal?: AbortSignal) {
  const embedded = await embedTexts([query], true, signal);
  // Re-read scope after the async model call: retention/reanalysis may have changed it.
  const scope = footageInScope(townshipId, filters.locationId, filters.timeFrom, filters.timeTo, filters.cameraIds), coverage = coverageOf(scope, embedded.digest);
  const candidates = scope.segments.flatMap(s => {
    // Read only the vector for an already authorised, current, non-expired segment.
    const row = db.prepare('SELECT data FROM documents WHERE kind=? AND id=? AND townshipId=?').get('segmentEmbeddings', s.id, townshipId);
    const e = row && JSON.parse(String(row.data));
    if (!e || e.model !== embedded.model || e.digest !== embedded.digest || e.dimension !== embedded.dimension || e.contentHash !== contentHash(segmentText(s))) return [];
    const score = cosine(embedded.vectors[0], e.vector);
    if (!Number.isFinite(score)) return [];
    return [{ ...s, score, video: scope.videoMap.get(s.videoId), matchReason: 'Ranked by multilingual semantic similarity to the sampled visual description. Each requested detail needs verification in the original video.',
      matchType: 'semantic_candidate', embeddingModel: embedded.model }];
  }).sort((a, b) => b.score - a.score);
  // Suppress overlapping windows; a click still opens the exact source interval.
  const results: typeof candidates = [];
  for (const candidate of candidates) {
    if (!results.some(r => r.videoId === candidate.videoId && r.startSec < candidate.endSec && r.endSec > candidate.startSec)) results.push(candidate);
    if (results.length >= 8) break;
  }
  return { results, coverage, mode: 'semantic', model: embedded.model,
    notice: 'Closest candidate footage, not verified matches. Similarity is a ranking score, not confidence or proof. Brands, identities and intent are not verified. Sampled frames can miss short events. Unanalysed or unindexed footage is excluded.' };
}
