# DREAMSY

An AI-native game platform. Anyone, on iPhone or web, describes a game (text + reference
images) and Dreamsy builds it, hosts it, and lets others play it — single or multiplayer.
Think Roblox where the studio is a Claude harness.

This file is the overview and the map of the spec (the rest lives in `docs/`, see [Spec map](#spec-map)). Everything in
the spec is a decision unless marked **OPEN**. Started 2026-11-14; current state of the work: STATUS.md.

---

## 1. Principles

1. **The game package is the contract.** Harness writes it, engine runs it, server hosts it,
   clients download it, marketplace items plug into it. Change it deliberately, version it.
2. **Everyone is a creator.** Creation happens from a phone. No desktop editor is required, ever.
3. **Generation lives in the cloud.** Clients are thin: chat, preview, tap-to-select.
4. **Edits, not rewrites.** Every entity has a stable ID; the AI emits diffs against the package.
5. **Server-authoritative multiplayer from day one.** Same code runs on client and server.
6. **Determinism where it matters.** Async play (Clash of Clans-style raids) and replays need
   a deterministic simulation path.
7. **One engine core everywhere.** The same engine code runs in the browser, in the app, on the game server and in
   harness playtests: the C++ engine (`engine/`, §14) built for WebAssembly, iOS, Android and headless servers. It
   replaced the TypeScript engine (`engine-web/`: three.js + Rapier + Luau→WASM), deleted 2026-11-18 (git tag
   `engine-web-final` has its last version).
8. **2D and 2.5D only.** No 3D (decided 2026-11-17, §14). The format still contains 3D types until §14.11 settles
   their removal.

## 2. Repository layout

```
dreamsy/
  DREAMSY.MD            this file: principles, layout, spec map
  docs/                 the spec by topic (format, runtime, harness, platform, kits, engine) + guides
  engine/               the C++ engine (§14): one core for web (WASM), iOS, Android, headless tools and servers
  format/               game package spec, JSON schemas, validator, diff ops, Luau API contract
  kits/                 21 genre kits (Luau libraries games `require("@kit/...")`, §12)
  games/examples/       hand-written golden packages (one per kit, plus engine feature demos)
  games/showcase/       Claude-built showcase games (seeded into the API, played in the app)
  harness/              cloud generation: Claude agent loop, playtests on the C++ engine (§5)
  taste/                house-style packs and reference art the harness shows the model
  services/api/         platform API: accounts, games, versions, uploads, generation jobs
  services/gameserver/  multiplayer room server (v1: rooms, quick match, relay; §4.5) → later headless C++ engine servers (E8)
  apps/mobile/          iPhone app, React Native/Expo (create + play)
  apps/web/             Dreamsy Studio: build games by chat in the browser, publish, play
  scripts/  deploy/     dev stack (dev.sh), production Docker image + compose + Caddy
  third_party/          vendored libraries (Luau 0.747, Box2D, sokol, ...; §14.6), unmodified
```

## Spec map

The spec is split by topic. Section numbers are global, so "§14.5" anywhere means section 14.5 of the file below.

| § | Topic | File |
|---|---|---|
| 1–2 | Principles, repository layout | this file |
| 3 | Game package format (the central contract; `.dpk` packs in §3.6) | [docs/format.md](docs/format.md) |
| 4 | Runtime: Luau scripting, determinism, targets, cloud topology, multiplayer v1 | [docs/runtime.md](docs/runtime.md) |
| 5 | Generation: the harness, assets | [docs/harness.md](docs/harness.md) |
| 6, 11, 13 | Clients; platform v1 (social, remix, marketplace); leaderboards, ghosts, groups | [docs/platform.md](docs/platform.md) |
| 7–10 | Trust & safety, later, roadmap, open questions | this file |
| 12 | Genre kits | [docs/kits.md](docs/kits.md) |
| 14 | The C++ 2D/2.5D engine: stack, code style, 2.5D views, netcode, slices | [docs/engine.md](docs/engine.md) |

Guides: [docs/cpp-for-ts-devs.md](docs/cpp-for-ts-devs.md) (C++ for TypeScript developers, with the engine as examples),
`engine/README.md` (build, test, embed), `format/LUAU_API.md` (the scripting API), `harness/README.md`.

## 7. Trust & safety

Required for App Store (UGC, likely minors). Moderate prompts, generated assets, in-game text,
names and chat before publish/display; report + block; age-appropriate defaults.
**OPEN:** build into v1 vs stub until App Store submission.

## 8. Later

Marketplace, avatar skins/ornaments (assets that bind to the platform avatar rig, sold via
Ledger), creator economy, website, Android.

## 9. Roadmap

Done: the package format, the platform (API, app, studio, harness), multiplayer v1 rooms, 21 kits, and the C++ engine
through parity (E0–E6, a first E7 2.5D slice; engine-web removed 2026-11-18). Next, in no fixed order:
- **Harness**: quality, speed and cost of generation (§5).
- **Studio deploy**: host `apps/web` so games built there are playable by link.
- **Engine slices** (§14.10): E7 2.5D content, E8 authoritative netcode (multiplayer games run solo in the C++ engine
  until then), E9 native mobile without the WebView, E10 polish. Audio gets its own harness.

## 10. Open questions

- Deterministic physics scope (§4.2) — settled by §14.4: all physics deterministic in the C++ engine
- C++ engine questions (§14.11)
- Harness language (§5.1)
- Audio generation (§5.2)
- Moderation in v1 or stubbed (§7)
- Who creates in v1: everyone from day one, or invite-only creators first?
