"""Pick public MEVA clips for the R1/R3 evaluation and write a labelling sheet.

Steps (each is explicit; nothing is downloaded unless --yes is given):

  index        list the public bucket (XML listings only, no media/annotation files)
  annotations  fetch the small activities/types YAML files of the annotated example clips
  plan         rank annotated clips and write data/meva/eval_candidates.csv + eval_protocol.md
  download     fetch the AVI clips named in the CSV and record SHA-256 in a manifest
  to-mp4       convert downloaded AVI clips to MP4 so the JagaAI upload form accepts them

MEVA is CC BY 4.0 (Kitware Inc. / IARPA). Source: https://mevadata.org/
Annotation parsing here only *selects candidates*. It is not a native MEVA reader and its
output is never used as a training target. The YAML shapes were checked on 2026-10-15 against the
128 files of `examples/annotations/` only; unparsed entries are counted and reported, not hidden.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

BUCKET = "https://mevadata-public-01.s3.amazonaws.com/"
VIDEO_PREFIX = "drops-123-r13/"
ANNOTATION_PREFIX = "examples/annotations/"
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "meva"
VIDEO_RE = re.compile(
    r"drops-123-r13/(\d{4}-\d\d-\d\d)/(\d\d)/\d{4}-\d\d-\d\d\.(\d\d)-(\d\d)-(\d\d)\.(\d\d)-(\d\d)-(\d\d)\.(\w+)\.(G\d+)\.r13\.avi")
ANNOTATION_RE = re.compile(
    r"examples/annotations/(\d{4}-\d\d-\d\d)/\d\d/(\d{4}-\d\d-\d\d\.\d\d-\d\d-\d\d\.\d\d-\d\d-\d\d\.\w+\.G\d+)\.(activities|types|geom)\.yml")
ACTIVITY_NAME_RE = re.compile(r"act\d+")
CLASS_SET_RE = re.compile(r"cset\d+")
# Activities involving a vehicle: the closest MEVA labels to R1 context. The example files use an older
# vocabulary than the NIST SDL list (e.g. Open_Vehicle_Door, not person_opens_vehicle_door). Pairing the
# old names with the SDL names below is inferred from the names alone and is NOT a verified alias table.
VEHICLE_ACTIVITIES = {
    "open_vehicle_door", "close_vehicle_door", "open_trunk", "close_trunk", "enter_vehicle", "exit_vehicle",
    "load_vehicle", "unload_vehicle", "vehicle_picksup_person", "vehicle_dropsoff_person", "vehicle_starting",
    "vehicle_stopping", "vehicle_reversing", "vehicle_turning_left", "vehicle_turning_right", "vehicle_uturn",
    "person_opens_vehicle_door", "person_closes_vehicle_door", "person_opens_trunk", "person_closes_trunk",
    "person_enters_vehicle", "person_exits_vehicle", "person_loads_vehicle", "person_unloads_vehicle",
    "vehicle_picks_up_person", "vehicle_drops_off_person", "vehicle_starts", "vehicle_stops", "vehicle_reverses",
}


def list_bucket(prefix, delimiter=None):
    """Return [(key, size)] for a prefix. Listing XML only; follows continuation tokens."""
    token, keys = None, []
    while True:
        query = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
        if delimiter:
            query["delimiter"] = delimiter
        if token:
            query["continuation-token"] = token
        with urllib.request.urlopen(BUCKET + "?" + urllib.parse.urlencode(query), timeout=60) as response:
            page = response.read().decode()
        keys += [(k, int(s)) for k, s in re.findall(r"<Key>([^<]*)</Key>.*?<Size>(\d+)</Size>", page)]
        match = re.search(r"<NextContinuationToken>([^<]*)", page)
        if not match:
            return keys
        token = match.group(1)


def parse_video_key(key, size):
    match = VIDEO_RE.fullmatch(key)
    if not match:
        return None
    day, hour, h1, m1, s1, h2, m2, s2, site, camera = match.groups()
    start = int(h1) * 3600 + int(m1) * 60 + int(s1)
    end = int(h2) * 3600 + int(m2) * 60 + int(s2)
    return {"clip_id": key.rsplit("/", 1)[1][:-len(".r13.avi")], "key": key, "size": size, "date": day,
            "hour": int(h1), "start": f"{h1}:{m1}:{s1}", "duration_sec": (end - start) % 86400,
            "site": site, "camera": camera}


def _walk(node):
    """Yield every dict inside a YAML tree."""
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from _walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from _walk(value)


def parse_activities(tree):
    """Return ([(activity, start_frame, end_frame, n_actors)], unparsed_count). Spans are video frame numbers."""
    found, unparsed = [], 0
    for item in tree if isinstance(tree, list) else []:
        body = item.get("act") if isinstance(item, dict) else None
        if body is None:
            continue
        name = next((next(iter(v)) for k, v in body.items() if ACTIVITY_NAME_RE.fullmatch(k) and isinstance(v, dict) and v), None)
        span = next((s[k] for s in body.get("timespan", []) if isinstance(s, dict) for k in s if k.startswith("tsr")), None)
        if not name or not span or len(span) != 2:
            unparsed += 1
            continue
        found.append((name, int(span[0]), int(span[1]), len(body.get("actors", []))))
    return found, unparsed


def parse_types(tree):
    """Return (Counter of class -> actor count, unparsed_count)."""
    counts, unparsed = Counter(), 0
    for item in tree if isinstance(tree, list) else []:
        body = (item.get("types") or item.get("typ")) if isinstance(item, dict) else None
        if body is None:
            continue
        cset = next((v for k, v in body.items() if CLASS_SET_RE.fullmatch(k) and isinstance(v, dict) and v), None)
        if not cset:
            unparsed += 1
            continue
        counts[max(cset, key=cset.get).lower()] += 1
    return counts, unparsed


DOOR_ACTIVITIES = {"open_facility_door", "enter_facility", "exit_facility", "person_opens_facility_door",
                   "person_enters_scene_through_structure", "person_exits_scene_through_structure"}


def context_tag(clip):
    """Which rule a clip is *context* for. This is a hint for picking clips, never ground truth."""
    names = {n.lower() for n in clip["activities"]}
    if clip["person_actors"] >= 1 and clip["vehicle_actors"] >= 1:
        return "R1_context"
    if names & DOOR_ACTIVITIES:
        return "R3_context"
    return "normal_context"


def stable_split(camera_ids):
    """Hold out whole cameras (never clips): about one third, chosen by a stable hash."""
    ordered = sorted(set(camera_ids), key=lambda c: hashlib.sha256(c.encode()).hexdigest())
    holdout = set(ordered[: max(1, len(ordered) // 3)])
    return {c: ("holdout" if c in holdout else "debug") for c in ordered}


def select(clips, max_clips, max_bytes, min_duration=240):
    """Spread picks across cameras; prefer clips with both people and vehicles and vehicle activities."""
    eligible = [c for c in clips if c["duration_sec"] >= min_duration]
    eligible.sort(key=lambda c: (-c["score"], c["clip_id"]))
    per_camera, picked, total = defaultdict(int), [], 0
    for cap in (1, 2, 3, 99):
        for clip in eligible:
            if len(picked) >= max_clips:
                return picked
            if clip in picked or per_camera[clip["camera"]] >= cap or total + clip["size"] > max_bytes:
                continue
            picked.append(clip)
            per_camera[clip["camera"]] += 1
            total += clip["size"]
    return picked


def cmd_index(_args):
    OUT.mkdir(parents=True, exist_ok=True)
    videos = [v for v in (parse_video_key(k, s) for k, s in list_bucket(VIDEO_PREFIX)) if v]
    annotations = [{"key": k, "size": s} for k, s in list_bucket(ANNOTATION_PREFIX)]
    (OUT / "index.json").write_text(json.dumps({"videos": videos, "annotations": annotations}, indent=1), encoding="utf-8")
    hours = Counter(v["hour"] for v in videos)
    print(f"{len(videos)} videos, {sum(v['size'] for v in videos) / 1e9:.0f} GB, "
          f"{sum(v['duration_sec'] for v in videos) / 3600:.0f} h; {len(annotations)} annotation files")
    print("clips per start hour:", dict(sorted(hours.items())))
    print("night clips (19:00-06:00):", sum(v["hour"] >= 19 or v["hour"] < 6 for v in videos))


def load_index():
    path = OUT / "index.json"
    if not path.exists():
        sys.exit("Run `index` first.")
    return json.loads(path.read_text(encoding="utf-8"))


def fetch(key, size, destination, workers=24, chunk=4 << 20):
    """Download one object with parallel HTTP range requests (a single stream was throttled to ~50 KB/s).

    Writes to a .part file and renames only when every chunk arrived and the size matches the listing.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.stat().st_size == size:
        return "kept"
    temporary = destination.with_suffix(destination.suffix + ".part")
    url = BUCKET + urllib.parse.quote(key)
    lock = threading.Lock()

    def get_chunk(offset, file):
        end = min(offset + chunk, size) - 1
        for attempt in range(4):
            try:
                request = urllib.request.Request(url, headers={"Range": f"bytes={offset}-{end}"})
                with urllib.request.urlopen(request, timeout=60) as response:
                    data = response.read()
                if len(data) != end - offset + 1:
                    raise OSError("short read")
                with lock:
                    file.seek(offset)
                    file.write(data)
                return
            except OSError:
                if attempt == 3:
                    raise
                time.sleep(2 * (attempt + 1))

    try:
        with temporary.open("wb") as file:
            file.truncate(size)
            with ThreadPoolExecutor(workers) as pool:
                list(pool.map(lambda offset: get_chunk(offset, file), range(0, size, chunk)))
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    if temporary.stat().st_size != size:
        temporary.unlink()
        raise RuntimeError(f"{key}: size differs from the bucket listing")
    temporary.replace(destination)
    return "downloaded"


def cmd_annotations(args):
    wanted = [a for a in load_index()["annotations"] if (m := ANNOTATION_RE.fullmatch(a["key"])) and m.group(3) != "geom"]
    total = sum(a["size"] for a in wanted)
    print(f"{len(wanted)} files (activities.yml + types.yml), {total / 1024:.0f} KB, from {BUCKET}{ANNOTATION_PREFIX}")
    if not args.yes:
        sys.exit("Dry run. Re-run with --yes to download these small text files.")
    results = Counter(fetch(a["key"], a["size"], OUT / a["key"]) for a in wanted)
    print(dict(results))


def read_yaml(path):
    import yaml
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def cmd_plan(args):
    index = load_index()
    videos = {v["clip_id"]: v for v in index["videos"]}
    clips, unparsed = [], 0
    for a in index["annotations"]:
        match = ANNOTATION_RE.fullmatch(a["key"])
        if not match or match.group(3) != "activities" or match.group(2) not in videos:
            continue
        clip = dict(videos[match.group(2)])
        activities_path, types_path = OUT / a["key"], OUT / a["key"].replace(".activities.", ".types.")
        if not activities_path.exists() or not types_path.exists():
            continue
        acts, bad_a = parse_activities(read_yaml(activities_path))
        types, bad_t = parse_types(read_yaml(types_path))
        unparsed += bad_a + bad_t
        names = Counter(name for name, *_ in acts)
        vehicle_acts = sum(n for name, n in names.items() if name.lower() in VEHICLE_ACTIVITIES)
        clip.update(person_actors=types.get("person", 0), vehicle_actors=types.get("vehicle", 0), activities=names,
                    vehicle_activity_count=vehicle_acts)
        clip["score"] = min(clip["person_actors"], 5) + min(clip["vehicle_actors"], 5) + min(vehicle_acts, 5)
        clips.append(clip)
    if not clips:
        sys.exit("No annotated clips found. Run `annotations --yes` first.")
    for clip in clips:
        clip["tag"] = context_tag(clip)
    quota = {"R1_context": round(args.max_clips * 5 / 12), "R3_context": round(args.max_clips / 4)}
    quota["normal_context"] = args.max_clips - sum(quota.values())
    picked, budget = [], int(args.max_gb * 1e9)
    for tag, count in quota.items():
        chosen = select([c for c in clips if c["tag"] == tag], count, budget)
        budget -= sum(c["size"] for c in chosen)
        picked += chosen
    split = stable_split(c["camera"] for c in picked)
    sheet = OUT / "eval_candidates.csv"
    columns = ["clip_id", "split", "site", "camera", "date", "start_time", "duration_sec", "size_mb", "person_actors",
               "vehicle_actors", "vehicle_activities", "context_tag", "activity_summary", "upload_recorded_at_myt_for_testing",
               "scene_hint", "R1_expected", "R3_expected", "labeller", "notes", "s3_key"]
    with sheet.open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, columns)
        writer.writeheader()
        for c in picked:
            writer.writerow({"clip_id": c["clip_id"], "split": split[c["camera"]], "site": c["site"], "camera": c["camera"],
                             "date": c["date"], "start_time": c["start"], "duration_sec": c["duration_sec"],
                             "size_mb": round(c["size"] / 1e6, 1), "person_actors": c["person_actors"],
                             "vehicle_actors": c["vehicle_actors"], "vehicle_activities": c["vehicle_activity_count"], "context_tag": c["tag"],
                             "activity_summary": "; ".join(f"{k}x{v}" for k, v in c["activities"].most_common(6)),
                             "upload_recorded_at_myt_for_testing": f"{c['date']}T{c['start']}", "s3_key": c["key"]})
    (OUT / "eval_protocol.md").write_text(PROTOCOL.format(count=len(picked), cameras=len(split), today=date.today().isoformat(),
                                                           gb=sum(c["size"] for c in picked) / 1e9), encoding="utf-8")
    print(f"{len(clips)} annotated clips parsed ({unparsed} unparsed YAML entries); picked {len(picked)} on {len(split)} cameras, "
          f"{sum(c['size'] for c in picked) / 1e9:.1f} GB")
    print("split:", Counter(split[c["camera"]] for c in picked), "->", sheet)
    if unparsed:
        print("WARNING: some YAML entries did not match the assumed shape; inspect before trusting the ranking.")


PROTOCOL = """# MEVA evaluation protocol (generated {today})

{count} clips on {cameras} cameras, about {gb:.1f} GB. Source: MEVA, Kitware Inc. and IARPA, CC BY 4.0, https://mevadata.org/.

## What this can and cannot show
- MEVA has no "loitering" or "restricted area" labels. `R1_expected` and `R3_expected` come only from a person watching the clip. The activity columns are context, not ground truth.
- `context_tag` is a proxy used only to pick clips: R1_context = person and vehicle both annotated; R3_context = a facility door is entered or exited (a doorway can serve as the restricted line); normal_context = the rest. It is not proof a clip contains R1 or R3.
- `data/meva/examples/annotations` is MEVA's small *example* release: 64 clips, 122 activity instances, 3-5 per activity. These clips were curated to show each activity, so they contain more events than ordinary footage. Do not read false-alert rates on them as typical.
- MEVA is US footage in daylight. Only one 5-minute slot per camera is after 19:00 (2018-03-11, 23:xx), so R3's 19:00-06:00 window is **not** exercised. For testing, set R3 active hours to cover each clip's own time and say so in the report.
- Timestamps are used as MYT wall-clock only so the software can run. This does not claim they are Malaysian time.
- Results describe MEVA's school/hospital/bus/admin sites, not Malaysian residential CCTV.

## Labelling (one person, about 5 minutes per clip at 4x speed)
1. Open the clip. Fill `scene_hint`: parking / entrance / walkway / other.
2. `R1_expected` = yes if any person stays inside a parking area >= 120 s, or approaches >= 3 different vehicles within 5 minutes with >= 3 s each. Otherwise no.
3. For each camera, draw one restricted polygon or line on a doorway or fence in Cameras. `R3_expected` = yes if a person enters it or crosses the line. Record the polygon coordinates in `notes`.
4. A second person labels 5 clips independently; record disagreements instead of resolving them silently.
5. Only then run the clips through JagaAI. Tune thresholds on `debug` clips; read `holdout` once, at the end.

## Reporting
Raw counts only: true positives, false negatives and false alerts per rule, plus clip count and total minutes. Clips with no label stay in the denominator as "unlabelled". Unmet rules are labelled experimental.
"""


def cmd_download(args):
    rows = list(csv.DictReader((args.csv or OUT / "eval_candidates.csv").open(encoding="utf-8-sig")))
    index = {v["key"]: v for v in load_index()["videos"]}
    chosen = [index[r["s3_key"]] for r in rows if r["s3_key"] in index and (not args.split or r["split"] == args.split)]
    total = sum(c["size"] for c in chosen)
    print(f"{len(chosen)} clips, {total / 1e9:.2f} GB, from {BUCKET}{VIDEO_PREFIX}")
    if not args.yes:
        sys.exit("Dry run. Re-run with --yes to download.")
    manifest_path = OUT / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    for clip in chosen:
        destination = OUT / "videos" / (clip["clip_id"] + ".r13.avi")
        state = fetch(clip["key"], clip["size"], destination)
        digest = hashlib.sha256()
        with destination.open("rb") as file:
            while chunk := file.read(1 << 20):
                digest.update(chunk)
        manifest[clip["clip_id"]] = {"source_uri": "s3://mevadata-public-01/" + clip["key"], "size": clip["size"],
                                     "sha256": digest.hexdigest(), "accessed": date.today().isoformat(),
                                     "license": "CC-BY-4.0", "attribution": "Kitware Inc. and IARPA, MEVA, https://mevadata.org/"}
        manifest_path.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
        print(state, clip["clip_id"], flush=True)


def cmd_to_mp4(args):
    ffmpeg = ROOT / "tools" / "ffmpeg.exe"
    source = Path(args.source)
    target = OUT / "mp4"
    target.mkdir(parents=True, exist_ok=True)
    for avi in sorted(source.glob("*.avi")):
        output = target / (avi.name.removesuffix(".r13.avi").removesuffix(".avi") + ".mp4")
        if output.exists():
            continue
        for codec in (["-c", "copy"], ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-an"]):
            result = subprocess.run([str(ffmpeg), "-y", "-loglevel", "error", "-i", str(avi), *codec, "-movflags", "+faststart", str(output)],
                                    capture_output=True, text=True)
            if result.returncode == 0:
                print("ok", output.name, "(stream copy)" if codec[1] == "copy" else "(re-encoded, audio dropped)")
                break
            output.unlink(missing_ok=True)
        else:
            print("FAILED", avi.name, result.stderr.strip()[:200])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("index").set_defaults(run=cmd_index)
    annotations = sub.add_parser("annotations")
    annotations.add_argument("--yes", action="store_true")
    annotations.set_defaults(run=cmd_annotations)
    plan = sub.add_parser("plan")
    plan.add_argument("--max-clips", type=int, default=24)
    plan.add_argument("--max-gb", type=float, default=5.0)
    plan.set_defaults(run=cmd_plan)
    download = sub.add_parser("download")
    download.add_argument("--csv", type=Path)
    download.add_argument("--split", choices=["debug", "holdout"])
    download.add_argument("--yes", action="store_true")
    download.set_defaults(run=cmd_download)
    convert = sub.add_parser("to-mp4")
    convert.add_argument("--source", default=str(OUT / "videos"))
    convert.set_defaults(run=cmd_to_mp4)
    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
