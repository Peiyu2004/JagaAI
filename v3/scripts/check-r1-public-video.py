"""Exploratory R1 check on the full existing G340 clip; no ground-truth claim."""
from datetime import datetime,timedelta,timezone
import json
import os
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[1]
os.environ['JAGAAI_DATA_DIR']=str(ROOT/'output/ai-readiness/r1-exploration')
os.environ['JAGAAI_ENABLE_VLM']='0'
sys.path.insert(0,str(ROOT/'backend'))
from app.database import init_db,session_scope,default_rules
from app.models import Camera,Video,Event,Track,utcnow
from app.worker import process_video
from sqlmodel import select
init_db()
source=next((ROOT/'data/meva/mp4').glob('2018-03-07.17-05-00.17-10-00.bus.G340*.mp4'))
with session_scope() as s:
    rules=default_rules();rules['R3']['enabled']=False
    if not s.get(Camera,'r1-explore'):
        s.add(Camera(id='r1-explore',name='Public G340 exploratory check',location_id='zone-b',rules=rules));s.flush()
    if not s.get(Video,'r1-explore'):
        s.add(Video(id='r1-explore',camera_id='r1-explore',path=str(source),filename=source.name,
                    duration_sec=300,recorded_at=datetime(2018,3,7,9,5,tzinfo=timezone.utc),expires_at=utcnow()+timedelta(days=30)))
    s.commit()
process_video('r1-explore')
with session_scope() as s:
    v=s.get(Video,'r1-explore')
    events=s.exec(select(Event).where(Event.video_id==v.id)).all()
    people=s.exec(select(Track).where(Track.video_id==v.id,Track.class_name=='person')).all()
    r={'purpose':'Exploratory detector/tracker/rule run, not independent ground truth. Semantic analysis deliberately disabled.',
       'source':str(source),'metrics':v.analysis_metrics,
       'events':[{'rule_id':e.rule_id,'start_sec':e.start_sec,'end_sec':e.end_sec,'metrics':e.metrics} for e in events if not e.verification.get('superseded')],
       'longest_person_tracks':[{'track_id':p.track_id,'start_sec':p.start_sec,'end_sec':p.end_sec} for p in sorted(people,key=lambda p:p.end_sec-p.start_sec,reverse=True)[:10]]}
    (ROOT/'output/ai-readiness/r1-exploration.json').write_text(json.dumps(r,indent=2),encoding='utf-8')
    print(json.dumps({'events':r['events'],'longest_person_tracks':r['longest_person_tracks'][:3],'detection_wall_sec':v.analysis_metrics['detection_wall_sec']}),flush=True)
