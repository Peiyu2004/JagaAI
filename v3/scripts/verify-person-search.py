"""Live paraphrase regression, including high-similarity empty-frame counterexamples."""
import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import statistics
import time

import httpx

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--rounds', type=int, default=3)
parser.add_argument('--report', type=Path, default=ROOT/'output/ai-readiness/person-search-evaluation.json')
args = parser.parse_args()
positive = [
    ('red-original-en', 'person wearing red near a white car', 'demo-parking-people'),
    ('red-failed-variant', 'a person wearing a red jacket beside a white SUV', 'demo-parking-people'),
    ('red-someone', 'show me someone in a red jacket near a white car', 'demo-parking-people'),
    ('red-clothing', 'find people in red clothing beside a white vehicle', 'demo-parking-people'),
    ('red-original-zh', '穿红衣服的人靠近白色汽车', 'demo-parking-people'),
    ('red-coat-zh', '穿红色外套的人在白色车旁边', 'demo-parking-people'),
    ('red-find-zh', '找穿红衣的人和白色汽车', 'demo-parking-people'),
    ('red-orang', 'orang berbaju merah dekat kereta putih', 'demo-parking-people'),
    ('red-lelaki', 'lelaki baju merah dekat kereta putih', 'demo-parking-people'),
    ('black-zh', '穿黑色衣服的人在楼梯旁边', None),
    ('black-en', 'person wearing black near stairs', None),
    ('black-someone', 'someone in a black jacket near the stairs', None),
    ('black-ms', 'orang berbaju hitam dekat tangga', None),
]
negative = [
    ('purple-zh', '穿紫色衣服的人'),
    ('purple-en', 'a person wearing purple beside a white car'),
    ('purple-ms', 'orang berbaju ungu dekat kereta putih'),
    ('elephant-zh', '有没有大象'),
    ('elephant-en', 'an elephant in the parking lot'),
]

with httpx.Client(base_url='http://127.0.0.1:8766', trust_env=False, timeout=240) as client:
    client.post('/api/auth/login', json={'email':'admin@jagaai.local','password':'JagaAI-demo-2026!'}).raise_for_status()
    bootstrap = client.get('/api/bootstrap').json()
    videos = {v['id']:v for v in bootstrap['videos']}
    assert len(videos)==7 and all(k.startswith('demo-') for k in videos), 'Use the isolated --demo profile.'
    cases = [(ident, {'query':query}, 'positive', expected) for ident,query,expected in positive]
    cases += [(ident, {'query':query}, 'negative', None) for ident,query in negative]
    for video_id, start, end in [('demo-stairs-empty',3,8), ('demo-parking-machine',88,92)]:
        recorded = datetime.fromisoformat(videos[video_id]['recorded_at'].replace('Z','+00:00'))
        for query in ['a person', 'someone in red clothing', '有人吗', 'ada orang']:
            cases.append((video_id+'-'+query, {'query':query,'time_from':(recorded+timedelta(seconds=start)).isoformat(),
                                            'time_to':(recorded+timedelta(seconds=end)).isoformat()}, 'empty', None))
    cases += [('behaviour-en',{'query':'Show restricted entry events'},'event',None),
              ('behaviour-zh',{'query':'有没有人进入限制区域'},'event',None),
              ('behaviour-ms',{'query':'orang masuk kawasan larangan'},'event',None),
              ('unsupported',{'query':'有没有人打架'},'unsupported',None)]
    report = {'checked_at':datetime.now(timezone.utc).isoformat(), 'rounds':args.rounds,
              'threshold':bootstrap['settings']['search_threshold'], 'queries':[], 'media':[]}
    for repeat in range(args.rounds):
        # Reverse alternate rounds to check that answers don't depend on the prior question.
        for ident,payload,kind,expected in (cases if repeat%2==0 else list(reversed(cases))):
            started=time.perf_counter()
            response=client.post('/api/search',json=payload);response.raise_for_status();result=response.json()
            shown=result['related']+result['nearest']
            if kind=='positive':
                allowed={expected} if expected else {'demo-stairs-entry','demo-landing-entry'}
                passed=bool(result['related']) and all(r['video_id'] in allowed for r in result['related'])
            elif kind in {'negative','empty'}:
                passed=not result['related'] and not result['events']
                if kind=='empty':
                    passed=passed and not result['nearest'] and result['coverage']=={'analysed':1,'total':1,'pending':0}
            elif kind=='event':
                passed=len(result['events'])==3
            else:
                passed=result['supported'] is False
            requested=result['interpreted'].get('visible_conditions',{})
            if 'person' in requested.get('objects',[]):
                passed=passed and all(r.get('person_supported') is True for r in shown)
                passed=passed and not any(r['video_id']=='demo-parking-machine' and r['observed_at_sec']==90 for r in shown)
            report['queries'].append({'round':repeat+1,'id':ident,'payload':payload,'kind':kind,'passed':passed,
                                      'seconds':round(time.perf_counter()-started,3),'result':result})
            print(json.dumps({'round':repeat+1,'id':ident,'passed':passed,'matches':[(r['video_id'],r['observed_at_sec'],r['score']) for r in result['related']],
                              'coverage':result['coverage']}),flush=True)
    for video in videos:
        response=client.get('/api/videos/'+video+'/media',headers={'Range':'bytes=0-127'})
        report['media'].append({'video_id':video,'passed':response.status_code==206 and len(response.content)==128})
    report['all_passed']=all(q['passed'] for q in report['queries']) and all(m['passed'] for m in report['media'])
    report['median_seconds']=round(statistics.median(q['seconds'] for q in report['queries']),3)
    args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print('All passed:',report['all_passed'],';',len(report['queries']),'queries; median',report['median_seconds'],'seconds')
    if not report['all_passed']:
        raise SystemExit(1)
