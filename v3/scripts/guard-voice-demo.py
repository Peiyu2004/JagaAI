"""One-run local rehearsal with labelled synthetic alerts and an isolated DB."""
import os
import shutil
import sys
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "output" / "voice-demo" / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
os.environ["JAGAAI_DATA_DIR"] = str(DATA)
os.environ["JAGAAI_FRONTEND_DIR"] = str(ROOT / "frontend" / "dist")
os.environ["JAGAAI_ALLOWED_ORIGINS"] = "http://127.0.0.1:8767,http://localhost:8767"
os.environ["JAGAAI_SECURE_COOKIE"] = "0"
sys.path.insert(0, str(ROOT / "backend"))

from app import database, main, notifications  # noqa: E402
from app.models import Alert, Event, Guard, NotificationPolicy, Video, utcnow  # noqa: E402
from sqlmodel import Session  # noqa: E402


def no_outbound(*_args, **_kwargs):
    return {"status": "failed", "error": "This local rehearsal server disables real outbound requests."}


def prepare():
    if not (ROOT / "frontend" / "dist" / "index.html").exists():
        raise SystemExit("Build the frontend first: cd frontend, then npm run build.")
    source = next((ROOT / "data" / "ai-demo" / "videos").glob("*.mp4"), None)
    if source is None:
        raise SystemExit("No demo video found in data/ai-demo/videos. Run Start-AI-Demo.cmd once to prepare it.")
    database.init_db()
    folder = DATA / "videos"
    folder.mkdir(parents=True, exist_ok=True)
    destination = folder / "public-demo-recording.mp4"
    shutil.copy2(source, destination)
    with Session(database.engine) as session:
        guard = Guard(name="Demo Duty Guard", phone="+60123456789", shift="Demo only", notification_opt_in=False)
        session.add(guard); session.flush()
        policy = session.get(NotificationPolicy, "global")
        policy.enabled, policy.mode, policy.primary_guard_id, policy.voice_language = False, "simulate", guard.id, "en-US" if "--english" in sys.argv else "zh-CN"
        session.add(policy); session.flush()
        for camera, name in [("cam-b1", "Voice acceptance"), ("cam-n1", "Keypad fallback"), ("cam-p1", "90-second limit")]:
            now = utcnow()
            video = Video(camera_id=camera, filename=f"[SYNTHETIC DEMO] {name}.mp4", path=str(destination),
                status="ready", recorded_at=now - timedelta(minutes=2), duration_sec=120,
                is_simulation=True, expires_at=now + timedelta(days=1))
            session.add(video); session.flush()
            event = Event(video_id=video.id, camera_id=camera, type="restricted_entry", start_sec=1, end_sec=3,
                rule_id="R3", metrics={"track_id": "synthetic-demo"}, verification={"method": "synthetic_demo",
                    "note": "Seeded workflow rehearsal. This is not an AI detection or an accuracy result."})
            session.add(event); session.flush()
            alert = Alert(event_id=event.id, priority="high")
            session.add(alert); session.flush()
            notifications.enqueue_alert(session, alert, automatic=False)
        session.commit()


if __name__ == "__main__":
    main.jobs.start_worker = lambda: None
    main.jobs.stop_worker = lambda: None
    main.live.start_all = lambda: None
    notifications.send_to_twilio = no_outbound
    prepare()
    print("Local simulated guard calls: http://127.0.0.1:8767")
    print("Use the normal demo administrator login. Alerts -> Guard notification -> Rehearse call.")
    print("Synthetic alerts only. No real phone calls or messages. Data:", DATA)
    import uvicorn
    uvicorn.run(main.app, host="127.0.0.1", port=8767)
