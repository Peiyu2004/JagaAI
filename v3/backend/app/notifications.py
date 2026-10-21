"""Persistent guard notifications. Simulation never contacts a provider.

Outbound requests are claimed before sending. An ambiguous network result is
never automatically resent; signed callbacks may reconcile it later.
"""
import hashlib
import hmac
import importlib.util
import json
import os
import re
import secrets
from datetime import timedelta, timezone
from urllib.parse import urlsplit
from uuid import NAMESPACE_URL, uuid5
from xml.etree.ElementTree import Element, SubElement, tostring

import httpx
from fastapi import HTTPException
from sqlalchemy import update
from sqlmodel import select

from .auth import aware
from .database import session_scope
from .hosting import allowed_origins
from .models import (Alert, AuditLog, Camera, Event, Guard, GuardDispatch, Incident,
                     Location, NotificationAttempt, NotificationPolicy, Video, GuardVoiceCall, utcnow)
from .realtime import publish_refresh
from .serializers import record_json

OPEN = {"active", "unacknowledged"}
BAD_DELIVERY = {"failed", "unknown"}


def phone_number(value):
    number = re.sub(r"[\s()\-]", "", value or "")
    if not re.fullmatch(r"\+[1-9][0-9]{7,14}", number):
        raise HTTPException(422, "Use an international guard number, for example +60123456789.")
    return number


def provider_config():
    return {key: os.environ.get(key, "").strip() for key in (
        "JAGAAI_PUBLIC_URL", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN",
        "TWILIO_WHATSAPP_FROM", "TWILIO_WHATSAPP_CONTENT_SID", "TWILIO_VOICE_FROM", "TWILIO_SMS_FROM")}


def readiness(sms=True):
    config = provider_config()
    # Without a template SID, WhatsApp sends plain text (Sandbox/trial: needs an open 24-hour session).
    # Without a voice/SMS number, Live plans simply omit that channel (see live_channels).
    optional = {"TWILIO_WHATSAPP_CONTENT_SID", "TWILIO_VOICE_FROM", "TWILIO_SMS_FROM"}
    missing = [name for name, value in config.items() if not value and name not in optional]
    url = urlsplit(config["JAGAAI_PUBLIC_URL"])
    if config["JAGAAI_PUBLIC_URL"] and (url.scheme != "https" or not url.hostname or url.hostname in {"localhost", "127.0.0.1", "::1"}
            or url.username or url.password or url.path not in {"", "/"} or url.query or url.fragment):
        missing.append("JAGAAI_PUBLIC_URL must be a public HTTPS origin without a path")
    if config["JAGAAI_PUBLIC_URL"] and config["JAGAAI_PUBLIC_URL"].rstrip("/") not in allowed_origins():
        missing.append("JAGAAI_ALLOWED_ORIGINS must include the public HTTPS origin")
    if config["TWILIO_ACCOUNT_SID"] and not re.fullmatch(r"AC[0-9a-fA-F]{32}", config["TWILIO_ACCOUNT_SID"]):
        missing.append("TWILIO_ACCOUNT_SID has an invalid format")
    if config["TWILIO_WHATSAPP_CONTENT_SID"] and not re.fullmatch(r"HX[0-9a-fA-F]{32}", config["TWILIO_WHATSAPP_CONTENT_SID"]):
        missing.append("TWILIO_WHATSAPP_CONTENT_SID has an invalid format")
    for name in ("TWILIO_WHATSAPP_FROM", "TWILIO_VOICE_FROM", *(["TWILIO_SMS_FROM"] if sms else [])):
        if config[name]:
            try:
                phone_number(config[name].removeprefix("whatsapp:"))
            except HTTPException:
                missing.append(f"{name} must be an international phone number")
    if not importlib.util.find_spec("twilio"):
        missing.append("Install the backend twilio dependency")
    return {"ready": not missing, "missing": missing, "channels": live_channels()}


def live_channels():
    config = provider_config()
    return {"whatsapp": True, "voice": bool(config["TWILIO_VOICE_FROM"]), "sms": bool(config["TWILIO_SMS_FROM"])}


def policy_json(session):
    policy = session.get(NotificationPolicy, "global")
    return {"policy": record_json(policy), "provider": readiness(policy.sms_fallback)}


def validate_contacts(session, policy, primary_id=None):
    primary = session.get(Guard, primary_id or policy.primary_guard_id) if (primary_id or policy.primary_guard_id) else None
    if not primary:
        raise HTTPException(422, "Choose a duty contact in notification settings first.")
    escalation = session.get(Guard, policy.escalation_guard_id) if policy.escalation_guard_id else None
    if policy.escalation_guard_id and not escalation:
        raise HTTPException(422, "The escalation contact was not found.")
    if escalation and escalation.id == primary.id:
        raise HTTPException(422, "Choose a different escalation contact.")
    for guard in [primary, *([escalation] if escalation else [])]:
        phone_number(guard.phone)
        if policy.mode == "live" and not guard.notification_opt_in:
            raise HTTPException(422, f"Record {guard.name}'s consent to receive guard notifications first.")
    if policy.mode == "live" and not readiness(policy.sms_fallback)["ready"]:
        raise HTTPException(422, "Live notifications are not ready. Complete the provider setup shown in Settings.")
    return primary, escalation


def attempt(session, dispatch, stage, channel, due):
    identifier = str(uuid5(NAMESPACE_URL, f"jagaai:{dispatch.id}:{stage}:{channel}"))
    row = session.get(NotificationAttempt, identifier)
    if row:
        return row
    prefix = "primary" if stage == "primary" else "escalation"
    row = NotificationAttempt(id=identifier, dispatch_id=dispatch.id, stage=stage, channel=channel,
        guard_id=getattr(dispatch, prefix + "_guard_id"), guard_name=getattr(dispatch, prefix + "_name"),
        phone=getattr(dispatch, prefix + "_phone"), due_at=due)
    session.add(row)
    session.flush()
    return row


def enqueue_alert(session, alert, *, automatic=True, guard_id=None):
    existing = session.exec(select(GuardDispatch).where(GuardDispatch.alert_id == alert.id)).first()
    if existing:
        return existing
    policy = session.get(NotificationPolicy, "global") or NotificationPolicy()
    if automatic and not policy.enabled:
        return None
    event = session.get(Event, alert.event_id) if alert.event_id else None
    video = session.get(Video, event.video_id) if event else None
    camera = session.get(Camera, event.camera_id) if event else None
    if not event or not video or not camera or aware(video.expires_at) <= utcnow():
        if automatic:
            return None
        raise HTTPException(410, "The alert's source recording is no longer available.")
    event_at = aware(video.recorded_at) + timedelta(seconds=event.end_sec)
    if automatic:
        if video.source != "live" or not -30 <= (utcnow() - event_at).total_seconds() <= 300:
            return None
        if policy.mode == "live" and (video.is_simulation or (camera.stream_url or "").startswith("demo:")):
            return None
    if alert.status == "dismissed" or event.verification.get("superseded"):
        if automatic:
            return None
        raise HTTPException(409, "Dismissed or superseded alerts cannot notify a guard.")
    try:
        primary, escalation = validate_contacts(session, policy, guard_id)
    except HTTPException as error:
        if not automatic:
            raise
        # Do not fail video analysis because a contact/configuration needs repair.
        session.add(AuditLog(action="notification.blocked", target=alert.id, details={"reason": error.detail}))
        return None
    now = utcnow()
    location = session.get(Location, camera.location_id)
    dispatch = GuardDispatch(alert_id=alert.id, camera_id=camera.id, rule_id=event.rule_id,
        title="Possible " + event.type.replace("_", " "), location=location.name if location else camera.name,
        priority=alert.priority, event_at=event_at, mode=policy.mode, automatic=automatic,
        primary_guard_id=primary.id, primary_name=primary.name, primary_phone=phone_number(primary.phone),
        escalation_guard_id=escalation.id if escalation else None, escalation_name=escalation.name if escalation else "",
        escalation_phone=phone_number(escalation.phone) if escalation else "", sms_fallback=policy.sms_fallback,
        voice_language=policy.voice_language,
        token_seed=secrets.token_urlsafe(32), expires_at=now + timedelta(minutes=30))
    for incident in session.exec(select(Incident)).all():
        if any(e.get("alert_id") == alert.id for e in incident.evidence):
            if incident.status in {"resolved", "closed"}:
                if automatic:
                    return None
                raise HTTPException(409, "This incident is already resolved or closed.")
            dispatch.incident_id = incident.id
            break
    if automatic:
        recent = session.exec(select(GuardDispatch).where(GuardDispatch.camera_id == camera.id,
            GuardDispatch.rule_id == event.rule_id, GuardDispatch.created_at >= now - timedelta(seconds=policy.cooldown_sec),
            GuardDispatch.mode == policy.mode, GuardDispatch.status != "suppressed")).first()
        if recent:
            dispatch.status = "suppressed"
            dispatch.reason = "Merged by the camera/rule notification cooldown; see alert " + recent.alert_id[:8] + "."
    session.add(dispatch)
    session.flush()
    if dispatch.status == "active":
        calls = policy.mode != "live" or live_channels()["voice"]
        attempt(session, dispatch, "primary", "whatsapp", now)
        delay = 0 if policy.urgent_call and alert.priority == "urgent" else policy.call_after_sec
        if calls:
            attempt(session, dispatch, "primary", "voice", now + timedelta(seconds=delay))
        if escalation:
            attempt(session, dispatch, "escalation", "whatsapp", now + timedelta(seconds=policy.escalate_after_sec))
            if calls:
                attempt(session, dispatch, "escalation", "voice", now + timedelta(seconds=policy.escalate_after_sec + policy.call_after_sec))
    session.add(AuditLog(action="notification.created", target=dispatch.id,
        details={"alert_id": alert.id, "mode": policy.mode, "automatic": automatic, "status": dispatch.status}))
    return dispatch


def cancel(session, dispatch, reason):
    if dispatch.status not in OPEN:
        return
    dispatch.status, dispatch.reason = "cancelled", reason
    session.add(dispatch)
    session.exec(update(NotificationAttempt).where(NotificationAttempt.dispatch_id == dispatch.id,
        NotificationAttempt.status == "queued").values(status="cancelled", updated_at=utcnow()))


def cancel_alert(session, alert_id, reason):
    for dispatch in session.exec(select(GuardDispatch).where(GuardDispatch.alert_id == alert_id)).all():
        cancel(session, dispatch, reason)


def token_for(dispatch, guard_id):
    return hmac.new(dispatch.token_seed.encode(), (dispatch.id + ":" + guard_id).encode(), hashlib.sha256).hexdigest()


def guard_link(dispatch, guard_id):
    base = provider_config()["JAGAAI_PUBLIC_URL"].rstrip("/") if dispatch.mode == "live" else ""
    # Capability stays in the URL fragment: it is not sent in server request logs.
    return f"{base}/guard#{dispatch.id}/{guard_id}/{token_for(dispatch, guard_id)}"


def authorized_dispatch(session, dispatch_id, guard_id, token):
    dispatch = session.get(GuardDispatch, dispatch_id)
    if not dispatch or guard_id not in {dispatch.primary_guard_id, dispatch.escalation_guard_id} or not hmac.compare_digest(token_for(dispatch, guard_id), token):
        raise HTTPException(404, "This guard notification link is invalid.")
    if aware(dispatch.expires_at) <= utcnow():
        raise HTTPException(410, "This notification link has expired. Contact the control room.")
    return dispatch


def acknowledge(session, dispatch, guard_id, via, recorded_by=""):
    if dispatch.status == "acknowledged":
        if dispatch.acknowledged_by != guard_id:
            raise HTTPException(409, "Another guard has already accepted this notification.")
        return dispatch
    if dispatch.status not in OPEN or aware(dispatch.expires_at) <= utcnow():
        raise HTTPException(409, "This notification is no longer open for acceptance.")
    if guard_id not in {dispatch.primary_guard_id, dispatch.escalation_guard_id}:
        raise HTTPException(422, "Choose one of this notification's recipients.")
    alert = session.get(Alert, dispatch.alert_id)
    event = session.get(Event, alert.event_id) if alert and alert.event_id else None
    video = session.get(Video, event.video_id) if event else None
    incident = session.get(Incident, dispatch.incident_id) if dispatch.incident_id else None
    if (not alert or not event or not video or aware(video.expires_at) <= utcnow() or alert.status == "dismissed"
            or event.verification.get("superseded") or (incident and incident.status in {"resolved", "closed"})):
        raise HTTPException(409, "This alert or incident is no longer available for acceptance. Contact the control room.")
    guard_name = dispatch.primary_name if guard_id == dispatch.primary_guard_id else dispatch.escalation_name
    now = utcnow()
    changed = session.exec(update(GuardDispatch).where(GuardDispatch.id == dispatch.id, GuardDispatch.status.in_(OPEN)).values(
        status="acknowledged", reason="", acknowledged_by=guard_id, acknowledged_name=guard_name, acknowledged_at=now,
        acknowledged_via=via, recorded_by=recorded_by))
    if changed.rowcount != 1:
        session.refresh(dispatch)
        if dispatch.status == "acknowledged" and dispatch.acknowledged_by == guard_id:
            return dispatch
        raise HTTPException(409, "This notification was already accepted or cancelled.")
    session.exec(update(NotificationAttempt).where(NotificationAttempt.dispatch_id == dispatch.id,
        NotificationAttempt.status == "queued").values(status="cancelled", updated_at=now))
    session.refresh(dispatch)
    if dispatch.incident_id:
        link_incident(session, dispatch.alert_id, session.get(Incident, dispatch.incident_id))
    session.add(AuditLog(action="notification.acknowledged", target=dispatch.id,
        details={"guard_id": guard_id, "via": via, "recorded_by": recorded_by, "mode": dispatch.mode}))
    return dispatch


def link_incident(session, alert_id, incident):
    dispatch = session.exec(select(GuardDispatch).where(GuardDispatch.alert_id == alert_id)).first()
    if not dispatch or not incident:
        return
    dispatch.incident_id = incident.id
    session.add(dispatch)
    if dispatch.status == "acknowledged" and not any(t.get("notification_id") == dispatch.id for t in incident.timeline):
        # Simulation must never silently assign a real incident to a guard.
        if dispatch.mode == "live" and not incident.guard_id and incident.status == "open":
            incident.guard_id, incident.status = dispatch.acknowledged_by, "assigned"
        incident.timeline = [*incident.timeline, {"at": aware(dispatch.acknowledged_at).isoformat(),
            "action": "guard_acknowledged" if dispatch.mode == "live" else "simulated_guard_acknowledgement",
            "text": f"{dispatch.acknowledged_name} accepted via {dispatch.acknowledged_via}.", "notification_id": dispatch.id}]
        incident.updated_at = utcnow()
        session.add(incident)


def dispatch_json(session, dispatch):
    result = record_json(dispatch, {"token_seed", "primary_phone", "escalation_phone"})
    rows = session.exec(select(NotificationAttempt).where(NotificationAttempt.dispatch_id == dispatch.id).order_by(NotificationAttempt.due_at)).all()
    result["attempts"] = [record_json(row, {"phone"}) for row in rows]
    result["voice_calls"] = [record_json(call, {"provider_sid"}) for call in session.exec(
        select(GuardVoiceCall).where(GuardVoiceCall.attempt_id.in_([row.id for row in rows])).order_by(GuardVoiceCall.started_at)).all()]
    # Only a local simulation exposes a preview to management.
    if dispatch.mode == "simulate" and dispatch.status in OPEN and aware(dispatch.expires_at) > utcnow():
        result["preview_url"] = guard_link(dispatch, dispatch.primary_guard_id)
    return result


def progress(row, status, provider_status=None, error=""):
    row.status, row.error, row.updated_at = status, error, utcnow()
    if provider_status is not None:
        row.provider_status = provider_status
    row.history = [*row.history, {"status": row.provider_status or status, "at": row.updated_at.isoformat()}][-20:]


def provider_progress(row, status):
    if row.channel == "voice":
        order = {"queued": 0, "initiated": 1, "ringing": 2, "in-progress": 3, "completed": 4, "busy": 4, "no-answer": 4, "failed": 4, "canceled": 4}
    else:
        order = {"accepted": 0, "scheduled": 0, "queued": 1, "sending": 2, "sent": 3, "delivered": 4, "read": 5, "failed": 6, "undelivered": 6}
    if status not in order or order[status] < order.get(row.provider_status, -1):
        return
    if row.provider_status in {"read", "delivered"} and status in {"failed", "undelivered"}:
        return
    if row.provider_status == status:
        return
    failed = status in {"failed", "undelivered", "busy", "no-answer", "canceled"}
    progress(row, "failed" if failed else "submitted", status, "Provider reported " + status + "." if failed else "")


def send_to_twilio(row, dispatch):
    config = provider_config()
    base = config["JAGAAI_PUBLIC_URL"].rstrip("/")
    callback = f"{base}/api/notifications/twilio/status/{row.id}"
    parameters = {"To": row.phone, "StatusCallback": callback}
    resource = "Messages"
    if row.channel == "voice":
        resource = "Calls"
        parameters.update(From=config["TWILIO_VOICE_FROM"], Url=f"{base}/api/notifications/twilio/voice/{row.id}",
                          Method="POST", Timeout="25", TimeLimit="90", StatusCallbackEvent=["initiated", "ringing", "answered", "completed"])
    elif row.channel == "whatsapp":
        moment = aware(dispatch.event_at).astimezone(timezone(timedelta(hours=8))).strftime("%d %b %Y %H:%M MYT")
        variables = {"1": row.guard_name, "2": dispatch.title, "3": dispatch.location, "4": moment, "5": guard_link(dispatch, row.guard_id)}
        parameters.update(To="whatsapp:" + row.phone, From="whatsapp:" + config["TWILIO_WHATSAPP_FROM"].removeprefix("whatsapp:"))
        if config["TWILIO_WHATSAPP_CONTENT_SID"]:
            parameters.update(ContentSid=config["TWILIO_WHATSAPP_CONTENT_SID"], ContentVariables=json.dumps(variables))
        else:
            # Same wording as the template; only delivered inside the recipient's 24-hour session.
            parameters["Body"] = (f"Hello {variables['1']}, JagaAI requests your attendance.\n{variables['2']} at {variables['3']}. "
                f"Event time: {variables['4']}.\nThis event needs verification. Review and accept: {variables['5']}")
    else:
        # Malaysia blocks SMS containing URLs, phone numbers and email addresses.
        place = re.sub(r"[^\w\s-]", " ", dispatch.location)[:70]
        parameters.update(From=config["TWILIO_SMS_FROM"], Body=f"JagaAI: {dispatch.title} at {place}. Ref JG-{dispatch.alert_id[:8]}. Please contact the control room to accept.")
    try:
        response = httpx.post(f"https://api.twilio.com/2010-04-01/Accounts/{config['TWILIO_ACCOUNT_SID']}/{resource}.json",
            data=parameters, auth=(config["TWILIO_ACCOUNT_SID"], config["TWILIO_AUTH_TOKEN"]), timeout=10)
        if 400 <= response.status_code < 500:
            return {"status": "failed", "error": f"Provider rejected the request (HTTP {response.status_code}). Check the provider console."}
        if response.status_code >= 500:
            return {"status": "unknown", "error": "Provider response uncertain. This request will not be resent automatically."}
        payload = response.json()
        if response.status_code >= 300 or not re.fullmatch(r"(?:CA|SM|MM)[0-9a-fA-F]{32}", payload.get("sid", "")):
            raise ValueError()
        return {"status": "submitted", "sid": payload["sid"], "provider_status": payload.get("status", "queued")}
    except (httpx.RequestError, ValueError, TypeError):
        return {"status": "unknown", "error": "Delivery uncertain after a network/response error. No automatic resend; callbacks may reconcile it."}


def tick():
    """One bounded pass, independent of GPU/video work; safe to restart."""
    now = utcnow()
    changed = False
    with session_scope() as session:
        from . import voice_dialogue
        for call in session.exec(select(GuardVoiceCall).where(GuardVoiceCall.ended_at == None)).all():  # noqa: E711
            row = session.get(NotificationAttempt, call.attempt_id)
            dispatch = session.get(GuardDispatch, row.dispatch_id)
            if not voice_dialogue.check(session, dispatch, row, call):
                changed = True
        policy = session.get(NotificationPolicy, "global")
        for dispatch in session.exec(select(GuardDispatch).where(GuardDispatch.status.in_(OPEN))).all():
            alert = session.get(Alert, dispatch.alert_id)
            event = session.get(Event, alert.event_id) if alert and alert.event_id else None
            video = session.get(Video, event.video_id) if event else None
            incident = session.get(Incident, dispatch.incident_id) if dispatch.incident_id else None
            if (not alert or not event or not video or aware(video.expires_at) <= now or alert.status == "dismissed" or event.verification.get("superseded")
                    or (incident and incident.status in {"resolved", "closed"}) or aware(dispatch.expires_at) <= now
                    or policy.mode != dispatch.mode or (dispatch.automatic and not policy.enabled)):
                cancel(session, dispatch, "Notification stopped: source, incident, expiry or notification policy changed.")
                changed = True
                continue
            rows = session.exec(select(NotificationAttempt).where(NotificationAttempt.dispatch_id == dispatch.id)).all()
            for row in rows:
                if row.status == "sending" and (now - aware(row.updated_at)).total_seconds() > 60:
                    progress(row, "unknown", error="Sending was interrupted. Not resent automatically; awaiting provider confirmation.")
                    session.add(row)
                    changed = True
                # No callback within the call delay is also a reason to use the SMS backup.
                stalled = row.status == "submitted" and row.provider_status not in {"delivered", "read"} and (now - aware(row.updated_at)).total_seconds() >= policy.call_after_sec
                sms_ready = dispatch.mode != "live" or live_channels()["sms"]
                if dispatch.status == "active" and dispatch.sms_fallback and sms_ready and row.channel == "whatsapp" and (row.status in BAD_DELIVERY or stalled):
                    backup = attempt(session, dispatch, row.stage, "sms", now)
                    changed = changed or backup.status == "queued"
            last_due = max((aware(row.due_at) for row in rows), default=now)
            if dispatch.status == "active" and now > last_due + timedelta(seconds=90) and not any(row.status in {"queued", "sending"} for row in rows):
                dispatch.status = "unacknowledged"
                dispatch.reason = "All scheduled contacts attempted; no guard has accepted. Control room follow-up required."
                session.add(dispatch)
                changed = True
        session.commit()
        due_ids = list(session.exec(select(NotificationAttempt.id).where(NotificationAttempt.status == "queued", NotificationAttempt.due_at <= now).order_by(NotificationAttempt.due_at).limit(12)).all())
    for identifier in due_ids:
        with session_scope() as session:
            row = session.get(NotificationAttempt, identifier)
            dispatch = session.get(GuardDispatch, row.dispatch_id)
            if dispatch.status != "active":
                progress(row, "cancelled")
                session.add(row); session.commit()
                continue
            if (now - aware(row.due_at)).total_seconds() > 300:
                progress(row, "cancelled", error="Scheduled contact is more than five minutes late; control room follow-up required.")
                session.add(row); session.commit()
                changed = True
                continue
            if dispatch.mode == "live":
                contact = session.get(Guard, row.guard_id)
                valid = contact and contact.notification_opt_in
                try:
                    valid = valid and phone_number(contact.phone) == row.phone
                except HTTPException:
                    valid = False
                if not valid or not readiness(dispatch.sms_fallback)["ready"]:
                    progress(row, "failed", error="Contact consent/number or provider setup changed. No request sent.")
                    session.add(row); session.commit()
                    changed = True
                    continue
            claim = session.exec(update(NotificationAttempt).where(NotificationAttempt.id == identifier,
                NotificationAttempt.status == "queued").values(status="sending", updated_at=utcnow()))
            session.commit()
            if claim.rowcount != 1:
                continue
            session.refresh(row); session.refresh(dispatch)
            if dispatch.status != "active":
                progress(row, "cancelled")
                session.add(row); session.commit()
                continue
            result = {"status": "simulated"} if dispatch.mode == "simulate" else send_to_twilio(row, dispatch)
            session.refresh(row)
            # A signed callback may have already advanced this row during the HTTP request.
            if row.status == "sending":
                progress(row, result["status"], error=result.get("error", ""))
            if result.get("sid"):
                row.provider_sid = result["sid"]
                provider_progress(row, result["provider_status"])
            session.add(row); session.commit()
            changed = True
    if changed:
        publish_refresh("notification")


def xml_message(message):
    root = Element("Response")
    SubElement(root, "Say").text = message
    SubElement(root, "Hangup")
    return tostring(root, encoding="unicode")


