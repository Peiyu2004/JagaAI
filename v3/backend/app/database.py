import os
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import event, inspect, text
from sqlmodel import Session, SQLModel, create_engine, select

from .models import AppSettings, Camera, Location, User

DATA_DIR = Path(os.environ.get("JAGAAI_DATA_DIR", Path(__file__).resolve().parents[2] / "data")).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)
DATABASE_PATH = DATA_DIR / "jagaai-v3.sqlite"
engine = create_engine(f"sqlite:///{DATABASE_PATH.as_posix()}", connect_args={"check_same_thread": False, "timeout": 30})


@event.listens_for(engine, "connect")
def configure_sqlite(connection, _):
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA journal_mode=WAL")


def get_session():
    with Session(engine) as session:
        yield session


@contextmanager
def session_scope():
    with Session(engine) as session:
        yield session


def default_rules():
    return {
        "R1": {"enabled": True, "loiter_sec": 120, "window_sec": 300, "min_vehicles": 3, "min_dwell_sec": 3,
               "zone": [[0.05, 0.2], [0.95, 0.2], [0.95, 0.95], [0.05, 0.95]]},
        "R3": {"enabled": False, "active_start": "19:00", "active_end": "06:00",
               "zone": [[0.65, 0.1], [0.95, 0.1], [0.95, 0.9], [0.65, 0.9]], "line": None},
    }


def init_db():
    from .auth import hash_password

    SQLModel.metadata.create_all(engine)
    # Additive migration: keep existing recordings and indexes intact.
    if 'attributes' not in {column['name'] for column in inspect(engine).get_columns('description')}:
        with engine.begin() as connection:
            connection.execute(text("ALTER TABLE description ADD COLUMN attributes JSON NOT NULL DEFAULT '{}'"))
    for table, column, ddl in (("camera", "stream_url", "VARCHAR"), ("camera", "stream_enabled", "BOOLEAN NOT NULL DEFAULT 0"),
                               ("camera", "segment_sec", "INTEGER NOT NULL DEFAULT 60"),
                               ("video", "source", "VARCHAR NOT NULL DEFAULT 'upload'")):
        if column not in {item['name'] for item in inspect(engine).get_columns(table)}:
            with engine.begin() as connection:
                connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
    with Session(engine) as session:
        if not session.get(AppSettings, "global"):
            session.add(AppSettings())
        if not session.exec(select(User).where(User.role == "admin")).first():
            session.add(User(email=os.environ.get("JAGAAI_ADMIN_EMAIL", "admin@jagaai.local").lower(), name="Property manager", role="admin",
                             password_hash=hash_password(os.environ.get("JAGAAI_ADMIN_PASSWORD", "JagaAI-demo-2026!"))))
            session.add(User(email="supervisor@jagaai.local", name="Security supervisor", role="supervisor",
                             password_hash=hash_password(os.environ.get("JAGAAI_SUPERVISOR_PASSWORD", "JagaAI-demo-2026!"))))
        if not session.exec(select(Location)).first():
            locations = [
                Location(id="zone-b", name="Zone B Parking", aliases=["B区停车场", "停车场", "parking", "tempat letak kereta"], map_area=[12, 40, 39, 38]),
                Location(id="north-gate", name="North Gate", aliases=["北门", "大门", "gate", "pintu utara"], map_area=[43, 8, 25, 26]),
                Location(id="perimeter", name="Perimeter Walk", aliases=["围栏", "限制区", "perimeter", "pagar"], map_area=[70, 28, 20, 53]),
                Location(id="clubhouse", name="Clubhouse", aliases=["会所", "club", "rumah kelab"], map_area=[43, 49, 21, 31]),
            ]
            session.add_all(locations)
            session.flush()
            for camera_id, name, location_id in [
                ("cam-b1", "B-01 · Parking entrance", "zone-b"), ("cam-b2", "B-02 · Parking bays", "zone-b"),
                ("cam-n1", "N-01 · North entrance", "north-gate"), ("cam-p1", "P-01 · Perimeter east", "perimeter"),
                ("cam-p2", "P-02 · Service gate", "perimeter"), ("cam-c1", "C-01 · Clubhouse", "clubhouse"),
            ]:
                rules=default_rules()
                rules['R1']['enabled']=location_id=='zone-b'
                rules['R3']['enabled']=location_id=='perimeter'
                session.add(Camera(id=camera_id, name=name, location_id=location_id, rules=rules))
        session.commit()
