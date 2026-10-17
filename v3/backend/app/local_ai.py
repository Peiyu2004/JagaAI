"""Loopback-only Ollama helpers. Network failures never become fabricated descriptions."""
import base64
import json
import os
from urllib.parse import urlparse
from numbers import Real
import httpx
import numpy as np

OLLAMA = os.environ.get('JAGAAI_OLLAMA_URL','http://127.0.0.1:11435').rstrip('/')
if urlparse(OLLAMA).hostname not in {'127.0.0.1','localhost','::1'}:
    raise RuntimeError('Only a loopback Ollama endpoint is allowed.')
VLM = 'qwen3-vl:2b-instruct'
EMBED = 'qwen3-embedding:0.6b'


def _request(method,path,**kwargs):
    # A local-only application must not inherit HTTP(S)_PROXY or follow a redirect.
    with httpx.Client(trust_env=False,follow_redirects=False) as client:
        return client.request(method,OLLAMA+path,**kwargs)


def model_digest(name):
    response = _request('GET','/api/tags',timeout=10)
    response.raise_for_status()
    models = response.json().get('models',[])
    match = next((m for m in models if m.get('name')==name),None)
    if not match:
        raise RuntimeError(f'Local model {name} is not installed.')
    if any(match.get(k) or match.get('details',{}).get(k) for k in ('remote_model','remote_host')):
        raise RuntimeError('Cloud or remote model aliases are not allowed.')
    if not isinstance(match.get('digest'),str) or not match['digest']:
        raise RuntimeError('The local model digest is missing.')
    return name+'@'+match['digest']


def embed(texts):
    digest = model_digest(EMBED)
    response = _request('POST','/api/embed',json={'model':EMBED,'input':texts,'keep_alive':'15m','truncate':False},timeout=180)
    response.raise_for_status()
    vectors = response.json().get('embeddings',[])
    if len(vectors)!=len(texts) or any(not v for v in vectors):
        raise RuntimeError('Local embedding returned an incomplete result.')
    try:
        if any(not isinstance(value,Real) or isinstance(value,bool) for row in vectors for value in row):
            raise ValueError('non-numeric vector values')
        matrix=np.asarray(vectors,dtype=float)
        norms=np.linalg.norm(matrix,axis=1)
        if matrix.ndim!=2 or not matrix.shape[1] or not np.isfinite(matrix).all() or not np.isfinite(norms).all() or np.any(norms==0):
            raise ValueError('invalid vectors')
    except (ValueError,TypeError,IndexError) as error:
        raise RuntimeError('Local embedding returned invalid, inconsistent or zero vectors.') from error
    if model_digest(EMBED)!=digest:
        raise RuntimeError('The embedding model changed during indexing. Retry analysis.')
    return matrix.tolist(),digest


def describe(jpeg_bytes):
    digest=model_digest(VLM)
    colour={'type':'string','enum':['red','pink','orange','yellow','green','blue','purple','white','black','grey','brown','unknown']}
    person={'type':'object','properties':{'clothing_color':colour},'required':['clothing_color'],'additionalProperties':False}
    vehicle={'type':'object','properties':{'color':colour,'type':{'type':'string','enum':['car','truck','bus','motorcycle','bicycle','unknown']}},
             'required':['color','type'],'additionalProperties':False}
    schema={'type':'object','properties':{'description':{'type':'string'},'objects':{'type':'array','items':{'type':'string'}},
             'people':{'type':'array','items':person,'maxItems':6},'vehicles':{'type':'array','items':vehicle,'maxItems':6},
             'limitations':{'type':'string'}},'required':['description','objects','people','vehicles','limitations'],'additionalProperties':False}
    schema['properties']['objects']['maxItems']=10
    schema['properties']['objects']['items']['maxLength']=40
    schema['properties']['description']['maxLength']=600
    schema['properties']['limitations']['maxLength']=160
    prompt=('Describe this surveillance frame in at most 50 words. List only people and vehicles actually visible. '
            'Record distinct visible upper-clothing colours in people and distinct vehicle type/colour combinations in vehicles. '
            'List each combination once, at most six; prioritise foreground subjects. Do not count every parked car or repeat entries. '
            'Use unknown for small, occluded or uncertain objects. Empty arrays mean none observed. '
            'Mention visible spatial relationships, not movements between frames. '
            'Do not infer identity, intent, ownership, crime or a vehicle brand. Return compact English JSON without indentation. '
            'Limitations describes only visibility (blur, size, occlusion) in under 15 words, or empty. Do not restate these instructions.')
    for attempt in range(2):
        response=_request('POST','/api/generate',json={'model':VLM,
            'prompt':prompt+(' Shorten the description to one sentence and list only the three most prominent objects.' if attempt else ''),
            'images':[base64.b64encode(jpeg_bytes).decode()],'format':schema,'stream':False,
            'think':False,'keep_alive':'2m','options':{'temperature':0,'num_predict':1024 if not attempt else 1536,'num_ctx':4096}},timeout=240)
        response.raise_for_status()
        body=response.json()
        try:
            content=json.loads(body.get('response',''))
            break
        except (ValueError,TypeError) as error:
            if attempt:
                raise RuntimeError('Local VLM output was incomplete after one retry. Retry recording analysis.') from error
    text=content.get('description')
    if not isinstance(text,str) or not text.strip() or len(text)>5000:
        raise RuntimeError('Local VLM did not return a valid visible-scene description.')
    if not isinstance(content.get('objects'),list) or any(not isinstance(v,str) for v in content['objects']) or not isinstance(content.get('limitations'),str):
        raise RuntimeError('Local VLM returned invalid structured scene data.')
    colours=set(colour['enum'])
    people,vehicles=content.get('people'),content.get('vehicles')
    if (not isinstance(people,list) or len(people)>12 or not isinstance(vehicles,list) or len(vehicles)>16
        or any(not isinstance(p,dict) or p.get('clothing_color') not in colours for p in people)
        or any(not isinstance(v,dict) or v.get('color') not in colours or v.get('type') not in vehicle['properties']['type']['enum'] for v in vehicles)):
        raise RuntimeError('Local VLM returned invalid visible-object attributes.')
    if model_digest(VLM)!=digest:
        raise RuntimeError('The VLM changed during description. Retry analysis.')
    return {'text':text.strip(),'limitations':str(content.get('limitations',''))[:1000],
            'objects':[str(v) for v in content.get('objects',[])][:40],'model':VLM,
            'attributes':{'schema_version':2,'people':[dict(clothing_color=c) for c in dict.fromkeys(p['clothing_color'] for p in people)],
                          'vehicles':[dict(color=c,type=t) for c,t in dict.fromkeys((v['color'],v['type']) for v in vehicles)],'objects':content['objects'][:40],
                          'model_digest':digest,'sampled_frame_only':True,'generation_attempts':attempt+1}}
