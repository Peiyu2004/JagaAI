"""Pure-function checks for scripts/meva_select.py. The YAML fixtures are lines copied from the real
`examples/annotations/2018-03-07/16/...school.G328` files (checked 2026-10-15)."""
import yaml
import importlib.util
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "meva_select.py"
spec = importlib.util.spec_from_file_location("meva_select", SCRIPT)
meva = importlib.util.module_from_spec(spec)
spec.loader.exec_module(meva)


def test_parse_video_key_handles_midnight_wrap_and_rejects_other_names():
    clip = meva.parse_video_key("drops-123-r13/2018-03-11/23/2018-03-11.23-55-00.00-00-00.school.G299.r13.avi", 10)
    assert clip["duration_sec"] == 300 and clip["hour"] == 23 and clip["camera"] == "G299" and clip["site"] == "school"
    assert clip["clip_id"] == "2018-03-11.23-55-00.00-00-00.school.G299"
    assert meva.parse_video_key("drops-123-r13/readme.txt", 1) is None


REAL_ACTIVITIES = """
- { meta: "2018-03-07.16-50-01.16-55-01.school.G328 events" }
- { act: { act3: { Open_Vehicle_Door: 1.0 } , id2: 3, timespan: [{tsr0: [1369, 1436]}], src: truth, actors: [{ id1: 0, timespan: [{tsr0: [1369, 1436]}]}  , { id1: 1, timespan: [{tsr0: [1369, 1436]}]}  ]} }
- { act: { act3: { Vehicle_Stopping: 1.0 } , id2: 1, timespan: [{tsr0: [8051, 8102]}], src: truth, actors: [{ id1: 6, timespan: [{tsr0: [8051, 8102]}]}  ]} }
- { act: { act3: { }, id2: 4, timespan: [{tsr0: [1, 2]}] } }
- { act: { act3: { Vehicle_Starting: 1.0 }, id2: 5 } }
"""
REAL_TYPES = """
- { meta: "2018-03-07.16-50-01.16-55-01.school.G328 types"}
- { types: { id1: 0 , cset3: { Vehicle: 1.0 } } }
- { types: { id1: 1 , cset3: { Person: 1.0 } } }
- { types: { id1: 2 , cset3: { Person: 1.0 } } }
- { types: { id1: 3 } }
"""


def test_parse_activities_reads_real_lines_and_counts_unparsed_entries():
    found, unparsed = meva.parse_activities(yaml.safe_load(REAL_ACTIVITIES))
    assert found == [("Open_Vehicle_Door", 1369, 1436, 2), ("Vehicle_Stopping", 8051, 8102, 1)] and unparsed == 2


def test_parse_types_lowercases_classes_and_counts_unparsed_entries():
    counts, unparsed = meva.parse_types(yaml.safe_load(REAL_TYPES))
    assert counts == {"vehicle": 1, "person": 2} and unparsed == 1


def test_old_vocabulary_vehicle_activities_are_recognised():
    assert {"open_vehicle_door", "vehicle_stopping", "person_opens_vehicle_door"} <= meva.VEHICLE_ACTIVITIES
    assert "sit_down" not in meva.VEHICLE_ACTIVITIES


def test_split_holds_out_whole_cameras_and_is_stable():
    cameras = [f"G{n}" for n in range(300, 312)]
    first, second = meva.stable_split(cameras), meva.stable_split(reversed(cameras))
    assert first == second and set(first.values()) == {"debug", "holdout"}
    assert sum(v == "holdout" for v in first.values()) == 4


def _clip(identifier, camera, score, size=100, duration=300):
    return {"clip_id": identifier, "camera": camera, "score": score, "size": size, "duration_sec": duration}


def test_select_spreads_across_cameras_respects_budget_and_skips_short_clips():
    clips = [_clip("a1", "A", 15), _clip("a2", "A", 14), _clip("a3", "A", 13), _clip("b1", "B", 3), _clip("c1", "C", 2),
             _clip("short", "D", 99, duration=60)]
    ids = [c["clip_id"] for c in meva.select(clips, max_clips=3, max_bytes=10_000)]
    assert ids == ["a1", "b1", "c1"]
    assert [c["clip_id"] for c in meva.select(clips, max_clips=10, max_bytes=250)] == ["a1", "b1"]


@pytest.mark.skipif(not (SCRIPT.parents[1] / "tools" / "ffmpeg.exe").exists(), reason="bundled ffmpeg not present")
def test_to_mp4_converts_an_avi_made_locally(tmp_path, monkeypatch):
    ffmpeg = SCRIPT.parents[1] / "tools" / "ffmpeg.exe"
    source = tmp_path / "videos"
    source.mkdir()
    subprocess.run([str(ffmpeg), "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=5", "-t", "1",
                    "-c:v", "mpeg4", str(source / "clip.r13.avi")], check=True)
    monkeypatch.setattr(meva, "OUT", tmp_path)

    class Args:
        pass
    args = Args()
    args.source = str(source)
    meva.cmd_to_mp4(args)
    assert (tmp_path / "mp4" / "clip.mp4").stat().st_size > 0


def test_context_tag_is_a_hint_with_vehicle_first_then_door_then_normal():
    base = {"person_actors": 1, "vehicle_actors": 1, "activities": {"Vehicle_Stopping": 1}}
    assert meva.context_tag(base) == "R1_context"
    assert meva.context_tag({**base, "vehicle_actors": 0, "activities": {"Open_Facility_Door": 1}}) == "R3_context"
    assert meva.context_tag({**base, "vehicle_actors": 0, "activities": {"Stand_Up": 1}}) == "normal_context"
    assert meva.context_tag({**base, "person_actors": 0}) == "normal_context"


def test_fetch_reassembles_parallel_ranges_retries_a_failure_and_checks_size(tmp_path, monkeypatch):
    payload = bytes(range(256)) * 400  # 102,400 bytes
    calls = {"failed": False}

    class Response:
        def __init__(self, data):
            self.data = data
        def read(self):
            return self.data
        def __enter__(self):
            return self
        def __exit__(self, *_):
            return False

    def fake_urlopen(request, timeout):
        start, end = (int(v) for v in request.headers["Range"].split("=")[1].split("-"))
        if start == 4096 and not calls["failed"]:
            calls["failed"] = True
            raise OSError("temporary network error")
        return Response(payload[start:end + 1])

    monkeypatch.setattr(meva.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(meva.time, "sleep", lambda _s: None)
    target = tmp_path / "a" / "clip.avi"
    assert meva.fetch("k/clip.avi", len(payload), target, workers=4, chunk=4096) == "downloaded"
    assert target.read_bytes() == payload and calls["failed"] and not list(target.parent.glob("*.part"))
    assert meva.fetch("k/clip.avi", len(payload), target) == "kept"
    monkeypatch.setattr(meva.urllib.request, "urlopen", lambda request, timeout: Response(b"xx"))
    with pytest.raises(OSError):
        meva.fetch("k/other.avi", 10, tmp_path / "other.avi", workers=1, chunk=10)
    assert not (tmp_path / "other.avi").exists() and not list(tmp_path.glob("*.part"))
