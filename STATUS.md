# Dreamsy — status (2026-11-15, end of day 1)

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
