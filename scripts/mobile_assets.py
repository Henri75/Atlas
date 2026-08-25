#!/usr/bin/env python3
"""Generate Atlas mobile app assets (icon / adaptive-icon / splash / splash-logo).

Pure-python PNG writer (zlib + struct): the identity is drawn programmatically
from the same palette as the app — dark field #0e1116, amber #e3b341 lens-and-
orbit mark — so no binary asset is committed that cannot be regenerated.
"""
import math
import struct
import zlib

BG = (14, 17, 22)        # --color-bg
AMBER = (227, 179, 65)   # --color-kdb


def write_png(path: str, w: int, h: int, px) -> None:
    """px(x, y) -> (r, g, b, a)."""
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            r, g, b, a = px(x, y)
            raw.extend((int(r), int(g), int(b), int(a)))
    def chunk(tag: bytes, data: bytes) -> bytes:
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def alpha_blend(base, over_rgba):
    r, g, b, a = over_rgba
    if a >= 255:
        return over_rgba
    br, bg_, bb = base
    out_a = a / 255.0
    return (
        round(r * out_a + br * (1 - out_a)),
        round(g * out_a + bg_ * (1 - out_a)),
        round(b * out_a + bb * (1 - out_a)),
        255,
    )


def mark_px(size: int):
    """Atlas mark: amber ring + inner pupil + one satellite dot at 45°."""
    cx = cy = size / 2

    def px(x: int, y: int):
        dx, dy = x - cx, y - cy
        dist = math.hypot(dx, dy)
        ring_r = size * 0.36
        ring_w = size * 0.028
        pupil_r = size * 0.155
        pupil_w = size * 0.034
        sat_r = size * 0.36
        sat_cx = cx + sat_r * math.cos(math.radians(45))
        sat_cy = cy - sat_r * math.sin(math.radians(45))
        sat_rad = size * 0.052

        # Anti-aliased ring helper.
        def band(d, radius, width):
            edge = abs(d - radius)
            return max(0.0, min(1.0, (width / 2 + 1.1 - edge)))
        a_ring = band(dist, ring_r, ring_w) * 235
        a_pupil = band(dist, pupil_r, pupil_w) * 255
        d_sat = math.hypot(x - sat_cx, y - sat_cy)
        a_sat = max(0.0, min(1.0, (sat_rad - d_sat) + 1.0)) * 255

        a = max(a_ring, a_pupil, a_sat)
        if a <= 0:
            return (0, 0, 0, 0)
        return alpha_blend(BG, (*AMBER, int(min(255, a))))

    return px


def icon(path: str, size: int) -> None:
    write_png(path, size, size, lambda x, y: (*mark_px(size)(x, y), ) if False else mark_px(size)(x, y))


def splash(path: str, w: int, h: int, logo: int) -> None:
    ox = (w - logo) // 2
    oy = (h - logo) // 2
    mark = mark_px(logo)

    def px(x: int, y: int):
        lx, ly = x - ox, y - oy
        if 0 <= lx < logo and 0 <= ly < logo:
            c = mark(lx, ly)
            if c[3] > 0:
                return (*c[:3], 255)
        return (*BG, 255)

    write_png(path, w, h, px)


import os
os.makedirs('mobile/assets', exist_ok=True)
icon('mobile/assets/icon.png', 1024)
icon('mobile/assets/adaptive-icon.png', 1024)
splash('mobile/assets/splash-logo.png', 512, 512, 340)
splash('mobile/assets/splash.png', 1284, 2772, 420)
print('assets written')
