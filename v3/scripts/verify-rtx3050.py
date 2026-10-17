"""Record actual ONNX node providers and warm latency on an existing public frame."""
import hashlib
import json
from pathlib import Path
import statistics
import sys
from collections import Counter
import cv2
import onnxruntime as ort
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backend'))
from app.vision import Detector,MODEL_PATH,runtime_status
directory=ROOT/'output/ai-readiness'
detector=Detector()
options=ort.SessionOptions()
options.intra_op_num_threads=4
options.enable_profiling=True
options.profile_file_prefix=str(directory/'ort-3050-s')
providers=detector.session.get_providers()
provider_options=[detector.session.get_provider_options()[p] for p in providers]
detector.session=ort.InferenceSession(str(MODEL_PATH),options,providers=providers,provider_options=provider_options)
detector.session.disable_fallback()
frame=cv2.imread(str(directory/'search-positive.jpg'))
timings=[]
for _ in range(12):
    detections=detector.detect(frame)
    timings.append(detector.last_ms)
profile=Path(detector.session.end_profiling())
nodes=Counter(r.get('args',{}).get('provider') for r in json.loads(profile.read_text())
              if r.get('cat')=='Node' and r.get('args',{}).get('provider'))
assert nodes.get('CUDAExecutionProvider') and not any(p!='CUDAExecutionProvider' for p in nodes)
report={'runtime':runtime_status(),'model_sha256':hashlib.file_digest(MODEL_PATH.open('rb'),'sha256').hexdigest(),
        'onnxruntime':ort.__version__,'node_execution_providers':dict(nodes),
        'warm_mean_inference_ms':statistics.mean(timings[1:]),'inference_ms':timings,
        'profile':str(profile),'detections':len(detections),
        'scope':'Repeated public frame; detector latency only, excluding decode/tracking/VLM. Not an accuracy measure.'}
(directory/'gpu-detection.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
(directory/'cuda-node-proof.json').write_text(json.dumps({'node_execution_providers':dict(nodes),'profile':str(profile)},indent=2),encoding='utf-8')
print(json.dumps({k:report[k] for k in ('runtime','node_execution_providers','warm_mean_inference_ms')},indent=2))
