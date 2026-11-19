#!/usr/bin/env python3
"""Packs games into <build>/games/*.dpk and writes <build>/index.html, a picker that opens each game in the
C++ web player by URL (web/dreamsy-player.html?pkg=../games/<name>.dpk; kits load from web/kits/).

    python3 engine/tools/make_play_page.py [--build engine/build] [--tool engine/build/debug/dreamsy-tool] [dirs...]

Default game dirs: games/examples, games/showcase, games/mine (if present). Serve <build> with any static
server, e.g. python3 -m http.server 2006 --bind 127.0.0.1 -d engine/build, then open http://localhost:2006/.
"""
import argparse
import html
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", default=str(ROOT / "engine/build"))
    ap.add_argument("--tool", default=str(ROOT / "engine/build/debug/dreamsy-tool"))
    ap.add_argument("dirs", nargs="*")
    args = ap.parse_args()
    build = Path(args.build)
    (build / "games").mkdir(parents=True, exist_ok=True)
    groups = [Path(d) for d in args.dirs] or [p for p in (ROOT / "games/mine", ROOT / "games/showcase", ROOT / "games/examples") if p.exists()]
    rows = []
    for group in groups:
        for d in sorted(p for p in group.iterdir() if (p / "dreamsy.toml").exists()):
            toml = (d / "dreamsy.toml").read_text()
            name = (re.search(r'^name\s*=\s*"([^"]*)"', toml, re.M) or [None, d.name])[1]
            out = build / "games" / f"{d.name}.dpk"
            r = subprocess.run([args.tool, "pack", str(d), str(out)], capture_output=True, text=True)
            if r.returncode != 0:
                continue  # invalid in the C++ engine (e.g. the 3D example)
            rows.append((group.name, d.name, name))
    items = "\n".join(
        f'<li><a href="web/dreamsy-player.html?pkg=../games/{html.escape(slug)}.dpk">{html.escape(name)}</a>'
        f' <a class="t" href="web/dreamsy-player.html?pkg=../games/{html.escape(slug)}.dpk#touch">touch</a>'
        f' <span>{html.escape(group)}</span></li>' for group, slug, name in rows)
    (build / "index.html").write_text(f"""<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dreamsy C++ engine</title>
<style>body{{font:16px system-ui;background:#141220;color:#eee;margin:24px}}a{{color:#ffcd75}}li{{margin:6px 0}}span{{color:#888;font-size:13px}}a.t{{font-size:12px;color:#9ad}}</style>
<h1>Dreamsy C++ engine</h1><p>{len(rows)} games, loaded by URL into one web build.</p><ul>{items}</ul>
""")
    print(f"{len(rows)} games -> {build / 'index.html'}")


if __name__ == "__main__":
    main()
