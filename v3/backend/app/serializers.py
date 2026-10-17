from datetime import datetime

from sqlmodel import Session, select

from .auth import aware
from . import database
from .models import Alert, Description, Event, Lead, Video, utcnow


def json_value(value):
    if isinstance(value, datetime):
        return aware(value).isoformat()
    if isinstance(value, dict):
        return {key: json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_value(item) for item in value]
    return value


def record_json(record, exclude=None):
    # SQLAlchemy expires attributes on commit. Accessing each mapped field reloads
    # the row; model_dump alone would silently serialize an expired row as {}.
    excluded = exclude or set()
    return json_value({key: getattr(record, key) for key in type(record).model_fields if key not in excluded})


def camera_json(camera):
    from . import live
    result = record_json(camera, {"stream_url"})
    result["stream_url"] = live.mask_url(camera.stream_url)
    result["live"] = live.status(camera.id)
    return result


def video_json(video):
    result = record_json(video, {"path"})
    thumbnail = database.DATA_DIR / "frames" / video.id / "overview.jpg"
    result["thumbnail_url"] = f"/api/videos/{video.id}/keyframes/overview.jpg" if aware(video.expires_at) > utcnow() and thumbnail.is_file() else None
    return result


def alert_json(alert: Alert, session: Session):
    result = record_json(alert, {"event_snapshot", "reviewed_by"})
    event = session.get(Event, alert.event_id) if alert.event_id else None
    result["event"] = record_json(event) if event else alert.event_snapshot or None
    result["scene"] = trigger_scene(event, session) if event else None
    return result


def trigger_scene(event: Event, session: Session, tolerance=1.5):
    """The local VLM caption sampled nearest the trigger frame. Context only: it does not verify the rule."""
    video = session.get(Video, event.video_id)
    if not video or aware(video.expires_at) <= utcnow():
        return None
    nearest = None
    for row in session.exec(select(Description).where(Description.video_id == event.video_id)).all():
        observed = float((row.attributes or {}).get("observed_at_sec", row.start_sec))
        gap = abs(observed - event.end_sec)
        if gap <= tolerance and (nearest is None or gap < nearest[0]):
            nearest = (gap, observed, row)
    if not nearest:
        return None
    gap, observed, row = nearest
    keyframe = (row.attributes or {}).get("keyframe")
    return {"text": row.text, "model": row.model, "observed_at_sec": round(observed, 3), "offset_sec": round(gap, 3),
            "keyframe_url": f"/api/videos/{event.video_id}/keyframes/{keyframe}" if keyframe else None}


def lead_json(lead: Lead, public=False):
    fields = {"id", "location_id", "time_from", "time_to", "text", "status", "public_reply", "created_at"}
    if public:
        return json_value({key: getattr(lead, key) for key in fields})
    result = record_json(lead, {"resident_id", "photo_path"})
    result["photo_url"] = f"/api/leads/{lead.id}/photo" if lead.photo_path else None
    return result
