"""Render the Tides Plus brand icon to PNGs at multiple sizes.

Draws in PIL rather than via SVG because the ImageMagick SVG backend on
this machine ignores stroked paths. Writes the HA-facing brand images
into ``custom_components/noaa_tides_plus/brand/`` (which HA 2026.3+
serves through ``/api/brands/integration/<domain>/<image>``) and a
standalone ``favicon.png`` back into this directory.

Run inside the HA container so PIL is available:

    docker cp brands/render_icon.py ha_dev:/tmp/render_icon.py
    docker exec ha_dev python3 /tmp/render_icon.py /tmp/icons
    docker cp ha_dev:/tmp/icons/. custom_components/noaa_tides_plus/brand/
    docker cp ha_dev:/tmp/icons/favicon.png brands/favicon.png
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw


TEAL = (8, 145, 178, 255)
WHITE = (255, 255, 255, 255)


def render(size: int = 1024) -> Image.Image:
    """Render the icon at ``size``x``size`` pixels.

    Draws at 1024 and lets the caller downscale for anti-aliasing.
    """
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    corner_radius = int(size * 56 / 256)
    draw.rounded_rectangle(
        [(0, 0), (size - 1, size - 1)], radius=corner_radius, fill=TEAL
    )

    horizon_y = size // 2
    dash_width = int(size * 6 / 256)
    dash_gap = int(size * 10 / 256)
    x = int(size * 24 / 256)
    end_x = size - x
    line_h = max(2, int(size * 3 / 256))
    while x < end_x:
        x2 = min(x + dash_width, end_x)
        draw.line([(x, horizon_y), (x2, horizon_y)], fill=(255, 255, 255, 90), width=line_h)
        x = x2 + dash_gap

    stroke = int(size * 14 / 256)
    stroke_r = stroke / 2
    x_left = int(size * 16 / 256)
    x_right = size - x_left
    amplitude = int(size * 48 / 256)
    steps = 4000
    wave_points: list[tuple[float, float]] = []
    for i in range(steps + 1):
        t = i / steps
        px = x_left + (x_right - x_left) * t
        py = horizon_y - amplitude * math.sin(2 * math.pi * t)
        wave_points.append((px, py))
    for px, py in wave_points:
        draw.ellipse(
            [(px - stroke_r, py - stroke_r), (px + stroke_r, py + stroke_r)],
            fill=WHITE,
        )
    dot_r = int(size * 8 / 256)
    peak_i = steps // 4
    trough_i = 3 * steps // 4
    for cx, cy in (wave_points[peak_i], wave_points[trough_i]):
        draw.ellipse(
            [(cx - dot_r, cy - dot_r), (cx + dot_r, cy + dot_r)], fill=WHITE
        )

    return img


def main(out_dir: str) -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    master = render(1024)
    outputs = {
        "icon.png": 256,
        "icon@2x.png": 512,
        "logo.png": 256,
        "logo@2x.png": 512,
        "favicon.png": 32,
    }
    for name, target in outputs.items():
        master.resize((target, target), Image.Resampling.LANCZOS).save(
            out / name, "PNG"
        )


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "brands")
