from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel


def uid() -> str:
    return str(uuid4())


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(SQLModel, table=True):
    id: str = Field(default_factory=uid, primary_key=True)
    email: str = Field(unique=True, index=True)
    password_hash: str = ""
    name: str
    role: str
    created_at: datetime = Field(default_factory=utcnow)


class AuthSession(SQLModel, table=True):
    token_hash: str = Field(primary_key=True)
    user_id: str = Field(foreign_key="user.id", index=True)
    expires_at: datetime


class Location(SQLModel, table=True):
    id: str = Field(default_factory=uid, primary_key=True)
    name: str
    aliases: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    map_area: list[float] = Field(default_factory=list, sa_column=Column(JSON))


class Camera(SQLModel, table=True):
    id: str = Field(default_factory=uid, primary_key=True)
    name: str
    location_id: str = Field(foreign_key="location.id", index=True)
    status: str = "awaiting_upload"
    source_type: str = "upload"
    rules: dict = Field(default_factory=dict, sa_column=Column(JSON))
    # Live input. The URL may hold camera credentials: never serialise it unmasked.
    stream_url: str | None = None
    stream_enabled: bool = False
    segment_sec: int = 60


class Video(SQLModel, table=True):
    id: str = Field(default_factory=uid, primary_key=True)
    camera_id: str = Field(foreign_key="camera.id", index=True)
    path: str
    filename: str
    recorded_at: datetime
    duration_sec: float = 0
    status: str = "uploaded"
    error: str | None = None
    analysis_source: str | None = None
    source: str = "upload"
    description_status: str = "not_started"
    analysis_metrics: dict = Field(default_factory=dict, sa_column=Column(JSON))
    processed_at: datetime | None = None
    created_at: datetime = Field(default_factory=utcnow)
    expires_at: datetime


class Track(SQLModel, table=True):
    id: str = Field(default_factory=uid, primary_key=True)
    video_id: str = Field(foreign_key="video.id", index=True)
    track_id: str
    class_name: str
    start_sec: float
    end_sec: float
    attributes: dict = Field(default_factory=dict, sa_column=Column(JSON))


class Event(SQLModel, table=True):
    id: str = Field(default_factory=uid, primary_key=True)
    video_id: str = Field(foreign_key="video.id", index=True)
    camera_id: str = Field(foreign_key="camera.id", index=True)
    type: str
    start_sec: float
    end_sec: float
    metrics: dict = Field(default_factory=dict, sa_column=Column(JSON))
    rule_id: str
    rule_version: str = "1.0"
    verification: dict = Field(default_factory=dict, sa_column=Column(JSON))
    keyframes: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow)


class Alert(SQLModel, table=True):
    id: str = Field(default_factory=uid, primary_key=True)
    event_id: str | None = Field(default=None, foreign_key="event.id", index=True)
    status: str = "pending"
    priority: str = "normal"
    reviewed_by: str | None = Field(default=None, foreign_key="user.id")
    dismiss_reason: str | None = None
    reviewed_at: datetime | None = None
    created_at: datetime = Field(default_factory=utcnow)
    event_snapshot: dict = Field(default_factory=dict, sa_column=Column(JSON))


class Description(SQLModel, table=True):
    id: str = Field(default_factory=uid, primary_key=True)
    video_id: str = Field(foreign_key="video.id", index=True)
    track_id: str | None = None
    start_sec: float = 0
    end_sec: float = 0
    text: str
    vector: list[float] = Field(default_factory=list, sa_column=Column(JSON))
    vector_model: str = ""
    model: str
    analysis_source: str = "local_realtime"
    attributes: dict = Field(default_factory=dict, sa_column=Column(JSON))


class Guard(SQLModel, table=True):
    id: str = Field(default_factory=uid, primary_key=True)
    name: str
    shift: str
    phone: str


class Incident(SQLModel, table=True):
    id: str = Field(default_factory=uid, primary_key=True)
    title: str
    location_id: str = Field(foreign_key="location.id", index=True)
    priority: str = "normal"
    status: str = "open"
    guard_id: str | None = Field(default=None, foreign_key="guard.id")
    outcome: str = ""
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    evidence: list[dict] = Field(default_factory=list, sa_column=Column(JSON))
    timeline: list[dict] = Field(default_factory=list, sa_column=Column(JSON))


class Lead(SQLModel, table=True):
    id: str = Field(default_factory=uid, primary_key=True)
    resident_id: str = Field(foreign_key="user.id", index=True)
    location_id: str = Field(foreign_key="location.id", index=True)
    time_from: datetime
    time_to: datetime
    text: str
    status: str = "received"
    public_reply: str = ""
    incident_id: str | None = Field(default=None, foreign_key="incident.id")
    photo_path: str | None = None
    created_at: datetime = Field(default_factory=utcnow)


class IncidentCreateRequest(SQLModel, table=True):
    # One receipt per operator action, committed atomically with the incident.
    key_hash: str = Field(primary_key=True)
    request_hash: str
    incident_id: str = Field(foreign_key="incident.id")


class AuditLog(SQLModel, table=True):
    id: str = Field(default_factory=uid, primary_key=True)
    actor_id: str | None = None
    action: str
    target: str
    details: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, index=True)


class AppSettings(SQLModel, table=True):
    id: str = Field(default="global", primary_key=True)
    retention_days: int = 30
    search_threshold: float = 0.65
