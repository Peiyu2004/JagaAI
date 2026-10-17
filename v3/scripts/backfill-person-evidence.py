"""Recheck existing sampled frames without regenerating captions or embeddings."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys

import cv2

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--data-dir', required=True, type=Path)
parser.add_argument('--report', required=True, type=Path)
args = parser.parse_args()
os.environ['JAGAAI_DATA_DIR'] = str(args.data_dir.resolve())
sys.path.insert(0, str(ROOT / 'backend'))
from app.database import session_scope
from app.models import Camera, Description, Video, utcnow
from app.person_evidence import check_frame_people
from app.search import utc
from app.vision import Detector, detect_frame
from sqlmodel import select

detector = Detector()
report = {'checked_at': datetime.now(timezone.utc).isoformat(), 'data_dir': str(args.data_dir.resolve()), 'frames': []}
with session_scope() as session:
    video_ids = [v.id for v in session.exec(select(Video)).all() if v.status == 'ready' and utc(v.expires_at) > utcnow()]
for video_id in video_ids:
    with session_scope() as session:
        video = session.get(Video, video_id)
        path, processed_at = video.path, video.processed_at
        rules = session.get(Camera, video.camera_id).rules
        snapshots = [(d.id, dict(d.attributes)) for d in session.exec(select(Description).where(Description.video_id == video_id)).all()]
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError('Cannot open recording: ' + video_id)
    fps = cap.get(cv2.CAP_PROP_FPS)
    updates = []
    try:
        for ident, attributes in snapshots:
            second, name = attributes['observed_at_sec'], attributes['keyframe']
            # Worker uses the source frame number divided by fps; rounding recovers
            # that exact frame even when the stored timestamp has three decimals.
            cap.set(cv2.CAP_PROP_POS_FRAMES, round(second * fps))
            ok, frame = cap.read()
            if not ok:
                raise RuntimeError('Cannot decode sampled frame: ' + ident)
            evidence = check_frame_people(frame, detect_frame(frame, detector, rules), detector, second, name)
            updates.append((ident, attributes, evidence))
    finally:
        cap.release()
    with session_scope() as session:
        video = session.get(Video, video_id)
        if not video or video.status != 'ready' or video.path != path or video.processed_at != processed_at or utc(video.expires_at) <= utcnow():
            raise RuntimeError('Recording changed or expired during recheck: ' + video_id)
        for ident, attributes, evidence in updates:
            current = session.get(Description, ident)
            if not current or current.attributes != attributes:
                raise RuntimeError('Description changed during recheck: ' + ident)
            current.attributes = {**attributes, 'person_evidence': evidence}
            session.add(current)
            report['frames'].append({'description_id': ident, 'video_id': video_id,
                                     'vlm_people': attributes.get('people'), **evidence})
        session.commit()
    print(json.dumps({'video_id': video_id, 'frames': len(updates),
                      'person_frames': sum(bool(e['boxes']) for _, _, e in updates)}), flush=True)
report['provider'] = detector.provider
args.report.parent.mkdir(parents=True, exist_ok=True)
args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print('Checked', len(report['frames']), 'sampled frames;', detector.provider)
