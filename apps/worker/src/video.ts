import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
export const ffmpegPath = require('ffmpeg-static') as string;
const ffprobePath = (require('ffprobe-static') as { path: string }).path;
const execute = promisify(execFile);

export async function runFfmpeg(args: string[], signal?: AbortSignal) {
  if (!ffmpegPath) throw new Error('Bundled FFmpeg is unavailable. Reinstall local dependencies.');
  await execute(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
    timeout: 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, signal,
  });
}

export async function probeVideo(filePath: string): Promise<{ durationSec: number; width: number; height: number; fps: number }> {
  const result = await execute(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath], {
    timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  const probe = JSON.parse(result.stdout);
  const stream = probe.streams?.find((s: any) => s.codec_type === 'video');
  const durationSec = Number(probe.format?.duration);
  if (!String(probe.format?.format_name).split(',').includes('mp4') || !stream ||
      !Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 3600 ||
      !Number.isFinite(stream.width) || !Number.isFinite(stream.height) || stream.width <= 0 || stream.height <= 0) {
    throw new Error('A valid MP4 video with duration between 0 and 3600 seconds is required.');
  }
  const [numerator, denominator] = String(stream.avg_frame_rate || '0/1').split('/').map(Number);
  return { durationSec, width: stream.width, height: stream.height, fps: numerator / denominator || 1 };
}

/** Build a silent, bounded task evidence clip; callers keep its media record private. */
export async function createEvidenceClip(inputPath: string, outputPath: string, startSec: number, endSec: number) {
  const { durationSec } = await probeVideo(inputPath);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || startSec >= endSec || endSec > durationSec + 0.001) {
    throw new Error('Evidence clip times must be ordered and within the original video.');
  }
  await runFfmpeg(['-ss', String(startSec), '-i', inputPath, '-t', String(endSec - startSec), '-map', '0:v:0', '-an',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-movflags', '+faststart', outputPath]);
}

export function isInside(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/** Validate both the lexical path and its resolved target before reading or deleting local media. */
export async function safeMediaPath(root: string, candidate: string) {
  if (!isInside(root, candidate)) throw new Error('Media path is outside the local media directory.');
  const [resolvedRoot, resolvedFile] = await Promise.all([realpath(root), realpath(candidate)]);
  if (!isInside(resolvedRoot, resolvedFile)) throw new Error('Media path resolves outside the local media directory.');
  if (!(await stat(resolvedFile)).isFile()) throw new Error('Media path is not a regular file.');
  return resolvedFile;
}

export async function safeOutputPath(root: string, candidate: string) {
  if (!isInside(root, candidate)) throw new Error('Output path is outside its local directory.');
  const [resolvedRoot, resolvedParent] = await Promise.all([realpath(root), realpath(path.dirname(candidate))]);
  if (resolvedParent !== resolvedRoot && !isInside(resolvedRoot, resolvedParent)) throw new Error('Output directory resolves outside its local directory.');
  try {
    const existing = await lstat(candidate);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('Existing output target is not a plain file.');
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  return path.join(resolvedParent, path.basename(candidate));
}

export function segmentWindows(durationSec: number) {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 3600) throw new Error('Invalid video duration.');
  const windows: { startSec: number; endSec: number }[] = [];
  for (let startSec = 0; startSec < durationSec; startSec += 12) {
    const endSec = Math.min(startSec + 15, durationSec);
    windows.push({ startSec, endSec });
    if (endSec >= durationSec) break;
  }
  return windows;
}
