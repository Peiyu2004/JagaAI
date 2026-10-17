"""Frame-bound detector evidence, independent of a VLM's person claims."""
import math


def check_frame_people(frame, detections, detector, second, keyframe):
    from .vision import check_person_crop, MODEL_NAME

    height, width = frame.shape[:2]
    boxes = []
    candidates = 0
    for row in detections:
        if int(row[5]) != 0:
            continue
        candidates += 1
        box = [max(0., min(1., float(v) / scale))
               for v, scale in zip(row[:4], [width, height, width, height])]
        check = check_person_crop(frame, box, detector)
        if check['passed']:
            boxes.append({'box': box, 'score': round(float(row[4]), 4), 'crop_score': check['score']})
    return {'version': 1, 'method': 'frame_and_person_crop', 'detector': MODEL_NAME,
            'provider': detector.provider, 'observed_at_sec': round(second, 3),
            'keyframe': keyframe, 'boxes': boxes, 'rejected_candidates': candidates - len(boxes)}


def person_evidence_status(attributes):
    """Return None for old/mismatched evidence, False for checked empty frames."""
    facts = attributes or {}
    evidence = facts.get('person_evidence')
    if not isinstance(evidence, dict) or evidence.get('version') != 1 or evidence.get('method') != 'frame_and_person_crop':
        return None
    try:
        second = float(facts['observed_at_sec'])
        observed = float(evidence['observed_at_sec'])
        if not math.isfinite(second) or not math.isfinite(observed) or abs(second - observed) > .001:
            return None
        if not facts.get('keyframe') or facts['keyframe'] != evidence['keyframe']:
            return None
        boxes = evidence['boxes']
        if not isinstance(boxes, list):
            return None
        for person in boxes:
            x1, y1, x2, y2 = person['box']
            if not (0 <= x1 < x2 <= 1 and 0 <= y1 < y2 <= 1
                    and .25 <= person['score'] <= 1 and .35 <= person['crop_score'] <= 1):
                return None
        return bool(boxes)
    except (KeyError, TypeError, ValueError):
        return None
