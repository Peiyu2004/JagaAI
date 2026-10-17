"""Behavior regressions from the v3 rule/local-model review.

These tests use explicit tracks and model-response doubles, not CCTV accuracy
claims. No model server, weights or private footage are accessed.
"""
from datetime import datetime, timezone
import json

import httpx
import pytest

from app import local_ai
from app.vision import RuleEngine


NIGHT = datetime(2026, 10, 15, 12, tzinfo=timezone.utc)
PARKING = [[0, 0], [1, 0], [1, 1], [0, 1]]


def person(x):
    return {"id": "person-1", "class": "person", "box": [x - .025, .65, x + .025, .8]}


def car(ident, x):
    return {"id": ident, "class": "car", "box": [x - .08, .6, x + .08, .9]}


def visit_engine(min_vehicles):
    return RuleEngine({"R1": {"enabled": True, "zone": PARKING,
                              "loiter_sec": 9999, "window_sec": 300,
                              "min_vehicles": min_vehicles, "min_dwell_sec": 3}}, NIGHT)


def test_interrupted_short_car_visits_do_not_add_up_to_a_qualified_visit():
    engine = visit_engine(min_vehicles=1)
    parked = car("car-a", .2)
    # Longest continuous visit is 1.5s. The clearly observed away sample must
    # reset that visit even though the return is within a tracker gap tolerance.
    trajectory = [(0, .2), (.5, .2), (1, .2), (1.5, .5),
                  (2, .2), (2.5, .2), (3, .2), (3.5, .2)]
    for second, x in trajectory:
        assert engine.update(second, [person(x), parked]) == []


def test_qualified_visit_survives_leaving_and_a_short_revisit_within_window():
    engine = visit_engine(min_vehicles=2)
    cars = [car("car-a", .2), car("car-b", .8)]
    events = []
    for second in range(24):
        # A qualifies at 3s. Its later short revisit cannot erase the valid
        # earlier visit. B qualifies at 23s; both belong to the same 5min window.
        x = .2 if second <= 3 or 8 <= second <= 9 else .8 if second >= 20 else .5
        result = engine.update(second, [person(x), *cars])
        if second < 23:
            assert result == []
        events.extend(result)
    assert len(events) == 1
    assert events[0]["rule_id"] == "R1"
    assert events[0]["metrics"]["distinct_vehicles"] == 2


def test_qualified_visit_expires_outside_the_five_minute_window():
    engine = visit_engine(min_vehicles=2)
    cars = [car("car-a", .2), car("car-b", .8)]
    for second in range(308):
        x = .2 if second <= 3 else .8 if second >= 304 else .5
        assert engine.update(second, [person(x), *cars]) == []


def test_line_only_crossing_through_an_exact_boundary_sample_emits_once():
    engine = RuleEngine({"R3": {"enabled": True,
                                 "active_start": "19:00", "active_end": "06:00",
                                 "line": [[.6, .1], [.6, .9]]}}, NIGHT)
    assert engine.update(0, [person(.5)]) == []
    assert engine.update(1, [person(.6)]) == []  # Touching does not yet prove crossing.
    events = engine.update(2, [person(.7)])
    assert len(events) == 1
    assert events[0]["rule_id"] == "R3"
    assert events[0]["metrics"]["crossed_line"] is True
    assert events[0]["metrics"]["entered_zone"] is False
    assert engine.update(3, [person(.6)]) == []
    assert engine.update(4, [person(.5)]) == []


class ResponseData(dict):
    """Supports both a decoded-dict and httpx.Response internal request seam."""
    status_code = 200

    def json(self):
        return dict(self)

    def raise_for_status(self):
        return self

    @property
    def text(self):
        return json.dumps(self)


def install_model_responses(monkeypatch, vectors, model=None, remote=None, digests=None):
    calls = []
    tag_calls = 0

    def request(method, path, **kwargs):
        nonlocal tag_calls
        calls.append((method, path, kwargs))
        if path == "/api/tags":
            digest = digests[min(tag_calls, len(digests) - 1)] if digests else "stable-digest"
            tag_calls += 1
            record = {"name": model or local_ai.EMBED, "digest": digest, **(remote or {})}
            return ResponseData(models=[record])
        if path == "/api/embed":
            return ResponseData(embeddings=vectors)
        raise AssertionError(f"Unexpected model request: {method} {path}")

    monkeypatch.setattr(local_ai, "_request", request)
    return calls


@pytest.mark.parametrize("remote", [
    {"remote_model": "remote-model"},
    {"remote_host": "https://ollama.com"},
])
def test_model_digest_rejects_remote_alias_metadata(monkeypatch, remote):
    calls = install_model_responses(monkeypatch, [], remote=remote)
    with pytest.raises((RuntimeError, ValueError)):
        local_ai.model_digest(local_ai.EMBED)
    assert [path for _, path, _ in calls] == ["/api/tags"]


def test_describe_rejects_remote_model_before_sending_image(monkeypatch):
    calls = install_model_responses(monkeypatch, [], model=local_ai.VLM,
                                    remote={"remote_model": "remote-vlm"})
    with pytest.raises((RuntimeError, ValueError)):
        local_ai.describe(b"public image test bytes; no real footage")
    assert [path for _, path, _ in calls] == ["/api/tags"]


@pytest.mark.parametrize("vectors,texts", [
    ([[0., 0.]], ["one"]),
    ([[float("nan"), 1.]], ["one"]),
    ([[float("inf"), 1.]], ["one"]),
    ([["not a number", 1.]], ["one"]),
    ([[1., 0.], [1., 0., 0.]], ["one", "two"]),
])
def test_embedding_rejects_zero_nonfinite_or_inconsistent_vectors(monkeypatch, vectors, texts):
    install_model_responses(monkeypatch, vectors)
    with pytest.raises((RuntimeError, ValueError)):
        local_ai.embed(texts)


def test_embedding_rejects_model_digest_changes_during_inference(monkeypatch):
    install_model_responses(monkeypatch, [[1., 0.]], digests=["before", "after"])
    with pytest.raises((RuntimeError, ValueError)):
        local_ai.embed(["one"])


def test_embedding_accepts_valid_local_vectors_with_stable_digest(monkeypatch):
    calls = install_model_responses(monkeypatch, [[1., 0.], [0., 1.]])
    vectors, digest = local_ai.embed(["one", "two"])
    assert vectors == [[1., 0.], [0., 1.]]
    assert digest == local_ai.EMBED + "@stable-digest"
    assert [path for _, path, _ in calls] == ["/api/tags", "/api/embed", "/api/tags"]


def test_local_http_client_disables_environment_proxies_and_redirects(monkeypatch):
    options, requests = [], []

    class Client:
        def __init__(self, **kwargs):
            options.append(kwargs)

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def request(self, method, url, **kwargs):
            requests.append((method, url, kwargs))
            return httpx.Response(200, request=httpx.Request(method, url), json={"models": []})

    monkeypatch.setattr(local_ai.httpx, "Client", Client)
    local_ai._request("GET", "/api/tags", timeout=10)
    assert len(options) == 1
    assert options[0].get("trust_env") is False
    assert options[0].get("follow_redirects") is False
    assert len(requests) == 1
    assert requests[0][1] == local_ai.OLLAMA + "/api/tags"
