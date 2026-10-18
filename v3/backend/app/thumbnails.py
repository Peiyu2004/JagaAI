"""Small private previews; original overview/evidence frames remain unchanged."""
import os
from pathlib import Path
from uuid import uuid4

from PIL import Image, ImageOps


def preview_path(source: Path, width: int) -> Path:
    source_stat = source.stat()
    prefix = "" if source.name == "overview.jpg" else source.stem + "-"
    destination = source.with_name(f"{prefix}preview-{width}.webp")
    if destination.is_file() and destination.stat().st_mtime_ns >= source_stat.st_mtime_ns:
        return destination
    temporary = source.with_name(f".preview-{uuid4().hex}.tmp")
    try:
        with Image.open(source) as original:
            image = ImageOps.exif_transpose(original).convert("RGB")
            image.thumbnail((width, width * 4), Image.Resampling.LANCZOS)
            image.save(temporary, "WEBP", quality=76, method=4)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination
