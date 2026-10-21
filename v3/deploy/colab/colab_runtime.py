"""Manual, temporary Colab session for the unmodified JagaAI inference pipeline.

No billing API, external inference provider, keep-alive, or automatic restart is used.
"""
import hashlib
from contextlib import closing
import http.cookiejar
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request

TOOLS = {
    "ollama": (
        "https://github.com/ollama/ollama/releases/download/v0.40.6/ollama-linux-amd64.tar.zst",
        "c164ab8b1b28e2a247c29719b8e404c423c5b83ae64c3ab4e59d50c7ff7fc5e0",
    ),
    "cloudflared": (
        "https://github.com/cloudflare/cloudflared/releases/download/2026.10.2/cloudflared-linux-amd64",
        "35fbdd2beb378436c7da377d7358cea8e33f9c94a6705d1d8036bf9b0d6d8005",
    ),
}
MODELS = ("qwen3-embedding:0.6b", "qwen3-vl:2b-instruct")


def digest(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def download(url, target, expected):
    target = Path(target)
    if target.is_file() and digest(target) == expected:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".partial")
    print("Downloading " + target.name, flush=True)
    try:
        with urllib.request.urlopen(url, timeout=90) as source, partial.open("wb") as destination:
            shutil.copyfileobj(source, destination, length=4 * 1024 * 1024)
        if digest(partial) != expected:
            raise RuntimeError("SHA-256 verification failed for " + target.name)
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)


def has_gpu():
    if not shutil.which("nvidia-smi"):
        return False
    result = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                            capture_output=True, text=True, timeout=15)
    return result.returncode == 0 and bool(result.stdout.strip())


def install(root):
    root = Path(root).resolve()
    if platform.system() != "Linux" or platform.machine() not in {"x86_64", "AMD64"}:
        raise RuntimeError("This installer targets Colab Linux x86-64, not the Windows launcher.")
    runtime = root / ".runtime-colab"
    runtime.mkdir(exist_ok=True)
    packages = [name for name in ("ffmpeg", "zstd") if not shutil.which(name)]
    if packages:
        subprocess.run(["apt-get", "update", "-qq"], check=True)
        subprocess.run(["apt-get", "install", "-y", "-qq", *packages], check=True)
    python = runtime / "venv/bin/python"
    if not python.exists():
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "virtualenv"], check=True)
        subprocess.run([sys.executable, "-m", "virtualenv", str(python.parents[1])], check=True)
    requirements = root / "backend" / ("requirements-vision.txt" if has_gpu() else "requirements-cpu.txt")
    fingerprint = hashlib.sha256((requirements.name + sys.version + "".join(
        digest(path) for path in sorted((root / "backend").glob("requirements*.txt")))).encode()).hexdigest()
    receipt = runtime / "dependencies.sha256"
    if not receipt.exists() or receipt.read_text() != fingerprint:
        print("Installing isolated Python and detection dependencies…", flush=True)
        subprocess.run([str(python), "-m", "pip", "install", "-q", "-r", str(requirements)], check=True)
        receipt.write_text(fingerprint)
    ollama = runtime / "ollama/bin/ollama"
    ollama_receipt = runtime / "ollama.sha256"
    if not ollama.exists() or not ollama_receipt.exists() or ollama_receipt.read_text() != TOOLS["ollama"][1]:
        archive = runtime / "ollama-linux-amd64.tar.zst"
        download(TOOLS["ollama"][0], archive, TOOLS["ollama"][1])
        ollama.parents[1].mkdir(exist_ok=True)
        subprocess.run(["tar", "--zstd", "-xf", str(archive), "-C", str(ollama.parents[1])], check=True)
        ollama_receipt.write_text(TOOLS["ollama"][1])
    cloudflared = runtime / "cloudflared"
    download(TOOLS["cloudflared"][0], cloudflared, TOOLS["cloudflared"][1])
    cloudflared.chmod(0o755)
    print("Dependencies ready. AI device: " + ("NVIDIA GPU" if has_gpu() else "CPU (slower)"), flush=True)


def snapshot_data(data, destination):
    """Export SQLite consistently; never copy its live WAL files to Drive."""
    data, destination = Path(data), Path(destination)
    database = data / "jagaai-v3.sqlite"
    if not database.is_file():
        return
    destination.mkdir(parents=True, exist_ok=True)
    pending = destination / "snapshot.sqlite"
    pending.unlink(missing_ok=True)
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as source, closing(sqlite3.connect(pending)) as target:
        source.backup(target)
    for folder in ("videos", "frames", "photos"):
        if (data / folder).is_dir():
            shutil.copytree(data / folder, destination / folder, dirs_exist_ok=True)
    pending.replace(destination / "jagaai-v3.sqlite")


def restore_data(data, source):
    data, source = Path(data), Path(source)
    if not (data / "jagaai-v3.sqlite").exists() and (source / "jagaai-v3.sqlite").is_file():
        data.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / "jagaai-v3.sqlite", data / "jagaai-v3.sqlite")
        for folder in ("videos", "frames", "photos"):
            if (source / folder).is_dir():
                shutil.copytree(source / folder, data / folder, dirs_exist_ok=True)


class ColabSession:
    def __init__(self, root, email, password, backup_dir=None, resident_demo=True):
        if len(password) < 12 or not password.strip():
            raise ValueError("Use an administrator password of at least 12 characters.")
        self.root = Path(root).resolve()
        self.runtime = self.root / ".runtime-colab"
        self.data = self.runtime / "data"
        self.backup_dir = Path(backup_dir) / "data" if backup_dir else None
        self.children = []
        self.handles = []
        self.closed = False
        self.stop_backup = threading.Event()
        self.backup_lock = threading.Lock()
        self.backup_thread = None
        self.url = None
        self.env = os.environ.copy()
        self.env.update({
            "JAGAAI_DATA_DIR": str(self.data), "JAGAAI_OLLAMA_URL": "http://127.0.0.1:11435",
            "JAGAAI_YOLOX_MODEL": str(self.root / "models/yolox_s.onnx"),
            "JAGAAI_FRONTEND_DIR": str(self.root / "frontend/dist"),
            "JAGAAI_SECURE_COOKIE": "1", "JAGAAI_MAX_VIDEO_MB": "90",
            "JAGAAI_ADMIN_EMAIL": email.strip().lower(), "JAGAAI_ADMIN_PASSWORD": password,
            "JAGAAI_SUPERVISOR_PASSWORD": secrets.token_urlsafe(48),
            "JAGAAI_RESIDENT_DEMO": "1" if resident_demo else "0",
            "JAGAAI_DEVICE": "auto" if has_gpu() else "cpu",
            "OLLAMA_HOST": "127.0.0.1:11435", "OLLAMA_NO_CLOUD": "1",
            "OLLAMA_MODELS": str(self.runtime / "models"),
            "OLLAMA_MAX_LOADED_MODELS": "1", "OLLAMA_NUM_PARALLEL": "1",
            "NO_PROXY": "127.0.0.1,localhost", "PYTHONUNBUFFERED": "1",
            # Colab's inline backend is outside the isolated venv; ByteTrack imports matplotlib.
            "MPLBACKEND": "agg",
        })

    @property
    def python(self):
        return str(self.runtime / "venv/bin/python")

    def spawn(self, name, command):
        logs = self.runtime / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        handle = (logs / (name + ".log")).open("w")
        self.handles.append(handle)
        process = subprocess.Popen(command, env=self.env, cwd=self.root / "backend", stdout=handle,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        self.children.append((name, process))
        return process

    def check_children(self):
        for name, process in self.children:
            if process.poll() is not None:
                raise RuntimeError(f"{name} stopped. See {self.runtime / 'logs' / (name + '.log')}. Restart manually.")

    def wait_json(self, url, seconds=90):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.check_children()
            try:
                with opener.open(url, timeout=3) as response:
                    return json.load(response)
            except (OSError, ValueError):
                time.sleep(1)
        raise RuntimeError("Startup timed out: " + url)

    def start(self):
        try:
            for port in (7860, 11435):
                with socket.socket() as probe:
                    if probe.connect_ex(("127.0.0.1", port)) == 0:
                        raise RuntimeError(f"Port {port} is occupied. Stop the previous JagaAI cell first.")
            if self.backup_dir:
                restore_data(self.data, self.backup_dir)
            ollama = str(self.runtime / "ollama/bin/ollama")
            self.spawn("ollama", [ollama, "serve"])
            self.wait_json("http://127.0.0.1:11435/api/tags")
            for model in MODELS:
                print("Preparing real local model: " + model, flush=True)
                subprocess.run([ollama, "pull", model], env=self.env, check=True)
            subprocess.run([self.python, str(self.root / "deploy/colab/prepare_demo.py")],
                           cwd=self.root / "backend", env=self.env, check=True)
            print("Testing detection, image description and embeddings with a public sample…", flush=True)
            verification = subprocess.run([self.python, str(self.root / "deploy/colab/verify_ai.py")],
                                          cwd=self.root / "backend", env=self.env, text=True,
                                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            print(verification.stdout, flush=True)
            verification.check_returncode()
            self.spawn("tunnel", [str(self.runtime / "cloudflared"), "tunnel", "--no-autoupdate",
                                  "--url", "http://127.0.0.1:7860", "--protocol", "http2"])
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                self.check_children()
                log = (self.runtime / "logs/tunnel.log").read_text(errors="replace")
                found = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com\b", log)
                if found:
                    self.url = found.group(0)
                    break
                time.sleep(1)
            if not self.url:
                raise RuntimeError("No temporary URL was assigned. Check logs/tunnel.log; retry manually later.")
            self.env["JAGAAI_ALLOWED_ORIGINS"] = self.url
            self.spawn("api", [self.python, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
                               "--port", "7860", "--workers", "1", "--no-access-log"])
            self.wait_json("http://127.0.0.1:7860/api/health")
            if self.backup_dir:
                self.backup()
                self.backup_thread = threading.Thread(target=self.backup_loop, daemon=True)
                self.backup_thread.start()
            print("\nJagaAI temporary website + real AI: " + self.url, flush=True)
            print("Administrator: " + self.env["JAGAAI_ADMIN_EMAIL"] + " (use the password you entered)", flush=True)
            print("Resident demo: " + self.url + "/resident", flush=True)
            print("The two public samples are queued for REAL analysis; wait for them to finish.", flush=True)
            print("Keep this cell running. Stop the cell to stop the session. No automatic restart is configured.", flush=True)
            return self.url
        except BaseException:
            self.close()
            raise

    def backup(self):
        if self.backup_dir:
            with self.backup_lock:
                snapshot_data(self.data, self.backup_dir)

    def verify_application(self, seconds=900):
        """Check the running app and real jobs; verify the public URL from an external client."""
        # This client connects only to loopback. Browser-facing cookies remain Secure.
        policy = http.cookiejar.DefaultCookiePolicy(secure_protocols=("https", "wss", "http"))
        client = urllib.request.build_opener(urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar(policy)))

        def request(path, payload=None):
            body = None if payload is None else json.dumps(payload).encode()
            headers = {"Origin": self.url, "Content-Type": "application/json"}
            with client.open(urllib.request.Request("http://127.0.0.1:7860" + path, data=body, headers=headers), timeout=90) as response:
                return json.load(response)

        print("Checking application sign-in and real sample analysis on loopback…", flush=True)
        request("/api/health")
        request("/api/auth/login", {"email": self.env["JAGAAI_ADMIN_EMAIL"],
                                     "password": self.env["JAGAAI_ADMIN_PASSWORD"]})
        try:
            expected = {"colab-demo-stairs-entry", "colab-demo-courtyard-entry"}
            bootstrap = request("/api/bootstrap")
            # Retry only our known public fixtures after a repaired environment.
            for video in bootstrap["videos"]:
                if video["id"] in expected and video["status"] == "failed":
                    request("/api/videos/" + video["id"] + "/analyse", {})
            deadline, previous = time.monotonic() + seconds, None
            while time.monotonic() < deadline:
                self.check_children()
                videos = [video for video in request("/api/bootstrap")["videos"] if video["id"] in expected]
                if {video["id"] for video in videos} != expected:
                    raise RuntimeError("The two public sample recordings are missing.")
                states = {video["id"]: [video["status"], video["description_status"]] for video in videos}
                if states != previous:
                    print(json.dumps({"public_sample_progress": states}), flush=True)
                    previous = states
                failed = [video for video in videos if video["status"] == "failed" or video["description_status"] == "failed"]
                if failed:
                    raise RuntimeError("Public sample analysis failed: " + str(failed[0].get("error")))
                if all(video["status"] == "ready" and video["description_status"] in {"ready", "partial"} for video in videos):
                    break
                time.sleep(10)
            else:
                raise RuntimeError("Public sample analysis is still incomplete. Inspect the worker log before retrying.")
            result = request("/api/search", {"query": "outdoor stair entrance"})
            candidates = result.get("related", []) + result.get("nearest", [])
            if "unavailable" in result.get("message", "").lower() or not candidates:
                raise RuntimeError("Public semantic search did not return analysed evidence: " + result.get("message", ""))
            print(json.dumps({"application_ai_check": "passed", "analysed_samples": len(videos),
                              "search_candidates": len(candidates),
                              "detector_providers": [v.get("analysis_metrics", {}).get("provider") for v in videos]}), flush=True)
        finally:
            try:
                request("/api/auth/logout", {})
            except OSError:
                pass

    def backup_loop(self):
        while not self.stop_backup.wait(120):
            try:
                self.backup()
            except (OSError, sqlite3.Error) as error:
                print("Drive backup failed: " + str(error), flush=True)

    def wait(self):
        try:
            while True:
                self.check_children()
                time.sleep(3)
        except KeyboardInterrupt:
            print("Stopping this temporary session…", flush=True)
        finally:
            self.close()

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.stop_backup.set()
        if self.backup_thread:
            self.backup_thread.join(timeout=5)
        for _, process in reversed(self.children):
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    continue
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
        for handle in self.handles:
            handle.close()
        self.backup()
