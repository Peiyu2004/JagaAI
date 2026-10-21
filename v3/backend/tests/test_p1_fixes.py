import hashlib
import io
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from PIL import Image
from sqlmodel import Session, select

from app.models import AuditLog, Camera, Incident, IncidentCreateRequest, Video, utcnow
from test_api import api, recording, resident_login, staff_login, submit_lead


AREA = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
LINE = [[0.5, 0.1], [0.5, 0.9]]


@pytest.mark.parametrize("restricted", [True, False])
def test_demo_rules_roundtrip_accepts_empty_unused_area(api, restricted):
    client, engine, _ = api
    staff_login(client)
    rules = {"R1": {"enabled": not restricted, "zone": AREA},
             "R3": {"enabled": restricted, "zone": [], "line": LINE if restricted else None}}
    response = client.put("/api/cameras/cam-b1/rules", json={"rules": rules})
    assert response.status_code == 200, response.text
    saved = response.json()["rules"]
    assert client.put("/api/cameras/cam-b1/rules", json={"rules": saved}).status_code == 200
    with Session(engine) as session:
        assert session.get(Camera, "cam-b1").rules == saved


@pytest.mark.parametrize("patch", [
    {"R1": {"enabled": True, "zone": []}},
    {"R3": {"enabled": True, "zone": [], "line": None}},
    {"R3": {"enabled": False, "zone": [[0, 0], [1, 1]]}},
    {"R3": {"line": [[0, 0], [2, 1]]}},
    {"R3": "not a rule"},
])
def test_rules_still_reject_invalid_or_missing_active_geometry(api, patch):
    client, _, _ = api
    staff_login(client)
    assert client.put("/api/cameras/cam-b1/rules", json={"rules": patch}).status_code == 422


def test_partial_rule_edit_keeps_valid_saved_geometry(api):
    client, _, _ = api
    staff_login(client)
    response = client.put("/api/cameras/cam-b1/rules", json={"rules": {"R1": {"loiter_sec": 151}}})
    assert response.status_code == 200
    assert response.json()["rules"]["R1"]["loiter_sec"] == 151
    assert response.json()["rules"]["R1"]["zone"]


def test_incident_retry_is_durable_and_does_not_duplicate_audit(api):
    client, engine, _ = api
    staff_login(client)
    headers = {"Idempotency-Key": "p1-create-retry-123456"}
    payload = {"title": "Check the parking area", "location_id": "zone-b"}
    first = client.post("/api/incidents", headers=headers, json=payload)
    assert first.status_code == 200
    identifier = first.json()["id"]
    assert client.patch(f"/api/incidents/{identifier}", json={"status": "resolved", "outcome": "Area checked."}).status_code == 200
    retry = client.post("/api/incidents", headers=headers, json=payload)
    assert retry.status_code == 200
    assert retry.json()["id"] == identifier
    assert retry.json()["status"] == "resolved"
    conflict = client.post("/api/incidents", headers=headers, json=payload | {"title": "Different request"})
    assert conflict.status_code == 409
    with Session(engine) as session:
        assert len(session.exec(select(Incident)).all()) == 1
        assert len(session.exec(select(IncidentCreateRequest)).all()) == 1
        assert len(session.exec(select(AuditLog).where(AuditLog.action == "incident.create")).all()) == 1


def test_concurrent_incident_retries_commit_only_once(api):
    client, engine, _ = api
    staff_login(client)
    def create(_):
        return client.post("/api/incidents", headers={"Idempotency-Key": "p1-concurrent-123456"},
                           json={"title": "Concurrent creation", "location_id": "zone-b"})
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(create, range(2)))
    assert [response.status_code for response in responses] == [200, 200]
    assert responses[0].json()["id"] == responses[1].json()["id"]
    with Session(engine) as session:
        assert len(session.exec(select(Incident)).all()) == 1


def test_creation_keys_are_scoped_to_staff_user(api):
    client, _, _ = api
    payload = {"title": "Same action key, different operator", "location_id": "zone-b"}
    headers = {"Idempotency-Key": "p1-scoped-key-123456"}
    staff_login(client)
    first = client.post("/api/incidents", headers=headers, json=payload)
    staff_login(client, "guard")
    second = client.post("/api/incidents", headers=headers, json=payload)
    assert first.status_code == second.status_code == 200
    assert first.json()["id"] != second.json()["id"]


def test_concurrent_lead_incident_retry_reuses_the_committed_link(api):
    client, engine, _ = api
    resident_login(client)
    lead = submit_lead(client)
    staff_login(client)
    def create(_):
        return client.post("/api/incidents", headers={"Idempotency-Key": "p1-concurrent-lead-123456"},
                           json={"title": "Concurrent resident follow-up", "location_id": "zone-b", "lead_id": lead["id"]})
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(create, range(2)))
    assert [response.status_code for response in responses] == [200, 200]
    assert responses[0].json()["id"] == responses[1].json()["id"]
    with Session(engine) as session:
        assert len(session.exec(select(Incident)).all()) == 1


@pytest.mark.parametrize("width", [480, 960])
def test_previews_are_small_private_webp_and_preserve_original(api, width):
    client, engine, data = api
    video = recording(engine, data)
    directory = data / "frames" / video.id
    directory.mkdir(parents=True)
    source = directory / "overview.jpg"
    Image.new("RGB", (1280, 720), "blue").save(source, "JPEG")
    before = hashlib.sha256(source.read_bytes()).digest()
    url = f"/api/videos/{video.id}/thumbnail?width={width}"
    assert client.get(url).status_code == 401
    resident_login(client)
    assert client.get(url).status_code == 403
    staff_login(client)
    response = client.get(url)
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/webp"
    assert response.headers["cache-control"] == "no-store"
    with Image.open(io.BytesIO(response.content)) as image:
        assert image.size == (width, width * 9 // 16)
    assert hashlib.sha256(source.read_bytes()).digest() == before
    assert client.get(url).content == response.content
    with Session(engine) as session:
        stored = session.get(Video, video.id)
        stored.expires_at = utcnow() - timedelta(seconds=1)
        session.add(stored)
        session.commit()
    assert client.get(url).status_code == 410


def test_preview_cache_updates_after_reanalysis(api):
    client, engine, data = api
    staff_login(client)
    video = recording(engine, data)
    directory = data / "frames" / video.id
    directory.mkdir(parents=True)
    source = directory / "overview.jpg"
    Image.new("RGB", (640, 480), "blue").save(source, "JPEG")
    url = f"/api/videos/{video.id}/thumbnail"
    first = client.get(url).content
    Image.new("RGB", (640, 480), "red").save(source, "JPEG")
    cached = directory / "preview-480.webp"
    os.utime(cached, (0, 0))
    second = client.get(url)
    assert second.status_code == 200
    assert first != second.content
    assert client.get(url + "?width=99999").status_code == 422


def test_trigger_frame_previews_use_separate_cache_and_stay_inside_video(api):
    client, engine, data = api
    staff_login(client)
    video = recording(engine, data)
    directory = data / "frames" / video.id
    directory.mkdir(parents=True)
    Image.new("RGB", (640, 480), "blue").save(directory / "overview.jpg")
    Image.new("RGB", (640, 480), "red").save(directory / "trigger.jpg")
    base = f"/api/videos/{video.id}/thumbnail"
    overview = client.get(base + "?width=160")
    trigger = client.get(base + "?width=160&frame=trigger.jpg")
    assert overview.status_code == trigger.status_code == 200
    assert overview.content != trigger.content
    with Image.open(io.BytesIO(trigger.content)) as image:
        assert image.size == (160, 120)
    assert client.get(base + "?frame=../overview.jpg").status_code == 422
    assert client.get(base + "?frame=missing.jpg").status_code == 404
