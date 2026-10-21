"""Bounded alert questions shared by the phone adapter and local rehearsal.

Answers use the saved alert, never invented observations. Recognition is supplied
by Twilio (phone) or explicitly simulated in the browser. No LLM is required.
"""
import re
import unicodedata
from datetime import timedelta, timezone
from xml.etree.ElementTree import Element, SubElement, tostring

from fastapi import HTTPException
from sqlmodel import select

from . import notifications as n
from .models import Alert, Event, GuardVoiceCall, Incident, Video
from .serializers import record_json

LIMIT_SEC = 90
LANGUAGES = {"zh-CN", "en-US"}


def text(dispatch, chinese, english):
    return chinese if dispatch.voice_language == "zh-CN" else english


def available(session, dispatch, row):
    alert = session.get(Alert, dispatch.alert_id)
    event = session.get(Event, alert.event_id) if alert and alert.event_id else None
    video = session.get(Video, event.video_id) if event else None
    incident = session.get(Incident, dispatch.incident_id) if dispatch.incident_id else None
    return (dispatch.status in n.OPEN or (dispatch.status == "acknowledged" and dispatch.acknowledged_by == row.guard_id)) and (
        n.aware(dispatch.expires_at) > n.utcnow() and alert and alert.status != "dismissed" and event
        and not event.verification.get("superseded") and video and n.aware(video.expires_at) > n.utcnow()
        and not (incident and incident.status in {"resolved", "closed"}))


def greeting(dispatch):
    return text(dispatch,
        f"这里是 Jaga AI 安全提醒。{dispatch.location}，{chinese_title(dispatch)}，需要现场核查。"
        "可以问在哪里、什么情况。确认出勤请说收到，或按1接单。说再见，或按0结束。通话最多90秒。",
        f"Jaga AI security alert. {dispatch.title} at {dispatch.location}. This needs verification. "
        "Ask where or what happened. Say received or press 1 to accept and attend. Say goodbye or press 0 to end. The call is limited to 90 seconds.")


def chinese_title(dispatch):
    return {"Possible restricted entry": "疑似进入限制区域", "Possible vehicle loitering": "疑似车辆逗留",
        "Possible vehicle hopping": "疑似在多辆车之间徘徊"}.get(dispatch.title, dispatch.title)


def start(session, dispatch, row):
    call = session.exec(select(GuardVoiceCall).where(GuardVoiceCall.attempt_id == row.id,
        GuardVoiceCall.ended_at == None).order_by(GuardVoiceCall.started_at.desc())).first()  # noqa: E711
    if not call and dispatch.mode == "live":
        call = session.exec(select(GuardVoiceCall).where(GuardVoiceCall.provider_sid == row.provider_sid)).first()
    if call:
        return call
    if not available(session, dispatch, row):
        raise HTTPException(409, "This alert is no longer available for a call.")
    call = GuardVoiceCall(attempt_id=row.id, provider_sid=row.provider_sid if dispatch.mode == "live" else None,
        started_at=n.utcnow(), turns=[{"index": 0, "at": n.utcnow().isoformat(), "input": "", "intent": "greeting", "reply": greeting(dispatch)}])
    session.add(call)
    session.flush()
    return call


def end(session, call, reason):
    if not call.ended_at:
        call.ended_at, call.end_reason = n.utcnow(), reason
        session.add(call)


def check(session, dispatch, row, call):
    if not call.ended_at:
        if n.utcnow() >= n.aware(call.started_at) + timedelta(seconds=LIMIT_SEC):
            end(session, call, "time_limit")
        elif not available(session, dispatch, row):
            end(session, call, "unavailable")
    return not call.ended_at


def call_json(dispatch, call):
    result = record_json(call, {"provider_sid"})
    result.update(language=dispatch.voice_language, mode=dispatch.mode,
        deadline=(n.aware(call.started_at) + timedelta(seconds=LIMIT_SEC)).isoformat(),
        remaining_sec=max(0, LIMIT_SEC - (n.utcnow() - n.aware(call.started_at)).total_seconds()),
        status=dispatch.status, acknowledged_name=dispatch.acknowledged_name)
    return result


def normalise(value):
    value = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"[^\w]", "", value)


def respond(session, dispatch, row, call, *, turn, speech="", digits="", confidence=None):
    if not check(session, dispatch, row, call):
        return text(dispatch, "通话已结束，请联系控制室。", "This call has ended. Please contact the control room.")
    # Retried webhooks replay the same reply without recording another acceptance.
    if 0 < turn < len(call.turns):
        return call.turns[turn]["reply"]
    if turn != len(call.turns):
        raise HTTPException(409, "The call has advanced. Refresh before speaking again.")
    utterance = normalise(speech[:500])
    intent = "unknown"
    if digits == "0" or utterance in {"再见", "再見", "挂断", "掛斷", "结束通话", "goodbye", "bye", "hangup"}:
        intent, reply = "goodbye", text(dispatch, "通话结束，再见。", "Call ended. Goodbye.")
        end(session, call, "guard_ended")
    elif digits == "1" or (utterance in {"收到", "收到我现在过去", "收到马上过去", "我接单", "确认接单", "收到我会前往", "roger", "received", "acknowledged", "iwillattend", "accept", "iaccept", "receivedimonmyway"}
            and (confidence is None or confidence >= .75)):
        intent = "accept"
        try:
            n.acknowledge(session, dispatch, row.guard_id, "phone_keypad" if digits == "1" else "phone_speech")
            reply = text(dispatch, "已记录接单，请前往核查并向控制室汇报。你还可以问位置或情况，按0结束。",
                "Acceptance recorded. Please attend and report to the control room. You can still ask where or what happened. Press 0 to end.")
        except HTTPException:
            reply = text(dispatch, "此告警已被接单或已停止，请联系控制室。", "This alert is already accepted or unavailable. Contact the control room.")
            end(session, call, "unavailable")
    elif not digits and (confidence is None or confidence >= .5):
        if any(word in utterance for word in ("哪里", "哪裡", "位置", "地点", "地點", "where", "location")):
            intent = "location"
            reply = text(dispatch, f"告警位置是{dispatch.location}。请前往该区域核查。", f"The alert location is {dispatch.location}. Please check that area.")
        elif any(word in utterance for word in ("什么情况", "什麼情況", "什么事", "发生", "發生", "情况", "情況", "whathappened", "situation", "whatis", "whatsthealert", "details")):
            intent = "situation"
            title = chinese_title(dispatch)
            moment = n.aware(dispatch.event_at).astimezone(timezone(timedelta(hours=8))).strftime("%H:%M")
            reply = text(dispatch, f"记录时间是马来西亚时间{moment}，{dispatch.location}，{title}。这是待核查告警，具体现场情况尚未确认。",
                f"At {moment} Malaysia time, the system recorded {dispatch.title} at {dispatch.location}. This is an alert awaiting verification. The current scene has not been confirmed.")
        else:
            reply = text(dispatch, "未记录接单。我只能查询这条告警的位置和情况。确认出勤请清楚说收到，或按1。按0结束。",
                "No acceptance recorded. I can answer this alert's location and situation. Say received clearly or press 1 to accept and attend. Press 0 to end.")
    else:
        reply = text(dispatch, "未能确认你的回复，未记录接单。请按1接单，按0结束，也可以再问一次。",
            "Your reply could not be confirmed. No acceptance recorded. Press 1 to accept, press 0 to end, or ask again.")
    if not speech and not digits:
        intent = "silence"
        if call.turns[-1]["intent"] == "silence":
            reply = text(dispatch, "没有收到回复，通话结束。未接单请联系控制室。", "No reply received. Ending the call. Contact the control room if you have not accepted.")
            end(session, call, "no_response")
    if len(call.turns) >= 12:
        reply += text(dispatch, " 本次问答结束，请联系控制室。", " This question session is complete. Contact the control room.")
        end(session, call, "turn_limit")
    call.turns = [*call.turns, {"index": turn, "at": n.utcnow().isoformat(), "input": ("Key " + digits) if digits else speech[:500], "intent": intent, "reply": reply}]
    session.add(call)
    return reply


def twiml(dispatch, row, call, reply):
    root = Element("Response")
    say = {"voice": "Polly.Zhiyu", "language": "cmn-CN"} if dispatch.voice_language == "zh-CN" else {"voice": "Polly.Joanna", "language": "en-US"}
    parent = root
    if not call.ended_at:
        action = n.provider_config()["JAGAAI_PUBLIC_URL"].rstrip("/") + f"/api/notifications/twilio/accept/{row.id}?turn={len(call.turns)}"
        chinese = dispatch.voice_language == "zh-CN"
        parent = SubElement(root, "Gather", {"input": "dtmf speech", "numDigits": "1", "timeout": "6",
            "speechTimeout": "2", "language": "cmn-Hans-CN" if chinese else "en-US",
            "speechModel": "googlev2_chirp_3" if chinese else "googlev2_short",
            "actionOnEmptyResult": "true", "action": action, "method": "POST"})
    SubElement(parent, "Say", say).text = reply
    SubElement(root, "Hangup")
    return tostring(root, encoding="unicode")
