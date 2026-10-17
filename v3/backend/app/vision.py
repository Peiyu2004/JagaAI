"""Local YOLOX ONNX inference, ByteTrack, and measured R1/R3 rules.

YOLOX model and coordinate decoding: Megvii, Apache-2.0; see docs/licenses.
Tracking uses the MIT-licensed supervision 0.25.1 ByteTrack implementation.
No identity recognition or learned suspicion classifier is used.
"""
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
import math
import os
import time

import cv2
import numpy as np
from .gpu import gpu_environment, selected_gpu

CLASSES = {0: 'person', 1: 'bicycle', 2: 'car', 3: 'motorcycle', 5: 'bus',
           7: 'truck', 24: 'backpack', 26: 'handbag', 28: 'suitcase'}
VEHICLES = {'car', 'truck', 'bus', 'motorcycle'}
MODEL_PATH = Path(os.environ.get('JAGAAI_YOLOX_MODEL', Path(__file__).resolve().parents[2] / 'models' / 'yolox_s.onnx'))
MODEL_NAME = 'YOLOX-S' if MODEL_PATH.stem == 'yolox_s' else 'YOLOX-Tiny'
_active_provider = None
_dll_directories = []


def runtime_status():
    import onnxruntime as ort
    return {'detector':MODEL_NAME,'installed':MODEL_PATH.is_file(),'model_bytes':MODEL_PATH.stat().st_size if MODEL_PATH.is_file() else 0,
            'providers':ort.get_available_providers(),
            'configured_provider':'CUDAExecutionProvider' if selected_gpu() else 'CPUExecutionProvider',
            'active_provider':_active_provider,'gpu':selected_gpu(),'tracker':'ByteTrack','rule_ids':['R1','R3']}


class Detector:
    def __init__(self, model_path=MODEL_PATH):
        os.environ.update(gpu_environment())
        import onnxruntime as ort
        if not Path(model_path).is_file():
            raise RuntimeError('YOLOX is not installed. Run scripts/prepare-local.py first.')
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        self.session = None
        if selected_gpu() and 'CUDAExecutionProvider' in ort.get_available_providers():
            try:
                self.session = self._cuda_session(ort, model_path, options)
            except Exception as error:  # driver/cuDNN mismatch on another machine
                print(f'CUDA inference unavailable ({error}); using CPU.', flush=True)
        if self.session is None:
            # CPU mode: let ONNX Runtime use every physical core.
            self.session = ort.InferenceSession(str(model_path), ort.SessionOptions(), providers=['CPUExecutionProvider'])
        self.provider = self.session.get_providers()[0]
        self.input = self.session.get_inputs()[0]
        self.height, self.width = map(int, self.input.shape[-2:])
        self.last_ms = 0.0
        self.inference_passes = 0

    @staticmethod
    def _cuda_session(ort, model_path, options):
        if os.name == 'nt' and not _dll_directories:
            # cuDNN loads engine DLLs lazily; preloading its entry DLL is insufficient.
            for directory in (Path(ort.__file__).parent.parent/'nvidia').glob('*/bin'):
                _dll_directories.append(os.add_dll_directory(str(directory)))
                os.environ['PATH'] = str(directory)+os.pathsep+os.environ.get('PATH','')
        if hasattr(ort, 'preload_dlls'):
            ort.preload_dlls(directory='')
        session = ort.InferenceSession(str(model_path), options, providers=[
            ('CUDAExecutionProvider', {'device_id': 0, 'gpu_mem_limit': 536870912,
             'arena_extend_strategy': 'kSameAsRequested', 'cudnn_conv_algo_search': 'HEURISTIC',
             'cudnn_conv_use_max_workspace': '0'}), 'CPUExecutionProvider'])
        session.disable_fallback()
        if session.get_providers()[0] != 'CUDAExecutionProvider':
            raise RuntimeError('CUDA provider did not initialise')
        return session

    def detect(self, frame):
        global _active_provider
        original_h, original_w = frame.shape[:2]
        ratio = min(self.height / original_h, self.width / original_w)
        h, w = int(original_h * ratio), int(original_w * ratio)
        canvas = np.full((self.height, self.width, 3), 114, dtype=np.uint8)
        canvas[:h, :w] = cv2.resize(frame, (w, h))
        tensor = np.ascontiguousarray(canvas.transpose(2, 0, 1)[None], dtype=np.float32)
        started = time.perf_counter()
        predictions = self.session.run(None, {self.input.name: tensor})[0][0].copy()
        _active_provider = self.provider
        self.inference_passes += 1
        self.last_ms = (time.perf_counter() - started) * 1000
        grids, scales = [], []
        for stride in (8, 16, 32):
            yy, xx = np.mgrid[:self.height // stride, :self.width // stride]
            grids.append(np.column_stack((xx.ravel(), yy.ravel())))
            scales.append(np.full((xx.size, 1), stride))
        grid, scale = np.concatenate(grids), np.concatenate(scales)
        if len(predictions) != len(grid):
            raise RuntimeError('Unexpected YOLOX output grid; model export is incompatible.')
        predictions[:, :2] = (predictions[:, :2] + grid) * scale
        predictions[:, 2:4] = np.exp(np.clip(predictions[:, 2:4], -20, 20)) * scale
        classes = np.argmax(predictions[:, 5:], axis=1)
        scores = predictions[:, 4] * predictions[np.arange(len(predictions)), classes + 5]
        candidates = []
        for class_id in CLASSES:
            indexes = np.where((classes == class_id) & (scores >= 0.25))[0]
            if not len(indexes):
                continue
            rows = predictions[indexes]
            boxes = np.column_stack((rows[:, 0] - rows[:, 2] / 2, rows[:, 1] - rows[:, 3] / 2,
                                     rows[:, 2], rows[:, 3])) / ratio
            kept = cv2.dnn.NMSBoxes(boxes.tolist(), scores[indexes].tolist(), 0.25, 0.45)
            for local in np.asarray(kept).ravel():
                x, y, bw, bh = boxes[int(local)]
                x1, y1 = max(0., x), max(0., y)
                x2, y2 = min(original_w, x + bw), min(original_h, y + bh)
                if x2 > x1 and y2 > y1:
                    candidates.append((x1, y1, x2, y2, float(scores[indexes[int(local)]]), class_id))
        return np.array(candidates, dtype=np.float32).reshape(-1, 6)


class Tracker:
    def __init__(self, fps=5):
        import supervision as sv
        self.sv = sv
        self.trackers = {class_id: sv.ByteTrack(frame_rate=fps, lost_track_buffer=30,
                         track_activation_threshold=0.25, minimum_consecutive_frames=1) for class_id in CLASSES}

    def update(self, detections, width, height):
        output = []
        # ByteTrack itself is class agnostic. A person must never inherit a car ID.
        for class_id, tracker in self.trackers.items():
            rows=detections[detections[:,5]==class_id]
            det=self.sv.Detections(xyxy=rows[:,:4],confidence=rows[:,4],class_id=rows[:,5].astype(int))
            tracked=tracker.update_with_detections(det)
            for i, track_id in enumerate(tracked.tracker_id if tracked.tracker_id is not None else []):
                box=tracked.xyxy[i]/np.array([width,height,width,height])
                output.append({'id':f'{class_id}-{track_id}','class':CLASSES[class_id],
                               'box':box.tolist(),'confidence':float(tracked.confidence[i])})
        return output


def check_person_crop(frame, box, detector, min_side=320):
    """Recheck a long-dwell trigger at a larger scale; no identity inference.

    The crop keeps at least min_side pixels of context (at most ~2x magnification at the
    640 px model input). A distant person's tight box (about 25x70 px) was otherwise
    magnified up to 9x and never passed. Measured on every stored demo evidence frame:
    160 px still missed two people standing together in a re-encoded live segment; 320 px
    kept all 59 earlier passes and still rejects the known machinery false person.
    """
    height,width=frame.shape[:2]
    x1,y1,x2,y2=np.array(box)*[width,height,width,height]
    padx,pady=max(8,(x2-x1)*.3),max(8,(y2-y1)*.2)
    cx,cy=(x1+x2)/2,(y1+y2)/2
    half_w,half_h=max((x2-x1)/2+padx,min_side/2),max((y2-y1)/2+pady,min_side/2)
    left,top=max(0,int(cx-half_w)),max(0,int(cy-half_h))
    right,bottom=min(width,int(cx+half_w)),min(height,int(cy+half_h))
    if right<=left or bottom<=top:
        return {'passed':False,'score':0.,'method':'person_crop_recheck'}
    scores=[]
    for a,b,c,d,score,kind in detector.detect(frame[top:bottom,left:right]):
        if int(kind)!=0:
            continue
        a,b,c,d=a+left,b+top,c+left,d+top
        intersection=max(0,min(c,x2)-max(a,x1))*max(0,min(d,y2)-max(b,y1))
        overlap=intersection/max(1,(x2-x1)*(y2-y1))
        if overlap>=.3:
            scores.append(float(score))
    score=max(scores,default=0.)
    return {'passed':score>=.35,'score':round(score,4),'method':'person_crop_recheck'}


def detect_frame(frame, detector, rules):
    """Retain scene coverage and enlarge a configured R3 boundary for small people."""
    rows=detector.detect(frame)
    elapsed=detector.last_ms
    rule=rules.get('R3',{})
    points=rule.get('line') or rule.get('zone')
    if not rule.get('enabled') or not points:
        return rows
    height,width=frame.shape[:2]
    coordinates=np.asarray(points,dtype=float)
    left,top=np.maximum(0,coordinates.min(axis=0)-[.2,.15])
    right,bottom=np.minimum(1,coordinates.max(axis=0)+[.2,.15])
    x1,y1,x2,y2=int(left*width),int(top*height),int(right*width),int(bottom*height)
    if x2-x1<32 or y2-y1<32 or (x2-x1)*(y2-y1)>.85*width*height:
        return rows
    focused=detector.detect(frame[y1:y2,x1:x2]).copy()
    detector.last_ms+=elapsed
    focused=focused[focused[:,5]==0]
    focused[:,:4]+=np.array([x1,y1,x1,y1])
    people=np.concatenate((rows[rows[:,5]==0],focused))
    if not len(people):
        return rows
    boxes=people[:,:4].copy();boxes[:,2:]-=boxes[:,:2]
    keep=np.asarray(cv2.dnn.NMSBoxes(boxes.tolist(),people[:,4].tolist(),.25,.45)).ravel()
    return np.concatenate((rows[rows[:,5]!=0],people[keep.astype(int)]))


def in_polygon(point, polygon):
    if not polygon or len(polygon) < 3:
        return False
    # Boundary counts as inside; footpoint, not box overlap, is used.
    return cv2.pointPolygonTest(np.asarray(polygon, dtype=np.float32), tuple(map(float, point)), False) >= 0


def active_at(moment, start='19:00', end='06:00'):
    local = moment.astimezone(ZoneInfo('Asia/Kuala_Lumpur'))
    now = local.hour * 60 + local.minute
    a, b = (sum(int(v) * f for v, f in zip(s.split(':'), (60, 1))) for s in (start, end))
    return True if a == b else a <= now < b if a < b else now >= a or now < b


def crossed_segment(previous, current, line):
    if not line or len(line) != 2:
        return False
    def side(a, b, p):
        return (b[0]-a[0])*(p[1]-a[1]) - (b[1]-a[1])*(p[0]-a[0])
    a, b = line
    # Strict side change avoids repeated events while a tracked point lies on the boundary.
    return side(a, b, previous) * side(a, b, current) < 0 and side(previous, current, a) * side(previous, current, b) <= 0


def box_iou(a, b):
    w = max(0., min(a[2], b[2]) - max(a[0], b[0]))
    h = max(0., min(a[3], b[3]) - max(a[1], b[1]))
    union = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - w*h
    return w*h/union if union > 0 else 0.


class RuleEngine:
    def __init__(self, rules, recorded_at, cooldown_sec=600):
        self.rules = rules
        self.recorded_at = recorded_at.replace(tzinfo=timezone.utc) if recorded_at.tzinfo is None else recorded_at
        self.people = {}
        self.cooldown = {}
        self.emitted = set()
        self.cooldown_sec = cooldown_sec
        self.vehicle_alias = {}
        self.vehicle_seen = {}

    def _physical_vehicles(self, second, tracks, overlap=.6, memory=10.):
        """Give one ID to one physical vehicle.

        Tracking is per class, so a pickup seen as both car and truck, or a parked car
        whose class or tracker ID flips, would otherwise count as several vehicles.
        """
        merged = {}
        for track in (x for x in tracks if x['class'] in VEHICLES):
            ident = self.vehicle_alias.get(track['id'])
            if ident is None:
                nearby = [(box_iou(track['box'], seen['box']), key) for key, seen in self.vehicle_seen.items()
                          if second - seen['last'] <= memory]
                score, key = max(nearby, default=(0., None))
                ident = key if score >= overlap else track['id']
                self.vehicle_alias[track['id']] = ident
            self.vehicle_seen[ident] = {'box': track['box'], 'last': second}
            merged.setdefault(ident, {**track, 'id': ident})
        return list(merged.values())

    def update(self, second, tracks):
        events = []
        vehicles = self._physical_vehicles(second, tracks)
        r1, r3 = self.rules.get('R1', {}), self.rules.get('R3', {})
        for person in (x for x in tracks if x['class'] == 'person'):
            ident, box = person['id'], person['box']
            foot = ((box[0]+box[2])/2, box[3])
            prior = self.people.get(ident)
            continuous = prior is not None and 0 <= second-prior['last'] <= 1.5
            data = prior if continuous else {'first': second, 'last': second, 'foot': foot, 'entered': None, 'contacts': {}}
            dt = max(0., min(second-data['last'], 1.5)) if continuous else 0.
            if r1.get('enabled') and in_polygon(foot, r1.get('zone')):
                if data['entered'] is None:
                    data['entered'] = second
                for vehicle in vehicles:
                    x1, y1, x2, y2 = vehicle['box']
                    near = x1-.04 <= foot[0] <= x2+.04 and y1-.04 <= foot[1] <= y2+.04
                    if near:
                        contact = data['contacts'].get(vehicle['id'])
                        if contact is None:
                            contact = {'duration': 0., 'last': second}
                            data['contacts'][vehicle['id']] = contact
                        elif abs(contact['last']-data['last'])<1e-5 and second-contact['last'] <= 1.5:
                            contact['duration'] += dt
                        else:
                            contact['duration'] = 0.
                        contact['last'] = second
                        if contact['duration']>=r1.get('min_dwell_sec',3):
                            contact['qualified_at']=second
                contacts = {k:v for k,v in data['contacts'].items() if second-max(v['last'],v.get('qualified_at',-math.inf)) <= r1.get('window_sec',300)}
                data['contacts'] = contacts
                number = sum(second-c.get('qualified_at',-math.inf) <= r1.get('window_sec',300) for c in contacts.values())
                dwell = second-data['entered']
                if dwell >= r1.get('loiter_sec',120) or number >= r1.get('min_vehicles',3):
                    events += self._emit('R1', ident, second, data['entered'], 'vehicle_loitering',
                                         {'dwell_sec': round(dwell,2), 'distinct_vehicles': number,
                                          'threshold_sec': r1.get('loiter_sec',120), 'track_id': ident})
            else:
                data['entered'] = None
                data['contacts'] = {}
            line=r3.get('line')
            crosses=crossed_segment(data.get('line_anchor',data['foot']),foot,line) if continuous else False
            if line and len(line)==2:
                a,b=line
                side=(b[0]-a[0])*(foot[1]-a[1])-(b[1]-a[1])*(foot[0]-a[0])
                if abs(side)>1e-7:
                    data['line_anchor']=foot
            if r3.get('enabled') and continuous and active_at(self.recorded_at+timedelta(seconds=second),
                                                              r3.get('active_start','19:00'),r3.get('active_end','06:00')):
                enters = in_polygon(foot,r3.get('zone')) and not in_polygon(data['foot'],r3.get('zone'))
                if enters or crosses:
                    events += self._emit('R3',ident,second,max(0.,second-2),'restricted_entry',
                                         {'crossed_line': crosses, 'entered_zone': enters, 'track_id':ident,
                                          'active_hours':r3.get('active_start','19:00')+'–'+r3.get('active_end','06:00')})
            data['last'],data['foot'] = second,foot
            self.people[ident] = data
        return events

    def _emit(self,rule,person,second,start,event_type,metrics):
        if (rule,person) in self.emitted:
            return []
        # Mark this track even during cooldown: it must not generate a delayed duplicate.
        self.emitted.add((rule,person))
        if second-self.cooldown.get(rule,-math.inf) < self.cooldown_sec:
            return []
        self.cooldown[rule] = second
        return [{'rule_id':rule,'type':event_type,'start_sec':round(start,3),'end_sec':round(second,3),
                 'metrics':metrics}]
