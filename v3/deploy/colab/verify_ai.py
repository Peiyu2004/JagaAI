"""Execute every inference component before displaying a public website URL."""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))


def verify():
    import cv2
    from app.local_ai import describe, embed
    from app.vision import Detector, Tracker

    cap = cv2.VideoCapture(str(ROOT / "deploy/colab/samples/stairs-entry.mp4"))
    try:
        cap.set(cv2.CAP_PROP_POS_MSEC, 7000)
        ok, frame = cap.read()
    finally:
        cap.release()
    if not ok:
        raise RuntimeError("The bundled public MP4 could not be decoded.")
    detector = Detector()
    detections = detector.detect(frame)
    tracker = Tracker(fps=5)
    tracks = tracker.update(detections, frame.shape[1], frame.shape[0])
    print(json.dumps({"detector_provider": detector.provider, "detections": len(detections),
                      "tracker": "ByteTrack", "tracks": len(tracks)}), flush=True)
    _, jpeg = cv2.imencode(".jpg", cv2.resize(frame, (640, 360)))
    caption = describe(jpeg.tobytes())
    vectors, model = embed([caption["text"], "person at a stair entrance"])
    if len(vectors) != 2 or not vectors[0]:
        raise RuntimeError("Embedding smoke check did not produce two vectors.")
    print(json.dumps({"real_ai_smoke": "passed", "description": caption["text"],
                      "embedding_dimensions": len(vectors[0]), "embedding_model": model}), flush=True)


if __name__ == "__main__":
    verify()
