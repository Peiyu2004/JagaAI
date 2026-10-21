import asyncio
import io
from pathlib import Path
import subprocess
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import event
from sqlmodel import Session, SQLModel, create_engine, select

from app import database, jobs, main, retention
from app.auth import COOKIE_NAME, hash_password
from app.models import Alert, AuditLog, Camera, Description, Event, Incident, Lead, Track, User, Video, utcnow
from app.realtime import publish_refresh

_start_worker = jobs.start_worker


@pytest.fixture
def api(tmp_path, monkeypatch):
    data = tmp_path / "private"
    data.mkdir()
    engine = create_engine(f"sqlite:///{(data / 'test.sqlite').as_posix()}", connect_args={"check_same_thread": False})
    @event.listens_for(engine, "connect")
    def foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")
    monkeypatch.setattr(database, "engine", engine)
    monkeypatch.setattr(database, "DATA_DIR", data)
    monkeypatch.setattr(main, "DATA_DIR", data)
    monkeypatch.setattr(retention, "DATA_DIR", data)
    monkeypatch.setattr(main.jobs, "start_worker", lambda: None)
    monkeypatch.setattr(main.jobs, "stop_worker", lambda: None)
    monkeypatch.setattr(main.jobs, "enqueue", lambda _id: None)
    main._rates.clear()
    with TestClient(main.app) as client:
        yield client, engine, data
    engine.dispose()


def staff_login(client, role="admin"):
    response = client.post("/api/auth/login", json={"email": f"{role}@jagaai.local", "password": "JagaAI-demo-2026!"})
    assert response.status_code == 200, response.text
    return response.json()["user"]


RESIDENT_PASSWORD = "resident-pass-2026"


def resident_login(client, email="alice@example.com"):
    """Sign in through the shared entry as an approved resident, creating one if needed."""
    with Session(database.engine) as session:
        if not session.exec(select(User).where(User.email == email)).first():
            session.add(User(email=email, name=email.split("@")[0], role="resident", unit="A-01-01", password_hash=hash_password(RESIDENT_PASSWORD)))
            session.commit()
    response = client.post("/api/auth/login", json={"email": email, "password": RESIDENT_PASSWORD})
    assert response.status_code == 200, response.text
    return response.json()["user"]


def submit_lead(client, **changes):
    now = utcnow()
    payload = {"location_id": "zone-b", "text": "Car door scratched this morning", "time_from": (now - timedelta(hours=2)).isoformat(), "time_to": now.isoformat()}
    payload.update(changes)
    response = client.post("/api/resident/leads", data=payload)
    assert response.status_code == 200, response.text
    return response.json()


def recording(engine, data, expired=False):
    path = data / "videos" / "source.mp4"
    path.parent.mkdir(exist_ok=True)
    path.write_bytes(bytes(range(256)) * 4)
    with Session(engine) as session:
        video = Video(camera_id="cam-b1", filename="private.mp4", path=str(path), recorded_at=utcnow(), duration_sec=130,
                      expires_at=utcnow() + timedelta(days=-1 if expired else 30), status="ready")
        session.add(video)
        session.commit()
        session.refresh(video)
        return video


def triggered_alert(engine, video):
    with Session(engine) as session:
        candidate = Event(video_id=video.id, camera_id=video.camera_id, type="vehicle_loitering", start_sec=2, end_sec=124,
                          metrics={"dwell_sec": 122, "track_id": "p1"}, rule_id="R1", keyframes=[])
        session.add(candidate)
        session.flush()
        alert = Alert(event_id=candidate.id, priority="high")
        session.add(alert)
        session.commit()
        session.refresh(alert)
        return alert


def test_fresh_database_has_no_fabricated_ai_or_guard_accounts(api):
    client, engine, _ = api
    assert client.get("/api/auth/me").json() == {"user": None}
    assert client.get("/api/bootstrap").status_code == 401
    staff_login(client)
    result = client.get("/api/bootstrap").json()
    assert result["events"] == result["alerts"] == result["videos"] == result["guards"] == []
    assert result["summary"]["median_ack_sec"] is None
    assert len(result["cameras"]) == 6
    assert all("password_hash" not in item for item in client.get("/api/settings").json()["users"])
    assert COOKIE_NAME in client.cookies


@pytest.mark.parametrize("path,method", [
    ("/api/bootstrap", "get"), ("/api/settings", "get"), ("/api/videos/any/media", "get"),
    ("/api/videos/any/keyframes/frame.jpg", "get"), ("/api/leads/any/photo", "get"),
    ("/api/videos/any/analyse", "post"), ("/api/alerts/any/review", "post"),
    ("/api/incidents", "post"), ("/api/search", "post"),
])
def test_residents_cannot_access_management_routes(api, path, method):
    client, _, _ = api
    resident_login(client)
    response = getattr(client, method)(path, json={} ) if method == "post" else client.get(path)
    # Body validation may precede dependencies only when no authorization result is available;
    # these endpoints all run management authorization first.
    assert response.status_code == 403, response.text


def test_resident_ownership_and_public_field_allowlist(api):
    client, _, _ = api
    resident_login(client)
    lead = submit_lead(client)
    assert set(lead) == {"id", "location_id", "time_from", "time_to", "text", "status", "public_reply", "created_at", "linked_case", "points_awarded"}
    assert lead["linked_case"] is False
    assert set(client.get(f"/api/resident/leads/{lead['id']}").json()) == set(lead) - {"points_awarded"}
    assert len(client.get("/api/resident/leads").json()) == 1
    resident_login(client, "bob@example.com")
    assert client.get("/api/resident/leads").json() == []
    assert client.get(f"/api/resident/leads/{lead['id']}").status_code == 404
    public = client.get("/api/resident/context").json()
    assert set(public) == {"locations"}


def test_one_sign_in_entry_returns_the_role_assigned_to_each_account(api):
    client, _, _ = api
    for role in ("guard", "manager", "admin"):
        assert staff_login(client, role)["role"] == role
    assert resident_login(client)["role"] == "resident"
    # The role comes from the account; the request cannot choose one.
    response = client.post("/api/auth/login", json={"email": "guard@jagaai.local", "password": "JagaAI-demo-2026!", "role": "admin"})
    assert response.status_code == 422
    assert client.post("/api/auth/login", json={"email": "guard@jagaai.local", "password": "wrong"}).status_code == 401


def test_resident_registration_waits_for_manager_approval(api):
    client, _, _ = api
    details = {"name": "Nur Aisyah", "email": "aisyah@example.com", "phone": "012-3456789", "unit": "c-03-07", "password": "a-strong-pass"}
    assert client.post("/api/auth/register", json=details).json() == {"status": "pending"}
    assert client.post("/api/auth/register", json=details).status_code == 409
    login = {"email": "aisyah@example.com", "password": "a-strong-pass"}
    response = client.post("/api/auth/login", json=login)
    assert response.status_code == 403 and "approval" in response.json()["detail"]
    staff_login(client, "guard")
    assert client.get("/api/accounts").status_code == 403
    staff_login(client, "manager")
    assert client.get("/api/bootstrap").json()["summary"]["pending_residents"] == 1
    account = next(item for item in client.get("/api/accounts").json()["accounts"] if item["email"] == "aisyah@example.com")
    assert account["status"] == "pending" and account["unit"] == "C-03-07" and account["role"] == "resident"
    assert client.patch(f"/api/accounts/{account['id']}", json={"status": "active"}).json()["status"] == "active"
    assert client.post("/api/auth/login", json=login).json()["user"]["role"] == "resident"
    assert client.get("/api/resident/points").json()["balance"] == 50


def test_managers_handle_residents_and_guards_but_not_admins(api):
    client, _, _ = api
    staff_login(client, "manager")
    accounts = {item["email"]: item for item in client.get("/api/accounts").json()["accounts"]}
    created = client.post("/api/accounts", json={"name": "Night guard", "email": "night@jagaai.local", "password": "guard-pass-1", "role": "guard"})
    assert created.status_code == 200 and created.json()["role"] == "guard"
    assert client.post("/api/accounts", json={"name": "Boss", "email": "boss@jagaai.local", "password": "admin-pass-1", "role": "admin"}).status_code == 403
    assert client.patch(f"/api/accounts/{accounts['admin@jagaai.local']['id']}", json={"status": "disabled"}).status_code == 403
    # Disabling an account ends its existing session.
    manager_cookie = client.cookies.get(COOKIE_NAME)
    staff_login(client, "guard")
    guard_cookie = client.cookies.get(COOKIE_NAME)
    client.cookies.clear()
    client.cookies.set(COOKIE_NAME, manager_cookie)
    assert client.patch(f"/api/accounts/{accounts['guard@jagaai.local']['id']}", json={"status": "disabled"}).status_code == 200
    client.cookies.clear()
    client.cookies.set(COOKIE_NAME, guard_cookie)
    assert client.get("/api/bootstrap").status_code == 401
    response = client.post("/api/auth/login", json={"email": "guard@jagaai.local", "password": "JagaAI-demo-2026!"})
    assert response.status_code == 403 and "disabled" in response.json()["detail"]


def test_guard_permissions_and_guard_records(api):
    client, _, _ = api
    staff_login(client, "guard")
    settings = client.get("/api/settings").json()
    assert "users" not in settings and "audit_logs" not in settings
    assert client.patch("/api/settings", json={"retention_days": 14}).status_code == 403
    assert client.put("/api/cameras/cam-b1/rules", json={"rules": {"R1": {"enabled": False}}}).status_code == 403
    guard_data = {"name": "Duty guard", "shift": "19:00–07:00", "phone": "010-1234567"}
    assert client.post("/api/guards", json=guard_data).status_code == 403
    staff_login(client, "manager")
    guard = client.post("/api/guards", json=guard_data).json()
    assert client.patch("/api/settings", json={"retention_days": 14}).status_code == 403
    staff_login(client)
    incident = client.post("/api/incidents", json={"title": "Resident property report", "location_id": "zone-b", "guard_id": guard["id"]}).json()
    assert incident["status"] == "assigned"
    assert {user["role"] for user in client.get("/api/settings").json()["users"]} == {"guard", "manager", "admin"}


def test_guards_take_and_complete_tasks_managers_assign_them(api):
    client, _, _ = api
    guard = staff_login(client, "guard")
    mine_before = client.get("/api/bootstrap").json()["summary"]["my_tasks"]
    task = client.post("/api/tasks", json={"title": "Check the north gate", "location_id": "north-gate"}).json()
    assert task["assignee_id"] is None and task["status"] == "open"
    manager = staff_login(client, "manager")
    assert client.post("/api/tasks", json={"title": "Taken by me", "assignee_id": manager["id"]}).status_code == 200
    staff_login(client, "guard")
    assert client.post("/api/tasks", json={"title": "For the manager", "assignee_id": manager["id"]}).status_code == 403
    assert client.patch(f"/api/tasks/{task['id']}", json={"status": "done"}).status_code == 403
    taken = client.patch(f"/api/tasks/{task['id']}", json={"assignee_id": guard["id"], "status": "in_progress"}).json()
    assert taken["assignee_id"] == guard["id"] and taken["status"] == "in_progress"
    done = client.patch(f"/api/tasks/{task['id']}", json={"status": "done", "note": "Gate locked."}).json()
    assert done["status"] == "done" and done["note"] == "Gate locked."
    # Taken (+1) then completed (-1): finished tasks leave the guard's open count.
    assert client.get("/api/bootstrap").json()["summary"]["my_tasks"] == mine_before


def test_activity_signup_attendance_points_and_redemption(api):
    client, _, _ = api
    staff_login(client, "manager")
    starts = (utcnow() + timedelta(days=2)).isoformat()
    activity = client.post("/api/activities", json={"title": "Lantern walk", "location": "Clubhouse", "starts_at": starts, "capacity": 1, "points": 120}).json()
    resident = resident_login(client)
    assert client.post(f"/api/activities/{activity['id']}/join").json()["joined"] is True
    assert "attendees" not in client.get("/api/activities").json()[0]
    resident_login(client, "bob@example.com")
    assert client.post(f"/api/activities/{activity['id']}/join").status_code == 409
    staff_login(client, "guard")
    assert client.post(f"/api/activities/{activity['id']}/attendance", json={"user_id": resident["id"], "attended": True}).status_code == 403
    staff_login(client, "manager")
    marked = client.post(f"/api/activities/{activity['id']}/attendance", json={"user_id": resident["id"], "attended": True}).json()
    assert marked["attendees"][0]["attended"] is True
    client.post(f"/api/activities/{activity['id']}/attendance", json={"user_id": resident["id"], "attended": True})
    resident_login(client)
    points = client.get("/api/resident/points").json()
    assert points["balance"] == 120
    assert client.post("/api/resident/points/redeem", json={"reward_id": "cafe"}).status_code == 409
    assert client.post("/api/resident/points/redeem", json={"reward_id": "court"}).json()["balance"] == 20


def test_report_points_are_awarded_on_sending_up_to_the_daily_limit(api):
    client, _, _ = api
    resident_login(client)
    sent = [submit_lead(client, text=f"Report number {n}") for n in range(4)]
    assert [lead["points_awarded"] for lead in sent] == [10, 10, 10, 0]
    # The team acting on a report does not award more points.
    staff_login(client)
    client.patch(f"/api/leads/{sent[0]['id']}", json={"status": "in_progress"})
    client.patch(f"/api/leads/{sent[0]['id']}", json={"status": "resolved"})
    resident_login(client)
    points = client.get("/api/resident/points").json()
    assert points["balance"] == 30 and points["report_points"] == 10 and points["report_points_per_day"] == 3
    # Another resident has their own daily limit.
    resident_login(client, "bob@example.com")
    assert submit_lead(client)["points_awarded"] == 10


def test_marking_a_report_not_valid_withdraws_its_points_once(api):
    client, _, _ = api
    resident_login(client)
    junk = submit_lead(client, text="Junk report")
    staff_login(client)
    for _ in range(2):
        assert client.patch(f"/api/leads/{junk['id']}", json={"status": "invalid"}).json()["status"] == "invalid"
    resident_login(client)
    points = client.get("/api/resident/points").json()
    assert points["balance"] == 0
    assert [h["points"] for h in points["history"]].count(-10) == 1
    assert client.get(f"/api/resident/leads/{junk['id']}").json()["status"] == "invalid"
    # Restoring the report gives the points back.
    staff_login(client)
    client.patch(f"/api/leads/{junk['id']}", json={"status": "received"})
    resident_login(client)
    assert client.get("/api/resident/points").json()["balance"] == 10
    # A withdrawn report still counts towards the daily limit.
    staff_login(client)
    client.patch(f"/api/leads/{junk['id']}", json={"status": "invalid"})
    resident_login(client)
    assert [submit_lead(client, text=f"Report number {n}")["points_awarded"] for n in range(3)] == [10, 10, 0]
    unpaid = client.get("/api/resident/leads").json()[0]
    staff_login(client)
    client.patch(f"/api/leads/{unpaid['id']}", json={"status": "invalid"})
    resident_login(client)
    assert client.get("/api/resident/points").json()["balance"] == 20


def test_reports_linked_to_an_incident_cannot_be_marked_not_valid(api):
    client, _, _ = api
    resident_login(client)
    lead = submit_lead(client)
    staff_login(client)
    incident = client.post("/api/incidents", json={"title": "Vehicle damage", "location_id": "zone-b"}).json()
    assert client.post(f"/api/leads/{lead['id']}/link", json={"incident_id": incident["id"]}).status_code == 200
    assert client.patch(f"/api/leads/{lead['id']}", json={"status": "invalid"}).status_code == 409
    resident_login(client)
    assert client.get("/api/resident/points").json()["balance"] == 10


def test_alert_review_is_atomic_idempotent_and_audited(api):
    client, engine, data = api
    video = recording(engine, data)
    alert = triggered_alert(engine, video)
    staff_login(client)
    assert client.post(f"/api/alerts/{alert.id}/review", json={"action": "dismiss", "dismiss_reason": " "}).status_code == 422
    response = client.post(f"/api/alerts/{alert.id}/review", json={"action": "confirm"})
    assert response.status_code == 200, response.text
    incident_id = response.json()["incident"]["id"]
    again = client.post(f"/api/alerts/{alert.id}/review", json={"action": "confirm"})
    assert again.json()["incident"]["id"] == incident_id
    assert client.post(f"/api/alerts/{alert.id}/review", json={"action": "dismiss", "dismiss_reason": "late"}).status_code == 409
    with Session(engine) as session:
        assert len(session.exec(select(Incident)).all()) == 1
        assert session.get(Alert, alert.id).status == "confirmed"
        assert session.exec(select(AuditLog).where(AuditLog.action == "alert.confirm")).first()


def test_lead_incident_public_reply_and_status_workflow(api):
    client, _, _ = api
    resident_login(client)
    lead = submit_lead(client)
    staff_login(client)
    incident_response = client.post("/api/incidents", json={"title": "Check parking bay", "location_id": "zone-b", "lead_id": lead["id"]})
    assert incident_response.status_code == 200, incident_response.text
    incident = incident_response.json()
    incident_url = f"/api/incidents/{incident['id']}"
    assert client.patch(incident_url, json={"status": "assigned"}).status_code == 422
    assert client.patch(incident_url, json={"status": "resolved"}).status_code == 422
    assert client.patch(incident_url, json={"status": "closed", "outcome": "Reviewed"}).status_code == 422
    resolved = client.patch(incident_url, json={"status": "resolved", "outcome": "Internal observation only", "public_reply": "Security reviewed your report. Please contact management."})
    assert resolved.status_code == 200, resolved.text
    assert client.patch(incident_url, json={"status": "closed"}).status_code == 200
    assert client.patch(incident_url, json={"outcome": "edit"}).status_code == 409
    resident_login(client)
    own = client.get(f"/api/resident/leads/{lead['id']}").json()
    assert own["status"] == "resolved" and own["public_reply"]
    assert "Internal observation" not in str(own)


def test_assigning_guard_from_open_form_updates_status(api):
    client, _, _ = api
    resident_login(client)
    lead = submit_lead(client)
    staff_login(client)
    guard = client.post('/api/guards', json={'name': 'QA guard', 'shift': 'Day', 'phone': '0101234567'}).json()
    incident = client.post('/api/incidents', json={'title': 'Check reported damage', 'location_id': 'zone-b', 'lead_id': lead['id']}).json()
    url = f"/api/incidents/{incident['id']}"
    response = client.patch(url, json={'status': 'open', 'guard_id': guard['id']})
    assert response.status_code == 200, response.text
    assert response.json()['status'] == 'assigned'
    assert client.patch(url, json={'guard_id': None}).status_code == 422
    assert client.patch(url, json={'status': 'open', 'guard_id': None}).json()['status'] == 'open'


def test_linked_report_status_cannot_disagree_with_incident(api):
    client, _, _ = api
    resident_login(client)
    lead = submit_lead(client)
    staff_login(client)
    incident = client.post('/api/incidents', json={'title': 'Review resident report', 'location_id': 'zone-b', 'lead_id': lead['id']}).json()
    lead_url = f"/api/leads/{lead['id']}"
    for invalid in ['received', 'resolved']:
        assert client.patch(lead_url, json={'status': invalid}).status_code == 409
    assert client.patch(lead_url, json={'public_reply': 'We are checking.'}).status_code == 200
    assert client.patch(f"/api/incidents/{incident['id']}", json={'status': 'resolved', 'outcome': 'Checked internally', 'public_reply': 'The team has checked the area.'}).status_code == 200
    assert client.patch(lead_url, json={'status': 'in_progress'}).status_code == 409
    assert client.patch(lead_url, json={'status': 'resolved', 'public_reply': 'Follow-up completed.'}).status_code == 200


def test_linking_report_to_resolved_incident_keeps_resident_resolved(api):
    client, _, _ = api
    resident_login(client)
    lead = submit_lead(client)
    staff_login(client)
    incident = client.post('/api/incidents', json={'title': 'Existing case', 'location_id': 'zone-b'}).json()
    assert client.patch(f"/api/incidents/{incident['id']}", json={'status': 'resolved', 'outcome': 'Internal result'}).status_code == 200
    response = client.post(f"/api/leads/{lead['id']}/link", json={'incident_id': incident['id']})
    assert response.status_code == 200, response.text
    assert response.json()['status'] == 'resolved'
    resident_login(client)
    own = client.get(f"/api/resident/leads/{lead['id']}").json()
    assert own['status'] == 'resolved' and 'Internal result' not in str(own)
    assert own['linked_case'] is True and incident['id'] not in str(own)


def test_reports_cannot_be_linked_to_incidents_at_another_location(api):
    client, _, _ = api
    resident_login(client)
    lead = submit_lead(client)
    staff_login(client)
    incident = client.post('/api/incidents', json={'title': 'Gate issue', 'location_id': 'north-gate'}).json()
    assert client.post(f"/api/leads/{lead['id']}/link", json={'incident_id': incident['id']}).status_code == 422
    assert client.post('/api/incidents', json={'title': 'Wrong zone', 'location_id': 'north-gate', 'lead_id': lead['id']}).status_code == 422
    assert len(client.get('/api/bootstrap').json()['incidents']) == 1


def test_media_range_private_storage_and_audit(api):
    client, engine, data = api
    video = recording(engine, data)
    url = f"/api/videos/{video.id}/media"
    assert client.get(url).status_code == 401
    staff_login(client)
    response = client.get(url, headers={"Range": "bytes=10-19"})
    assert response.status_code == 206
    assert response.content == bytes(range(10, 20))
    assert response.headers["content-range"] == "bytes 10-19/1024"
    assert client.get(url, headers={"Range": "bytes=-4"}).content == bytes(range(252, 256))
    assert client.get(url, headers={"Range": "bytes=5000-"}).status_code == 416
    assert client.get(url, headers={"Range": "bytes=0-1,5-6"}).status_code == 416
    assert "path" not in client.get("/api/bootstrap").json()["videos"][0]
    with Session(engine) as session:
        assert session.exec(select(AuditLog).where(AuditLog.action == "video.view")).first()


def test_forged_mp4_and_invalid_dates_are_rejected(api):
    client, _, data = api
    staff_login(client)
    base = {"camera_id": "cam-b1", "recorded_at": utcnow().isoformat()}
    response = client.post("/api/videos", data=base, files={"file": ("renamed.mp4", b"This is not a recording." * 4, "video/mp4")})
    assert response.status_code == 422
    assert list((data / "videos").glob("*.mp4")) == []
    response = client.post("/api/videos", data={**base, "recorded_at": "2026-01-01T12:00:00"}, files={"file": ("x.mp4", b"bad", "video/mp4")})
    assert response.status_code == 422


def test_actual_mp4_probe_upload_range_and_queue_are_consistent(api, monkeypatch):
    client, engine, data = api
    ffmpeg = Path(__file__).resolve().parents[2] / "tools" / "ffmpeg.exe"
    if not ffmpeg.is_file():
        pytest.skip("Bundled FFmpeg is not installed; run prepare-local.py.")
    source = data / "actual.mp4"
    subprocess.run([str(ffmpeg), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=64x64:r=5", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source)],
                   capture_output=True, check=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    staff_login(client)
    queued = []
    monkeypatch.setattr(main.jobs, "enqueue", queued.append)
    response = client.post("/api/videos", data={"camera_id": "cam-b1", "recorded_at": utcnow().isoformat()},
                           files={"file": ("../../unsafe.mp4", source.read_bytes(), "video/mp4")})
    assert response.status_code == 200, response.text
    video = response.json()
    assert 0.9 <= video["duration_sec"] <= 1.1 and video["filename"] == "unsafe.mp4" and "path" not in video
    assert video["status"] == "queued" and queued == [video["id"]]
    media = client.get(f"/api/videos/{video['id']}/media", headers={"Range": "bytes=0-63"})
    assert media.status_code == 206 and media.content == source.read_bytes()[:64]
    for _ in range(2):
        result = client.post(f"/api/videos/{video['id']}/analyse")
        assert result.status_code == 200 and result.json()["status"] == "queued"
    assert queued == [video["id"]]
    with Session(engine) as session:
        assert session.exec(select(Event)).all() == []


def test_mp4_size_limit_and_invalid_container_leave_no_private_files(api, monkeypatch):
    client, _, data = api
    staff_login(client)
    payload = {"camera_id": "cam-b1", "recorded_at": utcnow().isoformat()}
    monkeypatch.setattr(main, "MAX_VIDEO_BYTES", 64)
    response = client.post("/api/videos", data=payload, files={"file": ("large.mp4", b"x" * 65, "video/mp4")})
    assert response.status_code == 413
    assert list((data / "videos").iterdir()) == []
    response = client.post("/api/videos", data=payload, files={"file": ("oversize.mp4", b"x" * 70000, "video/mp4")})
    assert response.status_code == 413  # Rejected before the multipart parser spools the body.
    multipart = b'--bound\r\nContent-Disposition: form-data; name="file"; filename="x.mp4"\r\nContent-Type: video/mp4\r\n\r\n' + b'x' * 70000 + b'\r\n--bound--\r\n'
    response = client.post("/api/videos", content=iter([multipart]), headers={"Content-Type": "multipart/form-data; boundary=bound"})
    assert response.status_code == 413  # Chunked uploads have the same limit.
    junk_mp4 = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 40
    response = client.post("/api/videos", data=payload, files={"file": ("junk.mp4", junk_mp4, "video/mp4")})
    assert response.status_code == 422
    assert list((data / "videos").iterdir()) == []


def test_camera_rules_reject_cancelled_or_invalid_behaviours(api):
    client, _, _ = api
    staff_login(client)
    url = "/api/cameras/cam-b1/rules"
    assert client.put(url, json={"rules": {"R2": {"enabled": True}}}).status_code == 422
    assert client.put(url, json={"rules": {"R1": {"loiter_sec": -4}}}).status_code == 422
    assert client.put(url, json={"rules": {"R3": {"active_start": "99:00"}}}).status_code == 422
    assert client.put(url, json={"rules": {"R1": {"zone": [[-1, 0], [0, 1], [1, 0]]}}}).status_code == 422
    response = client.put(url, json={"rules": {"R1": {"loiter_sec": 150}}})
    assert response.status_code == 200 and response.json()["rules"]["R1"]["loiter_sec"] == 150


def test_expiry_removes_sensitive_analysis_but_preserves_manual_decision(api):
    client, engine, data = api
    video = recording(engine, data)
    alert = triggered_alert(engine, video)
    staff_login(client)
    assert client.post(f"/api/alerts/{alert.id}/review", json={"action": "dismiss", "dismiss_reason": "Normal resident activity"}).status_code == 200
    frame_dir = data / "frames" / video.id
    frame_dir.mkdir(parents=True)
    (frame_dir / "one.jpg").write_bytes(b"private frame")
    with Session(engine) as session:
        stored = session.get(Video, video.id)
        stored.expires_at = utcnow() - timedelta(days=1)
        session.add(stored)
        session.add(Track(video_id=video.id, track_id="p1", class_name="person", start_sec=0, end_sec=130))
        session.add(Description(video_id=video.id, text="Private scene", model="local"))
        session.commit()
    assert retention.expire_videos() == 1
    assert not video.path or not __import__("pathlib").Path(video.path).exists()
    assert not frame_dir.exists()
    with Session(engine) as session:
        assert session.get(Video, video.id) is None
        assert session.exec(select(Event)).all() == []
        assert session.exec(select(Track)).all() == []
        assert session.exec(select(Description)).all() == []
        kept = session.get(Alert, alert.id)
        assert kept.event_id is None and kept.dismiss_reason == "Normal resident activity"
        assert kept.event_snapshot["media_expired"] is True
        assert kept.event_snapshot["keyframes"] == []


def test_resident_photo_is_reencoded_and_staff_only(api):
    client, _, data = api
    resident_login(client)
    photo = io.BytesIO()
    Image.new("RGB", (12, 12), "red").save(photo, "PNG")
    now = utcnow()
    response = client.post("/api/resident/leads", data={"location_id": "zone-b", "text": "Broken vehicle window", "time_from": now.isoformat(), "time_to": now.isoformat()},
                           files={"photo": ("../location.png", photo.getvalue(), "image/png")})
    assert response.status_code == 200, response.text
    lead = response.json()
    assert "photo_url" not in lead
    assert client.get(f"/api/leads/{lead['id']}/photo").status_code == 403
    staff_login(client)
    result = client.get(f"/api/leads/{lead['id']}/photo")
    assert result.status_code == 200 and result.headers["content-type"] == "image/jpeg"
    assert len(list((data / "photos").glob("*.jpg"))) == 1


def test_cross_origin_mutations_and_logout_invalidate_session(api):
    client, _, _ = api
    staff_login(client)
    token = client.cookies.get(COOKIE_NAME)
    assert client.patch("/api/settings", json={"retention_days": 5}, headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.patch("/api/settings", json={"retention_days": 5}, headers={"Origin": "http://127.0.0.1:5174"}).status_code == 200
    assert client.post("/api/auth/logout").status_code == 200
    client.cookies.set(COOKIE_NAME, token)
    assert client.get("/api/bootstrap").status_code == 401


def test_sse_resident_refresh_never_includes_internal_target_ids(api):
    client, _, _ = api
    class Request:
        def __init__(self):
            self.calls = 0
        async def is_disconnected(self):
            self.calls += 1
            return self.calls > 1
    publish_refresh("private_incident_changed", "sensitive-id")
    async def collect():
        response = await main.stream(Request(), User(email="resident@example.com", name="Resident", role="resident"))
        return [item async for item in response.body_iterator]
    messages = asyncio.run(collect())
    assert len(messages) == 1 and "event: refresh" in messages[0]
    assert "sensitive-id" not in messages[0] and "private_incident" not in messages[0]


def test_startup_recovers_incomplete_detector_and_description_jobs(api, monkeypatch):
    _, engine, data = api
    states = [("queued", "not_started"), ("processing", "not_started"), ("ready", "processing"), ("ready", "ready"), ("uploaded", "not_started")]
    identifiers = []
    with Session(engine) as session:
        for status, description_status in states:
            video = Video(camera_id="cam-b1", filename="recording.mp4", path=str(data / "unused.mp4"), recorded_at=utcnow(), expires_at=utcnow() + timedelta(days=1),
                          status=status, description_status=description_status)
            session.add(video)
            identifiers.append(video.id)
        session.commit()
    class FakeThread:
        def __init__(self, **_kwargs):
            self.alive = False
        def start(self):
            self.alive = True
        def is_alive(self):
            return self.alive
    queued = []
    monkeypatch.setattr(jobs, "Thread", FakeThread)
    monkeypatch.setattr(jobs, "_thread", None)
    monkeypatch.setattr(jobs, "enqueue", queued.append)
    # The API fixture disables worker startup; exercise the actual implementation.
    _start_worker()
    assert queued == identifiers[:3]
    with Session(engine) as session:
        assert [session.get(Video, identifier).status for identifier in identifiers] == ["queued", "queued", "queued", "ready", "uploaded"]
    _start_worker()
    assert queued == identifiers[:3]


def test_thumbnail_requires_a_real_private_frame_and_unexpired_video(api):
    client, engine, data = api
    video = recording(engine, data)
    staff_login(client)
    assert client.get("/api/bootstrap").json()["videos"][0]["thumbnail_url"] is None
    directory = data / "frames" / video.id
    directory.mkdir(parents=True)
    Image.new("RGB", (16, 16), "gray").save(directory / "overview.jpg", "JPEG")
    thumbnail_url = client.get("/api/bootstrap").json()["videos"][0]["thumbnail_url"]
    assert thumbnail_url == f"/api/videos/{video.id}/thumbnail"
    assert client.get(thumbnail_url).status_code == 200
    with Session(engine) as session:
        row = session.get(Video, video.id)
        row.expires_at = utcnow() - timedelta(minutes=1)
        session.add(row)
        session.commit()
    assert client.get("/api/bootstrap").json()["videos"][0]["thumbnail_url"] is None
    assert client.get(thumbnail_url).status_code == 410


@pytest.mark.parametrize("description_status,requeued", [("failed", True), ("partial", True), ("ready", False), ("processing", False)])
def test_analyse_retries_only_failed_or_partial_semantic_analysis(api, monkeypatch, description_status, requeued):
    client, engine, data = api
    staff_login(client)
    video = recording(engine, data)
    with Session(engine) as session:
        record = session.get(Video, video.id)
        record.description_status = description_status
        session.add(record)
        session.commit()
    queued = []
    monkeypatch.setattr(main.jobs, "enqueue", queued.append)
    response = client.post(f"/api/videos/{video.id}/analyse")
    assert response.status_code == 200, response.text
    assert queued == ([video.id] if requeued else [])
    with Session(engine) as session:
        record = session.get(Video, video.id)
        assert record.status == ("queued" if requeued else "ready")
        assert record.description_status == ("not_started" if requeued else description_status)


def test_analyse_force_requeues_ready_recording_but_not_one_still_processing(api, monkeypatch):
    client, engine, data = api
    staff_login(client)
    video = recording(engine, data)
    queued = []
    monkeypatch.setattr(main.jobs, "enqueue", queued.append)
    with Session(engine) as session:
        record = session.get(Video, video.id)
        record.description_status = "ready"
        session.add(record)
        session.commit()
    assert client.post(f"/api/videos/{video.id}/analyse").status_code == 200 and queued == []
    assert client.post(f"/api/videos/{video.id}/analyse?force=true").status_code == 200 and queued == [video.id]
    with Session(engine) as session:
        assert session.get(Video, video.id).status == "queued"
        record = session.get(Video, video.id)
        record.status, record.description_status = "ready", "processing"
        session.add(record)
        session.commit()
    assert client.post(f"/api/videos/{video.id}/analyse?force=true").status_code == 200 and queued == [video.id]
