"""Exercise delivery decisions and acceptance without contacting real numbers."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import httpx
import pytest
from sqlmodel import Session, select
from twilio.request_validator import RequestValidator

from app import main, notifications as n, retention
from app.event_index import save_events
from app.models import Alert, AuditLog, Camera, Guard, GuardDispatch, Incident, NotificationAttempt, NotificationPolicy, Video, utcnow
from test_api import api, recording, resident_login, staff_login, triggered_alert  # noqa: F401


@pytest.fixture(autouse=True)
def no_background_or_real_network(monkeypatch):
    async def no_loop():
        pass
    monkeypatch.setattr(main, "notification_loop", no_loop)
    def forbidden(*args, **kwargs):
        raise AssertionError("A notification test attempted a real outbound request")
    monkeypatch.setattr(n.httpx, "post", forbidden)
    for key in n.provider_config():
        monkeypatch.delenv(key, raising=False)


def configure(client, **changes):
    staff_login(client)
    contacts = []
    for name, phone in [("Duty guard", "+60123456789"), ("Escalation supervisor", "+60123456780")]:
        response = client.post("/api/guards", json={"name": name, "phone": phone, "shift": "Night", "notification_opt_in": True})
        assert response.status_code == 200, response.text
        contacts.append(response.json())
    policy = {"primary_guard_id": contacts[0]["id"], "escalation_guard_id": contacts[1]["id"], **changes}
    response = client.put("/api/notifications/config", json=policy)
    assert response.status_code == 200, response.text
    return contacts


def dispatch_fixture(api, **policy):
    client, engine, data = api
    contacts = configure(client, **policy)
    video = recording(engine, data)
    alert = triggered_alert(engine, video)
    response = client.post(f"/api/alerts/{alert.id}/notify", json={})
    assert response.status_code == 200, response.text
    return client, engine, alert, response.json(), contacts


def link_payload(engine, dispatch_id, guard_id=None):
    with Session(engine) as session:
        dispatch = session.get(GuardDispatch, dispatch_id)
        guard_id = guard_id or dispatch.primary_guard_id
        return {"dispatch_id": dispatch.id, "guard_id": guard_id, "token": n.token_for(dispatch, guard_id)}


def advance(monkeypatch, seconds):
    moment = utcnow() + timedelta(seconds=seconds)
    monkeypatch.setattr(n, "utcnow", lambda: moment)
    return moment


def twilio_env(monkeypatch):
    values = {"JAGAAI_PUBLIC_URL": "https://notify.example.test", "TWILIO_ACCOUNT_SID": "AC" + "a" * 32,
        "TWILIO_AUTH_TOKEN": "unit-test-secret", "TWILIO_WHATSAPP_FROM": "whatsapp:+14155550100",
        "TWILIO_WHATSAPP_CONTENT_SID": "HX" + "b" * 32, "TWILIO_VOICE_FROM": "+14155550101", "TWILIO_SMS_FROM": "+14155550102"}
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("JAGAAI_ALLOWED_ORIGINS", values["JAGAAI_PUBLIC_URL"])
    return values


def live_dispatch(api, monkeypatch):
    client, engine, alert, dispatch, contacts = dispatch_fixture(api)
    env = twilio_env(monkeypatch)
    with Session(engine) as session:
        policy = session.get(NotificationPolicy, "global"); policy.mode = "live"
        row = session.get(GuardDispatch, dispatch["id"]); row.mode = "live"
        session.add_all([policy, row]); session.commit()
    return client, engine, alert, dispatch, contacts, env


def signed_post(client, path, data, env):
    signature = RequestValidator(env["TWILIO_AUTH_TOKEN"]).compute_signature(env["JAGAAI_PUBLIC_URL"] + path, data)
    return client.post(path, data=data, headers={"X-Twilio-Signature": signature})


def test_simulation_idempotency_guard_scope_and_acceptance_stops_pending(api):
    client, engine, alert, dispatch, _ = dispatch_fixture(api)
    repeat = client.post(f"/api/alerts/{alert.id}/notify", json={}).json()
    assert repeat["id"] == dispatch["id"]
    assert "token_seed" not in str(dispatch) and "primary_phone" not in dispatch
    assert dispatch["preview_url"].startswith("/guard#")
    n.tick()
    result = client.get("/api/notifications").json()[0]
    assert [r["status"] for r in result["attempts"]].count("simulated") == 1
    payload = link_payload(engine, dispatch["id"])
    client.cookies.clear()
    public = client.post("/api/guard/notification", json=payload).json()
    assert "attempts" not in public and "phone" not in public and "video_id" not in public
    assert client.get("/api/bootstrap").status_code == 401
    assert client.post("/api/guard/accept", json=payload).status_code == 200
    assert client.post("/api/guard/accept", json=payload).status_code == 200
    with Session(engine) as session:
        row = session.get(GuardDispatch, dispatch["id"])
        assert row.acknowledged_via == "guard_link" and row.mode == "simulate"
        assert len(session.exec(select(AuditLog).where(AuditLog.action == "notification.acknowledged")).all()) == 1
        assert session.get(Alert, alert.id).status == "pending"  # acceptance is not verification
        assert all(r.status in {"cancelled", "simulated"} for r in session.exec(select(NotificationAttempt)).all())


def test_simulation_call_and_escalation_follow_schedule(api, monkeypatch):
    client, _, _, dispatch, _ = dispatch_fixture(api)
    n.tick()
    advance(monkeypatch, 61); n.tick()
    rows = client.get("/api/notifications").json()[0]["attempts"]
    assert [(r["stage"], r["channel"]) for r in rows if r["status"] == "simulated"] == [("primary", "whatsapp"), ("primary", "voice")]
    advance(monkeypatch, 181); n.tick()
    assert len([r for r in client.get("/api/notifications").json()[0]["attempts"] if r["status"] == "simulated"]) == 3
    advance(monkeypatch, 241); n.tick()
    assert all(r["status"] == "simulated" for r in client.get("/api/notifications").json()[0]["attempts"])
    advance(monkeypatch, 340); n.tick()
    assert client.get("/api/notifications").json()[0]["status"] == "unacknowledged"


def test_invalid_expired_and_other_guard_links(api):
    client, engine, _, dispatch, contacts = dispatch_fixture(api)
    payload = link_payload(engine, dispatch["id"])
    assert client.post("/api/guard/notification", json={**payload, "token": "wrong"}).status_code == 404
    assert client.post("/api/guard/accept", json={**payload, "guard_id": contacts[1]["id"]}).status_code == 404
    assert client.post("/api/guard/accept", json=payload).status_code == 200
    other = link_payload(engine, dispatch["id"], contacts[1]["id"])
    assert client.post("/api/guard/accept", json=other).status_code == 409
    with Session(engine) as session:
        row = session.get(GuardDispatch, dispatch["id"]); row.expires_at = utcnow() - timedelta(seconds=1)
        session.add(row); session.commit()
    assert client.post("/api/guard/notification", json=payload).status_code == 410


def test_notifications_require_staff_and_policy_requires_admin(api):
    client, _, _ = api
    assert client.get("/api/notifications").status_code == 401
    resident_login(client)
    assert client.get("/api/notifications/config").status_code == 403
    assert client.post("/api/alerts/any/notify", json={}).status_code == 403
    staff_login(client, "guard")
    assert client.put("/api/notifications/config", json={}).status_code == 403
    assert client.get("/api/notifications/config").status_code == 200


def test_live_configuration_and_consent_cannot_be_bypassed(api, monkeypatch):
    client, engine, _ = api
    contacts = configure(client)
    assert client.put("/api/notifications/config", json={"mode": "live", "primary_guard_id": contacts[0]["id"]}).status_code == 422
    twilio_env(monkeypatch)
    with Session(engine) as session:
        guard = session.get(Guard, contacts[0]["id"]); guard.notification_opt_in = False
        session.add(guard); session.commit()
    assert client.put("/api/notifications/config", json={"mode": "live", "primary_guard_id": contacts[0]["id"]}).status_code == 422
    assert client.put("/api/notifications/config", json={"call_after_sec": 60, "escalate_after_sec": 30}).status_code == 422
    assert client.put("/api/notifications/config", json={"primary_guard_id": contacts[0]["id"], "escalation_guard_id": contacts[0]["id"]}).status_code == 422


@pytest.mark.parametrize("source,simulation,age,expected", [("upload", False, 0, False), ("live", True, 0, False), ("live", False, 600, False), ("live", False, 0, True)])
def test_only_fresh_real_live_triggers_enqueue_real_notifications(api, monkeypatch, source, simulation, age, expected):
    client, engine, data = api
    twilio_env(monkeypatch)
    configure(client, enabled=True, mode="live")
    video = recording(engine, data)
    with Session(engine) as session:
        saved = session.get(Video, video.id); saved.source = source; saved.is_simulation = simulation
        saved.recorded_at = utcnow() - timedelta(seconds=10 + age)
        camera = session.get(Camera, saved.camera_id); camera.stream_url = "rtsp://camera.local/live"
        session.add_all([saved, camera]); session.commit()
        save_events(session, saved.id, saved.camera_id, n.aware(saved.recorded_at), [{"rule_id": "R3", "type": "restricted_entry", "start_sec": 8, "end_sec": 10, "metrics": {"track_id": "p1"}, "keyframes": []}])
        session.commit()
        assert bool(session.exec(select(GuardDispatch)).first()) is expected


def test_automatic_cooldown_and_retry_keep_one_plan(api):
    client, engine, data = api
    configure(client, enabled=True)
    first = recording(engine, data)
    second = recording(engine, data)
    with Session(engine) as session:
        for video in (first, second):
            saved = session.get(Video, video.id); saved.source = "live"; saved.recorded_at = utcnow() - timedelta(seconds=124)
            session.add(saved)
        session.commit()
    for video in (first, second):
        alert = triggered_alert(engine, video)
        with Session(engine) as session:
            saved_alert = session.get(Alert, alert.id)
            one = n.enqueue_alert(session, saved_alert)
            again = n.enqueue_alert(session, saved_alert)
            assert one.id == again.id
            session.commit()
    rows = client.get("/api/notifications").json()
    assert sorted(row["status"] for row in rows) == ["active", "suppressed"]
    assert len(next(row for row in rows if row["status"] == "active")["attempts"]) == 4


def test_whatsapp_failure_queues_one_sms_backup_and_keeps_call(api, monkeypatch):
    client, engine, _, dispatch, _, _ = live_dispatch(api, monkeypatch)
    sends = []
    def fake_send(row, _dispatch):
        sends.append(row.channel)
        return {"status": "failed", "error": "Provider rejected test request."} if row.channel == "whatsapp" else {"status": "submitted", "sid": "SM" + "1" * 32, "provider_status": "queued"}
    monkeypatch.setattr(n, "send_to_twilio", fake_send)
    n.tick(); n.tick(); n.tick()
    assert sends == ["whatsapp", "sms"]
    rows = client.get("/api/notifications").json()[0]["attempts"]
    assert len([r for r in rows if r["channel"] == "sms"]) == 1
    assert next(r for r in rows if r["channel"] == "voice")["status"] == "queued"


def test_interrupted_send_is_not_resent_and_falls_back(api, monkeypatch):
    client, engine, _, dispatch, _ = dispatch_fixture(api)
    with Session(engine) as session:
        row = session.exec(select(NotificationAttempt).where(NotificationAttempt.channel == "whatsapp", NotificationAttempt.stage == "primary")).one()
        row.status = "sending"; row.updated_at = utcnow() - timedelta(seconds=65)
        session.add(row); session.commit()
    n.tick()
    rows = client.get("/api/notifications").json()[0]["attempts"]
    assert next(r for r in rows if r["stage"] == "primary" and r["channel"] == "whatsapp")["status"] == "unknown"
    assert len([r for r in rows if r["channel"] == "sms"]) == 1


def test_signed_callbacks_reject_forgery_and_do_not_regress_delivery(api, monkeypatch):
    client, engine, _, dispatch, _, env = live_dispatch(api, monkeypatch)
    with Session(engine) as session:
        row = session.exec(select(NotificationAttempt).where(NotificationAttempt.stage == "primary", NotificationAttempt.channel == "whatsapp")).one()
        row.status = "sending"; session.add(row); session.commit(); identifier = row.id
    path = "/api/notifications/twilio/status/" + identifier
    body = {"AccountSid": env["TWILIO_ACCOUNT_SID"], "MessageSid": "SM" + "1" * 32, "To": "whatsapp:+60123456789", "MessageStatus": "delivered"}
    assert client.post(path, data=body).status_code == 403
    assert signed_post(client, path, body, env).status_code == 200
    assert signed_post(client, path, {**body, "MessageStatus": "sent"}, env).status_code == 200
    assert signed_post(client, path, {**body, "To": "whatsapp:+60123456780"}, env).status_code == 403
    row = client.get("/api/notifications").json()[0]["attempts"][0]
    assert row["provider_status"] == "delivered" and row["status"] == "submitted"
    assert client.get("/api/notifications").json()[0]["status"] == "active"


def test_phone_answer_is_not_acceptance_but_signed_press_one_is(api, monkeypatch):
    client, engine, _, dispatch, _, env = live_dispatch(api, monkeypatch)
    with Session(engine) as session:
        row = session.exec(select(NotificationAttempt).where(NotificationAttempt.stage == "primary", NotificationAttempt.channel == "voice")).one()
        row.status = "sending"; session.add(row); session.commit(); identifier = row.id
    body = {"AccountSid": env["TWILIO_ACCOUNT_SID"], "CallSid": "CA" + "2" * 32, "To": "+60123456789", "CallStatus": "in-progress"}
    assert signed_post(client, "/api/notifications/twilio/status/" + identifier, body, env).status_code == 200
    assert client.get("/api/notifications").json()[0]["status"] == "active"
    prompt = signed_post(client, "/api/notifications/twilio/voice/" + identifier, body, env)
    assert "Gather" in prompt.text and "按1接单" in prompt.text
    path = "/api/notifications/twilio/accept/" + identifier
    assert signed_post(client, path, {**body, "Digits": "2"}, env).status_code == 200
    assert client.get("/api/notifications").json()[0]["status"] == "active"
    assert signed_post(client, path + "?turn=2", {**body, "Digits": "1"}, env).status_code == 200
    final = client.get("/api/notifications").json()[0]
    assert final["acknowledged_via"] == "phone_keypad" and final["status"] == "acknowledged"


def test_acceptance_links_to_incident_and_simulation_does_not_assign_it(api):
    client, engine, alert, dispatch, _ = dispatch_fixture(api)
    accepted = client.post("/api/guard/accept", json=link_payload(engine, dispatch["id"]))
    assert accepted.status_code == 200
    confirmed = client.post(f"/api/alerts/{alert.id}/review", json={"action": "confirm"}).json()
    incident = confirmed["incident"]
    assert not incident["guard_id"]
    assert any(item["action"] == "simulated_guard_acknowledgement" for item in incident["timeline"])
    assert client.get("/api/notifications?incident_id=" + incident["id"]).json()[0]["id"] == dispatch["id"]


def test_dismissal_and_retention_stop_pending_but_preserve_history(api):
    client, engine, alert, dispatch, _ = dispatch_fixture(api)
    assert client.post(f"/api/alerts/{alert.id}/review", json={"action": "dismiss", "dismiss_reason": "False detection"}).status_code == 200
    assert client.get("/api/notifications").json()[0]["status"] == "cancelled"
    with Session(engine) as session:
        saved = session.get(Alert, alert.id)
        video = session.exec(select(Video)).one(); video.expires_at = utcnow() - timedelta(seconds=1)
        session.add(video); session.commit()
    retention.expire_videos()
    assert len(client.get("/api/notifications").json()) == 1
    assert client.post("/api/guard/accept", json=link_payload(engine, dispatch["id"])).status_code == 409


def test_policy_change_stops_previous_plan(api):
    client, _, _, dispatch, _ = dispatch_fixture(api)
    config = client.get("/api/notifications/config").json()["policy"]
    config.pop("id")
    config["call_after_sec"] = 75
    assert client.put("/api/notifications/config", json=config).status_code == 200
    assert client.get("/api/notifications").json()[0]["status"] == "cancelled"


@pytest.mark.parametrize("channel", ["whatsapp", "voice", "sms"])
def test_provider_payloads_are_real_api_requests_and_sms_has_no_link(api, monkeypatch, channel):
    _, engine, _, dispatch, _, env = live_dispatch(api, monkeypatch)
    with Session(engine) as session:
        saved = session.get(GuardDispatch, dispatch["id"])
        row = n.attempt(session, saved, "primary", channel, utcnow())
        requests = []
        def fake_post(url, **kwargs):
            requests.append((url, kwargs))
            return httpx.Response(201, json={"sid": ("CA" if channel == "voice" else "SM") + "3" * 32, "status": "queued"})
        monkeypatch.setattr(n.httpx, "post", fake_post)
        assert n.send_to_twilio(row, saved)["status"] == "submitted"
        url, options = requests[0]
        assert url.startswith("https://api.twilio.com/") and options["auth"][0] == env["TWILIO_ACCOUNT_SID"]
        if channel == "sms":
            body = options["data"]["Body"]
            assert "http" not in body and "@" not in body and "+60" not in body
        elif channel == "whatsapp":
            assert "ContentSid" in options["data"] and "ContentVariables" in options["data"]
        else:
            assert "/twilio/voice/" in options["data"]["Url"]
            assert options["data"]["TimeLimit"] == "90"
            encoded = httpx.Request("POST", url, data=options["data"]).content.decode()
            assert encoded.count("StatusCallbackEvent=") == 4


def test_whatsapp_without_template_sends_plain_text_with_link(api, monkeypatch):
    _, engine, _, dispatch, _, _ = live_dispatch(api, monkeypatch)
    monkeypatch.setenv("TWILIO_WHATSAPP_CONTENT_SID", "")
    assert n.readiness()["ready"]
    with Session(engine) as session:
        saved = session.get(GuardDispatch, dispatch["id"])
        row = n.attempt(session, saved, "primary", "whatsapp", utcnow())
        requests = []
        monkeypatch.setattr(n.httpx, "post", lambda url, **kwargs: requests.append(kwargs) or httpx.Response(201, json={"sid": "SM" + "4" * 32, "status": "queued"}))
        assert n.send_to_twilio(row, saved)["status"] == "submitted"
        data = requests[0]["data"]
        assert "ContentSid" not in data and data["To"] == "whatsapp:" + row.phone
        assert saved.title in data["Body"] and n.guard_link(saved, row.guard_id) in data["Body"]


def test_live_with_whatsapp_only_omits_calls_and_sms_backup(api, monkeypatch):
    client, engine, data = api
    contacts = configure(client)
    twilio_env(monkeypatch)
    monkeypatch.delenv("TWILIO_VOICE_FROM"); monkeypatch.delenv("TWILIO_SMS_FROM")
    assert n.readiness()["ready"] and n.readiness()["channels"] == {"whatsapp": True, "voice": False, "sms": False}
    response = client.put("/api/notifications/config", json={"mode": "live", "primary_guard_id": contacts[0]["id"], "escalation_guard_id": contacts[1]["id"]})
    assert response.status_code == 200, response.text
    alert = triggered_alert(engine, recording(engine, data))
    dispatch = client.post(f"/api/alerts/{alert.id}/notify", json={}).json()
    assert sorted((row["stage"], row["channel"]) for row in dispatch["attempts"]) == [("escalation", "whatsapp"), ("primary", "whatsapp")]
    with Session(engine) as session:
        row = session.exec(select(NotificationAttempt).where(NotificationAttempt.dispatch_id == dispatch["id"], NotificationAttempt.stage == "primary")).one()
        row.status = "failed"; session.add(row); session.commit()
    n.tick()
    assert not any(row["channel"] == "sms" for row in client.get("/api/notifications").json()[0]["attempts"])


def test_concurrent_acceptance_has_one_winner(api):
    client, engine, _, dispatch, contacts = dispatch_fixture(api)
    payloads = [link_payload(engine, dispatch["id"], g["id"]) for g in contacts]
    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(lambda body: client.post("/api/guard/accept", json=body).status_code, payloads))
    assert sorted(statuses) == [200, 409]


def test_concurrent_workers_claim_a_delivery_only_once(api, monkeypatch):
    client, _, _, _, _, _ = live_dispatch(api, monkeypatch)
    sends = []
    def fake_send(row, _dispatch):
        sends.append(row.id)
        return {"status": "submitted", "sid": "SM" + "4" * 32, "provider_status": "queued"}
    monkeypatch.setattr(n, "send_to_twilio", fake_send)
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: n.tick(), range(2)))
    assert len(sends) == 1
    assert client.get("/api/notifications").json()[0]["attempts"][0]["status"] == "submitted"


def test_timeout_stays_uncertain_and_is_not_reported_as_sent(api, monkeypatch):
    _, engine, _, dispatch, _, _ = live_dispatch(api, monkeypatch)
    def timeout(*args, **kwargs):
        raise httpx.ReadTimeout("test timeout")
    monkeypatch.setattr(n.httpx, "post", timeout)
    with Session(engine) as session:
        saved = session.get(GuardDispatch, dispatch["id"])
        row = session.exec(select(NotificationAttempt).where(NotificationAttempt.channel == "whatsapp", NotificationAttempt.stage == "primary")).one()
        assert n.send_to_twilio(row, saved)["status"] == "unknown"


def test_expired_source_cannot_be_accepted_before_retention_sweep(api):
    client, engine, _, dispatch, _ = dispatch_fixture(api)
    with Session(engine) as session:
        video = session.exec(select(Video)).one(); video.expires_at = utcnow() - timedelta(seconds=1)
        session.add(video); session.commit()
    assert client.post("/api/guard/accept", json=link_payload(engine, dispatch["id"])).status_code == 409


def test_live_acceptance_assigns_a_linked_unassigned_incident(api, monkeypatch):
    client, engine, alert, dispatch, contacts, _ = live_dispatch(api, monkeypatch)
    incident = client.post(f"/api/alerts/{alert.id}/review", json={"action": "confirm"}).json()["incident"]
    assert client.post("/api/guard/accept", json=link_payload(engine, dispatch["id"])).status_code == 200
    saved = next(row for row in client.get("/api/bootstrap").json()["incidents"] if row["id"] == incident["id"])
    assert saved["guard_id"] == contacts[0]["id"] and saved["status"] == "assigned"


def test_live_setup_requires_allowed_public_origin(api, monkeypatch):
    client, _, _ = api
    contacts = configure(client)
    twilio_env(monkeypatch)
    monkeypatch.delenv("JAGAAI_ALLOWED_ORIGINS")
    assert "JAGAAI_ALLOWED_ORIGINS" in " ".join(n.readiness()["missing"])
    assert client.put("/api/notifications/config", json={"mode": "live", "primary_guard_id": contacts[0]["id"]}).status_code == 422


def test_old_overdue_notifications_are_not_sent_in_a_burst(api, monkeypatch):
    client, _, _, _, _, _ = live_dispatch(api, monkeypatch)
    advance(monkeypatch, 900)
    n.tick()
    rows = client.get("/api/notifications").json()[0]["attempts"]
    assert all(row["status"] == "cancelled" for row in rows)


def test_simulated_live_collector_persists_source_marker(api):
    from app.live import Recorder
    client, engine, data = api
    path = data / "synthetic-segment.mp4"
    path.write_bytes(b"labelled test fixture")
    recorder = Recorder("cam-b1")
    recorder.simulated_source = True
    recorder._register(path, utcnow(), 30, "QA simulated camera")
    with Session(engine) as session:
        row = session.exec(select(Video)).one()
        assert row.source == "live" and row.is_simulation is True
