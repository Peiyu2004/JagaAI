"""Concurrent retention/re-analysis must not publish cached surveillance text.

All databases, frames and videos in this suite live under pytest's temporary
directory. Model calls are controlled at their API boundary, with real nonzero
vectors so a stale cache would produce a high-confidence match.
"""
from datetime import timedelta

import numpy as np
import pytest
from sqlalchemy import event
from sqlmodel import Session, SQLModel, create_engine, select

from app import database, local_ai
from app.models import Alert, AppSettings, Camera, Description, Event, Location, Track, Video, utcnow
from app.search import search

VECTOR = [0.8, 0.6, 0.0]
DIGEST = "qwen3-embedding:0.6b@test-digest"
PRIVATE_TEXT = "A red-shirted person stands beside a white parked car."


@pytest.fixture
def private_index(tmp_path, monkeypatch):
    directory = tmp_path / "private-test-data"
    directory.mkdir()
    engine = create_engine(f"sqlite:///{(directory / 'concurrency.sqlite').as_posix()}", connect_args={"check_same_thread": False})
    @event.listens_for(engine, "connect")
    def sqlite_settings(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA journal_mode=WAL")
    monkeypatch.setattr(database, "engine", engine)
    monkeypatch.setattr(database, "DATA_DIR", directory)
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(Location(id="private-location", name="Test parking", aliases=[], map_area=[]))
        session.flush()
        session.add(Camera(id="private-camera", name="Test camera", location_id="private-location", rules={}))
        session.flush()
        session.add(Video(id="private-video", camera_id="private-camera", path=str(directory / "video.mp4"), filename="test.mp4",
                          recorded_at=utcnow() - timedelta(minutes=2), duration_sec=10, status="ready", description_status="ready",
                          expires_at=utcnow() + timedelta(days=1)))
        session.add(AppSettings())
        session.flush()
        session.add(Description(id="private-description", video_id="private-video", start_sec=0, end_sec=10,
                                text=PRIVATE_TEXT, vector=VECTOR, vector_model=DIGEST, model="local-test-vlm",
                                attributes={'observed_at_sec':5.,'keyframe':'sample.jpg',
                                            'person_evidence':{'version':1,'method':'frame_and_person_crop',
                                                               'observed_at_sec':5.,'keyframe':'sample.jpg',
                                                               'boxes':[{'box':[.1,.1,.2,.8],'score':.8,'crop_score':.9}]}}))
        session.commit()
    yield engine, directory
    engine.dispose()


def test_semantic_race_control_really_matches_nonzero_vector(private_index, monkeypatch):
    engine, _ = private_index
    calls = []
    def embed(texts):
        calls.append(texts)
        return [VECTOR], DIGEST
    monkeypatch.setattr(local_ai, "embed", embed)
    with Session(engine) as session:
        result = search(session, {"query": "red shirt beside white car"})
    assert calls == [["red shirt beside white car"]]
    assert len(result["related"]) == 1
    assert result["related"][0]["text"] == PRIVATE_TEXT
    assert result["related"][0]["score"] == pytest.approx(1.0)
    assert result["coverage"] == {"analysed": 1, "total": 1, "pending": 0}


@pytest.mark.parametrize("change,expected_coverage", [
    ("expire_video", {"analysed": 0, "total": 0, "pending": 0}),
    ("start_reanalysis", {"analysed": 0, "total": 1, "pending": 1}),
    ("delete_description", {"analysed": 0, "total": 1, "pending": 1}),
])
def test_semantic_search_rechecks_private_rows_after_embedding(private_index, monkeypatch, change, expected_coverage):
    engine, _ = private_index
    calls = []
    def embed(texts):
        calls.append(texts)
        # A separate transaction simulates the worker or retention job committing
        # while Ollama is busy and the search session caches its old ORM rows.
        with Session(engine) as concurrent:
            video = concurrent.get(Video, "private-video")
            if change == "expire_video":
                video.expires_at = utcnow() - timedelta(seconds=1)
                concurrent.add(video)
            elif change == "start_reanalysis":
                video.status = "processing"
                concurrent.add(video)
            else:
                concurrent.delete(concurrent.get(Description, "private-description"))
            concurrent.commit()
        return [VECTOR], DIGEST
    monkeypatch.setattr(local_ai, "embed", embed)
    with Session(engine) as session:
        result = search(session, {"query": "red shirt beside white car"})
    assert calls == [["red shirt beside white car"]], "The race must occur inside the embedding call."
    assert result["related"] == [] and result["nearest"] == []
    assert PRIVATE_TEXT not in str(result)
    assert result["coverage"] == expected_coverage


@pytest.mark.parametrize("expire_during", ["detector", "description"])
def test_worker_rechecks_expiry_before_each_analysis_commit(private_index, monkeypatch, expire_during):
    from app import worker

    engine, directory = private_index
    monkeypatch.setattr(worker, "DATA_DIR", directory)
    monkeypatch.setenv("JAGAAI_ENABLE_VLM", "1")
    with Session(engine) as session:
        session.delete(session.get(Description, "private-description"))
        video = session.get(Video, "private-video")
        video.status = "queued"
        video.description_status = "not_started"
        session.add(video)
        session.commit()

    def expire():
        with Session(engine) as concurrent:
            video = concurrent.get(Video, "private-video")
            video.expires_at = utcnow() - timedelta(seconds=1)
            concurrent.add(video)
            concurrent.commit()

    class Capture:
        def __init__(self, _path):
            self.used = False
        def isOpened(self):
            return True
        def get(self, _property):
            return 5.0
        def read(self):
            if self.used:
                return False, None
            self.used = True
            return True, np.full((32, 32, 3), 100, dtype=np.uint8)
        def release(self):
            pass

    class Detector:
        last_ms = 1.0
        provider = 'test-provider'
        def detect(self, _frame):
            if expire_during == "detector":
                expire()
            return np.empty((0, 6), dtype=np.float32)

    class Tracker:
        def __init__(self, _fps):
            pass
        def update(self, _detections, _width, _height):
            return [{"id": "anonymous-1", "class": "person", "box": [0.1, 0.1, 0.3, 0.9], "confidence": 0.8}]

    class Rules:
        def __init__(self, _rules, _recorded_at):
            pass
        def update(self, _second, _tracks):
            if expire_during == "description":
                return []
            return [{"type": "vehicle_loitering", "start_sec": 0, "end_sec": 0,
                     "metrics": {"track_id": "anonymous-1", "dwell_sec": 120}, "rule_id": "R1", "rule_version": "1.0"}]

    description_calls = []
    def describe(_jpeg):
        description_calls.append(True)
        assert expire_during == "description", "Expired detections must not reach the VLM."
        expire()
        return {"text": PRIVATE_TEXT, "limitations": "", "objects": ["person", "car"], "model": "local-test-vlm"}

    monkeypatch.setattr(worker.cv2, "VideoCapture", Capture)
    monkeypatch.setattr(worker, "get_detector", Detector)
    monkeypatch.setattr(worker, "Tracker", Tracker)
    monkeypatch.setattr(worker, "RuleEngine", Rules)
    monkeypatch.setattr(local_ai, "describe", describe)
    monkeypatch.setattr(local_ai, "embed", lambda _texts: ([VECTOR], DIGEST))
    expected_message = "expired during analysis" if expire_during == "detector" else "expired during semantic analysis"
    with pytest.raises(RuntimeError, match=expected_message):
        worker.process_video("private-video")
    assert len(description_calls) == (1 if expire_during == "description" else 0)
    with Session(engine) as session:
        video = session.get(Video, "private-video")
        assert video.status == "failed" and "expired" in video.error.lower()
        assert session.exec(select(Description)).all() == []
        assert session.exec(select(Event)).all() == []
        assert session.exec(select(Alert)).all() == []
        if expire_during == "detector":
            assert session.exec(select(Track)).all() == []
