"""Three-language rule parsing and thresholded local semantic retrieval."""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import re
import numpy as np
from sqlmodel import select

from .models import AppSettings, Camera, Description, Event, Location, Video
from .retrieval import constraints, missing_attributes, multilingual_attribute_query
from .person_evidence import person_evidence_status

KL = ZoneInfo('Asia/Kuala_Lumpur')


def utc(value):
    if isinstance(value,str):
        value=datetime.fromisoformat(value.replace('Z','+00:00'))
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def parse_query(query, locations, now=None):
    text=query.casefold()
    compact=re.sub(r'\s+','',text)
    current=(now or datetime.now(timezone.utc)).astimezone(KL)
    start=end=None
    if any(t in compact for t in ['昨晚','lastnight','malamtadi']):
        start=(current-timedelta(days=1)).replace(hour=18,minute=0,second=0,microsecond=0)
        end=current.replace(hour=6,minute=0,second=0,microsecond=0)
    elif any(t in compact for t in ['今晚','tonight','malamini']):
        start=current.replace(hour=18,minute=0,second=0,microsecond=0)
        end=(current+timedelta(days=1)).replace(hour=6,minute=0,second=0,microsecond=0)
    elif any(t in compact for t in ['今早','thismorning','pagitadi']):
        start=current.replace(hour=0,minute=0,second=0,microsecond=0)
        end=current.replace(hour=12,minute=0,second=0,microsecond=0)
    elif any(t in compact for t in ['昨天','yesterday','semalam']):
        end=current.replace(hour=0,minute=0,second=0,microsecond=0)
        start=end-timedelta(days=1)
    elif any(t in compact for t in ['今天','today','hariini']):
        start=current.replace(hour=0,minute=0,second=0,microsecond=0)
        end=start+timedelta(days=1)
    unsupported=any(t in compact for t in ['fight','fighting','打架','bergaduh','pergaduhan','fall','fallen','jatuh','跌倒','倒地','偷窃','盗窃','theft','stealing','mencuri'])
    behaviour='vehicle_loitering' if any(t in compact for t in ['loiter','逗留','逐车','berkeliaran','berlegar']) else 'restricted_entry' if any(t in compact for t in ['fence','越线','翻越','限制区','禁区','pagar','restricted','kawasanlarangan']) else 'all' if any(t in compact for t in ['可疑','suspicious','mencurigakan','行为','behaviour']) else None
    appearance=[name for name,words in [('red',['red','红','merah']),('white',['white','白','putih']),('blue',['blue','蓝','biru']),('black',['black','黑','hitam'])] if any(w in text for w in words)]
    location_id=None
    candidates=[]
    for location in locations:
        get=lambda k: location.get(k) if isinstance(location,dict) else getattr(location,k)
        for alias in [get('name'),*(get('aliases') or [])]:
            normal=re.sub(r'\s+','',alias.casefold())
            if normal and normal in compact:
                candidates.append((len(normal),get('id')))
    if candidates:
        location_id=max(candidates)[1]
    return {'supported':not unsupported,'location_id':location_id,'time_from':start.astimezone(timezone.utc).isoformat() if start else None,
            'time_to':end.astimezone(timezone.utc).isoformat() if end else None,'behaviour':behaviour,
            'appearance':appearance,'combined':bool(behaviour and appearance)}


def scoped_videos(session,parsed,start,end):
    cameras={c.id:c for c in session.exec(select(Camera)).all()}
    videos=[]
    for video in session.exec(select(Video)).all():
        if utc(video.expires_at)<=datetime.now(timezone.utc):
            continue
        camera=cameras.get(video.camera_id)
        if parsed['location_id'] and (not camera or camera.location_id!=parsed['location_id']):
            continue
        recorded=utc(video.recorded_at)
        if start and recorded+timedelta(seconds=video.duration_sec)<start:
            continue
        if end and recorded>end:
            continue
        videos.append(video)
    return videos


def coverage(session,videos,behaviour,digest=None,require_people=False):
    rows=[d for d in session.exec(select(Description)).all()
          if d.vector and (digest is None or d.vector_model==digest)]
    indexed={d.video_id for d in rows}
    if require_people:
        # Checked empty frames count as analysed; legacy or mismatched frames don't.
        indexed-={d.video_id for d in rows if person_evidence_status(d.attributes) is None}
    analysed=sum(v.status=='ready' and (bool(behaviour) or (v.description_status=='ready' and v.id in indexed)) for v in videos)
    return {'analysed':analysed,'total':len(videos),'pending':len(videos)-analysed}


def scoped_descriptions(session,indexed,start,end):
    descriptions=[]
    for row in session.exec(select(Description)).all():
        video=indexed.get(row.video_id)
        if not video or video.status!='ready' or video.description_status not in {'ready','partial'} or not row.vector:
            continue
        a=utc(video.recorded_at)+timedelta(seconds=row.start_sec)
        b=utc(video.recorded_at)+timedelta(seconds=row.end_sec)
        if (start and b<start) or (end and a>end):
            continue
        descriptions.append(row)
    return descriptions


def search(session,payload):
    query=str(payload.get('query','')).strip()
    parsed=parse_query(query,session.exec(select(Location)).all())
    for key in ('location_id','time_from','time_to'):
        if key in payload:
            parsed[key]=payload[key]
    start=utc(parsed['time_from']) if parsed['time_from'] else None
    end=utc(parsed['time_to']) if parsed['time_to'] else None
    videos=scoped_videos(session,parsed,start,end)
    behaviour=parsed['behaviour']
    settings=session.get(AppSettings,'global')
    threshold=settings.search_threshold if settings else .65
    result={'supported':parsed['supported'],'message':'','interpreted':{k:v for k,v in parsed.items() if k not in ('supported','combined')},
            'events':[],'related':[],'nearest':[],'coverage':coverage(session,videos,behaviour),'threshold':threshold}
    if not parsed['supported']:
        result['message']='This behaviour is not supported. M1 supports vehicle loitering and restricted entry, not fighting, falls or theft intent.'
        return result
    if parsed['combined']:
        result['supported']=False
        result['message']='Combined behaviour and appearance filters are planned for M2. Search for a behaviour or appearance separately.'
        return result
    indexed={v.id:v for v in videos}
    if behaviour:
        for event in session.exec(select(Event)).all():
            if event.verification.get('superseded'):
                continue
            video=indexed.get(event.video_id)
            if not video or video.status!='ready' or (behaviour!='all' and event.type!=behaviour):
                continue
            a=utc(video.recorded_at)+timedelta(seconds=event.start_sec)
            b=utc(video.recorded_at)+timedelta(seconds=event.end_sec)
            if (start and b<start) or (end and a>end):
                continue
            from .serializers import record_json
            result['events'].append(record_json(event))
        result['events'].sort(key=lambda e:(e['created_at'],e['start_sec']),reverse=True)
        result['message']='Behaviour events need human review.' if result['events'] else 'No supported behaviour events found in the analysed coverage.'
        return result
    descriptions=scoped_descriptions(session,indexed,start,end)
    if not descriptions:
        scope=result['coverage']
        if not scope['total']:
            result['message']='Nothing was searched: no recordings fall inside the interpreted time and place. Edit the conditions or upload footage for that period.'
        else:
            result['message']=(f"No clear match, but only {scope['analysed']} of {scope['total']} recordings in range have finished semantic analysis. "
                               'Retry failed analysis from Cameras, or wait for it to finish.')
        return result
    try:
        from .local_ai import embed
        requested=constraints(query)
        expanded=multilingual_attribute_query(query,requested)
        vectors,digest=embed([query,expanded] if expanded and expanded!=query else [query])
        queries=[np.asarray(v,dtype=float) for v in vectors]
        if any(not np.isfinite(q).all() or np.linalg.norm(q)==0 for q in queries):
            raise ValueError('Invalid query embedding')
        # This read-only operation may wait for a model. End its old SQLite snapshot
        # and recheck expiry, state and source data after inference, before disclosure.
        session.rollback()
        videos=scoped_videos(session,parsed,start,end)
        indexed={v.id:v for v in videos}
        descriptions=scoped_descriptions(session,indexed,start,end)
        require_people='person' in requested['objects']
        result['coverage']=coverage(session,videos,behaviour,digest,require_people)
        ranked=[]
        for row in descriptions:
            if row.vector_model!=digest or len(row.vector)!=len(queries[0]):
                continue
            person_supported=person_evidence_status(row.attributes)
            # Similarity and a fluent caption cannot establish that a person exists.
            # Exclude these frames from BOTH matches and manual-review suggestions.
            if require_people and person_supported is not True:
                continue
            v=np.asarray(row.vector,dtype=float)
            if not np.linalg.norm(v) or not np.isfinite(v).all():
                continue
            score=max(float(np.clip(np.dot(v,q)/(np.linalg.norm(v)*np.linalg.norm(q)),-1,1)) for q in queries)
            video=indexed[row.video_id]
            missing=missing_attributes(row.text,row.attributes,requested)
            if person_supported is True and 'visible object: person' in missing:
                missing.remove('visible object: person')
            ranked.append({'video_id':row.video_id,'camera_id':video.camera_id,'start_sec':row.start_sec,
                           'end_sec':row.end_sec,'text':row.text,'score':round(score,4),'model':row.model,
                           'analysis_source':row.analysis_source,'unmet_conditions':missing,
                           'keyframe_url':f'/api/videos/{row.video_id}/keyframes/{row.attributes["keyframe"]}' if row.attributes.get('keyframe') else None,
                           'observed_at_sec':row.attributes.get('observed_at_sec',row.start_sec),
                           'person_supported':person_supported})
        ranked.sort(key=lambda r:r['score'],reverse=True)
        result['related']=[r for r in ranked if r['score']>=threshold and not r['unmet_conditions']][:20]
        result['nearest']=[r for r in ranked if r['score']<threshold or r['unmet_conditions']][:3]
        result['interpreted']['visible_conditions']=requested
        result['interpreted']['attribute_search_phrase']=expanded
        result['message']='Matches are leads for human review, not proof.' if result['related'] else 'No clear match above the configured threshold. Closest clips are for human review only.'
        if require_people:
            result['message']+=' Person searches only show sampled frames supported by detection and a crop recheck.'
            if result['coverage']['pending']:
                result['message']+=' Some recordings need analysis or renewed person checks; reanalyse them from Cameras.'
    except (Exception,) as error:
        result['message']='Local semantic search is unavailable. '+str(error)[:180]
        result['coverage']['pending']=len(videos)
        result['coverage']['analysed']=0
    return result
