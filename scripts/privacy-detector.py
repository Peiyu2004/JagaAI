"""Offline screenshot redaction. No recognition, OCR, network access or automatic model download."""
import hashlib
import json
import math
import os
import sys
from pathlib import Path

os.environ.setdefault('OMP_NUM_THREADS', '2')
import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

MODELS = {
    'face': ('face_detection_yunet_2023mar.onnx', '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'),
    'plate': ('yolo-v9-t-640-license-plates-end2end.onnx', 'c3c1026ca7d0585dd88084d68182dd897113712fa734ae1557ca70174440c076'),
}
Image.MAX_IMAGE_PIXELS = 24_000_000
cv2.setNumThreads(2)


def detect_and_mask(job):
    paths = {}
    for kind, (name, digest) in MODELS.items():
        filename = Path(job['modelDir']) / name
        if not filename.is_file() or hashlib.sha256(filename.read_bytes()).hexdigest() != digest:
            raise ValueError('Local privacy model missing or checksum mismatch. Run npm run privacy:setup.')
        paths[kind] = str(filename)
    with Image.open(job['inputPath']) as source:
        if getattr(source, 'n_frames', 1) != 1:
            raise ValueError('Use a still JPEG, PNG or WebP screenshot; animated images cannot be shared.')
        if source.width * source.height > 24_000_000:
            raise ValueError('Screenshot exceeds the 24-megapixel processing limit.')
        normalized = ImageOps.exif_transpose(source).convert('RGBA')
        background = Image.new('RGBA', normalized.size, 'white')
        background.alpha_composite(normalized)
        image = background.convert('RGB')
        image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        rgb = np.asarray(image).copy()
    height, width = rgb.shape[:2]
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    regions = []

    def region(kind, x1, y1, x2, y2, score, padding):
        if not all(math.isfinite(float(v)) for v in [x1, y1, x2, y2, score]):
            raise ValueError('Non-finite detector output; screenshot withheld.')
        dx, dy = max(3, (x2-x1)*padding), max(3, (y2-y1)*padding)
        x1, y1 = max(0, math.floor(x1-dx)), max(0, math.floor(y1-dy))
        x2, y2 = min(width, math.ceil(x2+dx)), min(height, math.ceil(y2+dy))
        if x2 <= x1 or y2 <= y1:
            return
        for old in regions:
            intersection = max(0, min(x2, old['x2'])-max(x1, old['x1'])) * max(0, min(y2, old['y2'])-max(y1, old['y1']))
            if old['kind'] == kind and intersection / max(1, min((x2-x1)*(y2-y1), (old['x2']-old['x1'])*(old['y2']-old['y1']))) > .75:
                # Union duplicates: never shrink an already detected privacy region.
                old.update(x1=min(x1, old['x1']), y1=min(y1, old['y1']), x2=max(x2, old['x2']), y2=max(y2, old['y2']))
                return
        regions.append(dict(kind=kind, x1=x1, y1=y1, x2=x2, y2=y2, score=float(score)))

    face = cv2.FaceDetectorYN.create(paths['face'], '', (320, 320), .65, .3, 5000)
    for size in [1280, 640]:
        scale = min(1., size / max(width, height))
        sample = cv2.resize(bgr, (max(32, round(width*scale)), max(32, round(height*scale))))
        sx, sy = sample.shape[1]/width, sample.shape[0]/height
        face.setInputSize((sample.shape[1], sample.shape[0]))
        _, faces = face.detect(sample)
        for row in faces if faces is not None else []:
            x, y, w, h = row[:4]
            region('face', x/sx, y/sy, (x+w)/sx, (y+h)/sy, row[-1], .22)

    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    plate = ort.InferenceSession(paths['plate'], sess_options=options, providers=['CPUExecutionProvider'])
    crops = [(0, 0, width, height)]
    if max(width, height) > 800:
        for y in range(0, height, 512):
            for x in range(0, width, 512):
                crops.append((x, y, min(width, x+640), min(height, y+640)))
    for x, y, right, bottom in crops:
        crop = bgr[y:bottom, x:right]
        h, w = crop.shape[:2]
        ratio = min(640/h, 640/w)
        resized = cv2.resize(crop, (round(w*ratio), round(h*ratio)))
        dw, dh = (640-resized.shape[1])/2, (640-resized.shape[0])/2
        padded = cv2.copyMakeBorder(resized, round(dh-.1), round(dh+.1), round(dw-.1), round(dw+.1), cv2.BORDER_CONSTANT, value=(114,114,114))
        tensor = np.ascontiguousarray(padded[:, :, ::-1].transpose(2,0,1)[None], dtype=np.float32)/255.
        predictions = np.asarray(plate.run(None, {plate.get_inputs()[0].name: tensor})[0])
        if predictions.ndim == 3 and predictions.shape[0] == 1:
            predictions = predictions[0]
        if predictions.ndim != 2 or predictions.shape[1] != 7 or not np.isfinite(predictions).all():
            raise ValueError('Unexpected plate detector output; screenshot withheld.')
        for row in predictions:
            if row[6] >= .2:
                region('plate', (row[1]-dw)/ratio+x, (row[2]-dh)/ratio+y, (row[3]-dw)/ratio+x, (row[4]-dh)/ratio+y, row[6], .18)
    for mask in job.get('manualMasks', []):
        region('manual', mask['x']*width, mask['y']*height, (mask['x']+mask['w'])*width, (mask['y']+mask['h'])*height, 1, 0)
    # Opaque pixels remove image detail; a mild blur would leave plate characters recoverable.
    for box in regions:
        rgb[box['y1']:box['y2'], box['x1']:box['x2']] = (27, 41, 35)
    Image.fromarray(rgb).save(job['outputPath'], 'JPEG', quality=92, exif=b'')
    return dict(width=width, height=height, regions=regions, counts={k: sum(r['kind'] == k for r in regions) for k in ['face', 'plate', 'manual']},
                models={k: dict(file=v[0], sha256=v[1]) for k, v in MODELS.items()}, method='opaque-rectangle-v1', metadataStripped=True)


if __name__ == '__main__':
    try:
        print(json.dumps(detect_and_mask(json.load(sys.stdin))))
    except Exception as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)
