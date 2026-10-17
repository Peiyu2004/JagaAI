import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import path from 'node:path';
import { createReadStream, existsSync, statSync, unlinkSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { audit, get, list, put, remove, transaction, uid, now, mediaDir } from '../../../packages/shared/store.ts';
import { publicUser, requireAuth, verifyPassword, createSession, logout, opaqueTicket, tokenHash, revokeSessions, isFieldStaff, type User, type Role } from './auth.ts';
import { seedDemo } from './seed.ts';
import { createEvidenceClip } from '../../worker/src/video.ts';
import { ANALYSIS_VERSION, queueVideo, WorkflowError, wakeReportSearches } from '../../../packages/shared/video-jobs.ts';
import { queueIndex } from '../../worker/src/indexer.ts';
import { analysisMode, visionModel, LocalAIError } from '../../../packages/shared/local-ai.ts';
import { parseSearchTime } from '../../../packages/shared/search-time.ts';
import { aiStatus, footageInScope, coverageOf, semanticSearch } from './semantic-search.ts';
import { queueReportSearch, retrievalSummary, candidateSource, reportScope } from '../../worker/src/report-retrieval.ts';
import { contentHash } from '../../../packages/shared/local-ai.ts';
import { queuePrivacyPhoto, privacyMasks, currentPrivacyCopy, residentScreenshots } from '../../../packages/shared/privacy.ts';

export { seedDemo } from './seed.ts';
class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
function fail(status: number, message: string): never { throw new ApiError(status, message); }
const actor = (res: Response): User => res.locals.user;
const param = (req: Request, name = 'id'): string => String(req.params[name]);
const text = (value: unknown, label: string, max = 2000, required = true): string => {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) return fail(400, `${label} is required and must be at most ${max} characters.`);
  return value.trim();
};
const date = (value: unknown, label: string): string => {
  const result = text(value, label, 64);
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(result) || !Number.isFinite(Date.parse(result))) return fail(400, `${label} must be a valid ISO date with timezone.`);
  return new Date(result).toISOString();
};
const integer = (value: unknown, label: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return fail(400, `${label} must be an integer from ${min} to ${max}.`);
  return value;
};
const role = (user: User, ...allowed: Role[]) => { if (!allowed.includes(user.role)) fail(403, 'This action is not available for your role.'); };
function scoped(kind: string, id: string, user: User): any {
  const record = get(kind, id);
  if (!record || record.townshipId !== user.townshipId) fail(404, 'Record not found.');
  return record;
}
const location = (value: unknown, user: User) => scoped('locations', text(value, 'Location', 100), user);
const assigned = (incidentId: string, user: User, activeOnly = false) => list('assignments', user.townshipId).find(a => a.incidentId === incidentId && a.assigneeId === user.id && !a.revokedAt && (activeOnly ? ['assigned', 'accepted', 'arrived'].includes(a.status) : a.status !== 'cancelled'));
function canSeeReport(report: any, user: User) {
  return report.townshipId === user.townshipId && (user.role === 'management' || (user.role === 'resident' && report.reporterId === user.id) || (isFieldStaff(user) && report.incidentId && Boolean(assigned(report.incidentId, user))));
}
function canSeeIncident(incident: any, user: User) {
  return incident.townshipId === user.townshipId && (user.role === 'management' || (isFieldStaff(user) && Boolean(assigned(incident.id, user))) || (user.role === 'resident' && list('reports', user.townshipId).some(r => r.reporterId === user.id && r.incidentId === incident.id)));
}
function visibleReport(report: any, user: User) {
  const aiRetrieval = retrievalSummary(report);
  if (user.role !== 'resident') return { ...report, aiRetrieval };
  return { id: report.id, townshipId: report.townshipId, number: report.number, reporterId: report.reporterId, locationId: report.locationId, category: report.category, timeFrom: report.timeFrom, timeTo: report.timeTo, description: report.description, photoIds: report.photoIds, status: report.status, incidentId: report.incidentId, publicUpdates: report.publicUpdates || [], createdAt: report.createdAt, demo: report.demo, aiRetrieval, sharedScreenshots: report.incidentId ? residentScreenshots(report.incidentId, user.townshipId) : [] };
}
function videoForTask(videoId: string, user: User) {
  if (user.role === 'management') return true;
  if (!isFieldStaff(user)) return false;
  const incidents = list('incidents', user.townshipId).filter(i => assigned(i.id, user));
  return incidents.some(i => list('alerts', user.townshipId).some(a => a.videoId === videoId && (a.incidentId === i.id || (i.alertIds || []).includes(a.id))) || list('incidentEvidence', user.townshipId).some(e => e.incidentId === i.id && e.videoId === videoId));
}
function incidentView(incident: any, user: User) {
  const updates = list('incidentUpdates', user.townshipId).filter(u => u.incidentId === incident.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (user.role === 'resident') return { id: incident.id, title: 'Your report follow-up', category: incident.category, locationId: incident.locationId, status: incident.status, createdAt: incident.createdAt, updatedAt: incident.updatedAt, updates: updates.filter(u => u.visibility === 'public').map(u => ({ id: u.id, action: u.action, note: u.note, visibility: 'public', createdAt: u.createdAt })), evidence: [], sharedScreenshots: residentScreenshots(incident.id, user.townshipId) };
  const evidence = list('incidentEvidence', user.townshipId).filter(e => e.incidentId === incident.id).map(e => { const source = e.reviewedClip && get('videos', e.videoId); return source && source.townshipId === user.townshipId ? { ...e, locationId: e.locationId || incident.locationId, recordedAt: new Date(Date.parse(source.recordedAt) + e.startSec * 1000).toISOString() } : e; });
  for (const alert of list('alerts', user.townshipId).filter(a => a.incidentId === incident.id || (incident.alertIds || []).includes(a.id))) {
    const video = get('videos', alert.videoId);
    if (video) evidence.push({ id: `alert_${alert.id}`, kind: 'video', mediaId: video.mediaId, videoId: video.id, startSec: alert.startSec, endSec: alert.endSec, description: alert.evidence, alertId: alert.id });
  }
  return { ...incident, updates, evidence, assignments: list('assignments', user.townshipId).filter(a => a.incidentId === incident.id) };
}
function publishProgress(incident: any, note: string) {
  for (const report of list('reports', incident.townshipId).filter(r => r.incidentId === incident.id)) {
    report.status = ['resolved', 'closed'].includes(incident.status) ? 'resolved' : 'linked';
    report.publicUpdates = [...(report.publicUpdates || []), { status: incident.status, note, createdAt: now() }];
    put('reports', report);
  }
}
function linkReport(report: any, incident: any, user: User) {
  if (report.incidentId && report.incidentId !== incident.id) fail(409, 'This report is already linked to another incident.');
  report.incidentId = incident.id;
  report.status = ['resolved', 'closed'].includes(incident.status) ? 'resolved' : 'linked';
  if (!(incident.reportIds || []).includes(report.id)) {
    incident.reportIds = [...(incident.reportIds || []), report.id];
    report.publicUpdates = [...(report.publicUpdates || []), { status: incident.status, note: 'Your report has been linked to a follow-up incident.', createdAt: now() }];
    put('incidents', incident);
    put('reports', report);
    audit(user, 'report.link', 'reports', report.id);
  }
}
function newIncident(body: any, user: User) {
  const title = text(body.title, 'Title', 180);
  const category = text(body.category, 'Category', 80);
  const locationId = location(body.locationId, user).id;
  const priority = body.priority || 'normal';
  if (!['low', 'normal', 'high', 'urgent'].includes(priority)) fail(400, 'Priority must be low, normal, high or urgent.');
  const incident: any = { id: uid('incident'), townshipId: user.townshipId, title, category, locationId, priority, status: 'open', createdBy: user.id, createdAt: now(), updatedAt: now(), reportIds: [], alertIds: [] };
  put('incidents', incident);
  audit(user, 'incident.create', 'incidents', incident.id);
  return incident;
}
function mediaAllowed(media: any, user: User): boolean {
  if (media.townshipId !== user.townshipId) return false;
  if (user.role === 'management') return true;
  if (media.privacyDraftId) {
    if (!currentPrivacyCopy(media)) return false;
    if (user.role === 'resident') return Boolean(list('reports', user.townshipId).some(r => r.incidentId === media.incidentId && r.reporterId === user.id) && list('screenshotShares', user.townshipId).some(s => s.mediaId === media.id && s.status === 'published'));
    return Boolean(isFieldStaff(user) && assigned(media.incidentId, user));
  }
  if (media.reportId) {
    const report = get('reports', media.reportId);
    if (report && media.kind === 'photo' && canSeeReport(report, user)) return true;
  }
  if (user.role === 'resident') return false;
  if (media.incidentId && assigned(media.incidentId, user) && (media.kind === 'photo' || media.evidenceClip === true)) return true;
  return false;
}
function availableMedia(id: string, user: User) {
  const media = scoped('media', id, user);
  if (!mediaAllowed(media, user)) fail(404, 'Media not found.');
  if (media.unavailable) fail(410, 'This media is no longer available.');
  if (media.expiresAt && Date.parse(media.expiresAt) <= Date.now()) fail(410, 'This media has expired.');
  const candidate = path.resolve(media.path);
  if (!existsSync(candidate)) fail(410, 'This media is no longer available.');
  const relative = path.relative(mediaDir, candidate);
  const filePath = realpathSync(candidate);
  const resolvedRelative = path.relative(realpathSync(mediaDir), filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !resolvedRelative || resolvedRelative.startsWith('..') || path.isAbsolute(resolvedRelative) || !statSync(filePath).isFile()) fail(410, 'This media is no longer available.');
  return { media, filePath };
}
const clipLocks = new Map<string, Promise<any>>();
async function guardEvidenceMedia(source: any, user: User, requestedAlertId?: string) {
  const video = scoped('videos', source.videoId, user);
  const alert = list('alerts', user.townshipId).find(a => a.videoId === video.id && (!requestedAlertId || a.id === requestedAlertId) && list('incidents', user.townshipId).some(i => assigned(i.id, user) && (a.incidentId === i.id || (i.alertIds || []).includes(a.id))));
  if (!alert) fail(404, 'Assigned evidence not found.');
  const incident = list('incidents', user.townshipId).find(i => assigned(i.id, user) && (alert.incidentId === i.id || (i.alertIds || []).includes(alert.id)));
  const sourcePath = availableMedia(source.id, { ...user, role: 'management' }).filePath;
  if (Date.parse(source.expiresAt || video.expiresAt) <= Date.now()) fail(410, 'The source evidence has expired.');
  const id = `media_clip_${alert.id}`;
  const existing = get('media', id);
  if (existing && existing.sourceStartSec === alert.startSec && existing.sourceEndSec === alert.endSec && existsSync(existing.path) && Date.parse(existing.expiresAt) > Date.now()) return existing;
  const inflight = clipLocks.get(id);
  if (inflight) return inflight;
  const promise = (async () => {
    const output = path.join(mediaDir, `${uid('evidence_clip')}.mp4`);
    try {
      await createEvidenceClip(sourcePath, output, alert.startSec, alert.endSec);
      const expiresAt = new Date(Math.min(Date.parse(source.expiresAt || video.expiresAt), Date.now() + 30 * 60_000)).toISOString();
      if (existing?.path && existsSync(existing.path)) unlinkSync(existing.path);
      return put('media', { id, townshipId: user.townshipId, path: output, contentType: 'video/mp4', kind: 'video', videoId: video.id, incidentId: incident.id, evidenceClip: true, sourceStartSec: alert.startSec, sourceEndSec: alert.endSec, expiresAt, createdAt: now() });
    } catch (error) { if (existsSync(output)) unlinkSync(output); throw error; }
  })();
  clipLocks.set(id, promise);
  try { return await promise; } finally { clipLocks.delete(id); }
}
const photoUpload = multer({ storage: multer.diskStorage({ destination: mediaDir, filename: (_req, _file, callback) => callback(null, uid('photo')) }), limits: { fileSize: 8 * 1024 * 1024, files: 3, fields: 12 }, fileFilter: (_req, file, callback) => {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)) callback(new ApiError(400, 'Photos must be JPEG, PNG, WebP or GIF.'));
  else callback(null, true);
} });
const videoUpload = multer({ storage: multer.diskStorage({ destination: mediaDir, filename: (_req, _file, callback) => callback(null, uid('video')) }), limits: { fileSize: Number(process.env.MAX_VIDEO_MB || 150) * 1024 * 1024, files: 1, fields: 8 }, fileFilter: (_req, file, callback) => {
  if (!file.originalname.toLowerCase().endsWith('.mp4')) callback(new ApiError(400, 'Upload an MP4 file.'));
  else callback(null, true);
} });
function photoType(file: Express.Multer.File) {
  const header = Buffer.alloc(16);
  const fd = openSync(file.path, 'r');
  try { readSync(fd, header, 0, 16, 0); } finally { closeSync(fd); }
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(header.toString('ascii', 0, 6))) return 'image/gif';
  if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return fail(400, 'A photo does not contain a supported image format.');
}
const uploads = (req: Request): Express.Multer.File[] => req.file ? [req.file] : Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat();
function cleanupUploads(req: Request) { for (const file of uploads(req)) if (existsSync(file.path)) try { unlinkSync(file.path); } catch { /* Preserve the original request error. */ } }
function savePhotos(files: Express.Multer.File[], user: User, extra: object) {
  return files.map(file => put('media', { id: uid('media'), townshipId: user.townshipId, path: file.path, contentType: photoType(file), kind: 'photo', ownerId: user.id, createdAt: now(), ...extra }));
}
async function probeMp4(filePath: string) {
  const require = createRequire(import.meta.url);
  const binary = require('ffprobe-static').path;
  const { stdout } = await promisify(execFile)(binary, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath], { timeout: 20000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  const result = JSON.parse(stdout);
  const stream = result.streams?.find((s: any) => s.codec_type === 'video');
  const durationSec = Number(result.format?.duration);
  const formats = String(result.format?.format_name || '').split(',');
  if (!stream || !formats.includes('mp4') || result.format?.tags?.major_brand?.trim() === 'qt' || !Number.isFinite(durationSec) || durationSec <= 0 || durationSec > Number(process.env.MAX_VIDEO_SECONDS || 300)) fail(400, `Upload a valid MP4 video lasting at most ${process.env.MAX_VIDEO_SECONDS || 300} seconds.`);
  return { durationSec, width: stream.width, height: stream.height };
}

export const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  const host = (req.headers.host || '').split(':')[0];
  if (!['127.0.0.1', 'localhost'].includes(host)) { res.status(403).json({ error: 'This service accepts local requests only.' }); return; }
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method) && req.headers.origin) {
    let origin: URL;
    try { origin = new URL(req.headers.origin); } catch { res.status(403).json({ error: 'Invalid request origin.' }); return; }
    const permitted = new Set([`http://${req.headers.host}`, `http://127.0.0.1:${process.env.WEB_PORT || 5173}`, `http://localhost:${process.env.WEB_PORT || 5173}`]);
    if (!permitted.has(origin.origin)) { res.status(403).json({ error: 'This service accepts requests from its local browser page only.' }); return; }
  }
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => { if (req.body == null) req.body = {}; next(); });
app.get('/api/health', (_req, res) => res.json({ status: 'ok', mode: 'local', timeZone: 'Asia/Kuala_Lumpur' }));
const loginAttempts = new Map<string, { count: number; until: number }>();
app.post('/api/auth/login', (req, res) => {
  const email = text(req.body?.email, 'Email', 254).toLowerCase();
  const password = text(req.body?.password, 'Password', 256);
  const key = req.ip || 'local';
  const attempts = loginAttempts.get(key);
  if (attempts && attempts.until > Date.now() && attempts.count >= 20) fail(429, 'Too many sign-in attempts. Try again in 15 minutes.');
  const user = list<User>('users').find(u => u.email.toLowerCase() === email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    const count = attempts && attempts.until > Date.now() ? attempts.count + 1 : 1;
    loginAttempts.set(key, { count, until: Date.now() + 15 * 60_000 });
    fail(401, 'Email or password is incorrect.');
  }
  if (user.membershipStatus !== 'active') fail(403, 'Your membership is not active.');
  loginAttempts.delete(key);
  createSession(user, res);
  res.json(publicUser(user));
});
app.post('/api/auth/logout', (req, res) => { logout(req, res); res.json({ ok: true }); });
app.use('/api', requireAuth);
app.get('/api/me', (_req, res) => res.json(publicUser(actor(res))));
app.get('/api/locations', (_req, res) => res.json(list('locations', actor(res).townshipId)));
app.get('/api/members', (_req, res) => { const user = actor(res); role(user, 'management'); res.json(list<User>('users', user.townshipId).map(publicUser)); });
app.patch('/api/members/:id', (req, res) => {
  const user = actor(res); role(user, 'management');
  const result = transaction(() => {
    const member = scoped('users', param(req), user);
    const membershipStatus = req.body.membershipStatus ?? member.membershipStatus;
    const nextRole = req.body.role ?? member.role;
    if (!['active', 'pending', 'disabled'].includes(membershipStatus) || !['management', 'guard', 'maintenance', 'resident'].includes(nextRole)) fail(400, 'Invalid membership status or role.');
    if (member.role === 'management' && member.membershipStatus === 'active' && (membershipStatus !== 'active' || nextRole !== 'management') && list<User>('users', user.townshipId).filter(u => u.role === 'management' && u.membershipStatus === 'active').length <= 1) fail(409, 'Keep at least one active manager.');
    const updated = put('users', { ...member, membershipStatus, role: nextRole });
    if (membershipStatus !== 'active' || nextRole !== member.role) revokeSessions(member.id, list('sessions', user.townshipId));
    audit(user, 'member.update', 'users', member.id);
    return publicUser(updated);
  });
  res.json(result);
});
app.get('/api/reports', (_req, res) => { const user = actor(res); res.json(list('reports', user.townshipId).filter(r => canSeeReport(r, user)).map(r => visibleReport(r, user))); });
app.get('/api/reports/:id', (req, res) => { const user = actor(res); const report = scoped('reports', param(req), user); if (!canSeeReport(report, user)) fail(404, 'Report not found.'); res.json(visibleReport(report, user)); });
app.post('/api/reports', photoUpload.array('photos', 3), (req, res) => {
  const user = actor(res);
  const timeFrom = date(req.body.timeFrom, 'Start time');
  const timeTo = date(req.body.timeTo, 'End time');
  if (Date.parse(timeFrom) > Date.parse(timeTo)) fail(400, 'End time must be after start time.');
  const report: any = { id: uid('report'), townshipId: user.townshipId, number: `JG-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${uid().slice(-6).toUpperCase()}`, reporterId: user.id, category: text(req.body.category, 'Category', 80), locationId: location(req.body.locationId, user).id, timeFrom, timeTo, description: text(req.body.description, 'Description', 4000), status: 'submitted', photoIds: [], publicUpdates: [], createdAt: now() };
  transaction(() => { report.photoIds = savePhotos(uploads(req), user, { reportId: report.id }).map(p => p.id); reportScope(report); put('reports', report); queueReportSearch(report); audit(user, 'report.create', 'reports', report.id); });
  res.locals.keepUploads = true;
  res.status(201).json(visibleReport(report, user));
});
app.post('/api/reports/:id/link', (req, res) => {
  const user = actor(res); role(user, 'management');
  const report = transaction(() => { const report = scoped('reports', param(req), user); const incident = scoped('incidents', text(req.body.incidentId, 'Incident', 100), user); linkReport(report, incident, user); return report; });
  res.json(report);
});
app.post('/api/reports/:id/review', (req, res) => {
  const user = actor(res); role(user, 'management');
  const status = req.body.status;
  if (!['reviewing', 'resolved', 'rejected'].includes(status)) fail(400, 'Invalid report status.');
  const reason = text(req.body.reason ?? '', 'Reason', 2000, status === 'rejected');
  const report = transaction(() => {
    const report = scoped('reports', param(req), user);
    if (report.incidentId) fail(409, 'Update the linked incident to change report progress.');
    if (['resolved', 'rejected'].includes(report.status)) fail(409, 'This report has already been reviewed.');
    report.status = status;
    report.publicUpdates = [...(report.publicUpdates || []), { status, note: reason || (status === 'reviewing' ? 'Your report is being reviewed.' : 'Your report has been resolved.'), createdAt: now() }];
    put('reports', report); audit(user, 'report.review', 'reports', report.id); return report;
  });
  res.json(report);
});
function currentManager(res: Response) {
  const initial = actor(res), session = get<any>('sessions', res.locals.session.id), current = get<User>('users', initial.id);
  if (!session || Date.parse(session.expiresAt) <= Date.now()) fail(401, 'Please sign in again.');
  if (!current || current.role !== 'management' || current.membershipStatus !== 'active' || current.townshipId !== initial.townshipId) fail(403, 'Your review access has changed.');
  return current;
}
function reportCandidate(reportId: string, candidateId: string, user: User) {
  const report = scoped('reports', reportId, user), candidate = scoped('reportCandidates', candidateId, user);
  if (candidate.reportId !== report.id) fail(404, 'Report candidate not found.');
  return { report, candidate };
}
app.get('/api/reports/:id/retrieval', (req, res) => {
  const user = actor(res); role(user, 'management'); const report = scoped('reports', param(req), user);
  const job = get<any>('reportSearchJobs', `retrieval_${report.id}`);
  res.json({ job, candidates: job ? list('reportCandidates', user.townshipId).filter(c => c.reportId === report.id && c.generation === job.generation) : [],
    dispatch: get('reportDispatches', `dispatch_${report.id}`), notice: 'AI returns candidate evidence. A manager must view and review each clip before linking and dispatching. Residents cannot access these recordings.' });
});
app.post('/api/reports/:id/retrieval', (req, res) => {
  const user = actor(res); role(user, 'management');
  const job = transaction(() => { const user = currentManager(res); const report = scoped('reports', param(req), user); const job = queueReportSearch(report, true); audit(user, 'report.retrieval_request', 'reports', report.id); return job; });
  res.status(202).json(job);
});
app.post('/api/reports/:id/candidates/:candidateId/view', async (req, res) => {
  const user = actor(res); role(user, 'management');
  const { candidate } = reportCandidate(param(req), param(req, 'candidateId'), user);
  const { video, media: source } = candidateSource(candidate);
  const sourcePath = availableMedia(source.id, user).filePath, clipId = `media_${candidate.id}`;
  const existing = get<any>('media', clipId);
  if (existing && (existing.unavailable || Date.parse(existing.expiresAt) <= Date.now() || existing.sourceStartSec !== candidate.startSec || existing.sourceEndSec !== candidate.endSec || existing.sourceMediaId !== video.mediaId)) fail(409, 'This cached review clip is stale. Run retrieval again.');
  if (!existing || !existsSync(existing.path)) {
    let inflight = clipLocks.get(clipId);
    if (!inflight) {
      inflight = (async () => {
        const output = path.join(mediaDir, `${uid('review_clip')}.mp4`);
        try {
          await createEvidenceClip(sourcePath, output, candidate.startSec, candidate.endSec);
          return put('media', { id: clipId, townshipId: user.townshipId, path: output, contentType: 'video/mp4', kind: 'video', videoId: video.id,
            reviewCandidateId: candidate.id, sourceMediaId: video.mediaId, evidenceClip: true, sourceStartSec: candidate.startSec, sourceEndSec: candidate.endSec, expiresAt: video.expiresAt, createdAt: now() });
        } catch (error) { if (existsSync(output)) unlinkSync(output); throw error; }
      })();
      clipLocks.set(clipId, inflight);
    }
    try { await inflight; } finally { clipLocks.delete(clipId); }
  }
  const fresh = currentManager(res); candidateSource(scoped('reportCandidates', candidate.id, fresh)); availableMedia(clipId, fresh);
  const receipt = opaqueTicket();
  transaction(() => {
    put('candidateViews', { id: tokenHash(receipt), townshipId: user.townshipId, candidateId: candidate.id, userId: user.id, sessionId: res.locals.session.id,
      descriptionHash: candidate.descriptionHash, sourceKey: candidate.sourceKey, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), createdAt: now() });
    audit(fresh, 'report.candidate_view', 'reportCandidates', candidate.id);
  });
  res.json({ receipt, video: { id: video.id, mediaId: clipId, locationId: video.locationId, cameraId: video.cameraId,
    recordedAt: candidate.absoluteStartAt, durationSec: candidate.endSec - candidate.startSec, evidenceClip: true, sourceStartSec: candidate.startSec } });
});
app.post('/api/reports/:id/candidates/:candidateId/review', (req, res) => {
  const user = actor(res); role(user, 'management');
  const decision = req.body.decision, note = text(req.body.note, 'Review note', 2000);
  if (!['approve', 'dismiss'].includes(decision) || req.body.reviewed !== true) fail(400, 'View the clip and explicitly confirm your human review.');
  const receiptId = tokenHash(text(req.body.receipt, 'Clip review receipt', 200));
  const result = transaction(() => {
    const user = currentManager(res);
    const { report, candidate } = reportCandidate(param(req), param(req, 'candidateId'), user);
    if (['resolved', 'rejected'].includes(report.status)) fail(409, 'This report is already resolved or rejected.');
    candidateSource(candidate);
    const view = get<any>('candidateViews', receiptId);
    if (!view || view.candidateId !== candidate.id || view.townshipId !== user.townshipId || view.userId !== user.id || view.sessionId !== res.locals.session.id || Date.parse(view.expiresAt) <= Date.now() || view.descriptionHash !== candidate.descriptionHash || view.sourceKey !== candidate.sourceKey) fail(403, 'Open this clip in your current session before reviewing it.');
    const status = decision === 'approve' ? 'approved' : 'dismissed';
    if (candidate.reviewStatus !== 'pending_review') { if (candidate.reviewStatus === status && candidate.reviewedBy === user.id && candidate.reviewNote === note) return candidate; fail(409, 'This candidate has already been reviewed.'); }
    if (view.usedAt) fail(409, 'This clip review receipt has already been used.');
    const reviewed = put('reportCandidates', { ...candidate, reviewStatus: status, reviewNote: note, reviewedBy: user.id, reviewedAt: now() });
    put('candidateViews', { ...view, usedAt: now() });
    audit(user, `report.candidate_${decision}`, 'reportCandidates', candidate.id); return reviewed;
  });
  res.json(result);
});
app.post('/api/reports/:id/dispatch', (req, res) => {
  const user = actor(res); role(user, 'management');
  if (!Array.isArray(req.body.candidateIds) || req.body.candidateIds.length < 1 || req.body.candidateIds.length > 3 || req.body.candidateIds.some((id: unknown) => typeof id !== 'string')) fail(400, 'Select one to three human-approved clips.');
  const candidateIds = [...new Set(req.body.candidateIds as string[])].sort();
  const instructions = text(req.body.instructions, 'Work instructions', 2000), assigneeId = text(req.body.assigneeId, 'Assignee', 100);
  const fingerprint = contentHash(JSON.stringify({ candidateIds, assigneeId, instructions, incidentId: req.body.incidentId || null, title: req.body.title || null, category: req.body.category || null, priority: req.body.priority || null }));
  const result = transaction(() => {
    const user = currentManager(res);
    const report = scoped('reports', param(req), user), existing = get<any>('reportDispatches', `dispatch_${report.id}`);
    if (existing) { if (existing.fingerprint !== fingerprint) fail(409, 'This report has already been dispatched. Use its incident workspace for changes.'); return { incident: incidentView(scoped('incidents', existing.incidentId, user), user), assignment: scoped('assignments', existing.assignmentId, user), alreadyDispatched: true }; }
    if (['resolved', 'rejected'].includes(report.status)) fail(409, 'Reopen the incident before adding reviewed evidence or dispatching.');
    const candidates = candidateIds.map(id => {
      const { candidate } = reportCandidate(report.id, id, user); candidateSource(candidate);
      if (candidate.reviewStatus !== 'approved') fail(409, 'Every selected clip needs human approval before dispatch.');
      availableMedia(`media_${candidate.id}`, user); return candidate;
    });
    if (report.incidentId && req.body.incidentId && report.incidentId !== req.body.incidentId) fail(409, 'The report is already linked to a different incident.');
    const linkedId = report.incidentId || req.body.incidentId;
    const incident = linkedId ? scoped('incidents', text(linkedId, 'Incident', 100), user) : newIncident({ title: req.body.title, category: req.body.category || report.category, priority: req.body.priority, locationId: report.locationId }, user);
    if (incident.locationId !== report.locationId) fail(400, 'Choose an incident at the report location.');
    if (!['open', 'assigned', 'in_progress'].includes(incident.status)) fail(409, 'Choose an open or active incident.');
    linkReport(report, incident, user);
    for (const candidate of candidates) {
      const media = get<any>('media', `media_${candidate.id}`);
      put('media', { ...media, incidentId: incident.id });
      put('incidentEvidence', { id: `evidence_${candidate.id}`, townshipId: user.townshipId, incidentId: incident.id, reportId: report.id, candidateId: candidate.id,
        mediaId: media.id, videoId: candidate.videoId, kind: 'video', reviewedClip: true, startSec: candidate.startSec, endSec: candidate.endSec,
        description: candidate.reviewNote, aiSummary: candidate.summary, reviewedBy: candidate.reviewedBy, reviewedAt: candidate.reviewedAt, authorId: user.id, createdAt: now() });
      put('reportCandidates', { ...candidate, incidentId: incident.id, attachedAt: now() });
    }
    const assignment = assignIncident(incident.id, assigneeId, user, instructions);
    put('incidentUpdates', { id: uid('update'), townshipId: user.townshipId, incidentId: incident.id, authorId: user.id, action: 'reviewed_evidence',
      note: `${candidates.length} human-reviewed clip(s) attached. Work instructions: ${instructions}`, visibility: 'internal', createdAt: now() });
    put('reportDispatches', { id: `dispatch_${report.id}`, townshipId: user.townshipId, reportId: report.id, incidentId: incident.id, assignmentId: assignment.id, candidateIds, fingerprint, dispatchedBy: user.id, createdAt: now() });
    audit(user, 'report.reviewed_dispatch', 'reports', report.id);
    return { incident: incidentView(get('incidents', incident.id), user), assignment, alreadyDispatched: false };
  });
  res.status(result.alreadyDispatched ? 200 : 201).json(result);
});
app.get('/api/incidents', (_req, res) => { const user = actor(res); res.json(list('incidents', user.townshipId).filter(i => canSeeIncident(i, user)).map(i => incidentView(i, user))); });
app.get('/api/incidents/:id', (req, res) => { const user = actor(res); const incident = scoped('incidents', param(req), user); if (!canSeeIncident(incident, user)) fail(404, 'Incident not found.'); res.json(incidentView(incident, user)); });
app.post('/api/incidents', (req, res) => {
  const user = actor(res); role(user, 'management');
  const incident = transaction(() => {
    const report = req.body.reportId ? scoped('reports', text(req.body.reportId, 'Report', 100), user) : undefined;
    const alert = req.body.alertId ? scoped('alerts', text(req.body.alertId, 'Alert', 100), user) : undefined;
    if (report?.incidentId || alert?.incidentId) fail(409, 'The source is already linked to an incident.');
    if (alert && alert.reviewStatus !== 'pending_review') fail(409, 'Only an alert awaiting review can create an incident.');
    const incident = newIncident(req.body, user);
    if (report) linkReport(report, incident, user);
    if (alert) { incident.alertIds = [alert.id]; put('alerts', { ...alert, reviewStatus: 'confirmed', incidentId: incident.id, reviewedBy: user.id, reviewedAt: now() }); put('incidents', incident); }
    return incident;
  });
  res.status(201).json(incidentView(incident, user));
});
function assignIncident(incidentId: string, assigneeId: unknown, user: User, instructions = '') {
    const incident = scoped('incidents', incidentId, user);
    if (!['open', 'assigned', 'in_progress'].includes(incident.status)) fail(409, 'Only an open or active incident can be assigned.');
    const assignee = scoped('users', text(assigneeId, 'Assignee', 100), user);
    if (!isFieldStaff(assignee) || assignee.membershipStatus !== 'active') fail(400, 'Choose active property or security staff in this township.');
    const existing = list('assignments', user.townshipId).find(a => a.incidentId === incident.id && a.assigneeId === assignee.id && !a.revokedAt && ['assigned', 'accepted', 'arrived'].includes(a.status));
    if (existing) return existing;
    for (const old of list('assignments', user.townshipId).filter(a => a.incidentId === incident.id && a.status !== 'cancelled' && !a.revokedAt)) put('assignments', { ...old, status: ['assigned', 'accepted', 'arrived'].includes(old.status) ? 'cancelled' : old.status, revokedAt: now() });
    const assignment = put('assignments', { id: uid('assignment'), townshipId: user.townshipId, incidentId: incident.id, assigneeId: assignee.id, team: assignee.role === 'maintenance' ? 'property' : 'security', instructions, createdBy: user.id, status: 'assigned', createdAt: now() });
    incident.status = 'assigned'; incident.updatedAt = now(); put('incidents', incident);
    put('incidentUpdates', { id: uid('update'), townshipId: user.townshipId, incidentId: incident.id, authorId: user.id, action: 'assign', note: 'A staff member has been assigned.', visibility: 'public', createdAt: now() });
    publishProgress(incident, 'A staff member has been assigned.'); audit(user, 'incident.assign', 'incidents', incident.id); return assignment;

}
app.post('/api/incidents/:id/assignments', (req, res) => { const user = actor(res); role(user, 'management'); const result = transaction(() => assignIncident(param(req), req.body.assigneeId, user, text(req.body.instructions || '', 'Instructions', 2000, false))); res.status(201).json(result); });
app.post('/api/incidents/:id/updates', (req, res) => {
  const user = actor(res); role(user, 'management', 'guard', 'maintenance');
  const action = req.body.action;
  if (!['accept', 'arrive', 'resolve', 'close', 'reopen', 'note'].includes(action)) fail(400, 'Invalid incident action.');
  if (['close', 'reopen'].includes(action)) role(user, 'management');
  const note = text(req.body.note ?? '', 'Note', 4000, ['resolve', 'close', 'reopen', 'note'].includes(action));
  const visibility = req.body.visibility || 'internal';
  if (!['public', 'internal'].includes(visibility)) fail(400, 'Invalid update visibility.');
  const incident = transaction(() => {
    const incident = scoped('incidents', param(req), user);
    const assignment = assigned(incident.id, user, true);
    if (isFieldStaff(user) && !assignment) fail(404, 'Active assigned incident not found.');
    if (['close', 'reopen'].includes(action)) role(user, 'management');
    if (action === 'accept') {
      if (incident.status !== 'assigned') fail(409, 'Only an assigned incident can be accepted.');
      const current = assignment || list('assignments', user.townshipId).find(a => a.incidentId === incident.id && a.status === 'assigned');
      if (!current || current.status !== 'assigned') fail(409, 'This task has already been accepted.');
      put('assignments', { ...current, status: 'accepted', acceptedAt: now() }); incident.status = 'in_progress';
    } else if (action === 'arrive') {
      if (incident.status !== 'in_progress') fail(409, 'Accept the assignment before recording arrival.');
      const current = assignment || list('assignments', user.townshipId).find(a => a.incidentId === incident.id && a.status === 'accepted');
      if (!current || current.status !== 'accepted') fail(409, 'Arrival requires an accepted assignment.');
      put('assignments', { ...current, status: 'arrived', arrivedAt: now() });
    } else if (action === 'resolve') {
      if (incident.status !== 'in_progress') fail(409, 'Only an incident in progress can be resolved.');
      if (isFieldStaff(user) && assignment?.status !== 'arrived') fail(409, 'Record your arrival before resolving the incident.');
      incident.status = 'resolved';
      for (const current of list('assignments', user.townshipId).filter(a => a.incidentId === incident.id && ['assigned', 'accepted', 'arrived'].includes(a.status))) put('assignments', { ...current, status: 'resolved', result: note, resolvedAt: now() });
    } else if (action === 'close') {
      if (incident.status !== 'resolved') fail(409, 'Review and resolve the incident before closing it.');
      incident.status = 'closed';
    } else if (action === 'reopen') {
      if (!['resolved', 'closed'].includes(incident.status)) fail(409, 'Only a resolved or closed incident can be reopened.');
      incident.status = 'open';
      for (const old of list('assignments', user.townshipId).filter(a => a.incidentId === incident.id && !a.revokedAt && a.status !== 'cancelled')) put('assignments', { ...old, revokedAt: now() });
    }
    incident.updatedAt = now(); put('incidents', incident);
    put('incidentUpdates', { id: uid('update'), townshipId: user.townshipId, incidentId: incident.id, authorId: user.id, action, note, visibility, createdAt: now() });
    if (visibility === 'public' || action !== 'note') {
      const progress: Record<string, string> = { accept: 'A staff member is working on your report.', arrive: 'A staff member has arrived to investigate.', resolve: 'The work has been completed and is awaiting management review.', close: 'Management has reviewed and closed this incident.', reopen: 'The incident has been reopened for follow-up.' };
      publishProgress(incident, visibility === 'public' && note ? note : progress[action]);
    }
    audit(user, `incident.${action}`, 'incidents', incident.id); return incident;
  });
  res.json(incidentView(incident, user));
});
app.post('/api/incidents/:id/evidence', photoUpload.array('photos', 3), (req, res) => {
  const user = actor(res); role(user, 'management', 'guard', 'maintenance');
  const incident = scoped('incidents', param(req), user);
  if (isFieldStaff(user) && !assigned(incident.id, user, true)) fail(404, 'Active assigned incident not found.');
  if (!uploads(req).length) fail(400, 'Choose at least one photo.');
  const description = text(req.body.description ?? 'Staff evidence photo', 'Description', 2000);
  const evidence = transaction(() => {
    const photos = savePhotos(uploads(req), user, { incidentId: incident.id, expiresAt: new Date(Date.now() + Math.max(1, Number(process.env.MEDIA_RETENTION_DAYS || 7))*86400_000).toISOString() });
    const evidence = photos.map(p => put('incidentEvidence', { id: uid('evidence'), townshipId: user.townshipId, incidentId: incident.id, mediaId: p.id, kind: 'photo', description, authorId: user.id, createdAt: now() }));
    for (const item of evidence) queuePrivacyPhoto(item, user);
    audit(user, 'incident.evidence', 'incidents', incident.id); return evidence;
  });
  res.locals.keepUploads = true; res.status(201).json(evidence);
});
function privacyIncident(id: string, user: User) {
  role(user, 'management', 'guard', 'maintenance');
  const incident = scoped('incidents', id, user);
  if (!canSeeIncident(incident, user)) fail(404, 'Assigned incident not found.');
  return incident;
}
function privacyDraft(req: Request, user: User) {
  const incident = privacyIncident(param(req), user), draft = scoped('privacyDrafts', param(req, 'draftId'), user);
  if (draft.incidentId !== incident.id) fail(404, 'Screenshot draft not found.');
  return draft;
}
app.get('/api/incidents/:id/privacy', (req, res) => {
  const user=actor(res), incident=privacyIncident(param(req),user);
  res.json({ drafts:list('privacyDrafts',user.townshipId).filter(d=>d.incidentId===incident.id), shares:list('screenshotShares',user.townshipId).filter(s=>s.incidentId===incident.id) });
});
app.post('/api/incidents/:id/evidence/:evidenceId/privacy', (req, res) => {
  const user=actor(res), incident=privacyIncident(param(req),user), evidence=scoped('incidentEvidence',param(req,'evidenceId'),user);
  if (evidence.incidentId!==incident.id) fail(404,'Evidence not found.');
  const draft=transaction(()=>{ const draft=queuePrivacyPhoto(evidence,user,req.body.retry===true); audit(user,'privacy.prepare','privacyDrafts',draft.id); return draft; });
  res.status(202).json(draft);
});
app.post('/api/incidents/:id/privacy/:draftId/masks', (req,res)=>{
  const user=actor(res), masks=privacyMasks(req.body.manualMasks);
  const result=transaction(()=>{ const draft=privacyDraft(req,user); if (draft.status!=='ready' || req.body.revision!==draft.revision) fail(409,'The screenshot changed. Open the latest preview before editing masks.'); const result=queuePrivacyPhoto(scoped('incidentEvidence',draft.evidenceId,user),user,true,masks); audit(user,'privacy.masks','privacyDrafts',draft.id); return result; });
  res.status(202).json(result);
});
app.post('/api/incidents/:id/privacy/:draftId/view', (req,res)=>{
  const user=actor(res), draft=privacyDraft(req,user), media=draft.previewMediaId && get('media',draft.previewMediaId);
  if (draft.status!=='ready' || !media || !currentPrivacyCopy(media)) fail(409,'A current masked preview is not ready. Prepare or retry the privacy copy.');
  availableMedia(media.id,user);
  const receipt=opaqueTicket();
  put('privacyViews',{id:tokenHash(receipt),townshipId:user.townshipId,draftId:draft.id,revision:draft.revision,mediaId:media.id,userId:user.id,sessionId:res.locals.session.id,expiresAt:new Date(Date.now()+15*60_000).toISOString()});
  res.json({receipt,revision:draft.revision,mediaId:media.id});
});
app.post('/api/incidents/:id/privacy/:draftId/share', (req,res)=>{
  const user=actor(res), caption=text(req.body.caption,'Resident caption',1000), receipt=text(req.body.receipt,'Preview receipt',200);
  const result=transaction(()=>{
    const draft=privacyDraft(req,user);
    if (req.body.reviewed!==true || req.body.revision!==draft.revision) fail(409,'Review the latest masked screenshot and confirm its privacy before sending.');
    const media=draft.previewMediaId && get('media',draft.previewMediaId), view=get('privacyViews',tokenHash(receipt));
    if (!media || !currentPrivacyCopy(media)) fail(409,'The screenshot changed or expired. Prepare a fresh copy.');
    availableMedia(media.id,user);
    if (!view || view.userId!==user.id || view.sessionId!==res.locals.session.id || view.draftId!==draft.id || view.revision!==draft.revision || view.mediaId!==media.id || Date.parse(view.expiresAt)<=Date.now()) fail(403,'Open the current privacy preview in this session before sending.');
    const incident=scoped('incidents',draft.incidentId,user);
    if (!list('reports',user.townshipId).some(r=>r.incidentId===incident.id)) fail(409,'Link a resident report before sending a screenshot.');
    const id=`share_${draft.id}_${draft.revision}`, existing=get('screenshotShares',id);
    if (existing?.status==='published') { if (existing.caption!==caption) fail(409,'Withdraw the existing screenshot before changing its caption.'); return existing; }
    if (view.usedAt) fail(403,'This preview was already used. Reopen the masked screenshot before sending again.');
    const shared=put('screenshotShares',{id,townshipId:user.townshipId,incidentId:incident.id,draftId:draft.id,revision:draft.revision,mediaId:media.id,status:'published',caption,sharedBy:user.id,sharedAt:now()});
    put('privacyViews',{...view,usedAt:now()});
    put('incidentUpdates',{id:uid('update'),townshipId:user.townshipId,incidentId:incident.id,authorId:user.id,action:'screenshot_shared',note:caption,visibility:'public',createdAt:now()});
    audit(user,'privacy.share','screenshotShares',id); return shared;
  });
  res.status(201).json(result);
});
app.post('/api/incidents/:id/privacy/:draftId/withdraw', (req,res)=>{
  const user=actor(res), draft=privacyDraft(req,user);
  transaction(()=>{ for(const share of list('screenshotShares',user.townshipId).filter(s=>s.draftId===draft.id && s.status==='published')) put('screenshotShares',{...share,status:'withdrawn',withdrawnAt:now(),withdrawnBy:user.id}); audit(user,'privacy.withdraw','privacyDrafts',draft.id); });
  res.json({ok:true});
});
function activityView(activity: any) {
  const count = list('registrations', activity.townshipId).filter(r => r.activityId === activity.id && ['registered', 'attended'].includes(r.status)).length;
  return { ...activity, registeredCount: count, registrationCount: count, remainingCapacity: Math.max(0, activity.capacity - count) };
}
app.get('/api/activities', (_req, res) => res.json(list('activities', actor(res).townshipId).map(activityView)));
app.post('/api/activities', (req, res) => {
  const user = actor(res); role(user, 'management');
  const startAt = date(req.body.startAt, 'Start time');
  const endAt = date(req.body.endAt, 'End time');
  if (Date.parse(startAt) >= Date.parse(endAt)) fail(400, 'End time must be after start time.');
  const type = text(req.body.type, 'Activity type', 80);
  if (!['training', 'safety_training', 'inspection', 'briefing'].includes(type)) fail(400, 'Choose training, inspection or briefing.');
  const activity = transaction(() => {
    const activity = put('activities', { id: uid('activity'), townshipId: user.townshipId, title: text(req.body.title, 'Title', 180), type, locationId: location(req.body.locationId, user).id, startAt, endAt, capacity: integer(req.body.capacity, 'Capacity', 1, 1000), points: integer(req.body.points, 'Points', 0, 1000), description: text(req.body.description ?? '', 'Description', 4000, false), status: 'published', createdBy: user.id, createdAt: now() });
    audit(user, 'activity.publish', 'activities', activity.id); return activity;
  });
  res.status(201).json(activityView(activity));
});
app.post('/api/activities/:id/cancel', (req, res) => {
  const user = actor(res); role(user, 'management');
  const reason = text(req.body.reason, 'Cancellation reason', 2000);
  const activity = transaction(() => {
    const activity = scoped('activities', param(req), user);
    if (activity.status === 'cancelled') return activity;
    put('activities', { ...activity, status: 'cancelled', cancellationReason: reason, cancelledBy: user.id, cancelledAt: now() });
    for (const registration of list('registrations', user.townshipId).filter(r => r.activityId === activity.id && r.status === 'registered')) put('registrations', { ...registration, status: 'cancelled', cancelledAt: now() });
    for (const award of list('pointTransactions', user.townshipId).filter(p => p.activityId === activity.id && p.reason === 'verified_attendance')) {
      const key = `cancel:${award.id}`;
      if (!list('pointTransactions', user.townshipId).some(p => p.idempotencyKey === key)) put('pointTransactions', { id: uid('points'), townshipId: user.townshipId, userId: award.userId, activityId: activity.id, delta: -award.delta, reason: 'activity_cancelled', note: reason, reversesId: award.id, verifiedBy: user.id, idempotencyKey: key, createdAt: now() });
    }
    audit(user, 'activity.cancel', 'activities', activity.id); return get('activities', activity.id);
  });
  res.json(activityView(activity));
});
app.post('/api/activities/:id/register', (req, res) => {
  const user = actor(res);
  const registration = transaction(() => {
    const activity = scoped('activities', param(req), user);
    if (activity.status !== 'published' || Date.parse(activity.endAt) <= Date.now()) fail(409, 'Registration is closed for this activity.');
    const registrations = list('registrations', user.townshipId).filter(r => r.activityId === activity.id);
    const existing = registrations.find(r => r.userId === user.id);
    if (existing && ['registered', 'attended'].includes(existing.status)) return existing;
    if (registrations.filter(r => ['registered', 'attended'].includes(r.status)).length >= activity.capacity) fail(409, 'This activity is full.');
    const registration = put('registrations', { id: existing?.id || `registration:${activity.id}:${user.id}`, townshipId: user.townshipId, activityId: activity.id, userId: user.id, status: 'registered', createdAt: now() });
    audit(user, 'activity.register', 'activities', activity.id); return registration;
  });
  res.status(201).json(registration);
});
app.delete('/api/activities/:id/registration', (req, res) => {
  const user = actor(res);
  const registration = transaction(() => {
    const activity = scoped('activities', param(req), user);
    const registration = list('registrations', user.townshipId).find(r => r.activityId === activity.id && r.userId === user.id);
    if (!registration) fail(404, 'Registration not found.');
    if (registration.status === 'attended') fail(409, 'Verified attendance cannot be cancelled.');
    put('registrations', { ...registration, status: 'cancelled', cancelledAt: now() }); audit(user, 'activity.unregister', 'activities', activity.id); return get('registrations', registration.id);
  });
  res.json(registration);
});
app.post('/api/activities/:id/attendance', (req, res) => {
  const user = actor(res); role(user, 'management');
  const result = transaction(() => {
    const activity = scoped('activities', param(req), user);
    if (!['published', 'completed'].includes(activity.status)) fail(409, 'Attendance cannot be awarded for a cancelled activity.');
    if (Date.parse(activity.startAt) > Date.now()) fail(409, 'Wait until the activity starts before verifying attendance.');
    const member = scoped('users', text(req.body.userId, 'Member', 100), user);
    if (member.membershipStatus !== 'active') fail(400, 'This member is not active.');
    const registration = list('registrations', user.townshipId).find(r => r.activityId === activity.id && r.userId === member.id);
    if (!registration || !['registered', 'attended'].includes(registration.status)) fail(409, 'The member must have an active registration.');
    const key = `attendance:${activity.id}:${member.id}`;
    const existing = list('pointTransactions', user.townshipId).find(p => p.idempotencyKey === key);
    if (existing) return { registration, transaction: existing, alreadyAwarded: true };
    const verifiedAt = now();
    const attended = put('registrations', { ...registration, status: 'attended', verifiedBy: user.id, verifiedAt });
    const award = put('pointTransactions', { id: uid('points'), townshipId: user.townshipId, userId: member.id, activityId: activity.id, delta: activity.points, reason: 'verified_attendance', verifiedBy: user.id, idempotencyKey: key, createdAt: verifiedAt });
    if (Date.parse(activity.endAt) <= Date.now()) put('activities', { ...activity, status: 'completed' });
    audit(user, 'activity.attendance', 'activities', activity.id); return { registration: attended, transaction: award, alreadyAwarded: false };
  });
  res.json(result);
});
app.get('/api/me/points', (_req, res) => { const user = actor(res); res.json(list('pointTransactions', user.townshipId).filter(p => p.userId === user.id)); });
app.get('/api/cameras', (_req, res) => { const user = actor(res); role(user, 'management'); res.json(list('cameras', user.townshipId)); });
app.post('/api/cameras', (req, res) => {
  const user = actor(res); role(user, 'management');
  const camera = transaction(() => { const camera = put('cameras', { id: uid('camera'), townshipId: user.townshipId, name: text(req.body.name, 'Camera name', 180), locationId: location(req.body.locationId, user).id, sourceType: 'upload', createdAt: now() }); audit(user, 'camera.create', 'cameras', camera.id); return camera; });
  res.status(201).json(camera);
});
app.post('/api/videos', (req, res, next) => { role(actor(res), 'management'); next(); }, videoUpload.single('file'), async (req, res) => {
  const user = actor(res);
  if (!req.file) fail(400, 'Choose an MP4 video.');
  const file = req.file!;
  const camera = scoped('cameras', text(req.body.cameraId, 'Camera', 100), user);
  const recordedAt = date(req.body.recordedAt, 'Recording start');
  let metadata: { durationSec: number; width: number; height: number };
  try { metadata = await probeMp4(file.path); } catch (error) { if (error instanceof ApiError) throw error; fail(400, 'This file could not be read as a valid MP4 video.'); }
  const retentionDays = Math.max(1, Number(process.env.MEDIA_RETENTION_DAYS || 7));
  const expiresAt = new Date(Date.now() + retentionDays * 86400_000).toISOString();
  const video = transaction(() => {
    const videoId = uid('video');
    const media = put('media', { id: uid('media'), townshipId: user.townshipId, path: file.path, contentType: 'video/mp4', kind: 'video', ownerId: user.id, videoId, expiresAt, createdAt: now() });
    const video = put('videos', { id: videoId, title: text(req.body.title || 'Local uploaded video', 'Title', 180), townshipId: user.townshipId, cameraId: camera.id, locationId: camera.locationId, mediaId: media.id, recordedAt, durationSec: metadata.durationSec, width: metadata.width, height: metadata.height, sizeBytes: file.size, status: 'uploaded', expiresAt, createdAt: now(), source: 'upload' });
    put('cameras', { ...camera, lastInputAt: now() }); wakeReportSearches(video); audit(user, 'video.upload', 'videos', video.id); return video;
  });
  res.locals.keepUploads = true; res.status(201).json(video);
});
app.post('/api/videos/:id/analyze', (req, res) => {
  const user = actor(res); role(user, 'management');
  const job = transaction(() => {
    const video = scoped('videos', param(req), user);
    availableMedia(video.mediaId, user);
    if (video.status === 'expired' || Date.parse(video.expiresAt) <= Date.now()) fail(410, 'This video has expired.');
    return queueVideo(video, user, req.body.retry === true, req.body.reanalyze === true);
  });
  res.status(202).json(job);
});
app.get('/api/videos/:id', (req, res) => { const user = actor(res); const video = scoped('videos', param(req), user); if (!videoForTask(video.id, user)) fail(404, 'Video not found.'); res.json(video); });
app.get('/api/videos', (_req, res) => { const user = actor(res); role(user, 'management'); res.json(list('videos', user.townshipId)); });
app.get('/api/jobs/:id', (req, res) => { const user = actor(res); role(user, 'management'); res.json(scoped('analysisJobs', param(req), user)); });
app.get('/api/alerts', (_req, res) => { const user = actor(res); role(user, 'management'); res.json(list('alerts', user.townshipId)); });
app.post('/api/alerts/:id/review', (req, res) => {
  const user = actor(res); role(user, 'management');
  const decision = req.body.decision;
  if (!['confirm', 'dismiss', 'link'].includes(decision)) fail(400, 'Choose confirm, dismiss or link.');
  const reason = text(req.body.reason ?? '', 'Reason', 2000, decision === 'dismiss');
  const alert = transaction(() => {
    const alert = scoped('alerts', param(req), user);
    if (alert.reviewStatus !== 'pending_review') fail(409, 'This alert has already been reviewed.');
    let incident: any;
    if (decision !== 'dismiss') {
      if (decision === 'link' && !req.body.incidentId) fail(400, 'Choose an existing incident.');
      incident = req.body.incidentId ? scoped('incidents', text(req.body.incidentId, 'Incident', 100), user) : newIncident({ title: `Review ${alert.eventType === 'possible_fall' ? 'possible fall' : 'prolonged lying'} candidate`, category: 'safety', locationId: alert.locationId, priority: 'high' }, user);
      if (incident.status === 'closed') fail(409, 'Reopen the incident before linking an alert.');
      incident.alertIds = [...new Set([...(incident.alertIds || []), alert.id])]; put('incidents', incident);
    }
    const reviewed = put('alerts', { ...alert, reviewStatus: decision === 'dismiss' ? 'dismissed' : decision === 'link' ? 'linked' : 'confirmed', reason, incidentId: incident?.id, reviewedBy: user.id, reviewedAt: now() });
    audit(user, `alert.${decision}`, 'alerts', alert.id); return reviewed;
  });
  res.json(alert);
});
app.get('/api/audit', (_req, res) => { const user = actor(res); role(user, 'management'); res.json(list('auditLogs', user.townshipId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 500)); });
app.get('/api/media/:id/access', async (req, res) => {
  const user = actor(res);
  let media = scoped('media', param(req), user);
  if (isFieldStaff(user) && media.kind === 'video' && !media.evidenceClip) media = await guardEvidenceMedia(media, user, typeof req.query.alertId === 'string' ? req.query.alertId : undefined);
  media = availableMedia(media.id, user).media;
  const ticket = opaqueTicket();
  const expiresAt = new Date(Date.now() + 2 * 60_000).toISOString();
  put('mediaTickets', { id: tokenHash(ticket), townshipId: user.townshipId, mediaId: media.id, sessionId: res.locals.session.id, userId: user.id, role: user.role, expiresAt });
  audit(user, 'media.access', 'media', media.id);
  res.json({ url: `/api/media/${encodeURIComponent(media.id)}/content?ticket=${ticket}`, expiresAt, isClip: Boolean(media.evidenceClip), sourceStartSec: media.sourceStartSec });
});
app.get('/api/media/:id/content', (req, res) => {
  const user = actor(res);
  const ticketString = text(req.query.ticket, 'Media ticket', 200);
  const ticket = get('mediaTickets', tokenHash(ticketString));
  if (!ticket || ticket.mediaId !== param(req) || ticket.sessionId !== res.locals.session.id || ticket.userId !== user.id || ticket.role !== user.role || Date.parse(ticket.expiresAt) <= Date.now()) fail(403, 'Media access has expired. Request a new access link.');
  const { media, filePath } = availableMedia(param(req), user);
  const size = statSync(filePath).size;
  res.set({ 'Content-Type': media.contentType, 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes', 'Content-Disposition': 'inline' });
  const range = req.headers.range;
  let start = 0, end = size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) { res.set('Content-Range', `bytes */${size}`); res.status(416).end(); return; }
    if (!match[1]) { const suffix = Number(match[2]); if (suffix <= 0) { res.set('Content-Range', `bytes */${size}`); res.status(416).end(); return; } start = Math.max(0, size - suffix); }
    else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), size - 1); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start < 0 || start > end) { res.set('Content-Range', `bytes */${size}`); res.status(416).end(); return; }
    res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.set('Content-Length', String(end - start + 1));
  const stream = createReadStream(filePath, { start, end });
  stream.on('error', () => { if (!res.headersSent) res.status(410).json({ error: 'Media is no longer available.' }); else res.destroy(); });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
});
const relativeDate = parseSearchTime;
function searchTerms(query: string) {
  let value = query.toLowerCase().replace(/last night|yesterday evening|yesterday|today|this morning|last week|昨晚|昨天|今天|今早|上周|上星期/g, ' ');
  const synonyms: Array<[RegExp, string]> = [[/自行车|脚踏车|bike|cycling/g, 'bicycle'], [/行走|走路|walking|walked/g, 'walk'], [/跌倒|摔倒|fell|fallen/g, 'fall'], [/倒地|躺着|lying/g, 'lying'], [/车辆|汽车/g, 'vehicle'], [/人员|有人|行人/g, 'person']];
  for (const [pattern, replacement] of synonyms) value = value.replace(pattern, ` ${replacement} `);
  const stop = new Set(['a', 'an', 'the', 'at', 'in', 'on', 'of', 'to', 'for', 'and', 'or', 'my', 'me', 'is', 'was', 'with', 'show', 'find', 'look', 'video', 'videos', 'footage', 'someone', 'somebody', 'please', 'moving', 'movement']);
  return [...new Set(value.match(/[\p{L}\p{N}]+/gu) || [])].filter(term => !stop.has(term) && term.length > 1);
}
function videoWithin(video: any, locationId?: string, from?: string, to?: string) {
  const start = Date.parse(video.recordedAt);
  const end = start + Number(video.durationSec || 0) * 1000;
  return (!locationId || video.locationId === locationId) && (!from || end >= Date.parse(from)) && (!to || start <= Date.parse(to));
}
app.get('/api/ai/status', async (_req, res) => { const user = actor(res); role(user, 'management'); const result = await aiStatus(user.townshipId); const current = get<User>('users', user.id); if (!get('sessions', res.locals.session.id) || Date.parse(get('sessions', res.locals.session.id).expiresAt) <= Date.now() || !current || current.role !== 'management' || current.membershipStatus !== 'active' || current.townshipId !== user.townshipId) fail(403, 'Your access has changed.'); res.json(result); });
app.post('/api/ai/index', (req, res) => {
  const user = actor(res); role(user, 'management');
  const jobs = transaction(() => {
    const videos = req.body.videoId ? [scoped('videos', text(req.body.videoId, 'Video', 100), user)] : footageInScope(user.townshipId).videos;
    return videos.filter(v => v.status === 'completed' && v.analysisMode === 'ollama' && Date.parse(v.expiresAt) > Date.now()).map(v => queueIndex(v, true));
  });
  audit(user, 'video.index', 'indexJobs', 'local-index'); res.status(202).json({ jobs });
});
app.post('/api/video-search', async (req, res) => {
  const user = actor(res); role(user, 'management');
  const query = text(req.body.query ?? '', 'Query', 2000, false);
  let parsed: ReturnType<typeof relativeDate>;
  try { parsed = relativeDate(query); } catch (e) { fail(400, e instanceof Error ? e.message : 'Choose a valid date range.'); }
  let locationId: string | undefined;
  if (req.body.locationId) locationId = location(req.body.locationId, user).id;
  else {
    const matched = list('locations', user.townshipId).filter(l => [l.name, ...(l.aliases || [])].some((name: string) => query.toLowerCase().includes(name.toLowerCase())));
    if (matched.length > 1) fail(400, 'The query names multiple locations. Choose one in the optional filters.');
    if (!matched.length && /(?:[a-z]\s*区|zone\s+[a-z]\b)/i.test(query)) fail(400, 'This named zone is not registered in your township. Choose a location in the optional filters.');
    locationId = matched[0]?.id;
  }
  let timeFrom = req.body.timeFrom ? date(req.body.timeFrom, 'Start time') : parsed?.timeFrom;
  let timeTo = req.body.timeTo ? date(req.body.timeTo, 'End time') : parsed?.timeTo;
  if (timeFrom && timeTo && Date.parse(timeFrom) >= Date.parse(timeTo)) fail(400, 'End time must be after start time.');
  if (timeFrom && timeTo && Date.parse(timeTo) - Date.parse(timeFrom) > 31 * 86400_000) fail(400, 'Narrow the search to a time range of at most 31 days.');
  const videos = list('videos', user.townshipId).filter(v => v.status !== 'expired' && (!v.expiresAt || Date.parse(v.expiresAt) > Date.now()) && videoWithin(v, locationId, timeFrom, timeTo));
  const coverage = { unanalysedVideos: videos.filter(v => v.status !== 'completed').length, totalVideos: videos.length };
  const searchScope = { locationId, locationName: locationId ? get('locations', locationId)?.name : 'All authorised locations', timeFrom, timeTo, timeZone: 'Asia/Kuala_Lumpur' };
  if (parsed && req.body.confirmRelativeDate !== true) { res.json({ results: [], needsConfirmation: true, scope: searchScope, parsed: { ...parsed, timeFrom, timeTo }, coverage, notice: 'Confirm the interpreted dates in Asia/Kuala_Lumpur before searching.' }); return; }
  if (req.body.mode !== undefined && !['semantic', 'keyword'].includes(req.body.mode)) fail(400, 'Choose semantic or keyword search.');
  if ((req.body.mode || (analysisMode() === 'ollama' ? 'semantic' : 'keyword')) === 'semantic') {
    const abort = new AbortController();
    const onClose = () => { if (!res.writableEnded) abort.abort(new Error('Search cancelled.')); };
    res.once('close', onClose);
    try {
      let visualQuery = parsed?.visualQuery || query;
      if (locationId) { const loc = get('locations', locationId); for (const name of [loc?.name, ...(loc?.aliases || [])].filter(Boolean)) visualQuery = visualQuery.replace(new RegExp(String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' '); }
      const result = await semanticSearch(user.townshipId, visualQuery.trim() || 'Describe the visible scene', { locationId, timeFrom, timeTo }, abort.signal);
      // A long local inference must not outlive revoked sessions or changed membership.
      const session = get<any>('sessions', res.locals.session.id), current = get<User>('users', user.id);
      if (!session || Date.parse(session.expiresAt) <= Date.now()) fail(401, 'Please sign in again.');
      if (!current || current.membershipStatus !== 'active' || current.role !== 'management' || current.townshipId !== user.townshipId) fail(403, 'Your video search access has changed.');
      audit(user, 'video.semantic_search', 'segments', 'local-query');
      res.json({ ...result, scope: searchScope, parsed, needsConfirmation: false }); return;
    } finally { res.off('close', onClose); }
  }
  const terms = searchTerms(query);
  const locationName = locationId && get('locations', locationId)?.name.toLowerCase();
  const locationWords = String(locationName || '').split(/\s+/);
  const contentTerms = terms.filter(t => !locationWords.includes(t));
  const videoMap = new Map(videos.map(v => [v.id, v]));
  const results = list('segments', user.townshipId).flatMap(segment => {
    const video = videoMap.get(segment.videoId);
    if (!video || (video.analysisVersion && segment.analysisVersion !== video.analysisVersion)) return [];
    const start = Date.parse(segment.absoluteStartAt || new Date(Date.parse(video.recordedAt) + segment.startSec * 1000).toISOString());
    const end = start + (segment.endSec - segment.startSec) * 1000;
    if ((timeFrom && end < Date.parse(timeFrom)) || (timeTo && start > Date.parse(timeTo))) return [];
    const description = `${segment.summary} ${(segment.observations || []).map((o: any) => o.description).join(' ')}`.toLowerCase();
    const matched = contentTerms.filter(term => description.includes(term));
    if (contentTerms.length && matched.length === 0) return [];
    const score = contentTerms.length ? matched.length / contentTerms.length : 1;
    return [{ ...segment, score, matchReason: matched.length ? `Local keyword match: ${matched.join(', ')}. Review the footage to verify the context.` : 'Matches the selected time and location filters.', video }];
  }).sort((a, b) => b.score - a.score || b.absoluteStartAt.localeCompare(a.absoluteStartAt)).slice(0, 50);
  audit(user, 'video.search', 'segments', 'local-query');
  res.json({ results, coverage, scope: searchScope, parsed, needsConfirmation: false, mode: 'keyword', notice: `${results.length ? 'Candidate footage only; review before drawing conclusions.' : 'No matching analysed segments found. This does not establish that an event did not happen.'}${coverage.unanalysedVideos ? ` ${coverage.unanalysedVideos} video(s) in this range have not completed analysis.` : ''} Results use local keyword ranking.` });
});
app.get('/api/bootstrap', (_req, res) => {
  const user = actor(res);
  const management = user.role === 'management';
  const incidents = list('incidents', user.townshipId).filter(i => canSeeIncident(i, user));
  const ids = new Set(incidents.map(i => i.id));
  res.json({
    user: publicUser(user),
    locations: list('locations', user.townshipId),
    members: management ? list<User>('users', user.townshipId).map(publicUser) : [publicUser(user)],
    reports: list('reports', user.townshipId).filter(r => canSeeReport(r, user)).map(r => visibleReport(r, user)),
    incidents: incidents.map(i => incidentView(i, user)),
    assignments: management ? list('assignments', user.townshipId) : isFieldStaff(user) ? list('assignments', user.townshipId).filter(a => a.assigneeId === user.id && ids.has(a.incidentId) && a.status !== 'cancelled') : [],
    activities: list('activities', user.townshipId).map(activityView),
    registrations: list('registrations', user.townshipId).filter(r => management || r.userId === user.id),
    pointTransactions: list('pointTransactions', user.townshipId).filter(p => management || p.userId === user.id),
    videos: management ? list('videos', user.townshipId) : [],
    jobs: management ? list('analysisJobs', user.townshipId) : [],
    alerts: management ? list('alerts', user.townshipId) : [],
    segments: management ? list('segments', user.townshipId) : [],
    indexJobs: management ? list('indexJobs', user.townshipId) : [],
    searchCoverage: management ? coverageOf(footageInScope(user.townshipId)) : undefined,
    capabilities: { mode: 'local', localOnly: true, demo: true, analysisMode: analysisMode(), analysisVersion: ANALYSIS_VERSION, visionModel: visionModel(), timeZone: 'Asia/Kuala_Lumpur', liveCctv: false, searchMode: analysisMode() === 'ollama' ? 'semantic' : 'keyword', facialRecognition: false, privacyMasking: true, notice: 'Local prototype. Built-in fixtures are synthetic demo data. Human review is required.' },
  });
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
app.use((error: any, req: Request, res: Response, _next: NextFunction) => {
  if (!res.locals.keepUploads) cleanupUploads(req);
  if (res.headersSent) { res.end(); return; }
  if (error instanceof multer.MulterError) { res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'The uploaded file exceeds the allowed size.' : 'Upload rejected. Check the file count and field names.' }); return; }
  if (error instanceof ApiError || error instanceof LocalAIError || error instanceof WorkflowError) { res.status(error.status).json({ error: error.message }); return; }
  if (error?.type === 'entity.parse.failed') { res.status(400).json({ error: 'Request body must be valid JSON.' }); return; }
  if (error?.type === 'entity.too.large') { res.status(413).json({ error: 'Request body is too large.' }); return; }
  console.error('Local API request failed:', error?.message || 'Unknown error');
  res.status(500).json({ error: 'The local service could not complete this request.' });
});

seedDemo();
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4000);
  const server = app.listen(port, '127.0.0.1', () => console.log(`JagaAI API: http://127.0.0.1:${port} (local only)`));
  server.on('error', error => { console.error(`Local API could not start: ${error.message}`); process.exitCode = 1; });
}
