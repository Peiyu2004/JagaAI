"""Build the static, privacy-checked CCTV reel used behind the staff login.

Reads demo frames from v3/data/ai-demo/frames and writes treated 640x360
JPEGs to v3/frontend/public/login-reel/. Run with the v3 virtualenv:

    v3/.venv/Scripts/python.exe v3/frontend/scripts/build-login-reel.py
"""

from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

FRONTEND = Path(__file__).resolve().parent.parent
SOURCE = FRONTEND.parent / "data" / "ai-demo" / "frames"
OUTPUT = FRONTEND / "public" / "login-reel"
SIZE = (640, 360)

CAMERAS = {
    "demo-stairs-entry": "CAM 01 · STAIR ACCESS",
    "demo-stairs-empty": "CAM 02 · STAIRWELL",
    "demo-landing-entry": "CAM 03 · LANDING",
    "demo-courtyard-entry": "CAM 04 · COURTYARD",
    "demo-parking-people": "CAM 05 · PARKING",
    "demo-parking-machine": "CAM 06 · PARKING",
    "demo-parking-holdout": "CAM 07 · PARKING",
    "demo-kerb-waiting": "CAM 08 · KERBSIDE",
}

# Privacy review (every output was opened and checked by eye):
# - demo-stairs-entry/event-R3-0-1.jpg dropped: close-range, recognisable face.
# - demo-stairs-entry/sample-000007400.jpg and sample-000006000.jpg not used
#   for the same reason; sample-000005600.jpg (face hidden by the door) covers
#   the scene instead.
FRAMES = [
    "demo-landing-entry/event-R3-0-1.jpg",
    "demo-landing-entry/event-R3-0-3.jpg",
    "demo-courtyard-entry/event-R3-0-3.jpg",
    "demo-kerb-waiting/event-R1-0-15.jpg",
    "demo-stairs-entry/sample-000005600.jpg",
    "demo-stairs-empty/sample-000000000.jpg",
    "demo-landing-entry/sample-000006400.jpg",
    "demo-landing-entry/sample-000008200.jpg",
    "demo-courtyard-entry/sample-000010400.jpg",
    "demo-parking-people/sample-000013600.jpg",
    "demo-parking-people/sample-000020000.jpg",
    "demo-parking-people/sample-000033400.jpg",
    "demo-parking-machine/sample-000060000.jpg",
    "demo-parking-holdout/sample-000036000.jpg",
    "demo-parking-holdout/sample-000058400.jpg",
    "demo-kerb-waiting/sample-000020000.jpg",
    "demo-kerb-waiting/sample-000085000.jpg",
    "demo-kerb-waiting/sample-000109400.jpg",
]


def mono_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in (r"C:\Windows\Fonts\consola.ttf", "DejaVuSansMono.ttf"):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def cover_crop(image: Image.Image) -> Image.Image:
    w, h = image.size
    target = SIZE[0] / SIZE[1]
    if w / h > target:
        cw, ch = round(h * target), h
    else:
        cw, ch = w, round(w / target)
    left, top = (w - cw) // 2, (h - ch) // 2
    image = image.crop((left, top, left + cw, top + ch))
    if cw > SIZE[0]:  # never upscale
        image = image.resize(SIZE, Image.Resampling.LANCZOS)
    return image


def grade(image: Image.Image) -> Image.Image:
    image = ImageEnhance.Color(image).enhance(0.85)
    tint = Image.new("RGB", image.size, (96, 128, 186))
    image = Image.blend(image, tint, 0.07)
    w, h = image.size
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).ellipse(
        (-w * 0.18, -h * 0.22, w * 1.18, h * 1.22), fill=255
    )
    mask = mask.filter(ImageFilter.GaussianBlur(min(w, h) * 0.16))
    dark = ImageEnhance.Brightness(image).enhance(0.62)
    return Image.composite(image, dark, mask)


def overlay(image: Image.Image, label: str, event: bool) -> Image.Image:
    w, _ = image.size
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    band = 44
    for y in range(band):
        alpha = 0.78 * (1 - y / band)
        if event and y < 22:
            alpha = 1.0  # fully hide the burned-in OpenCV caption
        elif event:
            alpha = max(alpha, 1.0 - (y - 22) / (band - 22))
        draw.line([(0, y), (w, y)], fill=(5, 8, 14, round(alpha * 255)))

    inset, arm, stroke = 12, 14, 2
    white = (255, 255, 255, round(0.7 * 255))
    x0, y0, x1, y1 = inset, inset, w - inset - 1, image.size[1] - inset - 1
    for (cx, cy, dx, dy) in ((x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)):
        draw.line([(cx, cy), (cx + dx * arm, cy)], fill=white, width=stroke)
        draw.line([(cx, cy), (cx, cy + dy * arm)], fill=white, width=stroke)

    label_font, chip_font = mono_font(11), mono_font(10)
    draw.text((inset + 10, inset + 3), label.upper(), font=label_font,
              fill=(255, 255, 255, round(0.9 * 255)))

    chip = "AI FLAG" if event else "ANALYSED"
    colour = (0xF5, 0xB5, 0x44, 255) if event else (0x8F, 0xB0, 0xFF, 255)
    text_w = draw.textlength(chip, font=chip_font)
    right = w - inset - 10
    tx = right - text_w
    draw.text((tx, inset + 4), chip, font=chip_font, fill=colour)
    dot = 6
    dx = tx - dot - 5
    draw.ellipse((dx, inset + 6, dx + dot, inset + 6 + dot), fill=colour)

    return Image.alpha_composite(image.convert("RGBA"), layer).convert("RGB")


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for old in OUTPUT.glob("*.jpg"):
        old.unlink()
    counters: dict[str, int] = {}
    total = 0
    for rel in FRAMES:
        scene, name = rel.split("/")
        event = name.startswith("event-")
        with Image.open(SOURCE / rel) as source:
            image = cover_crop(source.convert("RGB"))
        image = overlay(grade(image), CAMERAS[scene], event)
        counters[scene] = counters.get(scene, 0) + 1
        target = OUTPUT / f"{scene}-{counters[scene]}.jpg"
        image.save(target, "JPEG", quality=76, progressive=True, optimize=True)
        size = os.path.getsize(target)
        total += size
        print(f"{target.name:32} {'event ' if event else 'sample'} {size / 1024:6.1f} KB  <- {rel}")
    print(f"{len(FRAMES)} frames, {total / 1024:.0f} KB total")


if __name__ == "__main__":
    main()
