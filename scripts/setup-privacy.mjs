import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const modelDir = path.resolve('.runtime/privacy-models');
await mkdir(modelDir, { recursive: true });
const models = [
  ['face_detection_yunet_2023mar.onnx', 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx', '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'],
  ['yolo-v9-t-640-license-plates-end2end.onnx', 'https://github.com/ankandrew/open-image-models/releases/download/assets/yolo-v9-t-640-license-plates-end2end.onnx', 'c3c1026ca7d0585dd88084d68182dd897113712fa734ae1557ca70174440c076'],
];
for (const [name, url, sha256] of models) {
  const target = path.join(modelDir, name), hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const existing = await readFile(target).catch(() => undefined);
  if (existing && hash(existing) === sha256) { console.log(`${name}: checksum verified`); continue; }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Privacy model download failed: ${name}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== sha256) throw new Error(`Privacy model checksum mismatch: ${name}`);
  await writeFile(`${target}.download`, bytes); await unlink(target).catch(() => {}); await rename(`${target}.download`, target);
  console.log(`${name}: installed and checksum verified`);
}
execFileSync(process.env.PRIVACY_PYTHON || 'python', ['-c', 'import cv2,numpy,onnxruntime,PIL; assert hasattr(cv2,"FaceDetectorYN"); print("Local Python privacy dependencies ready")'], { stdio: 'inherit', windowsHide: true });
console.log('Privacy detection runs offline. If dependencies are missing, install scripts/requirements-privacy.txt in your local Python environment.');
