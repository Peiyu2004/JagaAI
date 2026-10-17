from pathlib import Path

from sqlmodel import select

from .auth import aware
from .database import DATA_DIR, session_scope
from .models import Alert, AuditLog, Description, Event, Track, Video, utcnow
from .serializers import record_json


def media_path(path: str) -> Path:
    """Stored paths may be relative to DATA_DIR so prepared demo data works from any folder."""
    result = Path(path)
    return result if result.is_absolute() else DATA_DIR / result


def private_path(path: str) -> Path:
    result = media_path(path).resolve()
    if not result.is_relative_to(DATA_DIR):
        raise ValueError("File is outside the v3 private data directory.")
    return result


def expire_videos(now=None):
    now = now or utcnow()
    removed = 0
    with session_scope() as session:
        videos = session.exec(select(Video).where(Video.expires_at <= now, Video.status != "processing")).all()
        for video in videos:
            files = [video.path]
            events = session.exec(select(Event).where(Event.video_id == video.id)).all()
            for event in events:
                for alert in session.exec(select(Alert).where(Alert.event_id == event.id)).all():
                    if alert.status == "pending":
                        session.delete(alert)
                    else:
                        snapshot = record_json(event)
                        snapshot["keyframes"] = []
                        snapshot["media_expired"] = True
                        alert.event_snapshot = snapshot
                        alert.event_id = None
                        session.add(alert)
                for keyframe in event.keyframes:
                    if not keyframe.startswith("/api/"):
                        files.append(keyframe)
                session.flush()
                session.delete(event)
            for cls in (Track, Description):
                for child in session.exec(select(cls).where(cls.video_id == video.id)).all():
                    session.delete(child)
            session.flush()
            session.delete(video)
            session.add(AuditLog(action="retention.video_expired", target=video.id, details={"filename": video.filename, "reviewed_decisions_preserved": True}))
            session.commit()
            for filename in files:
                try:
                    private_path(filename).unlink(missing_ok=True)
                except (ValueError, OSError):
                    pass
            # Workers store generated keyframes in an isolated per-video folder.
            frame_dir = DATA_DIR / "frames" / video.id
            if frame_dir.is_dir():
                for frame in frame_dir.iterdir():
                    if frame.is_file():
                        frame.unlink(missing_ok=True)
                try:
                    frame_dir.rmdir()
                except OSError:
                    pass
            removed += 1
    return removed
