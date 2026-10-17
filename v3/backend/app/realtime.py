import json
import threading
import time

_condition = threading.Condition()
_revision = 0
_last_event = {"reason": "connected"}


def publish_refresh(reason="changed", target_id=None):
    global _revision, _last_event
    with _condition:
        _revision += 1
        _last_event = {"reason": reason, "target_id": target_id, "revision": _revision}
        _condition.notify_all()


def snapshot():
    with _condition:
        return _revision, dict(_last_event)


def sse_messages():
    revision, event = snapshot()
    yield f"retry: 3000\nevent: refresh\nid: {revision}\ndata: {json.dumps(event)}\n\n"
    while True:
        with _condition:
            _condition.wait_for(lambda: _revision != revision, timeout=15)
            if _revision != revision:
                revision, event = _revision, dict(_last_event)
                yield f"event: refresh\nid: {revision}\ndata: {json.dumps(event)}\n\n"
            else:
                yield f": heartbeat {int(time.time())}\n\n"
