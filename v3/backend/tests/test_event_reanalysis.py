from datetime import timedelta
from sqlmodel import SQLModel, Session, create_engine, select
from app.event_index import save_events
from app.models import Alert, Camera, Event, Location, Video, utcnow


def test_retry_updates_same_event_and_retires_an_event_no_longer_detected(tmp_path):
    engine=create_engine('sqlite:///'+str(tmp_path/'retry.sqlite'))
    SQLModel.metadata.create_all(engine)
    now=utcnow()
    with Session(engine) as session:
        session.add(Location(id='l',name='Location'))
        session.add(Camera(id='c',name='Camera',location_id='l'))
        session.add(Video(id='v',camera_id='c',path='public-test.mp4',filename='public-test.mp4',
                          recorded_at=now,expires_at=now+timedelta(days=1)))
        session.commit()
        def candidate(track,second):
            return {'rule_id':'R3','type':'restricted_entry','start_sec':second-2,'end_sec':second,
                    'rule_version':'1.1','metrics':{'track_id':track},'keyframes':[]}
        save_events(session,'v','c',now,[candidate('original-track',10)])
        session.commit()
        first=session.exec(select(Event)).one()
        ident=first.id
        # Tracker IDs may change on a retry; this must not create a second alert.
        save_events(session,'v','c',now,[candidate('new-track',10.2)])
        session.commit()
        assert len(session.exec(select(Event)).all())==1
        assert len(session.exec(select(Alert)).all())==1
        assert session.get(Event,ident).metrics['track_id']=='new-track'
        save_events(session,'v','c',now,[])
        session.commit()
        assert session.get(Event,ident).verification['superseded'] is True
        assert session.exec(select(Alert)).one().status=='dismissed'
        save_events(session,'v','c',now,[candidate('restored-track',10.2)]);session.commit()
        assert session.exec(select(Alert)).one().status=='pending'
        # A reviewed alert is preserved as history when superseded, never reset to pending.
        alert=session.exec(select(Alert)).one();alert.status='converted';session.commit()
        save_events(session,'v','c',now,[]);session.commit()
        assert session.get(Alert,alert.id).status=='converted'
