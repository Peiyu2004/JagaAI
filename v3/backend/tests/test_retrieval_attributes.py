from datetime import timedelta

import numpy as np
from sqlmodel import SQLModel, Session, create_engine

from app import local_ai
from app.models import AppSettings, Camera, Description, Location, Video, utcnow
from app.retrieval import constraints, missing_attributes, multilingual_attribute_query
from app.search import search
from app.vision import Tracker, check_person_crop


def checked_people(second=11., boxes=None):
    return {'observed_at_sec': second, 'keyframe': 'sample.jpg',
            'person_evidence': {'version': 1, 'method': 'frame_and_person_crop',
                                'observed_at_sec': second, 'keyframe': 'sample.jpg',
                                'boxes': boxes if boxes is not None else [
                                    {'box': [.1,.1,.2,.8], 'score': .8, 'crop_score': .9}]}}


def test_colour_binding_does_not_swap_shirt_and_vehicle():
    request=constraints('穿红衣服的人靠近白色汽车')
    assert request['person_colours']==['red']
    assert request['vehicle_colours']==['white']
    wrong={'people':[{'clothing_color':'white'}],'vehicles':[{'color':'red','type':'car'}]}
    assert len(missing_attributes('Both colours are present.',wrong,request))==2
    correct={'people':[{'clothing_color':'red'}],'vehicles':[{'color':'white','type':'car'}]}
    assert missing_attributes('Person beside car.',correct,request)==[]


def test_malay_and_english_bind_the_same_visible_attributes():
    english=constraints('person wearing red beside a white car')
    malay=constraints('lelaki baju merah dekat kereta putih')
    assert english['person_colours']==malay['person_colours']==['red']
    assert english['vehicle_colours']==malay['vehicle_colours']==['white']


def test_chinese_and_malay_share_the_same_colour_retrieval_phrase():
    for query in ('穿红衣服的人靠近白色汽车','orang berbaju merah dekat kereta putih'):
        assert multilingual_attribute_query(query,constraints(query))=='person wearing red near a white car'
    query='person wearing red near a white car'
    assert multilingual_attribute_query(query,constraints(query)) is None
    assert multilingual_attribute_query('有没有大象',constraints('有没有大象')) is None


def test_empty_structured_people_are_authoritative_even_if_caption_mentions_people():
    request=constraints('person wearing red')
    missing=missing_attributes('No people visible, only a red car.',{'people':[],'vehicles':[{'color':'red','type':'car'}]},request)
    assert 'person clothing: red' in missing and 'visible object: person' in missing


def test_person_colour_unknown_does_not_satisfy_a_specific_colour():
    assert missing_attributes('A distant person.',{'people':[{'clothing_color':'unknown'}],'vehicles':[]},constraints('red shirt'))


def test_similar_description_of_cars_cannot_match_an_elephant_query():
    assert missing_attributes('Cars parked in a row.',{'people':[],'vehicles':[{'color':'white','type':'car'}]},constraints('昨晚有大象吗'))==['visible object: elephant']


def test_partial_index_is_searchable_but_wrong_attributes_are_not_matches(tmp_path,monkeypatch):
    engine=create_engine('sqlite:///'+str(tmp_path/'index.sqlite'))
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(local_ai,'embed',lambda _texts:([[1.,0.]],'test-digest'))
    with Session(engine) as s:
        s.add(Location(id='loc',name='Parking'));s.flush()
        s.add(Camera(id='cam',name='Test',location_id='loc'));s.flush()
        s.add(Video(id='video',camera_id='cam',path='unused',filename='test.mp4',recorded_at=utcnow(),duration_sec=30,
                    expires_at=utcnow()+timedelta(days=1),status='ready',description_status='partial'))
        s.add(AppSettings());s.flush()
        s.add(Description(video_id='video',start_sec=10,end_sec=12,text='A person next to a car.',model='test',vector=[1.,0.],vector_model='test-digest',
                          attributes={**checked_people(),'people':[{'clothing_color':'blue'}],'vehicles':[{'color':'white','type':'car'}]}));s.commit()
        result=search(s,{'query':'person wearing red beside white car'})
        assert result['related']==[]
        assert result['nearest'][0]['unmet_conditions']==['person clothing: red']
        result=search(s,{'query':'person wearing blue beside white car'})
        assert len(result['related'])==1
        assert result['coverage']=={'analysed':0,'total':1,'pending':1}
    engine.dispose()


def test_person_queries_exclude_phantom_and_unverified_frames_even_from_nearest(tmp_path,monkeypatch):
    engine=create_engine('sqlite:///'+str(tmp_path/'people.sqlite'))
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(local_ai,'embed',lambda _texts:([[1.,0.]],'test-digest'))
    with Session(engine) as s:
        s.add(Location(id='loc',name='Parking'));s.flush()
        s.add(Camera(id='cam',name='Test',location_id='loc'));s.flush()
        s.add(AppSettings())
        for name, evidence in [('real',checked_people()),('phantom',checked_people(boxes=[])),('legacy',{})]:
            s.add(Video(id=name,camera_id='cam',path='unused',filename=name+'.mp4',recorded_at=utcnow(),duration_sec=30,
                        expires_at=utcnow()+timedelta(days=1),status='ready',description_status='ready'));s.flush()
            s.add(Description(video_id=name,start_sec=10,end_sec=12,text='A person in red beside a white SUV.',
                              model='test',vector=[1.,0.],vector_model='test-digest',
                              attributes={**evidence,'people':[{'clothing_color':'red'}],
                                          'vehicles':[{'color':'white','type':'car'}]}))
        s.commit()
        for query in ['a person wearing a red jacket beside a white SUV', '穿红衣的人在白车旁边',
                      'orang berbaju merah dekat kereta putih', 'someone near a car', 'a pedestrian', 'red clothing']:
            result=search(s,{'query':query})
            assert [r['video_id'] for r in result['related']]==['real']
            assert result['nearest']==[]
            assert result['coverage']=={'analysed':2,'total':3,'pending':1}
        # Person evidence must not turn a vehicle-only query into a person query.
        assert len(search(s,{'query':'a white car'})['related'])==3
    engine.dispose()


def test_evidence_is_bound_to_the_sample_and_checked_boxes():
    from copy import deepcopy
    from app.person_evidence import person_evidence_status
    good=checked_people()
    assert person_evidence_status(good) is True
    assert person_evidence_status(checked_people(boxes=[])) is False
    for change in ('time','keyframe','score','box'):
        bad=deepcopy(good)
        if change=='time': bad['observed_at_sec']=90.
        elif change=='keyframe': bad['keyframe']='another-frame.jpg'
        elif change=='score': bad['person_evidence']['boxes'][0]['crop_score']=.1
        else: bad['person_evidence']['boxes'][0]['box']=[.5,.5,.1,.1]
        assert person_evidence_status(bad) is None


def test_frame_check_cannot_accept_a_raw_machine_person_box_without_crop_support():
    from app.person_evidence import check_frame_people,person_evidence_status
    class Machine:
        provider='test-provider'
        def detect(self,_frame):
            return np.array([[2,2,40,60,.9,7]],dtype=np.float32)
    evidence=check_frame_people(np.zeros((100,100,3),np.uint8),
                                np.array([[20,10,60,80,.95,0]]),Machine(),90.,'sample.jpg')
    facts={**checked_people(90.),'person_evidence':evidence}
    assert evidence['rejected_candidates']==1
    assert person_evidence_status(facts) is False


def test_crop_recheck_rejects_a_machine_without_a_person():
    class Machine:
        def detect(self,_frame):
            return np.array([[2,2,40,60,.9,7]],dtype=np.float32)
    assert not check_person_crop(np.zeros((100,100,3),dtype=np.uint8),[.2,.1,.6,.8],Machine())['passed']


def test_tracker_never_reuses_a_vehicle_track_as_a_person():
    tracker=Tracker(5)
    car=np.array([[20,20,60,80,.95,2]],dtype=np.float32)
    person=np.array([[20,20,60,80,.95,0]],dtype=np.float32)
    first=tracker.update(car,100,100)
    tracker.update(car,100,100)
    second=tracker.update(person,100,100)
    if not second:
        second=tracker.update(person,100,100)
    assert first and second
    assert first[0]['id']!=second[0]['id']
def test_boundary_focus_recovers_a_small_person_without_losing_scene_context():
    from app.vision import detect_frame
    import numpy as np
    class Model:
        last_ms=1.
        calls=0
        def detect(self,frame):
            self.calls+=1
            if self.calls==1:
                return np.array([[5,5,30,30,.8,2]],dtype=np.float32)
            # Person coordinates in the enlarged boundary crop, not the whole frame.
            return np.array([[10,10,25,40,.7,0]],dtype=np.float32)
    model=Model()
    result=detect_frame(np.zeros((200,400,3),np.uint8),model,{'R3':{'enabled':True,'line':[[.5,.4],[.5,.8]]}})
    assert model.calls==2
    assert {int(row[5]) for row in result}=={0,2}
    person=next(row for row in result if row[5]==0)
    assert np.allclose(person[:4],[130,60,145,90])

