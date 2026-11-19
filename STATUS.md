# Dreamsy — status

Current state of the work (2026-11-18). The spec is DREAMSY.MD + `docs/`; git history has the day-by-day log.

## What works

| Area | Where | State |
|---|---|---|
| Package format | `format/` | spec (docs/format.md §3), validator, edit ops, `.dpk` packs + zips, CLI; 50 tests |
| Engine | `engine/` (C++20) | 2D + 2.5D (side, topdown, oblique, iso), Luau 0.747, Box2D v3 + engine-handled height, sokol renderer (Metal / WebGL2), input + touch controls, platform UI, deterministic math, web player loading games by URL, iOS simulator build; E0–E6 done + a first E7 slice (docs/engine.md §14.10) |
| Kits | `kits/` | 21 genre kits with KIT.md, schemas, examples; balance sims run on the C++ engine (`dreamsy-tool eval`) |
| Harness | `harness/` | router, director + content fan-out, playtests on the C++ engine (`dreamsy-tool playtest` + web player screenshots), art-director review; Claude or OpenAI builders; 28 tests |
| API | `services/api/` | auth, games/versions, generations, coins economy, feed/remix/marketplace, leaderboards/ghosts/groups; 95 tests (PGlite, no Docker) |
| Rooms | `services/gameserver/` | multiplayer v1 room server (codes, quick match, relay; docs/runtime.md §4.5); 27 tests |
| App | `apps/mobile/` | Expo app: feed, play (C++ web player in a WebView), create, remix, profiles, market |
| Studio | `apps/web/` | build and edit games by chat in the browser, publish; to be deployed so games are playable by link |
| Games | `games/examples/`, `games/showcase/` | a minimal example per kit, engine feature demos, showcase games incl. Cloud Hopper (Claude-built oblique 2.5D) |

Tests (macOS, 2026-11-18): engine ctest debug 8/8 (ASan/UBSan), release 9/9 (incl. slow kit sims), web 2/2; conformance:
script output identical to engine-web's recorded goldens (12/12 scenarios, 26/26 games), C++ loader vs the TS validator
113/113; `pnpm -r typecheck` clean. CI (`.github/workflows/engine.yml`): macOS, Linux headless, web, conformance, fuzzers.

## Run it

```sh
./scripts/dev.sh              # laptop stack: Postgres, API, seed, harness worker, C++ web player on :2005, Expo Go (--prod: hosted)
pnpm -C harness local --prompt "..." --out /tmp/x [--rounds N]     # one game, no API
cd engine && cmake --preset release && cmake --build --preset release && ctest --preset release
engine/build/release/dreamsy-tool playtest games/showcase/cloud-hopper    # headless playtest report
python3 engine/tools/make_play_page.py    # packs every game for the web player + build/index.html picker
```
Engine build details (web, iOS, Android, sanitizers, embedding): `engine/README.md`.

## Gaps

- **Multiplayer:** the C++ engine has no online room client yet; multiplayer games run solo until E8 (authoritative
  netcode, docs/engine.md §14.6).
- **Web player vs the old engine:** no API store (purchases are free, in memory), no API leaderboards / ghosts / ranks,
  saves last only for the session. 34 ported-test cases wait on these and E8; the 5 run-end ones can be ported now
  (`HostOptions::on_run_end` exists).
- **Untested:** `deploy/Dockerfile` end to end (the player stage built), Android builds (no SDK on this machine).
- **Audio:** playback not wired in the C++ engine; the user is designing an audio harness.
- `third_party/luau/DREAMSY_VENDOR.md` still mentions engine-web's WASM build (vendored folder, left as is).

## Next

- Harness: quality, speed and cost of generation.
- Deploy the studio (`apps/web`) so games built there are playable by link.
- Engine slices when wanted: E7 2.5D content, E8 netcode, E9 native mobile, E10 polish.

## Production and accounts

Prod was torn down 2026-11-16 (EC2 box, IP, key pair and AWS access key deleted); its database and every game built
on it are gone, with no backup. `deploy/` keeps the stack for the next host (README "Production").
Still around, for cleanup or reuse:
- Cloudflare DNS for dreamsy.dev (www, api, play, pwa) pointing at the dead IP.
- IAM user `dreamsy-ses-smtp`; Resend, Anthropic and OpenAI keys in `deploy/.env.prod` (gitignored).
- Convex deployments `vivid-vulture-808` / `uncommon-fox-891` (the live feed, removed from the code 2026-11-18).
- EAS project 4da22b8e-13c3-4cff-9880-6b9275245537.
Local copies of older builds: `.data/blobs/packages/*.zip` (21 local-dev builds).

Machine note: this Mac's network has broken IPv6; Node needs `--network-family-autoselection-attempt-timeout=2000`
(set in `scripts/dev.sh` and the harness).
