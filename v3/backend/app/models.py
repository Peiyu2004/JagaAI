from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import JSON, Column, UniqueConstraint
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
    # resident | guard | manager | admin. Assigned by the server, never chosen at sign-in.
    role: str
    # active | pending (resident awaiting approval) | disabled
    status: str = "active"
    phone: str = ""
    unit: str = ""
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
    is_simulation: bool = False
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
    notification_opt_in: bool = False


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


class NotificationPolicy(SQLModel, table=True):
    id: str = Field(default="global", primary_key=True)
    enabled: bool = False
    mode: str = "simulate"
    primary_guard_id: str | None = None
    escalation_guard_id: str | None = None
    call_after_sec: int = 60
    escalate_after_sec: int = 180
    cooldown_sec: int = 600
    urgent_call: bool = True
    sms_fallback: bool = True
    voice_language: str = "zh-CN"


class GuardDispatch(SQLModel, table=True):
    id: str = Field(default_factory=uid, primary_key=True)
    # Plain record IDs preserve the notification history after media retention.
    alert_id: str = Field(unique=True, index=True)
    incident_id: str | None = Field(default=None, index=True)
    camera_id: str = Field(index=True)
    rule_id: str
    title: str
    location: str
    priority: str
    event_at: datetime
    mode: str
    automatic: bool = True
    status: str = "active"
    reason: str = ""
    primary_guard_id: str
    primary_name: str
    primary_phone: str
    escalation_guard_id: str | None = None
    escalation_name: str = ""
    escalation_phone: str = ""
    sms_fallback: bool = True
    voice_language: str = "zh-CN"
    token_seed: str
    acknowledged_by: str | None = None
    acknowledged_name: str = ""
    acknowledged_at: datetime | None = None
    acknowledged_via: str = ""
    recorded_by: str = ""
    created_at: datetime = Field(default_factory=utcnow, index=True)
    expires_at: datetime


class NotificationAttempt(SQLModel, table=True):
    # Deterministic ID per dispatch, recipient stage and channel.
    id: str = Field(primary_key=True)
    dispatch_id: str = Field(foreign_key="guarddispatch.id", index=True)
    stage: str
    channel: str
    guard_id: str
    guard_name: str
    phone: str
    due_at: datetime
    status: str = "queued"
    provider_sid: str = ""
    provider_status: str = ""
    error: str = ""
    updated_at: datetime = Field(default_factory=utcnow)
    history: list[dict] = Field(default_factory=list, sa_column=Column(JSON))


class GuardVoiceCall(SQLModel, table=True):
    id: str = Field(default_factory=uid, primary_key=True)
    attempt_id: str = Field(foreign_key="notificationattempt.id", index=True)
    provider_sid: str | None = Field(default=None, unique=True)
    started_at: datetime = Field(default_factory=utcnow)
    ended_at: datetime | None = None
    end_reason: str = ""
    turns: list[dict] = Field(default_factory=list, sa_column=Column(JSON))


class Task(SQLModel, table=True):
    id: str = Field(default_factory=uid, primary_key=True)
    title: str
    detail: str = ""
    location_id: str | None = Field(default=None, foreign_key="location.id")
    priority: str = "normal"
    # open | in_progress | done
    status: str = "open"
    assignee_id: str | None = Field(default=None, foreign_key="user.id", index=True)
    created_by: str | None = Field(default=None, foreign_key="user.id")
    # Optional origin such as "alert:<id>" or "lead:<id>".
    source: str = ""
    note: str = ""
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class Activity(SQLModel, table=True):
    id: str = Field(default_factory=uid, primary_key=True)
    title: str
    description: str = ""
    location: str
    starts_at: datetime
    capacity: int | None = None
    points: int = 20
    # published | cancelled
    status: str = "published"
    created_by: str | None = Field(default=None, foreign_key="user.id")
    created_at: datetime = Field(default_factory=utcnow)


class ActivitySignup(SQLModel, table=True):
    __table_args__ = (UniqueConstraint("activity_id", "user_id"),)
    id: str = Field(default_factory=uid, primary_key=True)
    activity_id: str = Field(foreign_key="activity.id", index=True)
    user_id: str = Field(foreign_key="user.id", index=True)
    attended: bool = False
    created_at: datetime = Field(default_factory=utcnow)


class PointEntry(SQLModel, table=True):
    id: str = Field(default_factory=uid, primary_key=True)
    user_id: str = Field(foreign_key="user.id", index=True)
    points: int
    reason: str
    # Awards with a ref are granted once per user, e.g. "lead:<id>" or "activity:<id>".
    ref: str = ""
    created_at: datetime = Field(default_factory=utcnow, index=True)
