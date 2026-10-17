"""Reproducible throughput smoke test on original synthetic input, not an accuracy test."""
from pathlib import Path
import json
import platform
import subprocess
import sys
import time
import cv2
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backend'))
from app.vision import Detector, Tracker, runtime_status

output=ROOT/'output/verification';output.mkdir(parents=True,exist_ok=True)
detector=Detector()
frame=np.full((360,640,3),(58,65,70),np.uint8)
for x in range(30,640,95):
    cv2.rectangle(frame,(x,70),(x+58,180),(200,205,190),2)
cv2.putText(frame,'SYNTHETIC PIPELINE TEST - NOT CCTV',(30,35),cv2.FONT_HERSHEY_SIMPLEX,.6,(230,230,230),1)
detector.detect(frame)
timings=[]
tracker=Tracker(5)
started=time.perf_counter()
for index in range(30):
    cv2.rectangle(frame,(70+index*4,200),(92+index*4,255),(50,90,170),-1)
    result=detector.detect(frame)
    timings.append(detector.last_ms)
    tracker.update(result,640,360)
wall=time.perf_counter()-started
frames=output/'synthetic-frames';frames.mkdir(exist_ok=True)
for index in range(25):
    f=frame.copy()
    cv2.rectangle(f,(100+index*6,220),(124+index*6,280),(80,105,190),-1)
    cv2.imwrite(str(frames/f'{index:03}.png'),f)
clip=output/'synthetic-pipeline-smoke.mp4'
subprocess.run([str(ROOT/'tools/ffmpeg.exe'),'-y','-framerate','5','-i',str(frames/'%03d.png'),
                '-c:v','libx264','-pix_fmt','yuv420p',str(clip)],check=True,capture_output=True)
report={'input':'Original 640x360 synthetic graphics, not CCTV or a held-out accuracy set.',
        'accuracy_evaluated':False,'iterations':30,'python':platform.python_version(),
        'runtime':runtime_status(),'mean_inference_ms':round(float(np.mean(timings)),2),
        'p95_inference_ms':round(float(np.percentile(timings,95)),2),
        'detection_and_tracking_fps':round(30/wall,2),'synthetic_clip':str(clip)}
(output/'gpu-benchmark.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report,indent=2))
