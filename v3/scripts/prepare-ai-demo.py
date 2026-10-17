"""Derive reproducible public-video demo clips and run the real local pipeline."""
import argparse
import csv
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--cases', nargs='*', help='Optional case IDs')
parser.add_argument('--reanalyse', action='store_true')
args = parser.parse_args()
data = ROOT/'data/ai-demo'
os.environ['JAGAAI_DATA_DIR'] = str(data)
os.environ.setdefault('JAGAAI_OLLAMA_URL', 'http://127.0.0.1:11435')
sys.path.insert(0, str(ROOT/'backend'))
from app.database import init_db, session_scope, default_rules
from app.models import Camera, Video, Event, Description, utcnow
from app.worker import process_video
from app.gpu import selected_gpu
from sqlmodel import select

plan = json.loads((ROOT/'scripts/ai-demo-cases.json').read_text(encoding='utf-8'))
metadata = {r['clip_id']: r for r in csv.DictReader((ROOT/'data/meva/eval_candidates.csv').open(encoding='utf-8-sig'))}
init_db()
with session_scope() as session:
    # Remove only unused default camera fixtures in this separate demo profile.
    for ident in ('cam-b1','cam-b2','cam-n1','cam-p1','cam-p2','cam-c1'):
        camera=session.get(Camera,ident)
        if camera and not session.exec(select(Video).where(Video.camera_id==ident)).first():
            session.delete(camera)
    session.commit()
(data/'videos').mkdir(exist_ok=True)
report_path = ROOT/'output/ai-readiness/demo-evaluation.json'
report_path.parent.mkdir(parents=True, exist_ok=True)
existing=json.loads(report_path.read_text(encoding='utf-8')) if report_path.exists() else {}
report = {'gpu': selected_gpu(), 'reference': plan['reference'], 'cases': existing.get('cases',[])}
for case in plan['cases']:
    if args.cases and case['id'] not in args.cases:
        continue
    print('Starting '+case['id'], flush=True)
    source = next((ROOT/'data/meva/mp4').glob(case['source']+'*.mp4'))
    clip = data/'videos'/(case['id']+'.mp4')
    if not clip.exists():
        subprocess.run([str(ROOT/'tools/ffmpeg.exe'), '-y', '-ss', str(case['from']), '-i', str(source),
            '-t', str(case['to']-case['from']), '-an', '-vf', 'scale=1280:-2', '-c:v', 'libx264',
            '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(clip)],
            check=True, capture_output=True)
    camera_id = 'demo-'+case['id']
    video_id = 'demo-'+case['id']
    rules = default_rules()
    rules['R1']['enabled'] = bool(case.get('r1'))
    rules['R3'].update({'enabled': bool(case.get('r3_line')), 'line': case.get('r3_line'),
                       'zone': [], 'active_start': '00:00', 'active_end': '00:00'})
    recorded = datetime.fromisoformat(metadata[case['source']]['upload_recorded_at_myt_for_testing']).replace(
        tzinfo=timezone(timedelta(hours=8)))+timedelta(seconds=case['from'])
    with session_scope() as session:
        camera = session.get(Camera, camera_id)
        if not camera:
            camera = Camera(id=camera_id, name=case['name'], location_id=case['location'], rules=rules)
            session.add(camera)
            session.flush()
        else:
            camera.rules = rules
        video = session.get(Video, video_id)
        if not video:
            video = Video(id=video_id, camera_id=camera_id, path=str(clip), filename=clip.name,
                          recorded_at=recorded, duration_sec=case['to']-case['from'], expires_at=utcnow()+timedelta(days=30))
            session.add(video)
        needs_analysis = args.reanalyse or video.status != 'ready' or video.description_status not in {'ready','partial'}
        session.commit()
    start = time.perf_counter()
    if needs_analysis:
        process_video(video_id)
    with session_scope() as session:
        video = session.get(Video, video_id)
        events = session.exec(select(Event).where(Event.video_id==video_id)).all()
        captions = session.exec(select(Description).where(Description.video_id==video_id)).all()
        actual = {r:sum(e.rule_id==r for e in events) for r in ('R1','R3')}
        result = {**case, 'split':metadata[case['source']]['split'], 'video_id':video_id,
            'source_url':'https://mevadata-public-01.s3.amazonaws.com/'+metadata[case['source']]['s3_key'],
            'license':'CC-BY-4.0','attribution':'MEVA, Kitware Inc. and IARPA, https://mevadata.org/',
            'source_sha256':hashlib.file_digest(source.open('rb'),'sha256').hexdigest(),
            'derived_sha256':hashlib.file_digest(clip.open('rb'),'sha256').hexdigest(),
            'status':video.status, 'description_status':video.description_status,
            'actual':actual, 'expectation_met':actual['R1']==case['expected_r1'] and actual['R3']==case['expected_r3'],
            'events':[{'rule_id':e.rule_id,'start_sec':e.start_sec,'end_sec':e.end_sec,'metrics':e.metrics} for e in events],
            'captions':[{'text':d.text,'attributes':d.attributes} for d in captions],
            'metrics':video.analysis_metrics, 'run_wall_sec':round(time.perf_counter()-start,2)}
    report['cases']=[c for c in report['cases'] if c['id']!=case['id']]+[result]
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'case':case['id'], 'actual':actual, 'expectation_met':result['expectation_met'],
                      'descriptions':len(captions), 'description_status':video.description_status,
                      'error':video.analysis_metrics.get('description_error'), 'seconds':result['run_wall_sec']}), flush=True)
print('Saved '+str(report_path), flush=True)
