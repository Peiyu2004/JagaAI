"""Local labelling tool for the MEVA evaluation clips (R1 / R3 ground truth by a person).

Serves only on 127.0.0.1. Labels are saved to <dir>/labels.json after every change, so you can stop and
resume. `Export` writes <dir>/eval_labelled_<name>.csv in the same columns as eval_candidates.csv.
Nothing is sent anywhere else; the page loads no external scripts, fonts or images.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import tempfile
import threading
import webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DIR = ROOT / "data" / "meva"
PAGE = Path(__file__).with_name("labeller") / "index.html"
SCENES = {"parking", "entrance", "walkway", "other", "unclear"}
ANSWERS = {"yes", "no", "unclear"}
NAME_RE = re.compile(r"[^\x00-\x1f/\\<>:\"|?*]{1,40}")
CLIP_RE = re.compile(r"[\w.\-]+")
MAX_TEXT = 2000
LABEL_LOCK = threading.Lock()


def load_rows(meva_dir):
    path = Path(meva_dir) / "eval_candidates.csv"
    with path.open(encoding="utf-8-sig", newline="") as file:
        return list(csv.DictReader(file))


def clean_name(value):
    name = str(value or "").strip()
    return name if NAME_RE.fullmatch(name) else None


def clean_label(payload):
    """Validate a label coming from the page. Returns a normalised dict or None when any field is invalid."""
    if not isinstance(payload, dict):
        return None
    scene, r1, r3 = payload.get("scene_hint", ""), payload.get("r1", ""), payload.get("r3", "")
    if scene not in SCENES | {""} or r1 not in ANSWERS | {""} or r3 not in ANSWERS | {""}:
        return None
    texts = {}
    for key in ("zone_note", "notes"):
        value = payload.get(key, "")
        if not isinstance(value, str):
            return None
        texts[key] = value.strip()[:MAX_TEXT]
    return {"scene_hint": scene, "r1": r1, "r3": r3, **texts, "context_viewed": bool(payload.get("context_viewed")),
            "updated": datetime.now(timezone.utc).isoformat(timespec="seconds")}


def read_labels(meva_dir):
    path = Path(meva_dir) / "labels.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def write_labels(meva_dir, labels):
    path = Path(meva_dir) / "labels.json"
    handle, temporary = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    with os.fdopen(handle, "w", encoding="utf-8") as file:
        json.dump(labels, file, ensure_ascii=False, indent=1)
    os.replace(temporary, path)


def export_csv(meva_dir, labeller):
    """Fill the sheet's columns from one labeller's saved labels. Returns (path, labelled_count)."""
    rows = load_rows(meva_dir)
    mine = read_labels(meva_dir).get(labeller, {})
    done = 0
    for row in rows:
        label = mine.get(row["clip_id"])
        if not label:
            continue
        done += bool(label["scene_hint"] and label["r1"] and label["r3"])
        row["scene_hint"], row["R1_expected"], row["R3_expected"] = label["scene_hint"], label["r1"], label["r3"]
        parts = [f"R3 zone: {label['zone_note']}" if label["zone_note"] else "", label["notes"],
                 "[MEVA activity context was viewed]" if label["context_viewed"] else ""]
        row["labeller"], row["notes"] = labeller, " | ".join(p for p in parts if p)
    target = Path(meva_dir) / f"eval_labelled_{re.sub(r'[^\w.-]', '_', labeller)}.csv"
    with target.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    return target, done


def parse_range(header, size):
    """Return (start, end) inclusive for a single byte range, or None when the header is invalid."""
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", header or "")
    if not match or not any(match.groups()) or size <= 0:
        return None
    first, last = match.groups()
    if first == "":
        length = int(last)
        return (max(0, size - length), size - 1) if length else None
    start = int(first)
    end = min(int(last), size - 1) if last else size - 1
    return (start, end) if start <= end and start < size else None


def make_handler(meva_dir, port):
    meva_dir = Path(meva_dir)
    clips = {row["clip_id"]: row for row in load_rows(meva_dir)}
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    class Handler(BaseHandler):
        directory = meva_dir
        clip_rows = clips
        hosts = allowed_hosts

    return Handler


class BaseHandler(BaseHTTPRequestHandler):
    directory: Path
    clip_rows: dict
    hosts: set

    def log_message(self, *_args):
        pass

    def send_json(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def host_ok(self):
        # Rejects DNS-rebinding and cross-site requests: only the exact local origin may talk to this server.
        if self.headers.get("Host") not in self.hosts:
            return False
        origin = self.headers.get("Origin")
        return origin is None or origin in {f"http://{h}" for h in self.hosts}

    def read_json(self):
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            return None
        try:
            length = int(self.headers.get("Content-Length", "0"))
            return json.loads(self.rfile.read(min(length, 100_000))) if 0 < length <= 100_000 else None
        except (ValueError, json.JSONDecodeError):
            return None

    def do_GET(self):
        if not self.host_ok():
            return self.send_json(403, {"error": "forbidden host"})
        path = urlparse(self.path).path
        if path == "/":
            data = PAGE.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'")
            self.end_headers()
            return self.wfile.write(data)
        if path == "/api/clips":
            public = ("clip_id", "split", "site", "camera", "date", "start_time", "duration_sec")
            return self.send_json(200, {"clips": [{k: r[k] for k in public} for r in self.clip_rows.values()],
                                        "labels": read_labels(self.directory)})
        match = re.fullmatch(r"/api/context/([\w.\-]+)", path)
        if match and match.group(1) in self.clip_rows:
            row = self.clip_rows[match.group(1)]
            return self.send_json(200, {"activity_summary": row["activity_summary"], "context_tag": row["context_tag"]})
        match = re.fullmatch(r"/media/([\w.\-]+)\.mp4", path)
        if match and match.group(1) in self.clip_rows:
            return self.send_media(self.directory / "mp4" / (match.group(1) + ".mp4"))
        self.send_json(404, {"error": "not found"})

    def send_media(self, file_path):
        if not file_path.is_file():
            return self.send_json(404, {"error": "clip not downloaded"})
        size = file_path.stat().st_size
        header = self.headers.get("Range")
        span = parse_range(header, size) if header else (0, size - 1)
        if span is None:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            return self.end_headers()
        start, end = span
        self.send_response(206 if header else 200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if header:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        try:
            with file_path.open("rb") as file:
                file.seek(start)
                remaining = end - start + 1
                while remaining > 0 and (chunk := file.read(min(1 << 20, remaining))):
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the player seeked away; normal for video

    def do_PUT(self):
        if not self.host_ok():
            return self.send_json(403, {"error": "forbidden host"})
        body = self.read_json()
        if urlparse(self.path).path != "/api/labels" or not isinstance(body, dict):
            return self.send_json(400, {"error": "expected JSON"})
        labeller, clip = clean_name(body.get("labeller")), body.get("clip_id")
        label = clean_label(body.get("label"))
        if not labeller or clip not in self.clip_rows or label is None:
            return self.send_json(422, {"error": "invalid labeller, clip or label values"})
        with LABEL_LOCK:
            labels = read_labels(self.directory)
            labels.setdefault(labeller, {})[clip] = label
            write_labels(self.directory, labels)
        self.send_json(200, {"saved": True, "updated": label["updated"]})

    def do_POST(self):
        if not self.host_ok():
            return self.send_json(403, {"error": "forbidden host"})
        body = self.read_json()
        labeller = clean_name(body.get("labeller")) if isinstance(body, dict) else None
        if urlparse(self.path).path != "/api/export" or not labeller:
            return self.send_json(400, {"error": "expected a labeller name"})
        with LABEL_LOCK:
            target, done = export_csv(self.directory, labeller)
        self.send_json(200, {"file": str(target), "fully_labelled": done, "total": len(self.clip_rows)})


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dir", type=Path, default=DEFAULT_DIR, help="folder with eval_candidates.csv and mp4/")
    parser.add_argument("--port", type=int, default=8780)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if not (args.dir / "eval_candidates.csv").exists():
        raise SystemExit(f"{args.dir / 'eval_candidates.csv'} not found. Run scripts/meva_select.py plan first.")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(args.dir, args.port))
    url = f"http://127.0.0.1:{args.port}/"
    print(f"MEVA labelling tool: {url}  (Ctrl+C to stop; labels are saved to {args.dir / 'labels.json'})", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
