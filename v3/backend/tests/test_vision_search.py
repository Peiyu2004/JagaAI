from datetime import datetime, timezone
import pytest
from app.vision import RuleEngine, active_at, crossed_segment
from app.search import parse_query

NIGHT=datetime(2026,10,15,12,tzinfo=timezone.utc)  # 20:00 MYT
FULL=[[0,0],[1,0],[1,1],[0,1]]


def person(ident='1',x=.5,y=.8):
    return {'id':ident,'class':'person','box':[x-.025,y-.15,x+.025,y]}


def r1(**options):
    return {'R1':{'enabled':True,'zone':FULL,'loiter_sec':120,'window_sec':300,
                  'min_vehicles':3,'min_dwell_sec':3,**options},'R3':{'enabled':False}}


def test_loiter_requires_measured_120_seconds_and_one_alert_per_track():
    engine=RuleEngine(r1(),NIGHT)
    found=[]
    for second in range(150):
        result=engine.update(second,[person()])
        if second<120:
            assert result==[]
        found.extend(result)
    assert len(found)==1
    assert found[0]['end_sec']==120
    assert found[0]['metrics']['dwell_sec']==120


def test_detection_gap_does_not_count_as_observed_loitering():
    engine=RuleEngine(r1(),NIGHT)
    for second in range(70):
        assert engine.update(second,[person()])==[]
    for second in range(90,180):
        assert engine.update(second,[person()])==[]


def test_leaving_parking_zone_resets_dwell():
    engine=RuleEngine(r1(zone=[[.1,.1],[.9,.1],[.9,.9],[.1,.9]]),NIGHT)
    for second in range(100):
        assert engine.update(second,[person()])==[]
    engine.update(100,[person(x=.99)])
    for second in range(101,200):
        assert engine.update(second,[person()])==[]


def test_three_different_cars_each_need_three_seconds():
    engine=RuleEngine(r1(loiter_sec=999),NIGHT)
    cars=[{'id':str(i+10),'class':'car','box':[x-.08,.65,x+.08,.9]} for i,x in enumerate([.2,.5,.8])]
    events=[]
    for second in range(12):
        result=engine.update(second,[person(x=[.2,.5,.8][second//4]),*cars])
        if second<11:
            assert not result
        events+=result
    assert len(events)==1
    assert events[0]['metrics']['distinct_vehicles']==3


def test_camera_rule_cooldown_and_track_dedup():
    engine=RuleEngine(r1(loiter_sec=1),NIGHT)
    engine.update(0,[person('1'),person('2')])
    assert len(engine.update(1,[person('1'),person('2')]))==1
    engine.update(700,[person('3')])
    assert len(engine.update(701,[person('3')]))==1
    assert not engine.update(702,[person('2')])


@pytest.mark.parametrize('utc_hour,expected',[(10,False),(11,True),(15,True),(19,True),(22,False)])
def test_active_hours_cross_midnight(utc_hour,expected):
    assert active_at(datetime(2026,10,15,utc_hour,tzinfo=timezone.utc)) is expected


def test_r3_finite_line_cross_and_restricted_entry():
    rules={'R3':{'enabled':True,'active_start':'19:00','active_end':'06:00',
                  'zone':[[.6,.1],[.9,.1],[.9,.9],[.6,.9]],'line':[[.6,.1],[.6,.9]]}}
    engine=RuleEngine(rules,NIGHT)
    assert not engine.update(0,[person(x=.5)])
    events=engine.update(1,[person(x=.7)])
    assert len(events)==1 and events[0]['rule_id']=='R3'
    assert events[0]['metrics']['crossed_line']
    assert not crossed_segment((.5,.99),(.7,.99),[[.6,.1],[.6,.9]])


def test_r3_initial_presence_is_not_evidence_of_crossing():
    engine=RuleEngine({'R3':{'enabled':True,'zone':FULL}},NIGHT)
    assert not engine.update(0,[person()])
    assert not engine.update(1,[person()])


LOCATIONS=[{'id':'parking','name':'Zone B Parking','aliases':['B区停车场','停车场','parking','tempat letak kereta']}]


@pytest.mark.parametrize('query,behaviour,appearance,supported',[
    ('昨晚有没有人有可疑行为','all',[],True),
    ('昨晚停车场有人逗留吗','vehicle_loitering',[],True),
    ('穿红衣服的人靠近白色汽车',None,['red','white'],True),
    ('lelaki baju merah dekat kereta',None,['red'],True),
    ('有没有人打架',None,[],False),
    ('有人倒地吗',None,[],False),
    ('orang jatuh',None,[],False),
    ('昨晚有大象吗',None,[],True),
])
def test_planned_search_cases(query,behaviour,appearance,supported):
    parsed=parse_query(query,LOCATIONS,NIGHT)
    assert parsed['supported'] is supported
    assert parsed['behaviour']==behaviour
    assert parsed['appearance']==appearance


def test_search_relative_time_is_utc_and_location_is_editable():
    parsed=parse_query('昨晚 B 区停车场有人逗留吗',LOCATIONS,NIGHT)
    assert parsed['time_from']=='2026-10-14T10:00:00+00:00'
    assert parsed['time_to']=='2026-10-14T22:00:00+00:00'
    assert parsed['location_id']=='parking'


def test_combined_appearance_and_behaviour_is_explicit_m2():
    assert parse_query('red person loitering',LOCATIONS,NIGHT)['combined']
