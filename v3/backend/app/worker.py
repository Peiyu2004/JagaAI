"""Sequential local analysis. Detection results and semantic descriptions are separate states."""
from collections import defaultdict
from pathlib import Path
import os
import time

import cv2
import numpy as np
from sqlmodel import delete, select

from .database import DATA_DIR, session_scope
from .models import Camera, Description, Track, Video, utcnow
from .person_evidence import check_frame_people
from .realtime import publish_refresh
from .retention import media_path
from .search import utc
from .vision import Detector, RuleEngine, Tracker, check_person_crop, detect_frame, MODEL_NAME

_detector = None


def get_detector():
    global _detector
    if _detector is None:
        _detector = Detector()
    return _detector


def process_video(video_id):
    started = time.perf_counter()
    with session_scope() as session:
        video=session.get(Video,video_id)
        if not video:
            return
        if utc(video.expires_at)<=utcnow():
            video.status='failed';video.error='Video has expired.';session.commit();return
        camera=session.get(Camera,video.camera_id)
        if not camera:
            raise RuntimeError('Camera no longer exists.')
        path,recorded_at,duration,rules,camera_id=media_path(video.path),utc(video.recorded_at),video.duration_sec,camera.rules,camera.id
        video.status='processing';video.error=None;video.description_status='not_started';session.commit()
    publish_refresh('analysis',video_id)
    try:
        detector=get_detector()
        initial_passes=getattr(detector,'inference_passes',0)
        cap=cv2.VideoCapture(str(path))
        if not cap.isOpened():
            raise RuntimeError('OpenCV could not open this video.')
        fps=cap.get(cv2.CAP_PROP_FPS) or 25
        restricted=bool(rules.get('R3',{}).get('enabled'))
        target_fps=10 if restricted else 5
        step=max(1,round(fps/target_fps))
        sample_fps=fps/step
        tracker=Tracker(round(sample_fps))
        engine=RuleEngine(rules,recorded_at)
        directory=DATA_DIR/'frames'/video_id
        directory.mkdir(parents=True,exist_ok=True)
        trajectory=defaultdict(list)
        classes={}
        generated=[]
        rejected=[]
        samples=[]
        last_gray=None
        last_detect=-1e6
        detections=np.empty((0,6),dtype=np.float32)
        frame_number=sample_count=detection_calls=skipped=0
        inference_ms=[]
        next_description=0.
        previous_people=0
        last_sample=-100.
        sample_budget_exceeded=False
        max_descriptions=max(1,min(120,int(os.environ.get('JAGAAI_MAX_VLM_FRAMES','24'))))
        detection_started=time.perf_counter()
        try:
            while True:
                ok,frame=cap.read()
                if not ok:
                    break
                second=frame_number/fps
                frame_number+=1
                if (frame_number-1)%step:
                    continue
                sample_count+=1
                gray=cv2.resize(cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY),(160,90))
                motion=last_gray is None or np.mean(cv2.absdiff(gray,last_gray))>1.2
                # Small/distant people barely change the whole-frame motion score.
                # Once seen, keep 5fps observations so ByteTrack can confirm and retain them.
                person_visible=bool(len(detections) and np.any(detections[:,5]==0))
                if restricted or motion or person_visible or second-last_detect>=1:
                    detections=detect_frame(frame,detector,rules)
                    inference_ms.append(detector.last_ms)
                    last_detect=second;detection_calls+=1
                else:
                    skipped+=1
                last_gray=gray
                # Do not repeatedly present stale boxes as observations of a new frame.
                observed=detections if last_detect==second else np.empty((0,6),dtype=np.float32)
                tracks=tracker.update(observed,frame.shape[1],frame.shape[0])
                for track in tracks:
                    ident=track['id'];classes[ident]=track['class']
                    if not trajectory[ident] or second-trajectory[ident][-1]['t']>=.9:
                        trajectory[ident].append({'t':round(second,3),'box':track['box']})
                if sample_count==1:
                    cv2.imwrite(str(directory/'overview.jpg'),frame)
                candidates=engine.update(second,tracks)
                for candidate in candidates:
                    if candidate['rule_id']=='R1':
                        person=next((t for t in tracks if t['id']==candidate['metrics']['track_id']),None)
                        check=check_person_crop(frame,person['box'],detector) if person else {'passed':False,'score':0.,'method':'person_crop_recheck'}
                        candidate['metrics']['person_check']=check
                        if not check['passed']:
                            rejected.append({**candidate,'reason':'Person not supported by the trigger-frame crop recheck.'})
                            continue
                    candidate['rule_version']='1.1'
                    name=f"event-{candidate['rule_id']}-{candidate['metrics']['track_id']}.jpg"
                    annotated=frame.copy()
                    configured=rules.get(candidate['rule_id'],{})
                    scale=np.array([frame.shape[1],frame.shape[0]])
                    if configured.get('zone'):
                        cv2.polylines(annotated,[(np.array(configured['zone'])*scale).astype(np.int32)],True,(255,170,60),2)
                    if configured.get('line'):
                        a,b=(np.array(configured['line'])*scale).astype(int)
                        cv2.line(annotated,tuple(a),tuple(b),(40,200,255),3)
                    cv2.putText(annotated,candidate['rule_id']+' configured boundary - review required',(16,28),
                                cv2.FONT_HERSHEY_SIMPLEX,.65,(40,200,255),2)
                    for track in tracks:
                        x1,y1,x2,y2=(np.array(track['box'])*[frame.shape[1],frame.shape[0],frame.shape[1],frame.shape[0]]).astype(int)
                        cv2.rectangle(annotated,(x1,y1),(x2,y2),(90,190,230),2)
                        cv2.putText(annotated,track['class']+' #'+track['id'],(x1,max(18,y1-5)),cv2.FONT_HERSHEY_SIMPLEX,.5,(120,220,250),1)
                    cv2.imwrite(str(directory/name),annotated)
                    candidate['keyframes']=[f'/api/videos/{video_id}/keyframes/{name}']
                    generated.append(candidate)
                people=sum(t['class']=='person' for t in tracks)
                activity_change=people>0 and people!=previous_people and second-last_sample>=2
                wanted=second>=next_description or activity_change or (bool(candidates) and second-last_sample>=1)
                if wanted and len(samples)<max_descriptions:
                    scaled=cv2.resize(frame,(min(768,frame.shape[1]),max(1,round(frame.shape[0]*min(768,frame.shape[1])/frame.shape[1]))))
                    ok_jpeg,jpeg=cv2.imencode('.jpg',scaled,[cv2.IMWRITE_JPEG_QUALITY,82])
                    if ok_jpeg:
                        name=f'sample-{round(second*1000):09d}.jpg'
                        (directory/name).write_bytes(jpeg.tobytes())
                        # Periodic samples can fall on a motion-skipped frame. Never
                        # borrow an earlier frame's boxes to support a person result.
                        fresh=observed if last_detect==second else detect_frame(frame,detector,rules)
                        evidence=check_frame_people(frame,fresh,detector,second,name)
                        samples.append((second,jpeg.tobytes(),name,evidence))
                        last_sample=second
                    next_description=second+15
                elif wanted:
                    sample_budget_exceeded=True
                if last_detect==second:
                    previous_people=people
        finally:
            cap.release()
        if sample_count==0:
            raise RuntimeError('The uploaded recording contains no decodable video frames.')
        detection_seconds=time.perf_counter()-detection_started
        metrics={'sample_fps':round(sample_fps,3),'source_frames':frame_number,'sampled_frames':sample_count,
                 'detector_cycles':detection_calls,'detector_calls':getattr(detector,'inference_passes',detection_calls)-initial_passes,
                 'boundary_focus_enabled':bool(rules.get('R3',{}).get('enabled')),
                 'motion_skipped_calls':skipped,'mean_inference_ms':round(float(np.mean(inference_ms)),2),
                 'detection_wall_sec':round(detection_seconds,3),'sampled_frames_per_wall_sec':round(sample_count/max(detection_seconds,.001),2),
                 'detector':MODEL_NAME+' ONNX','provider':detector.provider,'tracker':'ByteTrack (supervision 0.25.1)',
                 'rule_version':'1.1','identity_scope':'this video and camera only','source':'uploaded_recording',
                 'description_frames_total':len(samples),'description_frames_completed':0,
                 'rejected_candidates':rejected,'sample_budget_exceeded':sample_budget_exceeded}
        with session_scope() as session:
            video=session.get(Video,video_id)
            if not video:
                return
            if utc(video.expires_at)<=utcnow():
                raise RuntimeError('Recording expired during analysis; no new events were saved.')
            session.exec(delete(Track).where(Track.video_id==video_id))
            for ident,points in trajectory.items():
                session.add(Track(video_id=video_id,track_id=ident,class_name=classes[ident],start_sec=points[0]['t'],end_sec=points[-1]['t'],attributes={'samples':points}))
            from .event_index import save_events
            save_events(session,video_id,camera_id,recorded_at,generated)
            video.status='ready';video.analysis_source='local_yolox_bytetrack';video.processed_at=utcnow()
            video.analysis_metrics=metrics;video.description_status='processing';session.commit()
        publish_refresh('analysis',video_id)
        description_started=time.perf_counter()
        descriptions=[];description_error=None
        try:
            if os.environ.get('JAGAAI_ENABLE_VLM','1')!='1':
                raise RuntimeError('Local VLM description is disabled by configuration.')
            from .local_ai import describe,embed
            for second,jpeg,name,evidence in samples:
                result=describe(jpeg)
                text=result['text']+(' Visibility: '+result['limitations'] if result['limitations'] else '')
                descriptions.append({'start_sec':max(0.,round(second-1,3)),'end_sec':min(duration,round(second+1,3)),
                                     'text':text,'model':result['model'],
                                     'attributes':{**result.get('attributes',{}),'observed_at_sec':round(second,3),
                                                   'keyframe':name,'sampling':'periodic_and_activity_change',
                                                   'person_evidence':evidence}})
                with session_scope() as progress_session:
                    progress=progress_session.get(Video,video_id)
                    if progress and utc(progress.expires_at)>utcnow():
                        progress.analysis_metrics={**metrics,'description_frames_completed':len(descriptions)}
                        progress_session.commit()
                publish_refresh('analysis',video_id)
            vectors,vector_model=embed([d['text'] for d in descriptions])
            for item,vector in zip(descriptions,vectors):
                item['vector']=vector;item['vector_model']=vector_model
        except Exception as error:
            description_error=str(error)[:500]
        with session_scope() as session:
            video=session.get(Video,video_id)
            if not video:
                return
            if utc(video.expires_at)<=utcnow():
                raise RuntimeError('Recording expired during semantic analysis; descriptions were not saved.')
            if not description_error:
                session.exec(delete(Description).where(Description.video_id==video_id))
                for item in descriptions:
                    session.add(Description(video_id=video_id,analysis_source='local_realtime',**item))
                video.description_status='partial' if sample_budget_exceeded else 'ready'
            else:
                video.description_status='failed'
            video.analysis_metrics={**metrics,'description_frames':len(descriptions),'description_error':description_error,
                                    'description_frames_completed':len(descriptions),
                                    'semantic_wall_sec':round(time.perf_counter()-description_started,3),
                                    'total_wall_sec':round(time.perf_counter()-started,3)}
            session.commit()
        publish_refresh('analysis',video_id)
    except Exception as error:
        with session_scope() as session:
            video=session.get(Video,video_id)
            if video:
                video.status='failed';video.error=str(error)[:500];session.commit()
        publish_refresh('analysis',video_id)
        raise
