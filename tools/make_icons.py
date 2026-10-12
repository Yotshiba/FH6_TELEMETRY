"""
make_icons — render the web dashboard's app icon (a tachometer) as PNGs, with no imaging
library: a tiny supersampling rasteriser plus zlib.

    python tools/make_icons.py        # writes icon-192.png, icon-512.png, apple-touch-icon.png

The matching vector version is fh6_telemetry/web/static/icon.svg.
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "fh6_telemetry" / "web" / "static"

BG1, BG2 = (26, 26, 46), (8, 8, 20)
CYAN, AMBER, RED, WHITE = (68, 204, 255), (255, 153, 0), (255, 60, 60), (240, 244, 255)


def _mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def _over(dst, src, alpha):
    return tuple(dst[i] * (1 - alpha) + src[i] * alpha for i in range(3))


def _angle_frac(x: float, y: float) -> float | None:
    """0..1 along the 270° dial sweep (135° .. 405°), or None outside it."""
    ang = math.degrees(math.atan2(y, x)) % 360.0          # 0 = +x, clockwise (y down)
    rel = (ang - 135.0) % 360.0
    return rel / 270.0 if rel <= 270.0 else None


def shade(u: float, v: float) -> tuple[tuple[float, float, float], float]:
    """Colour and coverage of the icon at normalised (u, v) in [0, 1]."""
    # rounded-square mask
    r = 0.22
    dx, dy = abs(u - 0.5) - (0.5 - r), abs(v - 0.5) - (0.5 - r)
    outside = math.hypot(max(dx, 0.0), max(dy, 0.0)) + min(max(dx, dy), 0.0) - r
    if outside > 0:
        return BG2, 0.0
    d0 = math.hypot(u - 0.5, v - 0.42)
    col = _mix(BG1, BG2, min(1.0, d0 * 1.6))
    cx, cy = 0.5, 0.54
    x, y = u - cx, v - cy
    rad = math.hypot(x, y)
    # dial ring
    f = _angle_frac(x, y)
    if f is not None and 0.30 <= rad <= 0.35:
        ring = CYAN if f < 0.62 else _mix(AMBER, RED, (f - 0.62) / 0.38)
        col = ring
    # tick marks
    if f is not None and 0.375 <= rad <= 0.41:
        k = f * 9.0
        if abs(k - round(k)) < 0.045:
            col = _mix(WHITE, BG1, 0.25)
    # needle (points to ~72 % of the sweep)
    na = math.radians(135.0 + 270.0 * 0.72)
    nx, ny = math.cos(na), math.sin(na)
    t = x * nx + y * ny
    dist = abs(-x * ny + y * nx)
    if -0.05 <= t <= 0.28 and dist <= 0.016 * (1.0 - max(0.0, t) / 0.40):
        col = RED
    if rad <= 0.055:
        col = WHITE if rad > 0.03 else (60, 70, 100)
    return col, 1.0


def render(size: int, ss: int = 3) -> bytes:
    rows = []
    for py in range(size):
        row = bytearray([0])                                # PNG filter type 0
        for px in range(size):
            r = g = b = a = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    u = (px + (sx + 0.5) / ss) / size
                    v = (py + (sy + 0.5) / ss) / size
                    c, cov = shade(u, v)
                    r += c[0] * cov; g += c[1] * cov; b += c[2] * cov; a += cov
            n = ss * ss
            if a > 0:
                row += bytes((int(r / a), int(g / a), int(b / a), int(255 * a / n)))
            else:
                row += bytes((0, 0, 0, 0))
        rows.append(bytes(row))
    return b"".join(rows)


def png(size: int) -> bytes:
    raw = render(size)
    def chunk(tag: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)       # 8-bit RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main() -> None:
    for name, size in (("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)):
        (OUT / name).write_bytes(png(size))
        print("wrote", OUT / name)


if __name__ == "__main__":
    main()
