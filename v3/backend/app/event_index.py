"""Reconcile a recording retry without duplicating or reviving obsolete alerts."""
from datetime import timedelta
from uuid import NAMESPACE_URL, uuid5
from sqlmodel import select
from .models import Alert, Event, Video
from .search import utc


def save_events(session, video_id, camera_id, recorded_at, generated):
    previous=session.exec(select(Event).where(Event.camera_id==camera_id)).all()
    own=[e for e in previous if e.video_id==video_id]
    retained=set()
    for candidate in generated:
        moment=recorded_at+timedelta(seconds=candidate['end_sec'])
        duplicate=False
        for old in previous:
            if old.video_id==video_id or old.rule_id!=candidate['rule_id'] or old.verification.get('superseded'):
                continue
            other=session.get(Video,old.video_id)
            if other and abs((moment-(utc(other.recorded_at)+timedelta(seconds=old.end_sec))).total_seconds())<600:
                duplicate=True
                break
        if duplicate:
            continue
        match=next((e for e in own if e.id not in retained and e.rule_id==candidate['rule_id']
                    and abs(e.end_sec-candidate['end_sec'])<=5),None)
        if match:
            was_superseded=match.verification.get('superseded')
            for key,value in candidate.items():
                setattr(match,key,value)
            match.verification={**match.verification,'superseded':False}
            if was_superseded:
                for alert in session.exec(select(Alert).where(Alert.event_id==match.id)).all():
                    if alert.status=='dismissed' and (alert.dismiss_reason or '').startswith('Automatically closed:'):
                        alert.status='pending'
                        alert.dismiss_reason=None
            retained.add(match.id)
        else:
            ident=str(uuid5(NAMESPACE_URL,f"{video_id}:{candidate['rule_id']}:{candidate['metrics']['track_id']}:{candidate['end_sec']}"))
            event=Event(id=ident,video_id=video_id,camera_id=camera_id,
                verification={'status':'not_reviewed','method':'tracking_rule',
                              'note':'Tracking rule only; review the original video. Frame descriptions do not verify behaviour.'},**candidate)
            session.add(event)
            session.flush()
            alert=Alert(event_id=event.id,priority='high' if event.rule_id=='R1' else 'normal')
            session.add(alert)
            session.flush()
            from .notifications import enqueue_alert
            enqueue_alert(session,alert)
            retained.add(event.id)
    for old in own:
        if old.id in retained:
            continue
        old.verification={**old.verification,'superseded':True,'note':'Not reproduced by the latest recording analysis; previous review retained.'}
        for alert in session.exec(select(Alert).where(Alert.event_id==old.id)).all():
            if alert.status=='pending':
                alert.status='dismissed'
                alert.dismiss_reason='Automatically closed: event not reproduced by the latest analysis.'
                from .notifications import cancel_alert
                cancel_alert(session,alert.id,alert.dismiss_reason)
