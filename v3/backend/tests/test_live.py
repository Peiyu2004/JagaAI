"""Live camera input: credential masking, source validation, segment continuity and the API."""
from datetime import datetime, timedelta, timezone

from sqlmodel import Session, select

from app import live, worker
from app.models import AuditLog, Camera
from app.vision import RuleEngine, Tracker
from tests.test_api import api, staff_login  # noqa: F401  (fixture)


def test_camera_passwords_never_leave_the_server():
    assert live.mask_url('rtsp://admin:s3cret@192.168.1.20:554/Streaming/101') == 'rtsp://admin:***@192.168.1.20:554/Streaming/101'
    assert live.mask_url('rtsp://192.168.1.20/live') == 'rtsp://192.168.1.20/live'
    assert live.mask_url('demo:demo-kerb-waiting') == 'demo:demo-kerb-waiting'
    assert live.mask_url(None) is None


def test_only_camera_protocols_are_accepted():
    for url in ('file:///C:/Windows/win.ini', 'ftp://cam/live', 'rtsp://', 'rtsp://cam/live stream', 'javascript:alert(1)'):
        assert live.validate_source(url), url
    for url in ('rtsp://192.168.1.20:554/live', 'rtsps://cam.local/live', 'http://192.168.1.30/video.ts'):
        assert live.validate_source(url) is None, url


def test_network_sources_cannot_read_local_files(tmp_path):
    command = live.segment_command('ffmpeg', 'rtsp://192.168.1.20/live', tmp_path, 60)
    whitelist = command[command.index('-protocol_whitelist') + 1]
    assert 'file' not in whitelist.split(',')
    assert command[command.index('-segment_time') + 1] == '60'
    assert 'expr:gte(t,n_forced*60)' in command


def test_consecutive_segments_share_tracks_and_dwell_timers(monkeypatch):
    monkeypatch.setattr(worker, '_live_context', {})
    rules = {'R1': {'enabled': True}}
    start = datetime(2026, 10, 17, 12, tzinfo=timezone.utc)
    tracker, engine, offset, carry = worker.live_context('cam', start, rules, 5)
    assert offset == 0 and carry
    worker._live_context['cam'] = {'tracker': tracker, 'engine': engine, 'rules': rules, 'fps': 5,
                                   'start_at': start, 'end_at': start + timedelta(seconds=60)}
    # The next segment begins where the last ended (within the gap tolerance).
    same = worker.live_context('cam', start + timedelta(seconds=60.4), rules, 5)
    assert same[1] is engine and same[2] == 60.4 and same[3]
    # A dropped stream (long gap) starts fresh but may become the new running state.
    later = worker.live_context('cam', start + timedelta(seconds=200), rules, 5)
    assert later[1] is not engine and later[2] == 0 and later[3]
    # Retrying an older segment must not replace the running state.
    older = worker.live_context('cam', start - timedelta(seconds=120), rules, 5)
    assert older[1] is not engine and not older[3]
    # Changed rules restart the state rather than mixing thresholds.
    assert worker.live_context('cam', start + timedelta(seconds=60), {'R1': {'enabled': False}}, 5)[1] is not engine


def test_dwell_spanning_two_segments_reaches_the_threshold():
    """The rule engine sees continuous time, so 70 s + 70 s of standing still is one 140 s stay."""
    engine = RuleEngine({'R1': {'enabled': True, 'zone': [[0, 0], [1, 0], [1, 1], [0, 1]], 'loiter_sec': 120,
                                'window_sec': 300, 'min_vehicles': 99, 'min_dwell_sec': 3}},
                        datetime(2026, 10, 17, 12, tzinfo=timezone.utc))
    person = {'id': '0-1', 'class': 'person', 'box': [.4, .4, .45, .6]}
    events = []
    for offset in (0, 70):  # two segments, each restarting its own clock at zero
        for step in range(0, 141):
            local = step * .5
            if local > 70:
                break
            events += engine.update(offset + local, [person])
    assert [e['rule_id'] for e in events] == ['R1']
    assert events[0]['metrics']['dwell_sec'] >= 120


def test_stream_settings_api_masks_credentials_and_requires_admin(api, monkeypatch):  # noqa: F811
    client, engine, _ = api
    synced = []
    monkeypatch.setattr(live, 'sync', lambda camera_id: synced.append(camera_id))
    staff_login(client, 'guard')
    assert client.put('/api/cameras/cam-b1/stream', json={'url': 'rtsp://cam/live', 'enabled': True}).status_code == 403
    client.post('/api/auth/logout')
    staff_login(client)
    assert client.put('/api/cameras/cam-b1/stream', json={'enabled': True}).status_code == 422
    assert client.put('/api/cameras/cam-b1/stream', json={'url': 'file:///etc/passwd', 'enabled': True}).status_code == 422
    assert client.put('/api/cameras/cam-b1/stream', json={'url': 'rtsp://cam/live', 'enabled': True, 'segment_sec': 45}).status_code == 422
    response = client.put('/api/cameras/cam-b1/stream', json={'url': 'rtsp://admin:s3cret@cam:554/live', 'enabled': True})
    assert response.status_code == 200, response.text
    assert response.json()['stream_url'] == 'rtsp://admin:***@cam:554/live' and synced == ['cam-b1']
    cameras = {c['id']: c for c in client.get('/api/bootstrap').json()['cameras']}
    assert cameras['cam-b1']['stream_url'] == 'rtsp://admin:***@cam:554/live' and cameras['cam-b1']['source_type'] == 'stream'
    # Sending the masked address back is refused; omitting it keeps the saved one.
    assert client.put('/api/cameras/cam-b1/stream', json={'url': 'rtsp://admin:***@cam:554/live', 'enabled': True}).status_code == 422
    assert client.put('/api/cameras/cam-b1/stream', json={'enabled': False, 'segment_sec': 120}).status_code == 200
    with Session(engine) as session:
        camera = session.get(Camera, 'cam-b1')
        assert camera.stream_url == 'rtsp://admin:s3cret@cam:554/live' and not camera.stream_enabled and camera.segment_sec == 120
        logs = session.exec(select(AuditLog).where(AuditLog.action == 'camera.stream')).all()
        assert logs and all('s3cret' not in str(log.details) for log in logs)
    assert 's3cret' not in client.get('/api/bootstrap').text
    assert 's3cret' not in client.get('/api/live').text


def test_ffmpeg_errors_are_explained():
    assert 'refused' in live.explain('rtsp://127.0.0.1:8556/missing: Error number -138 occurred')
    assert 'password' in live.explain('method DESCRIBE failed: 401 Unauthorized')
    assert 'path' in live.explain('method DESCRIBE failed: 404 Not Found')
    assert live.explain('something new').startswith('Stream stopped: ')
