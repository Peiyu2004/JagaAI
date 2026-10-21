import importlib.util
from pathlib import Path
import sqlite3

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app import main
from app.hosting import allowed_origins, mount_frontend
from app.realtime import publish_refresh
from test_api import api, resident_login, staff_login


@pytest.mark.parametrize("origin", ["*", "https://*.example.com", "https://example.com/path", "https://a:b@example.com", ""])
def test_hosting_rejects_unbounded_or_non_origin_configuration(monkeypatch, origin):
    monkeypatch.setenv("JAGAAI_ALLOWED_ORIGINS", origin)
    with pytest.raises(ValueError):
        allowed_origins()


def test_allowed_hosted_origin_can_log_in_with_a_secure_cookie(api, monkeypatch):
    client, _, _ = api
    origin = "https://demo.trycloudflare.com"
    monkeypatch.setenv("JAGAAI_ALLOWED_ORIGINS", origin)
    monkeypatch.setenv("JAGAAI_SECURE_COOKIE", "1")
    monkeypatch.setattr(main, "ALLOWED_ORIGINS", allowed_origins())
    client.base_url = origin
    credentials = {"email": "admin@jagaai.local", "password": "JagaAI-demo-2026!"}
    assert client.post("/api/auth/login", json=credentials, headers={"Origin": "https://another.example"}).status_code == 403
    response = client.post("/api/auth/login", json=credentials, headers={"Origin": origin})
    assert response.status_code == 200
    cookie = response.headers["set-cookie"].lower()
    assert "secure" in cookie and "httponly" in cookie and "samesite=strict" in cookie
    assert client.get("/api/auth/me").json()["user"]["role"] == "admin"
    assert client.post("/api/auth/logout", headers={"Origin": origin}).status_code == 200
    assert client.get("/api/bootstrap").status_code == 401


def test_polling_authentication_and_resident_metadata_boundary(api):
    client, _, _ = api
    assert client.get("/api/updates").status_code == 401
    staff_login(client)
    before = client.get("/api/updates").json()["revision"]
    publish_refresh("private-management-change", "private-record-id")
    assert client.get("/api/updates").json() == {"revision": before + 1}
    resident_login(client)
    assert set(client.get("/api/updates").json()) == {"revision"}


def test_combined_website_preserves_spa_and_api_error_boundaries(tmp_path):
    (tmp_path / "index.html").write_text("<h1>JagaAI</h1>")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets/app.js").write_text("console.log('app')")
    app = FastAPI()
    mount_frontend(app, tmp_path)
    with TestClient(app) as client:
        assert "JagaAI" in client.get("/").text
        assert "JagaAI" in client.get("/resident").text
        assert client.get("/assets/app.js").status_code == 200
        assert client.get("/assets/missing.js").status_code == 404
        assert client.get("/api/not-a-route").status_code == 404
        assert client.get("/../not-a-secret.env").status_code == 404


def test_drive_backup_preserves_wal_commits_and_restores_only_a_fresh_workspace(tmp_path):
    path = Path(__file__).resolve().parents[2] / "deploy/colab/colab_runtime.py"
    spec = importlib.util.spec_from_file_location("jagaai_colab_runtime_test", path)
    runtime = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runtime)
    data, backup, restored = tmp_path / "data", tmp_path / "backup", tmp_path / "restored"
    (data / "videos").mkdir(parents=True)
    (data / "videos/public.mp4").write_bytes(b"example media")
    with sqlite3.connect(data / "jagaai-v3.sqlite") as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE checks (value TEXT)")
        connection.execute("INSERT INTO checks VALUES ('committed in WAL')")
        connection.commit()
        runtime.snapshot_data(data, backup)
    assert not list(backup.glob("*-wal"))
    runtime.restore_data(restored, backup)
    with sqlite3.connect(restored / "jagaai-v3.sqlite") as connection:
        assert connection.execute("SELECT value FROM checks").fetchone()[0] == "committed in WAL"
        connection.execute("UPDATE checks SET value='local change'")
    runtime.restore_data(restored, backup)
    with sqlite3.connect(restored / "jagaai-v3.sqlite") as connection:
        assert connection.execute("SELECT value FROM checks").fetchone()[0] == "local change"
    assert (restored / "videos/public.mp4").read_bytes() == b"example media"


def test_colab_children_do_not_inherit_the_notebook_only_plot_backend(tmp_path, monkeypatch):
    path = Path(__file__).resolve().parents[2] / "deploy/colab/colab_runtime.py"
    spec = importlib.util.spec_from_file_location("jagaai_colab_environment_test", path)
    runtime = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runtime)
    monkeypatch.setattr(runtime, "has_gpu", lambda: True)
    monkeypatch.setenv("MPLBACKEND", "module://matplotlib_inline.backend_inline")
    session = runtime.ColabSession(tmp_path, "admin@example.com", "test-only-passphrase")
    assert session.env["MPLBACKEND"] == "agg"
