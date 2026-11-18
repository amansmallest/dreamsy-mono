#!/usr/bin/env python3
"""Writes one Dreamsy pack per kit (DREAMSY.MD §3.6): <out_dir>/<kit>.dpk holding kits/<kit>/**/*.luau and
kits/<kit>/kit.json. Players load only the kits a game enables (script/kits.h), so kit code stays out of
the player binary and download.

    gen_kit_packs.py <kits_dir> <out_dir>
"""
import hashlib
import struct
import sys
from pathlib import Path

MAGIC = b"DREAMSY\x1a"


def align16(n: int) -> int:
    return (n + 15) & ~15


def write_pack(files: dict[str, bytes]) -> bytes:
    """Canonical .dpk bytes (same layout as engine/src/pkg/pack.cpp and format/src/pack.ts)."""
    paths = sorted(files, key=lambda p: p.encode())
    index, offset = bytearray(), 0
    for p in paths:
        data, name = files[p], p.encode()
        index += struct.pack("<H", len(name)) + name + bytes([0, 0])
        index += struct.pack("<QQ", offset, len(data)) + hashlib.sha256(data).digest()
        offset = align16(offset + len(data))
    data_offset = align16(80 + len(index))
    header = MAGIC + struct.pack("<IIII", 1, 0, len(paths), len(index)) + struct.pack("<QQ", data_offset, offset)
    header += hashlib.sha256(index).digest() + bytes(8)
    out = bytearray(header) + index
    out += bytes(data_offset - len(out))
    for p in paths:
        out += files[p]
        out += bytes(align16(len(out)) - len(out))
    return bytes(out)


def main():
    kits_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    for kit in sorted(d for d in kits_dir.iterdir() if d.is_dir() and not d.name.startswith("_")):
        files = {f"kits/{p.relative_to(kits_dir).as_posix()}": p.read_bytes()
                 for p in sorted(kit.rglob("*")) if p.is_file() and (p.suffix == ".luau" or p.name == "kit.json")}
        pack = write_pack(files)
        out = out_dir / f"{kit.name}.dpk"
        if not out.exists() or out.read_bytes() != pack:
            out.write_bytes(pack)


if __name__ == "__main__":
    main()
