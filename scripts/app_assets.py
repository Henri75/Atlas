#!/usr/bin/env python3
"""Generate every Atlas app icon, splash and PWA image from one drawn mark.

The identity is drawn programmatically from the shared palette — dark field
#0e1116, amber #e3b341 lens-and-orbit mark — so no binary asset is committed
that cannot be regenerated, and the native app, the web PWA and the browser
tab cannot drift apart.

Outputs:
  mobile/assets/            Expo icon, adaptive icon, splash + splash logo
  packages/ui/public/icons/ PWA icons (any + maskable), apple-touch, favicons
  packages/ui/public/splash/ iOS apple-touch-startup-image set

Run via `make app-assets`.
"""
import math
import os
import struct
import zlib

BG = (14, 17, 22)        # --color-bg   / PALETTE.bg
AMBER = (227, 179, 65)   # --color-kdb  / PALETTE.kdb


# --- PNG writer --------------------------------------------------------------

def write_png(path: str, w: int, h: int, rows) -> None:
    """`rows` is an iterable of h bytearrays, each w*4 bytes of RGBA."""
    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter type 0
        raw.extend(row)

    def chunk(tag: bytes, data: bytes) -> bytes:
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'wb') as f:
        f.write(png)
    print(f'  {path} ({w}x{h})')


# --- The mark ----------------------------------------------------------------

def mark_rows(size: int, opaque: bool):
    """Atlas mark: amber ring + inner pupil + one satellite dot at 45 degrees.

    Rendered row by row rather than through a per-pixel closure — the old
    version rebuilt the drawing closure once per pixel, which made a 1024px
    icon a million redundant constructions.
    """
    cx = cy = size / 2
    ring_r = size * 0.36
    ring_w = size * 0.028
    pupil_r = size * 0.155
    pupil_w = size * 0.034
    sat_orbit = size * 0.36
    sat_cx = cx + sat_orbit * math.cos(math.radians(45))
    sat_cy = cy - sat_orbit * math.sin(math.radians(45))
    sat_rad = size * 0.052
    ar, ag, ab = AMBER
    br, bgc, bb = BG

    def band(d, radius, width):
        edge = abs(d - radius)
        return max(0.0, min(1.0, (width / 2 + 1.1 - edge)))

    for y in range(size):
        row = bytearray(size * 4)
        dy = y - cy
        dsy = y - sat_cy
        for x in range(size):
            dx = x - cx
            dist = math.hypot(dx, dy)
            a = max(
                band(dist, ring_r, ring_w) * 235,
                band(dist, pupil_r, pupil_w) * 255,
                max(0.0, min(1.0, (sat_rad - math.hypot(x - sat_cx, dsy)) + 1.0)) * 255,
            )
            i = x * 4
            if a <= 0:
                if opaque:
                    row[i:i + 4] = bytes((br, bgc, bb, 255))
                continue
            k = min(255, a) / 255.0
            row[i:i + 4] = bytes((
                round(ar * k + br * (1 - k)),
                round(ag * k + bgc * (1 - k)),
                round(ab * k + bb * (1 - k)),
                255,
            ))
        yield row


def mark_buffer(size: int, opaque: bool) -> list:
    return list(mark_rows(size, opaque))


def flat_rows(w: int, h: int):
    row = bytes((*BG, 255)) * w
    for _ in range(h):
        yield bytearray(row)


def centred(w: int, h: int, logo: int):
    """A background field with the mark centred on it, at `logo` pixels."""
    drawn = logo
    buf = mark_buffer(drawn, opaque=False)
    ox, oy = (w - drawn) // 2, (h - drawn) // 2
    base = bytes((*BG, 255)) * w
    for y in range(h):
        row = bytearray(base)
        ly = y - oy
        if 0 <= ly < drawn:
            src = buf[ly]
            for lx in range(drawn):
                si = lx * 4
                if src[si + 3]:
                    di = (ox + lx) * 4
                    row[di:di + 4] = src[si:si + 4]
        yield row


# --- Outputs -----------------------------------------------------------------

def icon(path: str, size: int) -> None:
    """Opaque square. iOS app icons and favicons may not carry alpha — a
    transparent one gets backed with black instead of the Atlas field."""
    write_png(path, size, size, mark_rows(size, opaque=True))


def inset_rows(size: int, scale: float, opaque: bool):
    """The mark drawn at `scale` of the canvas, centred."""
    drawn = round(size * scale)
    buf = mark_buffer(drawn, opaque=False)
    ox, oy = (size - drawn) // 2, (size - drawn) // 2
    base = bytes((*BG, 255)) * size if opaque else bytes(size * 4)
    for y in range(size):
        row = bytearray(base)
        ly = y - oy
        if 0 <= ly < drawn:
            src = buf[ly]
            for lx in range(drawn):
                si = lx * 4
                if src[si + 3]:
                    di = (ox + lx) * 4
                    row[di:di + 4] = src[si:si + 4]
        yield row


def adaptive(path: str, size: int) -> None:
    """Android composites this foreground over app.json's
    adaptiveIcon.backgroundColor, so it stays transparent, inset to the 66%
    safe zone the launcher mask is free to crop to."""
    write_png(path, size, size, inset_rows(size, 0.62, opaque=False))


def maskable(path: str, size: int) -> None:
    """A maskable PWA icon is cropped to whatever shape the launcher likes, so
    it needs its own opaque field and the mark inside the safe zone."""
    write_png(path, size, size, inset_rows(size, 0.62, opaque=True))


def splash(path: str, w: int, h: int, logo: int) -> None:
    write_png(path, w, h, centred(w, h, logo))


# iOS has no manifest-driven splash: each device size needs its own
# apple-touch-startup-image. Current mainstream iPhone/iPad logical sizes at
# their device pixel ratio, which is what the media queries below match.
IOS_SPLASH = [
    (1179, 2556, 3),   # iPhone 15/16 Pro, 14 Pro
    (1290, 2796, 3),   # iPhone 15/16 Pro Max, 14 Pro Max
    (1170, 2532, 3),   # iPhone 12/13/14
    (1284, 2778, 3),   # iPhone 12/13/14 Pro Max
    (1125, 2436, 3),   # iPhone X/XS/11 Pro
    (828, 1792, 2),    # iPhone XR/11
    (1536, 2048, 2),   # iPad 9.7"/10.2"
    (1668, 2388, 2),   # iPad Pro 11"
    (2048, 2732, 2),   # iPad Pro 12.9"
]


def main() -> None:
    print('native (mobile/assets):')
    icon('mobile/assets/icon.png', 1024)
    adaptive('mobile/assets/adaptive-icon.png', 1024)
    splash('mobile/assets/splash-logo.png', 512, 512, 340)
    splash('mobile/assets/splash.png', 1284, 2772, 420)

    print('pwa (packages/ui/public/icons):')
    web = 'packages/ui/public/icons'
    icon(f'{web}/icon-192.png', 192)
    icon(f'{web}/icon-512.png', 512)
    maskable(f'{web}/maskable-512.png', 512)
    # Apple ignores transparency and applies its own corner radius, so the
    # touch icon must be drawn on an opaque field rather than cut out.
    icon(f'{web}/apple-touch-icon.png', 180)
    icon(f'{web}/favicon-32.png', 32)
    icon(f'{web}/favicon-16.png', 16)

    print('ios splash (packages/ui/public/splash):')
    for w, h, _ in IOS_SPLASH:
        splash(f'packages/ui/public/splash/{w}x{h}.png', w, h, round(min(w, h) * 0.34))

    print('assets written')


if __name__ == '__main__':
    main()
