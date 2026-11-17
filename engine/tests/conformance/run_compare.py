#!/usr/bin/env python3
"""Script-host conformance: runs each package in engine-web and in the C++ engine and diffs the reports
(logs, errors, audio events, save data, game time). See ts_run.mts and `dreamsy-tool run`.

    python3 engine/tests/conformance/run_compare.py [--tool engine/build/debug/dreamsy-tool] [package dirs...]

Default packages: engine/tests/scripts/*. Exit 0 when every report is identical.
"""
import argparse
import re
import difflib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TICKS, SEED, BUDGET = "120", "7", "100"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tool", default=str(ROOT / "engine/build/debug/dreamsy-tool"))
    ap.add_argument("packages", nargs="*")
    args = ap.parse_args()
    pkgs = [Path(p).resolve() for p in args.packages] or sorted(p for p in (ROOT / "engine/tests/scripts").iterdir() if p.is_dir())
    failures = 0
    for p in pkgs:
        ts = subprocess.run(["npx", "tsx", str(ROOT / "engine/tests/conformance/ts_run.mts"), str(p), TICKS, SEED, BUDGET],
                            cwd=ROOT / "engine-web", capture_output=True, text=True)
        cpp = subprocess.run([args.tool, "run", str(p), "--ticks", TICKS, "--seed", SEED, "--budget", BUDGET],
                             capture_output=True, text=True)
        if ts.returncode != 0 or cpp.returncode != 0:
            print(f"✗ {p.name}: ts exit {ts.returncode}, c++ exit {cpp.returncode}\n{ts.stderr[-1500:]}\n{cpp.stderr[-1500:]}")
            failures += 1
            continue
        # Memory addresses ("table: 0x...") differ between any two runs; everything else must match.
        norm = lambda text: [re.sub(r"0x[0-9a-f]+", "0x…", line) for line in text.splitlines()]
        a, b = norm(ts.stdout), norm(cpp.stdout)
        if a == b:
            print(f"✓ {p.name}  ({len(a)} lines identical)")
            continue
        failures += 1
        print(f"✗ {p.name}")
        for line in difflib.unified_diff(a, b, "engine-web", "c++", lineterm="", n=1):
            print("   ", line)
    print(f"\n{len(pkgs) - failures}/{len(pkgs)} identical")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
