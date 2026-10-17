import csv
import http.client
import importlib.util
import json
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "label_server.py"
spec = importlib.util.spec_from_file_location("label_server", SCRIPT)
ls = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ls)

COLUMNS = ["clip_id", "split", "site", "camera", "date", "start_time", "duration_sec", "size_mb", "person_actors", "vehicle_actors",
           "vehicle_activities", "context_tag", "activity_summary", "upload_recorded_at_myt_for_testing", "scene_hint",
           "R1_expected", "R3_expected", "labeller", "notes", "s3_key"]


@pytest.fixture
def meva(tmp_path):
    (tmp_path / "mp4").mkdir()
    rows = []
    for number, split in ((1, "debug"), (2, "holdout")):
        clip = f"clip{number}"
        (tmp_path / "mp4" / f"{clip}.mp4").write_bytes(bytes(range(256)) * 8)
        rows.append({**dict.fromkeys(COLUMNS, ""), "clip_id": clip, "split": split, "site": "school", "camera": f"G{number}",
                     "date": "2018-03-07", "start_time": "16:50:00", "duration_sec": "300", "context_tag": "R1_context",
                     "activity_summary": "Vehicle_Stoppingx1"})
    with (tmp_path / "eval_candidates.csv").open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    return tmp_path


@pytest.fixture
def server(meva):
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), None)
    port = httpd.server_address[1]
    httpd.RequestHandlerClass = ls.make_handler(meva, port)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield port
    httpd.shutdown()
    httpd.server_close()


def call(port, method, path, body=None, headers=None, host=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    data = json.dumps(body).encode() if body is not None else None
    merged = {"Host": host or f"127.0.0.1:{port}", **({"Content-Type": "application/json"} if data else {}), **(headers or {})}
    connection.request(method, path, body=data, headers=merged)
    response = connection.getresponse()
    return response.status, dict(response.getheaders()), response.read()


def test_parse_range_forms_and_invalid_headers():
    assert ls.parse_range("bytes=0-99", 1000) == (0, 99)
    assert ls.parse_range("bytes=900-", 1000) == (900, 999)
    assert ls.parse_range("bytes=-100", 1000) == (900, 999)
    assert ls.parse_range("bytes=0-5000", 1000) == (0, 999)
    for bad in ("bytes=1000-", "bytes=5-2", "bytes=-", "items=0-1", "", None, "bytes=-0"):
        assert ls.parse_range(bad, 1000) is None


def test_clean_label_rejects_unknown_values_and_trims_text():
    ok = ls.clean_label({"scene_hint": "parking", "r1": "yes", "r3": "unclear", "zone_note": "  door  ", "notes": "x" * 5000})
    assert ok["zone_note"] == "door" and len(ok["notes"]) == ls.MAX_TEXT and ok["context_viewed"] is False
    assert ls.clean_label({"scene_hint": "garage"}) is None and ls.clean_label({"r1": "maybe"}) is None
    assert ls.clean_label({"notes": 5}) is None and ls.clean_label("x") is None
    assert ls.clean_name("../evil") is None and ls.clean_name("") is None and ls.clean_name("李明") == "李明"


def test_server_rejects_foreign_host_and_origin_but_serves_local_page(server):
    assert call(server, "GET", "/")[0] == 200
    assert call(server, "GET", "/api/clips", host="evil.example")[0] == 403
    assert call(server, "GET", "/api/clips", headers={"Origin": "http://evil.example"})[0] == 403
    assert call(server, "PUT", "/api/labels", {"labeller": "a", "clip_id": "clip1", "label": {}}, host="evil.example")[0] == 403


def test_clip_list_hides_activity_context_until_requested(server):
    status, _, body = call(server, "GET", "/api/clips")
    clips = json.loads(body)["clips"]
    assert status == 200 and [c["clip_id"] for c in clips] == ["clip1", "clip2"]
    assert all("activity_summary" not in c and "context_tag" not in c for c in clips)
    assert json.loads(call(server, "GET", "/api/context/clip1")[2])["context_tag"] == "R1_context"
    assert call(server, "GET", "/api/context/unknown")[0] == 404


def test_media_supports_range_and_only_serves_listed_clips(server):
    status, headers, body = call(server, "GET", "/media/clip1.mp4", headers={"Range": "bytes=10-19"})
    assert status == 206 and len(body) == 10 and headers["Content-Range"] == "bytes 10-19/2048"
    assert call(server, "GET", "/media/clip1.mp4", headers={"Range": "bytes=99999-"})[0] == 416
    assert call(server, "GET", "/media/clip1.mp4")[0] == 200
    for path in ("/media/..%2Feval_candidates.mp4", "/media/other.mp4", "/media/../labels.mp4"):
        assert call(server, "GET", path)[0] == 404


def test_labels_save_per_labeller_and_export_fills_the_sheet(server, meva):
    label = {"scene_hint": "parking", "r1": "yes", "r3": "no", "zone_note": "side door, left", "notes": "[01:10] two cars",
             "context_viewed": True}
    assert call(server, "PUT", "/api/labels", {"labeller": "Mei", "clip_id": "clip1", "label": label})[0] == 200
    assert call(server, "PUT", "/api/labels", {"labeller": "Mei", "clip_id": "clip2", "label": {"scene_hint": "other"}})[0] == 200
    assert call(server, "PUT", "/api/labels", {"labeller": "Ali", "clip_id": "clip1", "label": {"r1": "no"}})[0] == 200
    assert json.loads(call(server, "GET", "/api/clips")[2])["labels"]["Ali"]["clip1"]["r1"] == "no"
    assert call(server, "PUT", "/api/labels", {"labeller": "Mei", "clip_id": "clip1", "label": {"r1": "maybe"}})[0] == 422
    assert call(server, "PUT", "/api/labels", {"labeller": "Mei", "clip_id": "../x", "label": {}})[0] == 422
    assert call(server, "PUT", "/api/labels", {"labeller": "Mei", "clip_id": "clip1", "label": {}}, headers={"Content-Type": "text/plain"})[0] == 400
    status, _, body = call(server, "POST", "/api/export", {"labeller": "Mei"})
    result = json.loads(body)
    assert status == 200 and result["fully_labelled"] == 1 and result["total"] == 2
    rows = list(csv.DictReader(Path(result["file"]).open(encoding="utf-8-sig")))
    assert rows[0]["R1_expected"] == "yes" and rows[0]["R3_expected"] == "no" and rows[0]["labeller"] == "Mei"
    assert "R3 zone: side door, left" in rows[0]["notes"] and "context was viewed" in rows[0]["notes"]
    assert rows[1]["scene_hint"] == "other" and rows[1]["R1_expected"] == ""
    assert (meva / "eval_candidates.csv").read_text(encoding="utf-8-sig").count("yes") == 0  # original sheet untouched
