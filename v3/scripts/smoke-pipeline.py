"""Exercise real local model inference on a clearly marked synthetic video."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import time
import httpx

ROOT=Path(__file__).resolve().parents[1]
output=ROOT/'output/verification';output.mkdir(parents=True,exist_ok=True)
with httpx.Client(base_url='http://127.0.0.1:8766',trust_env=False,timeout=240) as client:
    login=client.post('/api/auth/login',json={'email':'admin@jagaai.local','password':'JagaAI-demo-2026!'})
    login.raise_for_status()
    original=client.get('/api/bootstrap').json()
    name='synthetic-pipeline-smoke.mp4'
    # Reuse only this script's own labelled upload, never add duplicates on rerun.
    video=next((v for v in original['videos'] if v['filename']==name),None)
    if video is None:
        with (output/name).open('rb') as file:
            response=client.post('/api/videos',data={'camera_id':original['cameras'][0]['id'],
                'recorded_at':(datetime.now(timezone.utc)-timedelta(hours=1)).isoformat()},files={'file':(name,file,'video/mp4')})
        response.raise_for_status();video=response.json()
    if video['status']!='ready' or video['description_status']!='ready':
        client.post('/api/videos/'+video['id']+'/analyse').raise_for_status()
    previous=None;deadline=time.monotonic()+360
    while time.monotonic()<deadline:
        bootstrap=client.get('/api/bootstrap').json()
        current=next(v for v in bootstrap['videos'] if v['id']==video['id'])
        state=(current['status'],current['description_status'])
        if state!=previous:
            print('Pipeline:',state,flush=True);previous=state
        if current['status']=='failed':
            raise RuntimeError(current.get('error'))
        if current['status']=='ready' and current['description_status'] in ('ready','failed','partial'):
            break
        time.sleep(2)
    else:
        raise RuntimeError('Pipeline timed out; processing state was preserved for recovery.')
    results={}
    for query in ['有没有人打架','有人倒地吗','昨晚有大象吗','red rectangle near parking bays']:
        response=client.post('/api/search',json={'query':query})
        response.raise_for_status();results[query]=response.json()
    assert results['有没有人打架']['supported'] is False
    assert results['有人倒地吗']['supported'] is False
    media=client.get('/api/videos/'+video['id']+'/media',headers={'Range':'bytes=0-127'})
    assert media.status_code==206 and len(media.content)==128
    thumbnail=client.get(current['thumbnail_url']) if current.get('thumbnail_url') else None
    assert thumbnail is not None and thumbnail.status_code==200
    report={'input':'Original labelled synthetic clip, not a CCTV accuracy benchmark.',
            'actual_yolox_inference':current['status']=='ready',
            'actual_vlm_and_embedding':current['description_status']=='ready',
            'video':current,'searches':results,'private_range_playback':True,'private_thumbnail':True,
            'accuracy_evaluated':False}
    (output/'local-pipeline-smoke.json').write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf-8')
    print(json.dumps({'visual_status':current['status'],'semantic_status':current['description_status'],
                       'metrics':current.get('analysis_metrics'),'verification_file':str(output/'local-pipeline-smoke.json')},indent=2),flush=True)
    if current['description_status']!='ready':
        raise RuntimeError('Detection succeeded, but semantic pipeline did not finish: '+str(current.get('analysis_metrics')))
