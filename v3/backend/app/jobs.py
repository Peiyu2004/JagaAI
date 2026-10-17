"""One local inference worker; no concurrent analyses competing for local GPU RAM."""
import logging
from queue import Queue
from threading import Lock, Thread

from sqlmodel import or_, select

from .database import session_scope
from .models import Video
from .realtime import publish_refresh

log = logging.getLogger(__name__)
_queue = Queue()
_pending = set()
_lock = Lock()
_thread = None


def enqueue(video_id):
    with _lock:
        if video_id in _pending:
            return
        _pending.add(video_id)
    _queue.put(video_id)


def _run():
    while True:
        video_id = _queue.get()
        if video_id is None:
            _queue.task_done()
            return
        try:
            try:
                from .worker import process_video
            except ImportError:
                with session_scope() as session:
                    video = session.get(Video, video_id)
                    if video:
                        video.error = "Analysis worker is unavailable. Restart after installing its dependencies."
                        session.add(video)
                        session.commit()
                log.exception("Video worker is not installed")
            else:
                process_video(video_id)
        except Exception as exc:
            log.exception("Video analysis failed")
            with session_scope() as session:
                video = session.get(Video, video_id)
                if video:
                    video.status = "failed"
                    video.error = str(exc)[:1000]
                    session.add(video)
                    session.commit()
        finally:
            with _lock:
                _pending.discard(video_id)
            publish_refresh("analysis", video_id)
            _queue.task_done()


def start_worker():
    global _thread
    if _thread and _thread.is_alive():
        return
    _thread = Thread(target=_run, name="jagaai-analysis", daemon=True)
    _thread.start()
    with session_scope() as session:
        pending = session.exec(select(Video).where(or_(
            Video.status.in_(["queued", "processing"]),
            (Video.status == "ready") & (Video.description_status == "processing"),
        ))).all()
        for video in pending:
            video.status = "queued"
            session.add(video)
        session.commit()
        for video in pending:
            enqueue(video.id)


def stop_worker():
    if _thread and _thread.is_alive():
        _queue.put(None)
