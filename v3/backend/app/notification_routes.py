"""Staff configuration/history, scoped guard acceptance and signed Twilio callbacks."""
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlmodel import Session, select

from . import notifications as notify
from . import voice_dialogue as dialogue
from .auth import admin, staff
from .database import get_session
from .models import Alert, AuditLog, GuardDispatch, GuardVoiceCall, NotificationAttempt, NotificationPolicy, User, utcnow
from .realtime import publish_refresh

router = APIRouter()


class PolicyInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    mode: str = "simulate"
    primary_guard_id: str | None = None
    escalation_guard_id: str | None = None
    call_after_sec: int = Field(default=60, ge=15, le=1800)
    escalate_after_sec: int = Field(default=180, ge=30, le=3600)
    cooldown_sec: int = Field(default=600, ge=60, le=3600)
    urgent_call: bool = True
    sms_fallback: bool = True
    voice_language: str = "zh-CN"


class GuardLinkInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dispatch_id: str = Field(min_length=1, max_length=80)
    guard_id: str = Field(min_length=1, max_length=80)
    token: str = Field(min_length=1, max_length=128)


class ContactInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    guard_id: str | None = Field(default=None, max_length=80)


class VoiceTurnInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    turn: int = Field(ge=1, le=20)
    speech: str = Field(default="", max_length=500)
    digits: str = Field(default="", max_length=1, pattern=r"^[0-9]?$" )


@router.get("/api/notifications/config")
def config(session: Session = Depends(get_session), _user: User = Depends(staff)):
    return notify.policy_json(session)


@router.put("/api/notifications/config")
def save_config(payload: PolicyInput, session: Session = Depends(get_session), user: User = Depends(admin)):
    if payload.mode not in {"simulate", "live"}:
        raise HTTPException(422, "Choose simulation or live notifications.")
    if payload.voice_language not in dialogue.LANGUAGES:
        raise HTTPException(422, "Choose Mandarin Chinese or English for calls.")
    if payload.escalate_after_sec <= payload.call_after_sec:
        raise HTTPException(422, "Escalation must follow the first call delay.")
    candidate = NotificationPolicy(**payload.model_dump())
    if candidate.enabled or candidate.mode == "live" or candidate.primary_guard_id or candidate.escalation_guard_id:
        notify.validate_contacts(session, candidate)
    policy = session.get(NotificationPolicy, "global")
    for key, value in payload.model_dump().items():
        setattr(policy, key, value)
    session.add(policy)
    # A policy edit must not leave a previous contact or timing plan running.
    for dispatch in session.exec(select(GuardDispatch).where(GuardDispatch.status.in_(notify.OPEN))).all():
        notify.cancel(session, dispatch, "Notification settings changed; previous notification plan stopped.")
    session.add(AuditLog(actor_id=user.id, action="notification.policy_updated", target="global", details=payload.model_dump()))
    session.commit()
    publish_refresh("notification")
    return notify.policy_json(session)


@router.get("/api/notifications")
def history(alert_id: str | None = None, incident_id: str | None = None,
            session: Session = Depends(get_session), _user: User = Depends(staff)):
    query = select(GuardDispatch).order_by(GuardDispatch.created_at.desc())
    if alert_id:
        query = query.where(GuardDispatch.alert_id == alert_id)
    if incident_id:
        query = query.where(GuardDispatch.incident_id == incident_id)
    return [notify.dispatch_json(session, item) for item in session.exec(query.limit(50)).all()]


@router.post("/api/alerts/{alert_id}/notify")
def send_alert(alert_id: str, payload: ContactInput, session: Session = Depends(get_session), user: User = Depends(staff)):
    alert = session.get(Alert, alert_id)
    if not alert:
        raise HTTPException(404, "This alert was not found.")
    # Serialise creation before checking the unique alert receipt (SQLite).
    from sqlalchemy import update
    session.exec(update(Alert).where(Alert.id == alert_id).values(priority=Alert.priority))
    dispatch = notify.enqueue_alert(session, alert, automatic=False, guard_id=payload.guard_id)
    session.add(AuditLog(actor_id=user.id, action="notification.requested", target=dispatch.id, details={"mode": dispatch.mode}))
    session.commit()
    publish_refresh("notification", dispatch.id)
    return notify.dispatch_json(session, dispatch)


@router.post("/api/notifications/{dispatch_id}/cancel")
def cancel_dispatch(dispatch_id: str, session: Session = Depends(get_session), user: User = Depends(staff)):
    dispatch = session.get(GuardDispatch, dispatch_id)
    if not dispatch:
        raise HTTPException(404, "This notification was not found.")
    notify.cancel(session, dispatch, "Stopped by " + user.name + ".")
    session.add(AuditLog(actor_id=user.id, action="notification.cancelled", target=dispatch.id))
    session.commit()
    publish_refresh("notification", dispatch.id)
    return notify.dispatch_json(session, dispatch)


@router.post("/api/notifications/{dispatch_id}/acknowledge")
def record_acceptance(dispatch_id: str, payload: ContactInput, session: Session = Depends(get_session), user: User = Depends(staff)):
    dispatch = session.get(GuardDispatch, dispatch_id)
    if not dispatch:
        raise HTTPException(404, "This notification was not found.")
    if not payload.guard_id:
        raise HTTPException(422, "Choose the guard who confirmed acceptance.")
    notify.acknowledge(session, dispatch, payload.guard_id, "control_room", user.name)
    session.commit()
    publish_refresh("notification", dispatch.id)
    return notify.dispatch_json(session, dispatch)


def guard_summary(dispatch, guard_id):
    return {"id": dispatch.id, "title": dispatch.title, "location": dispatch.location,
        "priority": dispatch.priority, "event_at": notify.aware(dispatch.event_at).isoformat(),
        "status": dispatch.status, "mode": dispatch.mode, "reason": dispatch.reason,
        "guard_name": dispatch.primary_name if guard_id == dispatch.primary_guard_id else dispatch.escalation_name,
        "acknowledged_name": dispatch.acknowledged_name,
        "acknowledged_at": notify.aware(dispatch.acknowledged_at).isoformat() if dispatch.acknowledged_at else None}


@router.post("/api/guard/notification")
def guard_view(payload: GuardLinkInput, session: Session = Depends(get_session)):
    dispatch = notify.authorized_dispatch(session, **payload.model_dump())
    return guard_summary(dispatch, payload.guard_id)


@router.post("/api/guard/accept")
def guard_accept(payload: GuardLinkInput, session: Session = Depends(get_session)):
    dispatch = notify.authorized_dispatch(session, **payload.model_dump())
    notify.acknowledge(session, dispatch, payload.guard_id, "guard_link")
    session.commit()
    publish_refresh("notification", dispatch.id)
    return guard_summary(dispatch, payload.guard_id)


@router.post("/api/notifications/{dispatch_id}/voice-demo")
def start_voice_demo(dispatch_id: str, session: Session = Depends(get_session), user: User = Depends(staff)):
    from sqlalchemy import update
    session.exec(update(GuardDispatch).where(GuardDispatch.id == dispatch_id).values(reason=GuardDispatch.reason))
    dispatch = session.get(GuardDispatch, dispatch_id)
    if not dispatch or dispatch.mode != "simulate" or session.get(NotificationPolicy, "global").mode != "simulate":
        raise HTTPException(409, "Call rehearsal is only available in simulation mode.")
    row = session.exec(select(NotificationAttempt).where(NotificationAttempt.dispatch_id == dispatch.id,
        NotificationAttempt.channel == "voice", NotificationAttempt.stage == "primary")).first()
    if not row:
        raise HTTPException(404, "No call was scheduled for this notification.")
    call = dialogue.start(session, dispatch, row)
    dialogue.check(session, dispatch, row, call)
    if call.ended_at:
        # A rehearsal may be repeated; each run retains its own deadline and transcript.
        call = dialogue.start(session, dispatch, row)
    notify.progress(row, "simulated")
    session.add(row)
    session.add(AuditLog(actor_id=user.id, action="notification.voice_rehearsal", target=call.id))
    session.commit()
    publish_refresh("notification", dispatch.id)
    return dialogue.call_json(dispatch, call)


def simulated_call(session, call_id):
    from sqlalchemy import update
    session.exec(update(GuardVoiceCall).where(GuardVoiceCall.id == call_id).values(end_reason=GuardVoiceCall.end_reason))
    call = session.get(GuardVoiceCall, call_id)
    row = session.get(NotificationAttempt, call.attempt_id) if call else None
    dispatch = session.get(GuardDispatch, row.dispatch_id) if row else None
    if not dispatch or dispatch.mode != "simulate" or session.get(NotificationPolicy, "global").mode != "simulate":
        raise HTTPException(404, "This simulated call was not found.")
    dialogue.check(session, dispatch, row, call)
    return call, row, dispatch


@router.get("/api/notifications/voice-demo/{call_id}")
def get_voice_demo(call_id: str, session: Session = Depends(get_session), _user: User = Depends(staff)):
    call, _row, dispatch = simulated_call(session, call_id)
    session.commit()
    return dialogue.call_json(dispatch, call)


@router.post("/api/notifications/voice-demo/{call_id}/turn")
def demo_voice_turn(call_id: str, payload: VoiceTurnInput, session: Session = Depends(get_session), _user: User = Depends(staff)):
    call, row, dispatch = simulated_call(session, call_id)
    dialogue.respond(session, dispatch, row, call, **payload.model_dump())
    session.commit()
    publish_refresh("notification", dispatch.id)
    return dialogue.call_json(dispatch, call)


@router.post("/api/notifications/voice-demo/{call_id}/end")
def end_voice_demo(call_id: str, session: Session = Depends(get_session), _user: User = Depends(staff)):
    call, _row, dispatch = simulated_call(session, call_id)
    dialogue.end(session, call, "operator_ended")
    session.commit()
    publish_refresh("notification", dispatch.id)
    return dialogue.call_json(dispatch, call)


async def signed_attempt(request, session, attempt_id):
    config = notify.provider_config()
    if not notify.readiness(False)["ready"]:
        raise HTTPException(503, "The notification provider is not configured.")
    form = await request.form(max_fields=100, max_files=0)
    from twilio.request_validator import RequestValidator
    # Use our configured public origin, never untrusted forwarded host headers.
    url = config["JAGAAI_PUBLIC_URL"].rstrip("/") + request.url.path
    if request.url.query:
        url += "?" + request.url.query
    if not RequestValidator(config["TWILIO_AUTH_TOKEN"]).validate(url, form, request.headers.get("X-Twilio-Signature", "")):
        raise HTTPException(403, "Invalid provider signature.")
    row = session.get(NotificationAttempt, attempt_id)
    dispatch = session.get(GuardDispatch, row.dispatch_id) if row else None
    if not row or not dispatch or dispatch.mode != "live" or row.status in {"queued", "simulated", "cancelled"}:
        raise HTTPException(404, "This provider request was not found.")
    sid = str(form.get("CallSid" if row.channel == "voice" else "MessageSid", ""))
    import re
    if (form.get("AccountSid") != config["TWILIO_ACCOUNT_SID"] or
            not re.fullmatch(r"CA[0-9a-fA-F]{32}" if row.channel == "voice" else r"(?:SM|MM)[0-9a-fA-F]{32}", sid) or
            form.get("To") != ("whatsapp:" if row.channel == "whatsapp" else "") + row.phone or
            (row.provider_sid and row.provider_sid != sid)):
        raise HTTPException(403, "Provider account, call/message or recipient does not match.")
    row.provider_sid = sid
    session.add(row)
    return row, dispatch, form


@router.post("/api/notifications/twilio/status/{attempt_id}")
async def provider_status(attempt_id: str, request: Request, session: Session = Depends(get_session)):
    row, dispatch, form = await signed_attempt(request, session, attempt_id)
    notify.provider_progress(row, str(form.get("CallStatus" if row.channel == "voice" else "MessageStatus", "")))
    if row.channel == "voice" and row.provider_status in {"completed", "busy", "no-answer", "failed", "canceled"}:
        for call in session.exec(select(GuardVoiceCall).where(GuardVoiceCall.attempt_id == row.id, GuardVoiceCall.ended_at == None)).all():  # noqa: E711
            dialogue.end(session, call, "provider_" + row.provider_status)
    session.commit()
    publish_refresh("notification", dispatch.id)
    return {"ok": True}


@router.post("/api/notifications/twilio/voice/{attempt_id}")
async def voice(attempt_id: str, request: Request, session: Session = Depends(get_session)):
    row, dispatch, _ = await signed_attempt(request, session, attempt_id)
    if row.channel != "voice":
        raise HTTPException(404, "This call was not found.")
    notify.provider_progress(row, "in-progress")
    from sqlalchemy import update
    session.exec(update(NotificationAttempt).where(NotificationAttempt.id == row.id).values(error=NotificationAttempt.error))
    if not dialogue.available(session, dispatch, row):
        session.commit()
        return Response(notify.xml_message("This notification is no longer open. Thank you."), media_type="application/xml")
    call = dialogue.start(session, dispatch, row)
    dialogue.check(session, dispatch, row, call)
    session.commit()
    return Response(dialogue.twiml(dispatch, row, call, call.turns[-1]["reply"]), media_type="application/xml")


@router.post("/api/notifications/twilio/accept/{attempt_id}")
async def voice_accept(attempt_id: str, request: Request, turn: int = 1, session: Session = Depends(get_session)):
    row, dispatch, form = await signed_attempt(request, session, attempt_id)
    if row.channel != "voice":
        raise HTTPException(404, "This call was not found.")
    from sqlalchemy import update
    session.exec(update(NotificationAttempt).where(NotificationAttempt.id == row.id).values(error=NotificationAttempt.error))
    call = session.exec(select(GuardVoiceCall).where(GuardVoiceCall.provider_sid == row.provider_sid)).first()
    if not call:
        raise HTTPException(409, "This call has not started.")
    try:
        confidence = float(form["Confidence"]) if "Confidence" in form else None
        if confidence is not None and not 0 <= confidence <= 1:
            confidence = 0
    except (ValueError, TypeError):
        confidence = 0
    message = dialogue.respond(session, dispatch, row, call, turn=turn, speech=str(form.get("SpeechResult", "")),
        digits=str(form.get("Digits", "")), confidence=confidence)
    session.commit()
    publish_refresh("notification", dispatch.id)
    return Response(dialogue.twiml(dispatch, row, call, message), media_type="application/xml")
