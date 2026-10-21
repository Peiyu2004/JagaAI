import os
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import event, inspect, text
from sqlmodel import Session, SQLModel, create_engine, select

from .models import AppSettings, Camera, Location, NotificationPolicy, User

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
                               ("video", "source", "VARCHAR NOT NULL DEFAULT 'upload'"),
                               ("video", "is_simulation", "BOOLEAN NOT NULL DEFAULT 0"),
                               ("guard", "notification_opt_in", "BOOLEAN NOT NULL DEFAULT 0"),
                               ("notificationpolicy", "voice_language", "VARCHAR NOT NULL DEFAULT 'zh-CN'"),
                               ("guarddispatch", "voice_language", "VARCHAR NOT NULL DEFAULT 'zh-CN'"),
                               ("user", "status", "VARCHAR NOT NULL DEFAULT 'active'"),
                               ("user", "phone", "VARCHAR NOT NULL DEFAULT ''"),
                               ("user", "unit", "VARCHAR NOT NULL DEFAULT ''")):
        if column not in {item['name'] for item in inspect(engine).get_columns(table)}:
            with engine.begin() as connection:
                connection.execute(text(f'ALTER TABLE "{table}" ADD COLUMN {column} {ddl}'))
    with engine.begin() as connection:
        # Supervisors ran daily security operations without management rights: that is the guard role now.
        connection.execute(text("UPDATE \"user\" SET role = 'guard' WHERE role = 'supervisor'"))
    with Session(engine) as session:
        if not session.get(AppSettings, "global"):
            session.add(AppSettings())
        if not session.get(NotificationPolicy, "global"):
            session.add(NotificationPolicy())
        if not session.exec(select(User).where(User.role == "admin")).first():
            session.add(User(email=os.environ.get("JAGAAI_ADMIN_EMAIL", "admin@jagaai.local").lower(), name="Property manager", role="admin",
                             password_hash=hash_password(os.environ.get("JAGAAI_ADMIN_PASSWORD", "JagaAI-demo-2026!"))))
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
            session.flush()
        if os.environ.get("JAGAAI_DEMO_ACCOUNTS", "1") == "1":
            seed_demo_accounts(session, hash_password(os.environ.get("JAGAAI_DEMO_PASSWORD", "JagaAI-demo-2026!")))
        session.commit()


DEMO_ACCOUNTS = [
    # email, name, role, unit
    ("manager@jagaai.local", "Estate manager", "manager", ""),
    ("guard@jagaai.local", "Ahmad Faiz", "guard", ""),
    ("resident@jagaai.local", "Tan Mei Ling", "resident", "B-12-03"),
]


def seed_demo_accounts(session, password_hash):
    """One account per role for the demo, plus sample tasks, activities and points. Existing rows are kept."""
    from datetime import timedelta

    from .models import Activity, PointEntry, Task, utcnow

    users = {}
    for email, name, role, unit in DEMO_ACCOUNTS:
        user = session.exec(select(User).where(User.email == email)).first()
        if not user:
            user = User(email=email, name=name, role=role, unit=unit, password_hash=password_hash)
            session.add(user)
            session.flush()
        users[role] = user
    now = utcnow()

    def myt(days, hour):
        # A whole hour in Malaysia time (UTC+8), a few days from now.
        day = now + timedelta(days=days)
        return day.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(hours=hour - 8)

    if not session.exec(select(Task)).first():
        session.add_all([
            Task(title="Night patrol · Zone B parking", detail="Walk all parking rows and check the B-02 bays for vehicles idling with engines on.",
                 location_id="zone-b", priority="high", assignee_id=users["guard"].id, created_by=users["manager"].id),
            Task(title="Check service gate padlock", detail="Residents reported the service gate left open after 23:00. Confirm the padlock and log a photo.",
                 location_id="perimeter", status="in_progress", assignee_id=users["guard"].id, created_by=users["manager"].id),
            Task(title="Clubhouse closing round", detail="Confirm all clubhouse doors are locked after the 22:00 booking ends.",
                 location_id="clubhouse", created_by=users["manager"].id),
        ])
    if not session.exec(select(Activity)).first():
        session.add_all([
            Activity(title="Gotong-royong community clean-up", description="Bring gloves; refreshments provided at the clubhouse after the clean-up.",
                     location="Clubhouse lawn", starts_at=myt(4, 8), capacity=40, points=30, created_by=users["manager"].id),
            Activity(title="Neighbourhood watch briefing", description="Meet the security team, learn how alerts are handled and how to report safely.",
                     location="Clubhouse hall", starts_at=myt(9, 20), capacity=60, points=20, created_by=users["manager"].id),
            Activity(title="Kids' cycling safety workshop", description="For children aged 6–12 with a parent. Helmets available on loan.",
                     location="Zone B parking (closed off)", starts_at=myt(16, 10), capacity=25, points=20, created_by=users["manager"].id),
        ])
    if not session.exec(select(PointEntry).where(PointEntry.user_id == users["resident"].id)).first():
        session.add(PointEntry(user_id=users["resident"].id, points=50, reason="Welcome to the community", ref="welcome"))
