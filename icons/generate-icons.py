#!/usr/bin/env python3
"""Generate minimal PNG icons for the extension (no external deps)."""
from __future__ import annotations

import struct
import zlib
from pathlib import Path


def png(size: int, rgba: tuple[int, int, int, int]) -> bytes:
    r, g, b, a = rgba
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter none
        for x in range(size):
            # simple rounded-ish square with letter-bar accent
            margin = max(1, size // 8)
            inner = margin <= x < size - margin and margin <= y < size - margin
            bar = size * 0.35 <= y <= size * 0.55 and margin + size // 10 <= x < size - margin - size // 10
            if bar:
                raw.extend((255, 255, 255, 255))
            elif inner:
                raw.extend((r, g, b, a))
            else:
                raw.extend((0, 0, 0, 0))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"".join(
        [
            b"\x89PNG\r\n\x1a\n",
            chunk(b"IHDR", ihdr),
            chunk(b"IDAT", zlib.compress(bytes(raw), 9)),
            chunk(b"IEND", b""),
        ]
    )


def main() -> None:
    out = Path(__file__).resolve().parent
    out.mkdir(parents=True, exist_ok=True)
    color = (45, 138, 78, 255)  # green
    for size in (16, 32, 48, 128):
        (out / f"icon{size}.png").write_bytes(png(size, color))
        print(f"wrote icon{size}.png")


if __name__ == "__main__":
    main()
