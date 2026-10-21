"""Seed only the two bundled CC-BY public clips; never publish the existing demo DB."""
from datetime import datetime, timedelta
import json
import os
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))


def prepare():
    from sqlmodel import select
    from app.auth import verify_password
    from app.database import DATA_DIR, default_rules, init_db, session_scope
    from app.models import Camera, User, Video, utcnow

    init_db()
    samples = ROOT / "deploy/colab/samples"
    plan = json.loads((samples / "manifest.json").read_text(encoding="utf-8"))
    with session_scope() as session:
        admin = session.exec(select(User).where(User.role == "admin")).first()
        if (admin.email != os.environ["JAGAAI_ADMIN_EMAIL"]
                or not verify_password(os.environ["JAGAAI_ADMIN_PASSWORD"], admin.password_hash)):
            raise RuntimeError("The restored database uses another administrator email/password. Enter the original credentials; they were not overwritten.")
        for case in plan:
            ident = "colab-demo-" + case["id"]
            if session.get(Video, ident):
                continue
            folder = DATA_DIR / "videos"
            folder.mkdir(parents=True, exist_ok=True)
            shutil.copy2(samples / case["filename"], folder / case["filename"])
            rules = default_rules()
            rules["R1"]["enabled"] = False
            rules["R3"].update(enabled=True, line=case["line"], zone=[], active_start="00:00", active_end="00:00")
            session.add(Camera(id=ident, name=case["name"], location_id="perimeter", rules=rules))
            session.flush()
            session.add(Video(id=ident, camera_id=ident, path="videos/" + case["filename"],
                              filename=case["filename"], recorded_at=datetime.fromisoformat(case["recorded_at"]),
                              duration_sec=case["duration_sec"], expires_at=utcnow() + timedelta(days=30), status="queued"))
        session.commit()
    print("Independent public demo data prepared; original source dates preserved.", flush=True)


if __name__ == "__main__":
    prepare()
