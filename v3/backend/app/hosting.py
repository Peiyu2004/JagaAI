"""Opt-in settings for serving the existing app through an HTTPS demo URL."""
import os
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import HTTPException
from fastapi.responses import FileResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.staticfiles import StaticFiles


def allowed_origins():
    value = os.environ.get("JAGAAI_ALLOWED_ORIGINS")
    if value is None:
        return {f"http://{host}:{port}" for host in ("127.0.0.1", "localhost") for port in (5174, 8766)}
    origins = {item.strip() for item in value.split(",") if item.strip()}
    if not origins:
        raise ValueError("JAGAAI_ALLOWED_ORIGINS must contain at least one explicit origin.")
    for origin in origins:
        parts = urlsplit(origin)
        if (parts.scheme not in {"http", "https"} or not parts.hostname or "*" in origin
                or parts.username or parts.password or parts.path or parts.query or parts.fragment):
            raise ValueError("JAGAAI_ALLOWED_ORIGINS accepts explicit http(s) origins without paths or wildcards.")
    return origins


def mount_frontend(app, directory):
    root = Path(directory).resolve()
    if not (root / "index.html").is_file():
        raise RuntimeError("Build the frontend before starting the combined website/API service.")

    class Website(StaticFiles):
        async def get_response(self, path, scope):
            # Unknown API paths must never become an HTML page with a 200 status.
            route = scope["path"].lstrip("/")
            if route == "api" or route.startswith("api/"):
                raise HTTPException(404, "Not found")
            try:
                return await super().get_response(path, scope)
            except StarletteHTTPException as error:
                if error.status_code != 404 or Path(path).suffix:
                    raise
                return FileResponse(root / "index.html")

    app.mount("/", Website(directory=str(root), html=True), name="website")
