"""Exercise live authenticated search and private playback against the prepared demo."""
import json
from pathlib import Path
import time
import httpx

ROOT=Path(__file__).resolve().parents[1]
# Both clips show a person in a red top and a white car in the same sampled frame;
# the kerb clip's car is parked further away, which attribute search cannot tell apart.
RED={'demo-parking-people','demo-kerb-waiting'}
cases=[
    ('restricted-en','Show restricted entry events','event',None),
    ('restricted-zh','有没有人进入限制区域','event',None),
    ('restricted-ms','orang masuk kawasan larangan','event',None),
    ('red-white-en','person wearing red near a white car','clip',RED),
    ('red-white-zh','穿红衣服的人靠近白色汽车','clip',RED),
    ('red-white-ms','orang berbaju merah dekat kereta putih','clip',RED),
    ('elephant','有没有大象','none',None),
    ('purple','穿紫色衣服的人','none',None),
    ('unsupported','有没有人打架','unsupported',None),
]
with httpx.Client(base_url='http://127.0.0.1:8766',trust_env=False,timeout=240) as client:
    client.post('/api/auth/login',json={'email':'admin@jagaai.local','password':'JagaAI-demo-2026!'}).raise_for_status()
    bootstrap=client.get('/api/bootstrap').json()
    assert bootstrap['videos'] and all(v['id'].startswith('demo-') for v in bootstrap['videos']), 'Use --demo, not the original workspace.'
    output={'threshold':bootstrap['settings']['search_threshold'],'queries':[],'media':[]}
    for ident,query,kind,video in cases:
        start=time.perf_counter()
        response=client.post('/api/search',json={'query':query});response.raise_for_status();result=response.json()
        passed=(len(result['events'])==3 if kind=='event' else
                bool(result['related']) and all(r['video_id'] in video and r.get('person_supported') is True for r in result['related']) if kind=='clip' else
                not result['related'] and not result['events'] if kind=='none' else result['supported'] is False)
        output['queries'].append({'id':ident,'query':query,'passed':passed,'seconds':round(time.perf_counter()-start,3),'result':result})
        print(json.dumps({'query':ident,'passed':passed,'events':len(result['events']),'clips':len(result['related']),
                          'best_scores':[r['score'] for r in result['related'][:3]],'nearest':[r['score'] for r in result['nearest']]}),flush=True)
    for video in bootstrap['videos']:
        response=client.get('/api/videos/'+video['id']+'/media',headers={'Range':'bytes=0-127'})
        passed=response.status_code==206 and len(response.content)==128
        output['media'].append({'video_id':video['id'],'range_playback':passed})
    output['all_passed']=all(q['passed'] for q in output['queries']) and all(m['range_playback'] for m in output['media'])
    (ROOT/'output/ai-readiness/search-evaluation.json').write_text(json.dumps(output,indent=2,ensure_ascii=False),encoding='utf-8')
    print('All passed:',output['all_passed'])
    if not output['all_passed']:
        raise SystemExit(1)
