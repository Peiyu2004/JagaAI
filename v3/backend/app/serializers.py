from datetime import datetime

from sqlmodel import Session

from .auth import aware
from . import database
from .models import Alert, Event, Lead, utcnow


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


def video_json(video):
    result = record_json(video, {"path"})
    thumbnail = database.DATA_DIR / "frames" / video.id / "overview.jpg"
    result["thumbnail_url"] = f"/api/videos/{video.id}/keyframes/overview.jpg" if aware(video.expires_at) > utcnow() and thumbnail.is_file() else None
    return result


def alert_json(alert: Alert, session: Session):
    result = record_json(alert, {"event_snapshot", "reviewed_by"})
    event = session.get(Event, alert.event_id) if alert.event_id else None
    result["event"] = record_json(event) if event else alert.event_snapshot or None
    return result


def lead_json(lead: Lead, public=False):
    fields = {"id", "location_id", "time_from", "time_to", "text", "status", "public_reply", "created_at"}
    if public:
        return json_value({key: getattr(lead, key) for key in fields})
    result = record_json(lead, {"resident_id", "photo_path"})
    result["photo_url"] = f"/api/leads/{lead.id}/photo" if lead.photo_path else None
    return result
