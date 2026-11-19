#!/usr/bin/env python3
"""Writes seed corpora for the fuzz targets from the games in the repo.

    python3 engine/fuzz/make_corpus.py <out_dir> <dreamsy-tool>

out_dir/package/*  "path\\0content\\0..." encodings of every game (fuzz_package)
out_dir/pack/*     Dreamsy packs of every game (fuzz_pack)
out_dir/zip/*      zips of a few games (fuzz_zip_import)
"""
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main():
    out, tool = Path(sys.argv[1]), sys.argv[2]
    for sub in ("package", "pack", "zip"):
        (out / sub).mkdir(parents=True, exist_ok=True)
    games = sorted(d for g in ("games/examples", "games/showcase") for d in (ROOT / g).iterdir() if (d / "dreamsy.toml").exists())
    for d in games:
        files = sorted(p for p in d.rglob("*") if p.is_file() and p.name != ".DS_Store")
        blob = b"".join(p.relative_to(d).as_posix().encode() + b"\0" + p.read_bytes() + b"\0" for p in files)
        (out / "package" / d.name).write_bytes(blob)
        # 3D example can't be packed (invalid in this engine); everything else can.
        subprocess.run([tool, "pack", str(d), str(out / "pack" / f"{d.name}.dpk")], capture_output=True)
    for d in games[:4]:
        with zipfile.ZipFile(out / "zip" / f"{d.name}.zip", "w", zipfile.ZIP_DEFLATED) as z:
            for p in sorted(d.rglob("*")):
                if p.is_file():
                    z.write(p, f"{d.name}/{p.relative_to(d).as_posix()}")
    print(f"corpus written to {out}")


if __name__ == "__main__":
    main()
