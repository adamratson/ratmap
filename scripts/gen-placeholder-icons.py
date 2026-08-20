#!/usr/bin/env python3
"""Placeholder PNG icon generator — solid color, no deps.

Real icons are an open item; this exists only so the PWA manifest has
installable assets during Phase 0. Replace public/icons/*.png before launch.
"""
import struct
import zlib
import pathlib

BG = (30, 41, 59)  # slate-800
FG = (56, 189, 248)  # sky-400, simple triangle "peak" mark

SIZES = [192, 512]

OUT_DIR = pathlib.Path(__file__).resolve().parent.parent / "public" / "icons"


def make_png(size: int, maskable: bool) -> bytes:
    pad = size // 5 if maskable else 0
    rows = []
    apex = (size / 2, pad + size * 0.12)
    base_y = size - pad - size * 0.16
    left = (pad + size * 0.16, base_y)
    right = (size - pad - size * 0.16, base_y)

    def in_triangle(x, y):
        # barycentric sign test
        def sign(p1, p2, p3):
            return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])

        d1 = sign((x, y), apex, left)
        d2 = sign((x, y), left, right)
        d3 = sign((x, y), right, apex)
        has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
        has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
        return not (has_neg and has_pos)

    for y in range(size):
        row = bytearray([0])  # filter byte
        for x in range(size):
            color = FG if in_triangle(x + 0.5, y + 0.5) else BG
            row += bytes(color)
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    idat = zlib.compress(raw, 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


OUT_DIR.mkdir(parents=True, exist_ok=True)
for s in SIZES:
    (OUT_DIR / f"icon-{s}.png").write_bytes(make_png(s, maskable=False))
    (OUT_DIR / f"maskable-{s}.png").write_bytes(make_png(s, maskable=True))
(OUT_DIR / "apple-touch-icon.png").write_bytes(make_png(180, maskable=True))
print("wrote", sorted(p.name for p in OUT_DIR.iterdir()))
