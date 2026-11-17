# Dreamsy — status

## 2026-11-17 — engine v2 (C++) started

Decision: Dreamsy becomes a 2D + 2.5D engine (no 3D), rewritten in C++ with server-authoritative multiplayer.
Spec: DREAMSY.MD §14 (stack, code style, determinism, 2.5D views, netcode, migration, full-engine scope §14.12, slices E0–E10).
`engine-web/` stays the shipping engine and reference until parity (E6).

**E0 scaffold: done (not committed yet).**
- `engine/`: CMake + presets (`debug` with ASan/UBSan, `release`, `headless`, `web`), see `engine/README.md`.
- `src/base/`: Result/Status, Pool/Id generational handles, Arena, Rng (sfc32, bit-identical to engine-web), Hasher, log, checks.
- `dreamsy-tool smoke` (sandboxed Luau + Box2D), `dreamsy-player` (spinning square: Metal on macOS, WebGL2 on web), `dreamsy-tests` (11 cases).
- Physics golden hash `8f2b7e35f5951775` is identical on macOS arm64 (debug, release) and WebAssembly; CI adds Linux x86-64.
- Web sizes (gzip): player wasm 44 KB + js 17 KB; tool (with Luau + Box2D) wasm 341 KB.
- Vendored: Box2D v3.2.0, sokol, miniaudio 0.11.26, stb, doctest 2.5.3 (`third_party/*/DREAMSY_VENDOR.md`).
- CI: `.github/workflows/engine.yml` (macOS, Linux headless, web). Not run yet: runs on the first push of engine changes to origin.
- Emscripten bug workaround: `engine/src/platform/web/em_library_funcs.json` (see the comment in engine/CMakeLists.txt).
- C++ primer: `docs/CPP-FOR-TS-DEVS.md`.

**E1 packages: done (not committed yet).**
- Zip replaced by the **Dreamsy pack (`.dpk`)**: index first, uncompressed + 16-byte aligned (read in place, no
  decompressor; HTTP brotli/gzip compresses it better than zip), SHA-256 per file, package id = hash of the index,
  canonical bytes. Spec: DREAMSY.MD §3.6. Engine never reads zip; `dreamsy-tool pack` converts (all 21 `.data` zips OK).
- `engine/src/pkg/`: Files (packs, dirs, zero-copy views), catalog (embedded format/catalog.json + kit.json list),
  manifest (toml++), tilesets/levels/anims/sfx/music/SVG parsers, `load_package()` = full port of
  format/src/validate.ts with the same issue codes, typed `Package` output.
- Tool: `dreamsy-tool validate|info|pack|unpack`. Packs are byte-identical between native and web builds.
- Conformance: `engine/tests/conformance/conformance.py` runs both validators on 26 games + 81 generated broken
  packages: 107/107 agree, 69 of 70 issue codes exercised (`package.too_large` is unit-tested instead).
  Intended difference: C++ rejects `dimension = "3d"` (block-tower).
- Fuzzing: targets for pack, package, zip import; `-replay` builds run in ctest with random mutations; libFuzzer in
  CI. Found 3 real bugs, all fixed, inputs kept in `engine/fuzz/regressions/` (replayed by ctest):
  1. toml++ v3.4.0 asserted (UB in release) on `[`+newline headers → re-vendored at upstream master `c38c9b9`
     (fixed upstream); toml++ asserts stay on in every build and stop cleanly instead of becoming assumptions.
  2. yyjson's error locator does null-pointer arithmetic on empty input → empty JSON files rejected before parsing.
  3. miniz's memory reader overflows a pointer on corrupt zip offsets → importer uses its own bounds-checked reader.
  After the fixes: 7,826 package + 7,525 pack + 12,004 zip mutated inputs under ASan/UBSan, no crashes.
  macOS note: a crashing run sits in the crash reporter (state UE) and looks hung; set DREAMSY_FUZZ_SAVE to keep the input.
- Tests: 33 cases / 261 assertions + fuzz corpus/regression replays, green on macOS debug (ASan/UBSan), release and web.
- TODO outside the engine: TS `.dpk` reader/writer in format/src/package.ts, then API/harness/engine-web switch from zip.

**E2 scripting: core done (not committed yet → see below).**
- Spec: §14.13 (single-player keeps one VM like engine-web; separate server/client VMs only for authoritative
  multiplayer; fast native vectors left OPEN), 2.5D folded into E3 (world) and E4 (renderer).
- `engine/src/script/`: native Luau host. The prelude is extracted from engine-web/core/prelude.ts at build time
  (byte-identical to what engine-web runs) and every kit's sources are embedded. Same op numbers, script order,
  tick order, error dedupe, budgets (unswallowable), memory cap, require/kits/cycles, save (64 KB), data.read,
  scenes, offline room, in-memory store, audio events. Entity ops raise "not available yet (E3)".
- `dreamsy-tool run <pkg>`; `tests/conformance/run_compare.py` diffs it against engine-web (ts_run.mts):
  6/6 script-only test games identical (`engine/tests/scripts/`).
- Deterministic math: musl 1.2.5 libm (same as Emscripten → engine-web) linked into every executable, built
  without FMA paths; math results identical to engine-web on all ~170 sampled values, golden bits pass on native
  debug/release and web. Before: 20 values differed between macOS libm and engine-web.
- Speed: native Luau ~1.8x engine-web's WASM Luau on a mixed benchmark (2.8x on pure compute; vec2 math only
  1.7x because every vec2 allocates a table → evidence for the OPEN fast-vectors item). No Luau codegen yet.
- Contract mismatches found (engine-web behavior kept for now): `random(min)` returns `min` (API says [min,max));
  LUAU_API "Not available" says only scripts/ can be required, but `@kit/` works and is documented.
- Still TODO in E2: `dreamsy-tool check` (Luau type checking against a dreamsy.d.luau), Luau native codegen
  on desktop/Android/server, per-script profiling, hot reload.

Next: finish E2 (type checking), then E3 world + physics with 2.5D (z, height, view modes) built in.

---

## 2026-11-16 — after the hackathon

### Prod is gone
The user asked for prod to be torn down:
- EC2 `i-03475cd33072e0156` terminated, and its disk was deleted with it.
- Elastic IP 15.252.199.188 released; security group and `dreamsy-ec2` key pair deleted.
- AWS access key AKIA6H4S4CP4OH6RRRPR deleted.

`scripts/deploy.sh` and `ssh dreamsy-ec2` no longer work. A new host needs a new key and box.

### Lost
The prod Postgres (users, coins, notifications, friends) and every game built on prod, including:
- Tidal Dash, Nope. (the onboarding troll game)
- Skyforge Saga, Turbo Tiles, Crownbreak Chess, Calibre, Rat Race
- Riddle Rumble, Sky Sprint, Brass Era Rally, Gem Drop Duel, Orb Duel, Saboteur Blocks, Riddle Keeper, Sugar & Spice

There is no backup. Rebuild them from prompts if needed. `docs/BEST-GAMES.md` has the ideas.

### Surviving games (local)
- `games/examples/`: kit templates plus mp-duel, block-tower, coin-dash, tile-quest, feature-demo.
- `games/showcase/`: fox-quest, fort-raiders, street-racer, summer-ride.
- `.data/blobs/packages/*.zip`: 21 local-dev builds of Dragons & Ladders, Petalbrook Farm, City Rush, Bop Up!, Village Raiders, Tile Quest, Summer Ride, Fox Explorer, Feature Demo and Coin Dash.

### Still pointing at nothing / still live
- Cloudflare DNS (dreamsy.dev, www, api, play, pwa → dead IP).
- IAM user `dreamsy-ses-smtp`.
- Convex `vivid-vulture-808` (live build feed).
- Resend, Anthropic and OpenAI keys in `deploy/.env.prod` (gitignored).
- EAS project 4da22b8e-13c3-4cff-9880-6b9275245537.

### Next idea: open-source the games and host them free
- Use Cloudflare Pages (or GitHub Pages) to serve `engine-web/dist` plus a `games/` folder of zips and an index page.
- The engine already supports `?zip=<url>` (`engine-web/dev/main.ts`, loadPackage), so single-player needs no server.
- Multiplayer, leaderboards, coins and accounts need `services/api` + `services/gameserver`. The free path is Cloudflare Workers + D1/Durable Objects, which is new work.

---

## 2026-11-15 — end of day 1 (historical)

## Run it
```sh
# Docker Desktop running; EXPO_TOKEN in repo-root .env; Expo Go signed in on the phone (same account)
./scripts/dev.sh            # Postgres, migrations, API, seed showcase (once), harness worker, engine, Expo Go
# fresh DB:  docker compose -f services/api/docker-compose.yml down -v && rm -f .dev-logs/.seeded
```
Engine alone: `pnpm -C engine-web dev` → http://localhost:2005 (game picker). One game build without API:
`pnpm -C harness local --prompt "..." --out /tmp/x [--rounds N]`.

## Built
| Area | Where | State |
|---|---|---|
| Spec | `DREAMSY.MD` (§3 format, §4 runtime, §11 platform, §12 kits) | current |
| Format | `format/` | 38 tests; catalog, styles, scenes, tilemaps, anims, sfx/music, store, kits, orientation |
| Engine | `engine-web/` (three.js + Rapier + Luau→WASM) | 54 tests; 2D, portrait/landscape, anim/tween/particles/camera/save/dialog/layers, store, platform menu, audio, kit loader, playtest/screenshot tools |
| API | `services/api/` | 31 tests; auth, games/versions, generations (+checkpoints/ETA), Stars store/ledger, feed/search/likes/plays/remix/follow/public/marketplace/reports/thumbnails |
| Harness | `harness/` | 10 tests; Haiku router (kit/style/pack/orientation), Opus director + build_content fan-out, playtest + art-director review, multi-round worker, taste packs |
| App | `apps/mobile/` (Expo SDK 58, Expo Go) | feed, game page, remix, profiles, market, create w/ ETA + checkpoints, WebView player |
| Taste | `taste/packs/*.md` + `taste/refs/` | 11 house styles from Pinterest refs |
| Games | `games/showcase/` (fox-quest, fort-raiders, street-racer, summer-ride), `games/examples/` | |

## Kits (engine-web/kits, DREAMSY.MD §12) — all 21 built, documented (KIT.md), schema'd, tested
- Foundation: core · progression · juice · combat · ai · procgen
- Genres: rpg · platformer · topdown · tower-defense · tycoon · puzzle · simulator · racing · roguelite · runner · story · deckbuilder · farming · survival · shooter
- Each has `kit.json` (deps auto-enabled), reads content via `data.read`, a minimal example in `games/examples/kit-*`, headless tests and (most) a balance/pacing sim.
- Engine extras landed: lighting (Light2D/Lighting2D, emissive, additive), game-time playtests (reproducible taps/shots, start mid-game with scene/params/save), gestures, UI stack/scroll/radius/clip, look stick, data reader, clock, timeScale.
- Harness: kit selection + kit (and dependency) docs in prompt, director → build_content fan-out with JSON-Schema checks (ajv), lighting guidance, mid-game playtests.

## Next
- All suites green (day 2 morning): format 41, engine 328, API 38, harness 23 (+1 live Supermemory smoke, skipped without key), web + app build. Engine context doc: https://claude.ai/artifact/Pr2oGVnJTSgRZ6tuBzmFiY
- First flagship 1–2h game on a kit (e.g. `pnpm -C harness local --prompt "..." --out /tmp/x --rounds 8`), ~$40–60.
- UI + taste pass on the app; a dark/gothic taste pack (send refs); Nano Banana backgrounds once Gemini billing is enabled (`GEMINI` key is free tier → 0 image quota).
- Hackathon: hosted backend + web player (venue Wi-Fi), pre-generated hero games, live tweak/remix demo, QR for judges.
- Multiplayer v1 built, not deployed (DREAMSY.MD §4.5): `services/gameserver` (rooms, codes, 1v1 quick match red/blue, relay; `pnpm -C services/gameserver start`, :8790, also in dev.sh + compose + Caddy `/rooms*`), engine lobby/HUD/winner card, Luau `room`/`players`/remote events, `games/examples/mp-duel`, racing kit versus. v2: server-authoritative sim on engine core, reconnect.
- Not started: moderation beyond Haiku pre-check, real payments (Stars are free), TestFlight (Apple Developer + EAS cloud build), macOS/Xcode update.
- Network note: this Mac's network has broken IPv6 + slow IPv4 → Node needs `--network-family-autoselection-attempt-timeout=2000` (set in scripts/dev.sh and harness).
- Nothing is committed to git yet.

## Production (2026-11-15)
- One EC2 box, ap-south-1: `i-03475cd33072e0156` (t3.large, 60 GB), Elastic IP 15.252.199.188, SSH `ssh dreamsy-ec2` (key ~/.ssh/dreamsy-ec2.pem, port 22 open only to the laptop IP).
- Mirrors the dev stack via `deploy/docker-compose.yml`: postgres:17, api, worker (Chromium playtests), caddy (80/443). Data on the host: `/srv/dreamsy/pg` (DB), `/srv/dreamsy/data/{blobs,memory,sprites}` (= local `.data`). Secrets in `deploy/.env.prod` (gitignored).
- Deploy code: `./scripts/deploy.sh` (rsync + rebuild; data kept).
- DNS (Cloudflare, proxied): api.dreamsy.dev + play.dreamsy.dev → A 15.252.199.188. Caddy: api → API, play → engine (static build copied to /srv/dreamsy/engine by deploy.sh). App + web point at prod by default; `dev.sh --local` for the laptop stack.
- Migrated from local on 2026-11-15 12:06: 5 users, 13 games, 24 versions, blobs + memory + sprite library.
- Convex live feed (`services/live`): prod deployment `vivid-vulture-808` (dashboard https://dashboard.convex.dev/d/vivid-vulture-808), dev `uncommon-fox-891`. API mirrors key build steps (`services/api/src/live.ts`, env CONVEX_SITE_URL + LIVE_INGEST_SECRET) → `POST /ingest` → tables builds/events/stats; clients subscribe to `live:feed` / `live:build`. Web "Live now" panel on Home (`VITE_CONVEX_URL`). Deploy functions: `cd services/live && npx convex deploy -y`.
- Web dashboard on https://dreamsy.dev (+www): static apps/web build served by Caddy from /srv/dreamsy/web; `scripts/deploy.sh` builds + uploads it (requires apps/web/.env.local → prod API).
- Demo sign-in bypass: `POST /v1/auth/demo {username}` → `{user, token}` with no email code, for usernames ending in `_demo` and the special names in DEMO_USERNAMES (default `demo,judge`); same username = same account; DEMO_LOGIN=0 disables. Dashboard: type a username instead of an email.
- Email sign-in is OURS now (not Supabase): `POST /v1/auth/email/start {email}` emails a 6-digit code via Resend (RESEND_API_KEY, EMAIL_FROM = noreply@thoughts.engineering), `POST /v1/auth/email/verify {email, code}` → `{user, token}`. 10-min codes, single use, 5 tries, 30 s between sends, 8/hour. Links to an existing user with the same email (old Supabase sign-ins). Supabase is only used for Google OAuth now. Table `email_codes` (migration 0007).
- Builders: Claude (default) or OpenAI per generation (`provider` on POST /v1/games/:id/generations; migration 0008). `harness/src/openai.ts` adapts the agent loop to the OpenAI Responses API (gpt-6.1-sol builder, gpt-6.1-terra content workers, service_tier priority = fast). Router/critic/lessons stay on Claude. Prod runs two workers: `worker` (Claude, WORKER_CONCURRENCY=5) and `worker-openai` (DREAMSY_PROVIDER=openai, 4). OpenAI $ in the cost meter are estimates (OPENAI_PRICE_*).
- Leaderboards + ghosts + family groups (DREAMSY §13) live on prod (API migration 0009, engine `leaderboard` Luau API + results card, kits racing/platformer/runner/puzzle wired, web Leaderboard tab + Groups page + /join/:code).
- Touch controls: fixed, smaller joystick (only the stick takes touches); buttons also appear when a game first reads them at runtime (kits read buttons via config, so the static scan missed e.g. the platformer's jump).
- Deploy: `./scripts/deploy.sh --keep-workers [--no-engine]` never interrupts running builds. Engine-only: `cd engine-web && npx vite build && rsync -az --delete dist/ dreamsy-ec2:/srv/dreamsy/engine/`. Workers still run the pre-leaderboard harness prompt until restarted when idle.
- Multiplayer v1 live: room server `gameserver` (wss://api.dreamsy.dev/rooms, DREAMSY §4.5: server-relayed state, devices simulate). Example "Orb Duel" published on @apxrv: https://play.dreamsy.dev/?public=g_01m7gkv3zzcazkvwhd2dm4y1rz.
- All @apxrv games published (2026-11-15 ~13:57); re-publish after the batch finishes (publish pins a version).
- Touch controls now show only while the game reads them (InputState.recentlyRead, ~0.75 s grace): hidden on title screens/menus/shops.
- Coins economy live (DREAMSY §11.6): 1M starter coins ($10), play 10K (90% creator / 10% platform, 30-min pass), first build 100K (refund on failure), remix 25K → original owner, spin-off plays: 8K spin-off creator + 1K royalty to direct parent owner + 1K platform. Notifications inbox + Expo push (EAS project 4da22b8e…, apxrvs-team; iOS Expo Go only; Android needs a dev build). seed-showcase needs CREATE_PRICE=0 or a topped-up account.
