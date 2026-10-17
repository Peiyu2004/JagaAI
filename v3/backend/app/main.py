import asyncio
import hashlib
import io
import json
import logging
import math
import os
import re
import shutil
import statistics
import subprocess
import threading
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field as PydanticField
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from . import jobs, live
from .auth import COOKIE_NAME, admin, authenticated, aware, current_user, establish_session, hash_password, resident, staff, user_json, verify_password
from .database import DATA_DIR, get_session, init_db, session_scope
from .models import Alert, AppSettings, AuditLog, AuthSession, Camera, Event, Guard, Incident, Lead, Location, User, Video, uid, utcnow
from .realtime import publish_refresh, snapshot
from .retention import expire_videos, private_path
from .serializers import alert_json, camera_json, lead_json, record_json, video_json

log = logging.getLogger(__name__)
MAX_VIDEO_BYTES = int(os.environ.get("JAGAAI_MAX_VIDEO_MB", "512")) * 1024 * 1024
MAX_PHOTO_BYTES = 8 * 1024 * 1024
ALLOWED_ORIGINS = {"http://127.0.0.1:5174", "http://localhost:5174", "http://127.0.0.1:8766", "http://localhost:8766"}
_rates = defaultdict(deque)
_rate_lock = threading.Lock()


async def retention_loop():
    while True:
        await asyncio.sleep(3600)
        await asyncio.to_thread(expire_videos)


@asynccontextmanager
async def lifespan(_app):
    init_db()
    expire_videos()
    jobs.start_worker()
    live.start_all()
    task = asyncio.create_task(retention_loop())
    yield
    task.cancel()
    await asyncio.to_thread(live.stop_all)
    jobs.stop_worker()


app = FastAPI(title="JagaAI v3 local API", version="3.0.0", lifespan=lifespan)


class UploadBodyLimit:
    """Bound the multipart parser as well as the final saved file."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        limit = MAX_VIDEO_BYTES if scope.get("path") == "/api/videos" else MAX_PHOTO_BYTES if scope.get("path") == "/api/resident/leads" else None
        if scope["type"] != "http" or scope.get("method") != "POST" or limit is None:
            return await self.app(scope, receive, send)
        limit += 65536  # Multipart boundaries and bounded form fields.
        headers = dict(scope.get("headers", []))
        try:
            length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            return await JSONResponse({"detail": "Invalid request length."}, status_code=400)(scope, receive, send)
        if length > limit:
            return await JSONResponse({"detail": "The upload exceeds the allowed request size."}, status_code=413)(scope, receive, send)
        received = 0
        async def limited_receive():
            nonlocal received
            message = await receive()
            received += len(message.get("body", b""))
            if received > limit:
                raise HTTPException(413, "The upload exceeds the allowed request size.")
            return message
        return await self.app(scope, limited_receive, send)


app.add_middleware(UploadBodyLimit)
app.add_middleware(CORSMiddleware, allow_origins=sorted(ALLOWED_ORIGINS), allow_credentials=True,
                   allow_methods=["GET", "POST", "PATCH", "PUT", "OPTIONS"], allow_headers=["Content-Type", "Range"])


@app.exception_handler(RequestValidationError)
async def validation_error(_request, error):
    messages = [f"{'.'.join(str(part) for part in item['loc'] if part != 'body')}: {item['msg']}" for item in error.errors()]
    return JSONResponse({"detail": "; ".join(messages)}, status_code=422)


@app.exception_handler(IntegrityError)
async def integrity_error(_request, _error):
    return JSONResponse({"detail": "This record conflicts with a saved record. Refresh and try again."}, status_code=409)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    if request.method in {"POST", "PATCH", "PUT", "DELETE"}:
        origin = request.headers.get("origin")
        if origin and origin not in ALLOWED_ORIGINS:
            return JSONResponse({"detail": "This request origin is not allowed."}, status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "same-origin"
    return response


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LoginPayload(Payload):
    email: str = PydanticField(min_length=3, max_length=254)
    password: str = PydanticField(min_length=1, max_length=256)


class ResidentLogin(Payload):
    email: str = PydanticField(min_length=3, max_length=254)
    code: str = PydanticField(min_length=1, max_length=12)


class ReviewPayload(Payload):
    action: str
    dismiss_reason: str | None = PydanticField(default=None, max_length=2000)
    incident_id: str | None = None


class IncidentCreate(Payload):
    title: str = PydanticField(min_length=3, max_length=180)
    location_id: str
    priority: str = "normal"
    guard_id: str | None = None
    alert_id: str | None = None
    lead_id: str | None = None


class IncidentPatch(Payload):
    status: str | None = None
    guard_id: str | None = None
    outcome: str | None = PydanticField(default=None, max_length=4000)
    public_reply: str | None = PydanticField(default=None, max_length=2000)


class LeadPatch(Payload):
    status: str | None = None
    public_reply: str | None = PydanticField(default=None, max_length=2000)


class LinkPayload(Payload):
    incident_id: str


class SearchPayload(Payload):
    query: str = PydanticField(min_length=1, max_length=1000)
    location_id: str | None = None
    time_from: datetime | None = None
    time_to: datetime | None = None


class RulesPayload(Payload):
    rules: dict


class StreamPayload(Payload):
    # Omit url to keep the saved address (the client only ever sees it masked); "" removes it.
    url: str | None = PydanticField(default=None, max_length=2000)
    enabled: bool
    segment_sec: int = 60


class SettingsPatch(Payload):
    retention_days: int | None = PydanticField(default=None, ge=1, le=365)
    search_threshold: float | None = PydanticField(default=None, ge=0.05, le=1)


class GuardPayload(Payload):
    name: str = PydanticField(min_length=2, max_length=100)
    shift: str = PydanticField(min_length=1, max_length=120)
    phone: str = PydanticField(min_length=3, max_length=40)


class UserPayload(LoginPayload):
    password: str = PydanticField(min_length=12, max_length=256)
    name: str = PydanticField(min_length=2, max_length=100)
    role: str


def require_record(session, cls, identifier):
    item = session.get(cls, identifier)
    if item is None:
        raise HTTPException(404, f"{cls.__name__} was not found.")
    return item


def audit(session, user, action, target, details=None):
    session.add(AuditLog(actor_id=user.id if user else None, action=action, target=target, details=details or {}))


def commit_refresh(session, reason, target=None):
    session.commit()
    publish_refresh(reason, target)


def rate_limit(key, maximum, seconds):
    now = time.monotonic()
    with _rate_lock:
        values = _rates[key]
        while values and values[0] <= now - seconds:
            values.popleft()
        if len(values) >= maximum:
            raise HTTPException(429, "Too many attempts. Please try again later.")
        values.append(now)


def email_value(value):
    value = value.strip().lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
        raise HTTPException(422, "Enter a valid email address.")
    return value


def iso_value(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
        if parsed.tzinfo is None:
            raise ValueError()
        return aware(parsed)
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(422, "Dates must include an ISO timezone offset.")


def validate_times(start, end):
    start, end = iso_value(start), iso_value(end)
    if end < start:
        raise HTTPException(422, "The end time must follow the start time.")
    if end - start > timedelta(days=31):
        raise HTTPException(422, "Choose a time range of 31 days or less.")
    if start > utcnow() + timedelta(minutes=5):
        raise HTTPException(422, "The reported time cannot be in the future.")
    return start, end


def priority_value(value):
    if value not in {"urgent", "high", "normal"}:
        raise HTTPException(422, "Choose urgent, high or normal priority.")
    return value


@app.get("/api/health")
def health():
    ai = {"detector": {"status": "unknown"}, "vlm": {"status": "unavailable"}, "embedding": {"status": "unavailable"}}
    try:
        from .vision import runtime_status
        status = runtime_status()
        ai["detector"] = {**status, "status": "ready" if status.get("active_provider") else "installed_unverified" if status.get("installed") else "missing"}
    except (ImportError, AttributeError):
        pass
    except Exception:
        ai["detector"] = {"status": "error", "message": "Detector health check failed."}
    try:
        from .local_ai import OLLAMA
        with urlopen(OLLAMA+"/api/tags", timeout=1) as result:
            models = json.load(result).get("models", [])
        names = {item.get("name", "") for item in models}
        from .local_ai import VLM
        ai["vlm"] = {"status": "installed" if VLM in names else "missing", "model": VLM}
        ai["embedding"] = {"status": "installed" if "qwen3-embedding:0.6b" in names else "missing", "model": "qwen3-embedding:0.6b"}
    except (URLError, OSError, ValueError):
        pass
    return {"status": "ok", "service": "JagaAI v3", "ai": ai}


@app.get("/api/auth/me")
def me(user=Depends(current_user)):
    return {"user": user_json(user) if user else None}


@app.post("/api/auth/login")
def login(payload: LoginPayload, request: Request, response: Response, session: Session = Depends(get_session)):
    email = email_value(payload.email)
    rate_limit(("login", request.client.host if request.client else "local", email), 12, 300)
    user = session.exec(select(User).where(User.email == email)).first()
    if not user or user.role not in {"admin", "supervisor"} or not verify_password(payload.password, user.password_hash):
        raise HTTPException(401, "Email or password is incorrect.")
    audit(session, user, "auth.login", user.id)
    establish_session(response, session, user)
    return {"user": user_json(user)}


@app.post("/api/auth/resident")
def resident_login(payload: ResidentLogin, request: Request, response: Response, session: Session = Depends(get_session)):
    email = email_value(payload.email)
    rate_limit(("resident_login", request.client.host if request.client else "local", email), 12, 300)
    if os.environ.get("JAGAAI_RESIDENT_DEMO", "1") != "1":
        raise HTTPException(503, "Resident demo login is disabled. An OTP provider has not been configured.")
    if payload.code != "246810":
        raise HTTPException(401, "The demo verification code is incorrect.")
    user = session.exec(select(User).where(User.email == email)).first()
    if user and user.role != "resident":
        raise HTTPException(403, "Use a resident email address for this entry.")
    if not user:
        user = User(email=email, name=email.split("@")[0], role="resident")
        session.add(user)
        session.flush()
    audit(session, user, "auth.resident_demo_login", user.id)
    establish_session(response, session, user)
    return {"user": user_json(user)}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response, session: Session = Depends(get_session), user=Depends(current_user)):
    token = request.cookies.get(COOKIE_NAME)
    if token:
        record = session.get(AuthSession, hashlib.sha256(token.encode()).hexdigest())
        if record:
            session.delete(record)
            audit(session, user, "auth.logout", record.user_id)
            session.commit()
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/api/bootstrap")
def bootstrap(session: Session = Depends(get_session), user: User = Depends(staff)):
    videos = session.exec(select(Video).order_by(Video.created_at.desc())).all()
    alerts = session.exec(select(Alert).order_by(Alert.created_at.desc())).all()
    alerts.sort(key=lambda item: ({"urgent": 0, "high": 1, "normal": 2}.get(item.priority, 2), item.status != "pending"))
    leads = session.exec(select(Lead).order_by(Lead.created_at.desc())).all()
    incidents = session.exec(select(Incident).order_by(Incident.updated_at.desc())).all()
    ack = [(aware(item.reviewed_at) - aware(item.created_at)).total_seconds() for item in alerts if item.reviewed_at]
    return {"user": user_json(user),
            "locations": [record_json(item) for item in session.exec(select(Location)).all()],
            "cameras": [camera_json(item) for item in session.exec(select(Camera)).all()],
            "videos": [video_json(item) for item in videos],
            "events": [record_json(item) for item in session.exec(select(Event).order_by(Event.created_at.desc())).all() if not item.verification.get('superseded')],
            "alerts": [alert_json(item, session) for item in alerts], "leads": [lead_json(item) for item in leads],
            "incidents": [record_json(item) for item in incidents],
            "guards": [record_json(item) for item in session.exec(select(Guard)).all()],
            "settings": record_json(session.get(AppSettings, "global")),
            "summary": {"alert_count": sum(item.status == "pending" for item in alerts),
                        "open_incidents": sum(item.status in {"open", "assigned"} for item in incidents),
                        "new_leads": sum(item.status == "received" for item in leads),
                        "median_ack_sec": statistics.median(ack) if ack else None,
                        "video_count": len(videos), "analysed_video_count": sum(item.status == "ready" for item in videos),
                        "pending_video_count": sum(item.status in {"uploaded", "queued", "processing"} for item in videos)}}


@app.get("/api/stream")
async def stream(request: Request, user: User = Depends(authenticated)):
    async def events():
        revision = -1
        heartbeat = time.monotonic()
        while not await request.is_disconnected():
            current, item = snapshot()
            if current != revision:
                revision = current
                # Resident sessions receive only a generic refresh, never management metadata.
                data = {"revision": current} if user.role == "resident" else item
                yield f"retry: 3000\nevent: refresh\nid: {current}\ndata: {json.dumps(data)}\n\n"
                heartbeat = time.monotonic()
            elif time.monotonic() - heartbeat >= 15:
                yield ": heartbeat\n\n"
                heartbeat = time.monotonic()
            await asyncio.sleep(0.5)
    return StreamingResponse(events(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"})


def timeline_item(user, action, text):
    return {"at": utcnow().isoformat(), "actor": user.name, "action": action, "text": text}


def evidence_for_alert(alert, session):
    event = session.get(Event, alert.event_id) if alert.event_id else None
    if event is None:
        raise HTTPException(410, "The source recording has expired.")
    return {"alert_id": alert.id, "event_id": event.id, "video_id": event.video_id,
            "start_sec": event.start_sec, "end_sec": event.end_sec, "type": event.type}


def attach_alert(session, alert, incident, user):
    existing = next((item for item in session.exec(select(Incident)).all() if any(e.get("alert_id") == alert.id for e in item.evidence)), None)
    if existing:
        if existing.id != incident.id:
            raise HTTPException(409, "This alert is already linked to another incident.")
        return
    if alert.status != "pending":
        raise HTTPException(409, "This alert has already been reviewed.")
    evidence = evidence_for_alert(alert, session)
    result = session.exec(update(Alert).where(Alert.id == alert.id, Alert.status == "pending").values(
        status="confirmed", reviewed_by=user.id, reviewed_at=utcnow()))
    if result.rowcount != 1:
        raise HTTPException(409, "This alert was reviewed by another operator.")
    incident.evidence = [*incident.evidence, evidence]
    incident.timeline = [*incident.timeline, timeline_item(user, "alert_confirmed", "Alert reviewed and linked to the incident.")]
    incident.updated_at = utcnow()
    session.add(incident)
    session.flush()
    session.refresh(alert)


def attach_lead(session, lead, incident, user):
    if lead.location_id != incident.location_id:
        raise HTTPException(422, "Choose an incident at the report's location.")
    if lead.incident_id and lead.incident_id != incident.id:
        raise HTTPException(409, "This lead is already linked to another incident.")
    if lead.incident_id == incident.id:
        return
    lead.incident_id = incident.id
    lead.status = "resolved" if incident.status in {"resolved", "closed"} else "in_progress"
    incident.evidence = [*incident.evidence, {"lead_id": lead.id, "text": lead.text}]
    incident.timeline = [*incident.timeline, timeline_item(user, "lead_linked", "Resident lead linked to the incident.")]
    incident.updated_at = utcnow()
    session.add(lead)
    session.add(incident)


@app.post("/api/alerts/{alert_id}/review")
def review_alert(alert_id: str, payload: ReviewPayload, session: Session = Depends(get_session), user: User = Depends(staff)):
    alert = require_record(session, Alert, alert_id)
    if payload.action not in {"confirm", "dismiss", "link"}:
        raise HTTPException(422, "Choose confirm, dismiss or link.")
    if payload.action == "dismiss":
        if not payload.dismiss_reason or not payload.dismiss_reason.strip():
            raise HTTPException(422, "Explain why this alert is being dismissed.")
        if alert.status != "pending":
            raise HTTPException(409, "This alert has already been reviewed.")
        result = session.exec(update(Alert).where(Alert.id == alert.id, Alert.status == "pending").values(
            status="dismissed", dismiss_reason=payload.dismiss_reason.strip(), reviewed_by=user.id, reviewed_at=utcnow()))
        if result.rowcount != 1:
            raise HTTPException(409, "This alert was reviewed by another operator.")
        audit(session, user, "alert.dismiss", alert.id, {"reason": payload.dismiss_reason.strip()})
        commit_refresh(session, "alert", alert.id)
        session.refresh(alert)
        return {"alert": alert_json(alert, session)}
    if payload.action == "link" and not payload.incident_id:
        raise HTTPException(422, "Choose an incident to link.")
    if payload.incident_id:
        incident = require_record(session, Incident, payload.incident_id)
        if incident.status == "closed":
            raise HTTPException(409, "Closed incidents cannot accept new evidence.")
    else:
        existing = next((item for item in session.exec(select(Incident)).all() if any(e.get("alert_id") == alert.id for e in item.evidence)), None)
        if existing:
            return {"alert": alert_json(alert, session), "incident": record_json(existing)}
        evidence = evidence_for_alert(alert, session)
        event = session.get(Event, alert.event_id)
        camera = require_record(session, Camera, event.camera_id)
        incident = Incident(title="Review: " + event.type.replace("_", " "), location_id=camera.location_id,
                            priority=alert.priority, timeline=[timeline_item(user, "created", "Incident created from a reviewed alert.")])
        session.add(incident)
        session.flush()
    attach_alert(session, alert, incident, user)
    audit(session, user, "alert.confirm", alert.id, {"incident_id": incident.id})
    commit_refresh(session, "incident", incident.id)
    return {"alert": alert_json(alert, session), "incident": record_json(incident)}


@app.post("/api/incidents")
def create_incident(payload: IncidentCreate, session: Session = Depends(get_session), user: User = Depends(staff)):
    require_record(session, Location, payload.location_id)
    priority_value(payload.priority)
    if not payload.title.strip() or len(payload.title.strip()) < 3:
        raise HTTPException(422, "An incident title needs at least three characters.")
    if payload.guard_id:
        require_record(session, Guard, payload.guard_id)
    incident = Incident(title=payload.title.strip(), location_id=payload.location_id, priority=payload.priority,
                        guard_id=payload.guard_id, status="assigned" if payload.guard_id else "open",
                        timeline=[timeline_item(user, "created", "Incident created." )])
    session.add(incident)
    session.flush()
    if payload.alert_id:
        attach_alert(session, require_record(session, Alert, payload.alert_id), incident, user)
    if payload.lead_id:
        attach_lead(session, require_record(session, Lead, payload.lead_id), incident, user)
    audit(session, user, "incident.create", incident.id)
    commit_refresh(session, "incident", incident.id)
    return record_json(incident)


@app.patch("/api/incidents/{incident_id}")
def patch_incident(incident_id: str, payload: IncidentPatch, session: Session = Depends(get_session), user: User = Depends(staff)):
    incident = require_record(session, Incident, incident_id)
    if incident.status == "closed":
        raise HTTPException(409, "Closed incidents cannot be edited.")
    if payload.status and payload.status not in {"open", "assigned", "resolved", "closed"}:
        raise HTTPException(422, "Choose a valid incident status.")
    changes = payload.model_dump(exclude_unset=True)
    guard_id = changes.get("guard_id", incident.guard_id)
    if guard_id:
        require_record(session, Guard, guard_id)
    next_status = payload.status or incident.status
    # The form submits its current status along with the selected guard.
    if next_status == "open" and guard_id:
        next_status = "assigned"
        changes["status"] = next_status
    outcome = payload.outcome if payload.outcome is not None else incident.outcome
    if next_status == "assigned" and not guard_id:
        raise HTTPException(422, "Choose a guard before assigning this incident.")
    if next_status in {"resolved", "closed"} and not outcome.strip():
        raise HTTPException(422, "Record the outcome before resolving or closing an incident.")
    if next_status == "closed" and incident.status != "resolved":
        raise HTTPException(422, "Resolve the incident before closing it.")
    if incident.status == "resolved" and next_status not in {"resolved", "closed"}:
        raise HTTPException(422, "A resolved incident can only be closed.")
    for key in ("status", "guard_id", "outcome"):
        if key in changes and (changes[key] is not None or key == "guard_id"):
            setattr(incident, key, changes[key])
    if payload.status is None and payload.guard_id and incident.status == "open":
        incident.status = "assigned"
    incident.updated_at = utcnow()
    incident.timeline = [*incident.timeline, timeline_item(user, "updated", f"Status: {incident.status}.")]
    for lead in session.exec(select(Lead).where(Lead.incident_id == incident.id)).all():
        if payload.public_reply is not None:
            lead.public_reply = payload.public_reply.strip()
        lead.status = "resolved" if incident.status in {"resolved", "closed"} else "in_progress"
        session.add(lead)
    session.add(incident)
    audit(session, user, "incident.update", incident.id, {"fields": list(changes), "status": incident.status})
    commit_refresh(session, "incident", incident.id)
    return record_json(incident)


@app.post("/api/leads/{lead_id}/link")
def link_lead(lead_id: str, payload: LinkPayload, session: Session = Depends(get_session), user: User = Depends(staff)):
    lead = require_record(session, Lead, lead_id)
    incident = require_record(session, Incident, payload.incident_id)
    if incident.status == "closed":
        raise HTTPException(409, "Closed incidents cannot accept new evidence.")
    attach_lead(session, lead, incident, user)
    audit(session, user, "lead.link", lead.id, {"incident_id": incident.id})
    commit_refresh(session, "lead", lead.id)
    return lead_json(lead)


@app.patch("/api/leads/{lead_id}")
def patch_lead(lead_id: str, payload: LeadPatch, session: Session = Depends(get_session), user: User = Depends(staff)):
    lead = require_record(session, Lead, lead_id)
    if payload.status is not None:
        if payload.status not in {"received", "in_progress", "resolved"}:
            raise HTTPException(422, "Choose a valid lead status.")
        if lead.incident_id:
            incident = require_record(session, Incident, lead.incident_id)
            expected = "resolved" if incident.status in {"resolved", "closed"} else "in_progress"
            if payload.status != expected:
                raise HTTPException(409, "This report follows its linked incident. Update the incident status instead.")
        lead.status = payload.status
    if payload.public_reply is not None:
        lead.public_reply = payload.public_reply.strip()
    session.add(lead)
    audit(session, user, "lead.update", lead.id, {"fields": list(payload.model_fields_set)})
    commit_refresh(session, "lead", lead.id)
    return lead_json(lead)


@app.post("/api/search")
def search_videos(payload: SearchPayload, session: Session = Depends(get_session), user: User = Depends(staff)):
    if payload.location_id:
        require_record(session, Location, payload.location_id)
    if payload.time_from:
        iso_value(payload.time_from)
    if payload.time_to:
        iso_value(payload.time_to)
    if payload.time_from and payload.time_to and payload.time_to < payload.time_from:
        raise HTTPException(422, "The end time must follow the start time.")
    try:
        from .search import search
    except ImportError:
        raise HTTPException(503, "Local search has not been installed.")
    result = search(session, payload.model_dump(mode="json", exclude_unset=True))
    audit(session, user, "search.query", "videos", {"query": payload.query, "location_id": payload.location_id})
    session.commit()
    return result


def ffprobe_path():
    # A configured path that does not exist must not hide a system-wide FFprobe.
    bundled = Path(__file__).resolve().parents[2] / "tools" / "ffprobe.exe"
    for candidate in (os.environ.get("JAGAAI_FFPROBE"), str(bundled), shutil.which("ffprobe")):
        if candidate and Path(candidate).is_file():
            return candidate
    raise HTTPException(503, "FFprobe is required to validate uploaded recordings. Install FFmpeg and make sure ffprobe is on PATH.")


def probe_video(path):
    try:
        process = subprocess.run([ffprobe_path(), "-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=duration:stream=codec_type,duration", "-of", "json", str(path)],
                                 capture_output=True, timeout=30, check=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        probe = json.loads(process.stdout)
        if not any(stream.get("codec_type") == "video" for stream in probe.get("streams", [])):
            raise ValueError()
        duration = float(probe.get("format", {}).get("duration", 0))
        if not math.isfinite(duration) or not 0 < duration <= 4 * 3600:
            raise ValueError()
        return duration
    except (subprocess.SubprocessError, ValueError, KeyError, OSError):
        raise HTTPException(422, "The MP4 must contain a readable video track with a duration of up to four hours.")


async def store_video(upload, destination):
    total = 0
    try:
        with destination.open("xb") as output:
            while chunk := await upload.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_VIDEO_BYTES:
                    raise HTTPException(413, f"The recording exceeds the {MAX_VIDEO_BYTES // (1024 * 1024)} MB upload limit.")
                output.write(chunk)
        with destination.open("rb") as source:
            signature = source.read(64)
        if total < 32 or signature[4:8] != b"ftyp":
            raise HTTPException(422, "Upload an MP4 recording, not a renamed file.")
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    finally:
        await upload.close()


@app.post("/api/videos")
async def upload_video(camera_id: str = Form(...), recorded_at: str = Form(...), file: UploadFile = File(...),
                       session: Session = Depends(get_session), user: User = Depends(staff)):
    require_record(session, Camera, camera_id)
    recorded = iso_value(recorded_at)
    if recorded > utcnow() + timedelta(minutes=5):
        raise HTTPException(422, "The recording time cannot be in the future.")
    filename = Path((file.filename or "recording.mp4").replace("\\", "/")).name
    if not filename.lower().endswith(".mp4"):
        raise HTTPException(422, "Only MP4 recordings are accepted.")
    video_id = uid()
    folder = DATA_DIR / "videos"
    folder.mkdir(exist_ok=True)
    path = folder / f"{video_id}.mp4"
    await store_video(file, path)
    try:
        duration = await asyncio.to_thread(probe_video, path)
        retention_days = session.get(AppSettings, "global").retention_days
        video = Video(id=video_id, camera_id=camera_id, path=str(path), filename=filename[:255], recorded_at=recorded,
                      duration_sec=duration, expires_at=utcnow() + timedelta(days=retention_days), status="queued")
        session.add(video)
        audit(session, user, "video.upload", video.id, {"filename": video.filename, "duration_sec": duration})
        commit_refresh(session, "video", video.id)
        jobs.enqueue(video.id)
        return video_json(video)
    except Exception:
        path.unlink(missing_ok=True)
        raise


@app.post("/api/videos/{video_id}/analyse")
def analyse_video(video_id: str, force: bool = False, session: Session = Depends(get_session), user: User = Depends(staff)):
    video = require_record(session, Video, video_id)
    if aware(video.expires_at) <= utcnow():
        raise HTTPException(410, "This recording has expired.")
    # A finished recording is only re-queued to retry incomplete descriptions or when explicitly forced.
    rerun = video.status == "ready" and (force or video.description_status in {"failed", "partial"})
    if video.status in {"queued", "processing", "ready"} and not rerun:
        return video_json(video)
    if video.status == "ready" and video.description_status == "processing":
        return video_json(video)
    video.status = "queued"
    video.error = None
    if rerun:
        video.description_status = "not_started"
    session.add(video)
    audit(session, user, "video.analyse", video.id)
    commit_refresh(session, "video", video.id)
    jobs.enqueue(video.id)
    return video_json(video)


def byte_range(header, size):
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", header or "")
    if not match or not any(match.groups()):
        raise HTTPException(416, "The requested byte range is invalid.", headers={"Content-Range": f"bytes */{size}"})
    first, last = match.groups()
    if not first:
        suffix = int(last)
        if suffix <= 0:
            raise HTTPException(416, "The requested byte range is invalid.", headers={"Content-Range": f"bytes */{size}"})
        start, end = max(0, size - suffix), size - 1
    else:
        start, end = int(first), min(int(last), size - 1) if last else size - 1
    if start >= size or end < start:
        raise HTTPException(416, "The requested byte range is unavailable.", headers={"Content-Range": f"bytes */{size}"})
    return start, end


@app.get("/api/videos/{video_id}/media")
def video_media(video_id: str, request: Request, session: Session = Depends(get_session), user: User = Depends(staff)):
    video = require_record(session, Video, video_id)
    if aware(video.expires_at) <= utcnow():
        raise HTTPException(410, "This recording has expired.")
    try:
        path = private_path(video.path)
    except ValueError:
        raise HTTPException(404, "The recording is unavailable.")
    if not path.is_file():
        raise HTTPException(404, "The recording is unavailable.")
    audit(session, user, "video.view", video.id, {"range": request.headers.get("range")})
    session.commit()
    size = path.stat().st_size
    headers = {"Accept-Ranges": "bytes", "Content-Disposition": "inline"}
    requested = request.headers.get("range")
    if not requested:
        return FileResponse(path, media_type="video/mp4", headers=headers)
    start, end = byte_range(requested, size)
    def chunks():
        with path.open("rb") as source:
            source.seek(start)
            remaining = end - start + 1
            while remaining:
                data = source.read(min(1024 * 1024, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data
    headers.update({"Content-Range": f"bytes {start}-{end}/{size}", "Content-Length": str(end - start + 1)})
    return StreamingResponse(chunks(), status_code=206, media_type="video/mp4", headers=headers)


@app.get("/api/videos/{video_id}/keyframes/{filename}")
def keyframe(video_id: str, filename: str, session: Session = Depends(get_session), user: User = Depends(staff)):
    video = require_record(session, Video, video_id)
    if aware(video.expires_at) <= utcnow():
        raise HTTPException(410, "This recording has expired.")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+\.(jpg|jpeg|png)", filename):
        raise HTTPException(404, "The keyframe is unavailable.")
    path = DATA_DIR / "frames" / video_id / filename
    if not path.is_file():
        raise HTTPException(404, "The keyframe is unavailable.")
    audit(session, user, "keyframe.view", video_id)
    session.commit()
    return FileResponse(path, media_type="image/png" if path.suffix == ".png" else "image/jpeg")


def validate_rules(rules):
    if set(rules) - {"R1", "R3"}:
        raise HTTPException(422, "Only R1 vehicle loitering and R3 restricted entry are supported in this workspace.")
    defaults = {"R1": {"enabled", "loiter_sec", "window_sec", "min_vehicles", "min_dwell_sec", "zone"},
                "R3": {"enabled", "active_start", "active_end", "zone", "line"}}
    for rule, values in rules.items():
        if not isinstance(values, dict) or set(values) - defaults[rule]:
            raise HTTPException(422, f"{rule} contains unsupported parameters.")
        if "enabled" in values and type(values["enabled"]) is not bool:
            raise HTTPException(422, "Rule enabled must be true or false.")
        for key in ("loiter_sec", "window_sec", "min_vehicles", "min_dwell_sec"):
            if key in values and (type(values[key]) not in {int, float} or not math.isfinite(values[key]) or not 1 <= values[key] <= 3600):
                raise HTTPException(422, f"{key} must be between 1 and 3600.")
        for key in ("active_start", "active_end"):
            if key in values and (not isinstance(values[key], str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", values[key])):
                raise HTTPException(422, "Active hours must use HH:MM in Malaysia time.")
        for key in ("zone", "line"):
            points = values.get(key)
            if points is None:
                continue
            required = 2 if key == "line" else 3
            if not isinstance(points, list) or not required <= len(points) <= (2 if key == "line" else 16):
                raise HTTPException(422, "A zone needs 3–16 points and a line needs two points.")
            if any(not isinstance(point, list) or len(point) != 2 or any(type(v) not in {int, float} or not math.isfinite(v) or not 0 <= v <= 1 for v in point) for point in points):
                raise HTTPException(422, "Zone coordinates must be normalized between zero and one.")


@app.put("/api/cameras/{camera_id}/rules")
def camera_rules(camera_id: str, payload: RulesPayload, session: Session = Depends(get_session), user: User = Depends(staff)):
    camera = require_record(session, Camera, camera_id)
    validate_rules(payload.rules)
    camera.rules = {**camera.rules, **{key: {**camera.rules.get(key, {}), **value} for key, value in payload.rules.items()}}
    session.add(camera)
    audit(session, user, "camera.rules", camera.id, {"rules": payload.rules})
    commit_refresh(session, "camera", camera.id)
    return camera_json(camera)


@app.put("/api/cameras/{camera_id}/stream")
def camera_stream(camera_id: str, payload: StreamPayload, session: Session = Depends(get_session), user: User = Depends(admin)):
    camera = require_record(session, Camera, camera_id)
    if payload.segment_sec not in live.SEGMENT_CHOICES:
        raise HTTPException(422, "Choose a segment length of 30, 60, 120 or 300 seconds.")
    if payload.url is not None:
        url = payload.url.strip()
        if url and "***" in url:
            raise HTTPException(422, "Enter the full camera address, or leave it blank to keep the saved one.")
        if url and (message := live.validate_source(url)):
            raise HTTPException(422, message)
        camera.stream_url = url or None
    if payload.enabled and not camera.stream_url:
        raise HTTPException(422, "Add a camera address before turning on live recording.")
    camera.stream_enabled = payload.enabled
    camera.segment_sec = payload.segment_sec
    camera.source_type = "stream" if camera.stream_url else "upload"
    session.add(camera)
    # The address may contain a password; the audit log keeps only the masked form.
    audit(session, user, "camera.stream", camera.id, {"url": live.mask_url(camera.stream_url), "enabled": camera.stream_enabled,
                                                       "segment_sec": camera.segment_sec})
    session.commit()
    live.sync(camera.id)
    session.refresh(camera)
    publish_refresh("camera", camera.id)
    return camera_json(camera)


@app.get("/api/live")
def live_status(session: Session = Depends(get_session), user: User = Depends(staff)):
    return {"cameras": [{"camera_id": c.id, "enabled": c.stream_enabled, "segment_sec": c.segment_sec, "status": live.status(c.id)}
                        for c in session.exec(select(Camera)).all() if c.stream_url]}


@app.get("/api/settings")
def settings(session: Session = Depends(get_session), user: User = Depends(staff)):
    result = {"settings": record_json(session.get(AppSettings, "global")), "guards": [record_json(item) for item in session.exec(select(Guard)).all()]}
    if user.role == "admin":
        result["users"] = [user_json(item) for item in session.exec(select(User).where(User.role.in_(["admin", "supervisor"]))).all()]
        result["audit_logs"] = [record_json(item) for item in session.exec(select(AuditLog).order_by(AuditLog.created_at.desc()).limit(200)).all()]
    return result


@app.patch("/api/settings")
def patch_settings(payload: SettingsPatch, session: Session = Depends(get_session), user: User = Depends(admin)):
    settings = session.get(AppSettings, "global")
    for field, value in payload.model_dump(exclude_unset=True).items():
        if value is None:
            raise HTTPException(422, "Settings values cannot be null.")
        setattr(settings, field, value)
    if payload.retention_days is not None:
        for video in session.exec(select(Video)).all():
            video.expires_at = aware(video.created_at) + timedelta(days=payload.retention_days)
            session.add(video)
    session.add(settings)
    audit(session, user, "settings.update", "global", payload.model_dump(exclude_unset=True))
    commit_refresh(session, "settings")
    if payload.retention_days is not None:
        expire_videos()
    return record_json(settings)


@app.post("/api/guards")
def create_guard(payload: GuardPayload, session: Session = Depends(get_session), user: User = Depends(admin)):
    guard = Guard(**{key: value.strip() for key, value in payload.model_dump().items()})
    if not all((guard.name, guard.shift, guard.phone)):
        raise HTTPException(422, "Complete the guard name, shift and phone.")
    session.add(guard)
    audit(session, user, "guard.create", guard.id)
    commit_refresh(session, "guard", guard.id)
    return record_json(guard)


@app.patch("/api/guards/{guard_id}")
def patch_guard(guard_id: str, payload: GuardPayload, session: Session = Depends(get_session), user: User = Depends(admin)):
    guard = require_record(session, Guard, guard_id)
    for key, value in payload.model_dump().items():
        if not value.strip():
            raise HTTPException(422, "Complete the guard name, shift and phone.")
        setattr(guard, key, value.strip())
    session.add(guard)
    audit(session, user, "guard.update", guard.id)
    commit_refresh(session, "guard", guard.id)
    return record_json(guard)


@app.post("/api/users")
def create_user(payload: UserPayload, session: Session = Depends(get_session), user: User = Depends(admin)):
    if payload.role not in {"admin", "supervisor"}:
        raise HTTPException(422, "Staff roles are admin or supervisor; guards do not have accounts.")
    email = email_value(payload.email)
    if session.exec(select(User).where(User.email == email)).first():
        raise HTTPException(409, "This email already has an account.")
    account = User(email=email, password_hash=hash_password(payload.password), name=payload.name.strip(), role=payload.role)
    session.add(account)
    audit(session, user, "user.create", account.id, {"role": account.role})
    commit_refresh(session, "user", account.id)
    return user_json(account)


@app.get("/api/resident/context")
def resident_context(session: Session = Depends(get_session)):
    return {"locations": [record_json(item) for item in session.exec(select(Location)).all()]}


@app.get("/api/resident/leads")
def resident_leads(session: Session = Depends(get_session), user: User = Depends(resident)):
    return [lead_json(item, public=True) for item in session.exec(select(Lead).where(Lead.resident_id == user.id).order_by(Lead.created_at.desc())).all()]


@app.get("/api/resident/leads/{lead_id}")
def resident_lead(lead_id: str, session: Session = Depends(get_session), user: User = Depends(resident)):
    lead = session.exec(select(Lead).where(Lead.id == lead_id, Lead.resident_id == user.id)).first()
    if not lead:
        raise HTTPException(404, "This lead was not found.")
    return lead_json(lead, public=True)


@app.post("/api/resident/leads")
async def submit_lead(location_id: str = Form(...), time_from: str = Form(...), time_to: str = Form(...), text: str = Form(...),
                      photo: UploadFile | None = File(default=None), session: Session = Depends(get_session), user: User = Depends(resident)):
    rate_limit(("resident_lead", user.id), 5, 600)
    require_record(session, Location, location_id)
    start, end = validate_times(time_from, time_to)
    if not 3 <= len(text.strip()) <= 2000:
        raise HTTPException(422, "Describe what happened in 3–2000 characters.")
    path = None
    if photo and photo.filename:
        data = await photo.read(MAX_PHOTO_BYTES + 1)
        await photo.close()
        if len(data) > MAX_PHOTO_BYTES:
            raise HTTPException(413, "The photo exceeds the 8 MB upload limit.")
        try:
            with Image.open(io.BytesIO(data)) as image:
                image.verify()
            with Image.open(io.BytesIO(data)) as image:
                if image.format not in {"JPEG", "PNG", "WEBP"} or image.width * image.height > 25_000_000:
                    raise ValueError()
                # Re-encode to remove EXIF location information and active/polyglot payloads.
                image = image.convert("RGB")
                image.thumbnail((1920, 1920))
                folder = DATA_DIR / "photos"
                folder.mkdir(exist_ok=True)
                path = folder / f"{uid()}.jpg"
                image.save(path, "JPEG", quality=88)
        except (UnidentifiedImageError, ValueError, OSError, Image.DecompressionBombError):
            raise HTTPException(422, "Upload a readable JPG, PNG or WebP photo.")
    try:
        lead = Lead(resident_id=user.id, location_id=location_id, time_from=start, time_to=end, text=text.strip(), photo_path=str(path) if path else None)
        session.add(lead)
        audit(session, user, "lead.submit", lead.id)
        commit_refresh(session, "lead", lead.id)
        return lead_json(lead, public=True)
    except Exception:
        if path:
            path.unlink(missing_ok=True)
        raise


@app.get("/api/leads/{lead_id}/photo")
def lead_photo(lead_id: str, session: Session = Depends(get_session), user: User = Depends(staff)):
    lead = require_record(session, Lead, lead_id)
    if not lead.photo_path:
        raise HTTPException(404, "This lead has no photo.")
    try:
        path = private_path(lead.photo_path)
    except ValueError:
        raise HTTPException(404, "This photo is unavailable.")
    if not path.is_file():
        raise HTTPException(404, "This photo is unavailable.")
    audit(session, user, "lead.photo_view", lead.id)
    session.commit()
    return FileResponse(path, media_type="image/jpeg")
