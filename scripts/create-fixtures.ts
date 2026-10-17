import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataDir, mediaDir, get, list, now, put, remove, transaction } from '../packages/shared/store.ts';
import { seedDemo } from '../apps/api/src/seed.ts';
import { ffmpegPath, probeVideo, safeMediaPath, safeOutputPath } from '../apps/worker/src/video.ts';
import { fixtureSpecs, manifestSchema, sha256 } from '../apps/worker/src/fixtures.ts';

const WIDTH = 640, HEIGHT = 360, FPS = 8;
type Color = [number, number, number];
const blue: Color = [24, 142, 244], white: Color = [249, 251, 253];
const font: Record<string, string[]> = {
  A: ['01110','10001','10001','11111','10001','10001','10001'], B:['11110','10001','10001','11110','10001','10001','11110'],
  C:['01111','10000','10000','10000','10000','10000','01111'], D:['11110','10001','10001','10001','10001','10001','11110'],
  E:['11111','10000','10000','11110','10000','10000','11111'], F:['11111','10000','10000','11110','10000','10000','10000'],
  G:['01111','10000','10000','10111','10001','10001','01111'], H:['10001','10001','10001','11111','10001','10001','10001'],
  I:['11111','00100','00100','00100','00100','00100','11111'], J:['00111','00010','00010','00010','10010','10010','01100'],
  K:['10001','10010','10100','11000','10100','10010','10001'], L:['10000','10000','10000','10000','10000','10000','11111'],
  M:['10001','11011','10101','10101','10001','10001','10001'], N:['10001','11001','10101','10011','10001','10001','10001'],
  O:['01110','10001','10001','10001','10001','10001','01110'], P:['11110','10001','10001','11110','10000','10000','10000'],
  Q:['01110','10001','10001','10001','10101','10010','01101'], R:['11110','10001','10001','11110','10100','10010','10001'],
  S:['01111','10000','10000','01110','00001','00001','11110'], T:['11111','00100','00100','00100','00100','00100','00100'],
  U:['10001','10001','10001','10001','10001','10001','01110'], V:['10001','10001','10001','10001','10001','01010','00100'],
  W:['10001','10001','10001','10101','10101','11011','10001'], X:['10001','10001','01010','00100','01010','10001','10001'],
  Y:['10001','10001','01010','00100','00100','00100','00100'], Z:['11111','00001','00010','00100','01000','10000','11111'],
  '0':['01110','10001','10011','10101','11001','10001','01110'], '1':['00100','01100','00100','00100','00100','00100','01110'],
  '2':['01110','10001','00001','00010','00100','01000','11111'], '3':['11110','00001','00001','01110','00001','00001','11110'],
  '4':['00010','00110','01010','10010','11111','00010','00010'], '5':['11111','10000','10000','11110','00001','00001','11110'],
  '6':['01110','10000','10000','11110','10001','10001','01110'], '7':['11111','00001','00010','00100','01000','01000','01000'],
  '8':['01110','10001','10001','01110','10001','10001','01110'], '9':['01110','10001','10001','01111','00001','00001','01110'],
  '-':['00000','00000','00000','11111','00000','00000','00000'], ':':['00000','00100','00100','00000','00100','00100','00000'],
};

export function painter(buffer: Buffer) {
  const rect = (x: number, y: number, width: number, height: number, color: Color) => {
    for (let row = Math.max(0, Math.round(y)); row < Math.min(HEIGHT, y + height); row++) {
      for (let col = Math.max(0, Math.round(x)); col < Math.min(WIDTH, x + width); col++) {
        const offset = (row * WIDTH + col) * 3; buffer[offset] = color[0]; buffer[offset + 1] = color[1]; buffer[offset + 2] = color[2];
      }
    }
  };
  const circle = (x: number, y: number, radius: number, color: Color) => {
    for (let yy = -radius; yy <= radius; yy++) for (let xx = -radius; xx <= radius; xx++) {
      if (xx * xx + yy * yy <= radius * radius) rect(x + xx, y + yy, 1, 1, color);
    }
  };
  const line = (x: number, y: number, x2: number, y2: number, thick: number, color: Color) => {
    const steps = Math.max(Math.abs(x2 - x), Math.abs(y2 - y), 1);
    for (let i = 0; i <= steps; i++) circle(Math.round(x + (x2 - x) * i / steps), Math.round(y + (y2 - y) * i / steps), thick, color);
  };
  const text = (value: string, x: number, y: number, scale: number, color: Color) => {
    for (const char of value.toUpperCase()) {
      const glyph = font[char];
      if (glyph) for (let row = 0; row < glyph.length; row++) for (let col = 0; col < 5; col++) if (glyph[row][col] === '1') rect(x + col * scale, y + row * scale, scale, scale, color);
      x += 6 * scale;
    }
  };
  return { rect, circle, line, text };
}

function frame(key: string, sec: number, durationSec: number) {
  const buffer = Buffer.alloc(WIDTH * HEIGHT * 3), p = painter(buffer);
  p.rect(0, 0, WIDTH, HEIGHT, [14, 30, 43]);
  p.rect(0, 50, WIDTH, 130, [125, 177, 196]);
  for (let i = 0; i < 5; i++) {
    p.rect(30 + i * 130, 95 + (i % 2) * 15, 85, 95, [91, 122, 135]);
    p.rect(44 + i * 130, 120, 14, 18, [178, 216, 222]);
  }
  p.rect(0, 180, WIDTH, 80, [72, 125, 94]);
  p.rect(0, 260, WIDTH, 65, [116, 126, 132]);
  p.line(0, 260, WIDTH, 260, 2, [220, 224, 218]);
  p.rect(0, 0, WIDTH, 48, [176, 40, 58]);
  p.text('SYNTHETIC DEMO', 21, 10, 4, white);
  p.text('PREDEFINED ANIMATION - NOT REAL CCTV', 16, 58, 2, [21, 40, 57]);
  const x = key === 'fall' ? 310 : 68 + 450 * sec / durationSec;
  if (key === 'fall') {
    const angle = Math.max(0, Math.min(1, (sec - 6) / 3)) * Math.PI / 2;
    const headX = x + Math.sin(angle) * 85, headY = 259 - Math.cos(angle) * 104;
    const hipX = x + Math.sin(angle) * 35, hipY = 259 - Math.cos(angle) * 41;
    p.line(headX, headY + 15 * Math.cos(angle), hipX, hipY, 8, blue);
    p.circle(headX, headY, 12, [247, 204, 155]);
    p.line(hipX, hipY, x - 12 * Math.cos(angle), 259, 5, blue);
    p.line(hipX, hipY, x + 12 * Math.cos(angle), 259, 5, blue);
    p.line(headX - Math.sin(angle) * 20, headY + Math.cos(angle) * 25, hipX + Math.cos(angle) * 18, hipY - Math.sin(angle) * 12, 4, blue);
  } else {
    const stride = Math.sin(sec * 5) * 12;
    p.circle(x, 156, 12, [247, 204, 155]);
    p.line(x, 177, x, 220, 8, blue);
    p.line(x, 218, x - 13 + stride, 259, 5, blue);
    p.line(x, 218, x + 13 - stride, 259, 5, blue);
    p.line(x, 184, x + 27, key === 'bicycle' ? 207 : 207 + stride, 4, blue);
    p.line(x, 184, x - 22, 211 - stride, 4, blue);
    if (key === 'bicycle') {
      const yellow: Color = [247, 203, 52], black: Color = [26, 42, 49];
      for (const wheel of [x + 32, x + 109]) {
        p.circle(wheel, 249, 22, black); p.circle(wheel, 249, 17, [116, 126, 132]);
        p.line(wheel - 16 * Math.cos(sec * 3), 249 - 16 * Math.sin(sec * 3), wheel + 16 * Math.cos(sec * 3), 249 + 16 * Math.sin(sec * 3), 1, white);
      }
      p.line(x + 32, 249, x + 54, 215, 3, yellow); p.line(x + 54, 215, x + 73, 249, 3, yellow);
      p.line(x + 73, 249, x + 32, 249, 3, yellow); p.line(x + 73, 249, x + 94, 210, 3, yellow);
      p.line(x + 109, 249, x + 94, 210, 3, yellow); p.line(x + 54, 215, x + 94, 210, 3, yellow);
      p.line(x + 91, 207, x + 100, 201, 3, black); p.line(x + 48, 211, x + 64, 211, 3, black);
    }
  }
  p.text(key === 'fall' ? 'LAKESIDE - SAFE POSTURE CHANGE' : key === 'walking' ? 'NORTH GATE - WALKING' : 'CLUBHOUSE - BICYCLE MOVEMENT', 15, 295, 2, white);
  p.text(`DEMO TIME ${String(Math.floor(sec)).padStart(2, '0')} SECONDS`, 15, 338, 2, [188, 210, 219]);
  return buffer;
}

async function makeVideo(key: string, durationSec: number, filePath: string) {
  const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${WIDTH}x${HEIGHT}`, '-framerate', String(FPS), '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', filePath], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let errorText = '';
  child.stderr.on('data', chunk => { if (errorText.length < 8000) errorText += chunk.toString(); });
  child.stdin.on('error', () => {});
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`Synthetic video generation failed: ${errorText}`)));
  });
  completion.catch(() => {});
  try {
    for (let i = 0; i < durationSec * FPS; i++) {
      if (child.exitCode !== null) throw new Error('Synthetic video generator exited before all frames were written.');
      if (!child.stdin.write(frame(key, i / FPS, durationSec))) await once(child.stdin, 'drain');
    }
    child.stdin.end();
    await completion;
  } catch (error) { child.kill(); throw error; }
}

export async function createFixtures() {
  seedDemo();
  const fixtureDir = path.join(dataDir, 'fixtures'), videoDir = path.join(mediaDir, 'videos');
  await Promise.all([mkdir(fixtureDir, { recursive: true }), mkdir(videoDir, { recursive: true })]);
  let previousManifest: ReturnType<typeof manifestSchema.parse> | undefined;
  try { previousManifest = manifestSchema.parse(JSON.parse(await readFile(path.join(fixtureDir, 'manifest.json'), 'utf8'))); } catch {}
  const entries: ReturnType<typeof manifestSchema.parse>['entries'] = [];
  const queueTargets: { key: string; videoId: string; createdAt: string; reusable: boolean }[] = [];
  const retentionDays = Number(process.env.MEDIA_RETENTION_DAYS || 7);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) throw new Error('MEDIA_RETENTION_DAYS must be an integer between 1 and 365.');
  for (const spec of fixtureSpecs) {
    const videoId = `video_fixture_${spec.key}`, mediaId = `media_fixture_${spec.key}`, filePath = await safeOutputPath(mediaDir, path.join(videoDir, `${videoId}.mp4`));
    const old = get<any>('videos', videoId), oldManifest = previousManifest?.entries.find(item => item.videoId === videoId);
    let reusable = false;
    try { reusable = !!old && old.status !== 'expired' && Date.parse(old.expiresAt) > Date.now() && oldManifest?.sha256 === sha256(await readFile(await safeMediaPath(mediaDir, filePath))); } catch {}
    if (!reusable) {
      await makeVideo(spec.key, spec.durationSec, filePath);
      const probe = await probeVideo(filePath);
      if (Math.abs(probe.durationSec - spec.durationSec) > 0.1) throw new Error('Generated fixture has an unexpected duration.');
    }
    const hash = sha256(await readFile(filePath));
    const createdAt = reusable ? old.createdAt : now(), expiresAt = reusable ? old.expiresAt : new Date(Date.now() + retentionDays * 86400_000).toISOString();
    const report = get<any>('reports', 'report_bicycle');
    const recordedAt = reusable ? old.recordedAt : spec.key === 'bicycle' && report ? new Date((Date.parse(report.timeFrom) + Date.parse(report.timeTo)) / 2).toISOString() : new Date(Date.now() - (spec.key === 'walking' ? 4 : 1) * 3600_000).toISOString();
    transaction(() => {
      if (!reusable) {
        for (const segment of list<any>('segments', 'township_serenia').filter(item => item.videoId === videoId)) remove('segments', segment.id);
        for (const alert of list<any>('alerts', 'township_serenia').filter(item => item.videoId === videoId)) remove('alerts', alert.id);
        put('media', { id: mediaId, townshipId: 'township_serenia', path: filePath, kind: 'video', contentType: 'video/mp4', videoId, expiresAt });
        put('videos', { id: videoId, townshipId: 'township_serenia', title: spec.title, cameraId: spec.cameraId, locationId: spec.locationId,
          mediaId, recordedAt, durationSec: spec.durationSec, status: 'queued', expiresAt, createdAt, source: 'synthetic_fixture', fixtureKey: spec.key, demo: true, ownerId: 'user_manager' });
      }
    });
    queueTargets.push({ key: spec.key, videoId, createdAt, reusable });
    entries.push({ key: spec.key, videoId, mediaId, sha256: hash, durationSec: spec.durationSec });
    console.log(`${spec.title}: ${spec.durationSec}s, ${reusable ? 'existing local fixture retained' : 'created and queued'}`);
  }
  const manifestPath = await safeOutputPath(dataDir, path.join(fixtureDir, 'manifest.json'));
  const pendingManifest = await safeOutputPath(dataDir, path.join(fixtureDir, 'manifest.pending.json'));
  await writeFile(pendingManifest, JSON.stringify({ version: 1, synthetic: true, entries }, null, 2));
  await rename(pendingManifest, manifestPath);
  transaction(() => {
    for (const target of queueTargets) {
      const jobId = `job_fixture_${target.key}`, job = get<any>('analysisJobs', jobId);
      if (!target.reusable || !job || job.status === 'failed') put('analysisJobs', { id: jobId, townshipId: 'township_serenia', videoId: target.videoId,
        status: 'queued', attemptCount: 0, analysisVersion: 'local-v2', createdAt: target.createdAt, updatedAt: now() });
    }
  });
  console.log('Synthetic fixtures ready. Their analysis is predefined demonstration data, not model inference.');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await createFixtures();
