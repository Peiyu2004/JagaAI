"""Public-interval validation, grouped splits and honest sample-level metrics.

This module does NOT parse native MEVA annotation files or infer ground truth.
It is embedded in the accompanying Colab notebook. Standard library only.
"""
from __future__ import annotations

from collections import Counter
from datetime import date
import hashlib
import json
import math
from pathlib import Path
import random


ACTIVITIES = (
    "person_opens_vehicle_door", "person_closes_vehicle_door",
    "person_opens_trunk", "person_closes_trunk", "person_enters_vehicle",
    "person_exits_vehicle", "person_loads_vehicle", "person_unloads_vehicle",
    "person_picks_up_object", "person_puts_down_object", "person_transfers_object",
    "person_carries_heavy_object", "person_rides_bicycle", "vehicle_starts",
    "vehicle_stops", "unknown",
)
OBJECTS = ("person", "vehicle", "bicycle", "bag", "package")
ZONES = ("parking", "entrance", "walkway", "other", "unknown")
OUTPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["objects", "activity", "zone_hint"],
    "properties": {
        "objects": {"type": "array", "uniqueItems": True,
                    "items": {"type": "string", "enum": list(OBJECTS)}},
        "activity": {"type": "string", "enum": list(ACTIVITIES)},
        "zone_hint": {"type": "string", "enum": list(ZONES)},
    },
}


def stable_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True,
                                    separators=(",", ":")).encode()).hexdigest()


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_target(target):
    if not isinstance(target, dict) or set(target) != {"objects", "activity", "zone_hint"}:
        raise ValueError("Target must have exactly objects, activity, zone_hint.")
    if target["activity"] not in ACTIVITIES or target["zone_hint"] not in ZONES:
        raise ValueError("Unknown activity or zone value.")
    objects = target["objects"]
    if (not isinstance(objects, list) or any(not isinstance(x, str) or x not in OBJECTS
                                            for x in objects)
            or len(set(objects)) != len(objects)):
        raise ValueError("Objects must be unique supported class strings.")
    return target


def target_of(row):
    return validate_target({key: row[key] for key in ("objects", "activity", "zone_hint")})


def load_manifest(path, public_root, verify_media=True):
    """Validate our normalized contract; never treats missing annotations as negatives."""
    public_root = Path(public_root).resolve()
    rows, seen, video_metadata, verified = [], set(), {}, {}
    for number, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        required = {"sample_id", "dataset", "license", "source_uri", "source_sha256",
                    "video_path", "annotation_ref", "camera_id", "date", "start_sec",
                    "end_sec", "objects", "objects_complete", "activity", "zone_hint"}
        if not isinstance(row, dict) or required - row.keys():
            raise ValueError(f"Line {number}: incomplete normalized interval.")
        if row["dataset"] != "MEVA" or row["license"] != "CC-BY-4.0":
            raise ValueError(f"Line {number}: only public MEVA inputs are accepted.")
        for key in ("sample_id", "annotation_ref", "camera_id", "source_uri", "video_path"):
            if not isinstance(row[key], str) or not row[key].strip():
                raise ValueError(f"Line {number}: empty {key}.")
        if not row["source_uri"].startswith("s3://mevadata-public-01/"):
            raise ValueError(f"Line {number}: source is not the official public bucket.")
        source_hash = row["source_sha256"]
        if not isinstance(source_hash, str) or len(source_hash) != 64 or any(
                char not in "0123456789abcdef" for char in source_hash):
            raise ValueError(f"Line {number}: invalid source SHA-256.")
        if row["sample_id"] in seen:
            raise ValueError(f"Duplicate sample ID: {row['sample_id']}")
        seen.add(row["sample_id"])
        if date.fromisoformat(row["date"]).isoformat() != row["date"]:
            raise ValueError(f"Line {number}: use an ISO collection date.")
        relative = Path(row["video_path"])
        video_path = (public_root / relative).resolve()
        if relative.is_absolute() or not video_path.is_relative_to(public_root):
            raise ValueError(f"Line {number}: media path escapes PUBLIC_DATA_ROOT.")
        if not video_path.is_file():
            raise FileNotFoundError(video_path)
        for key in ("start_sec", "end_sec"):
            value = row[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"Line {number}: invalid {key}.")
        if not 0 <= row["start_sec"] < row["end_sec"]:
            raise ValueError(f"Line {number}: interval must have positive duration.")
        target_of(row)
        if type(row["objects_complete"]) is not bool:
            raise ValueError(f"Line {number}: objects_complete must be a boolean.")
        if row["activity"] == "unknown" and row.get("negative_verified") is not True:
            raise ValueError(f"Line {number}: unknown requires an audited negative interval.")
        metadata = (row["camera_id"], row["date"], source_hash)
        key = str(video_path)
        if key in video_metadata and video_metadata[key] != metadata:
            raise ValueError("Same video has inconsistent camera/date/hash metadata.")
        video_metadata[key] = metadata
        if verify_media and key not in verified:
            verified[key] = file_hash(video_path)
        if verify_media and verified[key] != source_hash:
            raise ValueError(f"Source hash mismatch: {relative}")
        rows.append(row)
    if not rows:
        raise ValueError("Manifest contains no audited public intervals.")
    return rows


def grouped_split(rows, group_by="date", seed=20261015):
    if group_by not in ("date", "camera_id"):
        raise ValueError("Split by complete date or camera_id, not individual intervals.")
    groups = sorted({row[group_by] for row in rows})
    if len(groups) < 3:
        raise ValueError("Need at least three complete groups for train/validation/test.")
    random.Random(seed).shuffle(groups)
    test_count = max(1, round(len(groups) * 0.2))
    val_count = max(1, round(len(groups) * 0.2))
    assignment = {group: ("test" if i < test_count else "validation"
                           if i < test_count + val_count else "train")
                  for i, group in enumerate(groups)}
    splits = {name: [row for row in rows if assignment[row[group_by]] == name]
              for name in ("train", "validation", "test")}
    video_sets = {name: {row["source_sha256"] for row in subset}
                  for name, subset in splits.items()}
    for a, b in (("train", "test"), ("train", "validation"), ("validation", "test")):
        if video_sets[a] & video_sets[b]:
            raise ValueError("The same source video leaked across splits.")
    return splits


def fraction(numerator, denominator):
    return {"numerator": numerator, "denominator": denominator,
            "value": numerator / denominator if denominator else None}


def score_predictions(rows, predictions):
    """Activity classification metrics; errors/invalid schema stay in denominator."""
    prediction_map = {}
    for prediction in predictions:
        sample_id = prediction["sample_id"]
        if sample_id in prediction_map:
            raise ValueError("Duplicate prediction sample_id.")
        prediction_map[sample_id] = prediction
    extra = prediction_map.keys() - {row["sample_id"] for row in rows}
    if extra:
        raise ValueError("Predictions contain sample IDs outside this evaluation set.")
    counts = {name: Counter(tp=0, fp=0, fn=0, support=0) for name in ACTIVITIES if name != "unknown"}
    json_ok = schema_ok = correct = object_tp = object_fp = object_fn = zone_ok = zone_n = 0
    object_n = 0
    latency, per_frame = [], []
    errors = []
    for row in rows:
        item = prediction_map.get(row["sample_id"], {})
        parsed = None
        try:
            parsed = json.loads(item.get("raw_response", ""))
            json_ok += 1
            validate_target(parsed)
            schema_ok += 1
        except (TypeError, ValueError, KeyError) as error:
            parsed = None
            errors.append({"sample_id": row["sample_id"],
                           "error": item.get("error") or str(error)})
        gold = row["activity"]
        predicted = parsed["activity"] if parsed else None
        correct += predicted == gold
        if gold != "unknown":
            counts[gold]["support"] += 1
            counts[gold]["tp" if predicted == gold else "fn"] += 1
        if predicted not in (None, "unknown", gold):
            counts[predicted]["fp"] += 1
        if row["objects_complete"]:
            object_n += 1
            actual = set(row["objects"])
            observed = set(parsed["objects"]) if parsed else set()
            object_tp += len(actual & observed)
            object_fp += len(observed - actual)
            object_fn += len(actual - observed)
        if row["zone_hint"] != "unknown":
            zone_n += 1
            zone_ok += bool(parsed and parsed["zone_hint"] == row["zone_hint"])
        elapsed, frames = item.get("elapsed_sec"), item.get("frame_count", 0)
        if isinstance(elapsed, (int, float)) and math.isfinite(elapsed) and elapsed >= 0:
            latency.append(elapsed)
            if isinstance(frames, int) and frames > 0:
                per_frame.append(elapsed / frames)
    per_activity = {}
    for name, values in counts.items():
        per_activity[name] = {**values, "precision": fraction(values["tp"], values["tp"] + values["fp"]),
                              "recall": fraction(values["tp"], values["tp"] + values["fn"])}
    total = Counter()
    for values in counts.values():
        total.update(values)
    return {
        "evaluation_unit": "annotated_interval_classification_not_temporal_detection",
        "samples": len(rows), "predictions_received": len(predictions),
        "json_parse_rate": fraction(json_ok, len(rows)),
        "schema_correct_rate": fraction(schema_ok, len(rows)),
        "activity_accuracy": fraction(correct, len(rows)),
        "activity_micro_precision": fraction(total["tp"], total["tp"] + total["fp"]),
        "activity_micro_recall": fraction(total["tp"], total["tp"] + total["fn"]),
        "per_activity": per_activity,
        "missing_positive_classes": [key for key, value in counts.items() if value["support"] == 0],
        "objects_complete_samples": object_n,
        "object_micro_precision": fraction(object_tp, object_tp + object_fp),
        "object_micro_recall": fraction(object_tp, object_tp + object_fn),
        "zone_accuracy": fraction(zone_ok, zone_n),
        "mean_seconds_per_sequence": sum(latency) / len(latency) if latency else None,
        "mean_amortized_seconds_per_input_frame": sum(per_frame) / len(per_frame) if per_frame else None,
        "latency_samples": len(latency), "errors": errors,
    }


def self_check():
    """Checks helper behavior only; uses no footage, models, training or network."""
    rows = [{"sample_id": str(i), "date": f"2026-01-{i + 1:02}", "camera_id": f"cam{i}",
             "source_sha256": str(i), "objects": ["person"], "objects_complete": True,
             "activity": "person_opens_vehicle_door", "zone_hint": "unknown"} for i in range(6)]
    splits = grouped_split(rows)
    assert sum(map(len, splits.values())) == 6 and all(splits.values())
    assert stable_hash(splits) == stable_hash(grouped_split(rows))
    predictions = [{"sample_id": "0", "raw_response": json.dumps(target_of(rows[0]))},
                   {"sample_id": "1", "raw_response": "not JSON"}]
    scores = score_predictions(rows[:2], predictions)
    assert scores["schema_correct_rate"] == fraction(1, 2)
    assert scores["activity_micro_recall"] == fraction(1, 2)
    assert scores["object_micro_recall"] == fraction(1, 2)
    try:
        validate_target({"objects": [], "activity": "fall", "zone_hint": "unknown"})
    except ValueError:
        pass
    else:
        raise AssertionError("Fall class must remain unsupported.")
    return "Helper checks passed; no model, dataset or training evaluation ran."


if __name__ == "__main__":
    print(self_check())
