# DREAMSY

An AI-native game platform. Anyone, on iPhone or web, describes a game (text + reference
images) and Dreamsy builds it, hosts it, and lets others play it — single or multiplayer.
Think Roblox where the studio is a Claude harness.

Status: v0 spec, 2026-11-14. Everything here is a decision unless marked **OPEN**.

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
   harness playtests. Today that is TypeScript (`engine-web/`: three.js + Rapier + Luau→WASM); it is being replaced
   by a C++ core (`engine/`, §14) built for WebAssembly, iOS, Android and headless servers.
8. **2D and 2.5D only.** No 3D (decided 2026-11-17, §14). The format still contains 3D types until §14.11 settles
   their removal.

## 2. Monorepo layout

```
dreamsy/
  DREAMSY.MD            this file
  engine/               the C++ engine v2 (§14): one core for web (WASM), iOS, Android, headless server
  engine-web/           the TypeScript engine (shipping + reference until engine/ reaches parity, §14.8)
  third_party/luau/     vendored Luau 0.747 (compiled to WASM for engine-web)
  format/               game package spec, JSON schemas, validator, diff ops
  services/api/         platform API: accounts, games, versions, uploads, generation jobs
  services/gameserver/  multiplayer room server (v1: rooms, quick match, relay; §4.5) → later Node game servers on engine-web/core
  harness/              cloud generation: Claude agent loop + sandboxed engine
  pipelines/assets/     2D/3D asset generation
  apps/mobile/          iPhone app, React Native/Expo (create + play)
  apps/web/             website (later)
  games/examples/       hand-written golden packages
  games/showcase/       Opus-generated showcase games (seeded into the API, played in the app)
```

## 3. Game package format (v0)

A game is a directory (authoring form), shipped as a Dreamsy pack (`.dpk`, §3.6), content-addressed and versioned.

```
game/
  dreamsy.toml               manifest
  scenes/*.scene.json        entity tree, flat map keyed by stable id
  scripts/
    client/*.luau            runs on each player's device
    server/*.luau            runs on the authoritative server only
    shared/*.luau            modules required by both
  data/*.luau|json           persistent data shapes (player + world), versioned
  data/tilesets/*.json       TileMap2D tilesets (§3.5)
  data/levels/*.txt          TileMap2D grids, one text row per tile row (§3.5)
  data/sfx/<id>.json         synthesized sound effects (sfxr-style params; LUAU_API.md)
  data/music/<id>.json       chiptune songs (≤ 4 channels, note text; LUAU_API.md)
  data/anims/<name>.json     sprite animation sets (frame lists, fps, loop; Sprite2D `anims`)
  assets/
    <id>.png|glb|ogg|ttf     binary assets
    <id>.meta.json           kind, file, provenance (model, prompt, seed, references), license
```

Implementation: `format/` (`@dreamsy/format`): schemas, entity catalog, styles, validator,
ops, deterministic zip, CLI (`pnpm -C format cli validate <dir>`). Golden examples:
`games/examples/coin-dash` (2D pixel, single-player), `games/examples/block-tower` (3D blocky, rooms),
`games/examples/tile-quest` (2D pixel, TileMap2D levels + multiple scenes), `games/examples/feature-demo`
(portrait pixel: sprite anims, tweens, particles, camera, save, dialogs, collision layers, text styles).
`format/catalog.json` is the generated catalog the engine loader and harness consume.

### 3.1 Manifest (`dreamsy.toml`)

```toml
format = "0"
id = "g_01J..."            # platform-assigned
name = "Tiny Clash"
dimension = "2d"           # "2d" | "3d"
orientation = "portrait"   # "portrait" (720×1280) | "landscape" (1280×720); absent = landscape (§11.1)
entry_scene = "scenes/main.scene.json"
kits = ["rpg"]             # optional engine kits (§12.1); format/src/kits.ts KITS

[players]
min = 1
max = 8                    # > 1 requires server.mode != "none"

[server]
mode = "rooms"             # "none" | "rooms" | "persistent" | "async"
tick_rate = 30
deterministic = false      # true required for mode = "async"

[avatar]
enabled = true             # requires a SpawnPoint in the entry scene

[physics]                  # optional; ≤ 16 named collision layers for Body2D/Area2D/TileMap2D
layers = ["player", "enemy", "pickup", "world"]   # `layer` / `mask` props; unset = every layer

[ui]                       # theme for the engine-owned pause/settings menu; all optional,
primary = "#5e7ed6"        # defaults derived from style.palette / preset
panel = "pixel"            # "pixel" | "rounded" | "sharp" | "outlined"
font = "pixel"             # "pixel" | "rounded" | "bold" | "serif"

[[store]]                  # Stars items; see LUAU_API.md "Store"
id = "vip"
kind = "pass"              # "pass" | "consumable"
name = "VIP"
price = 100

[style]
preset = "pixel"           # "pixel" | "blocky" | "clean" | "toon" | "custom"
grid = 16                  # pixel only
palette = ["#1a1c2c", "#ffcd75"]
notes = "..."              # required for custom
references = ["style_ref"] # image asset ids
```

Strict: unknown keys are errors (catches model typos).

### 3.2 Art styles

A preset (`format/src/styles.ts`) drives three things at once:
- **harness**: how Claude builds (e.g. `blocky`/`clean` = primitives first, no image-to-3D → cheap)
- **asset pipeline**: style prompt appended to every generation
- **engine**: render hints (texture filter, pixel snap, base resolution, shading, outline)

`pixel` is 2D-only; others work in 2D and 3D.

### 3.3 Scenes

```json
{
  "format": "0",
  "root": "world",
  "entities": {
    "world":   { "type": "Node2D", "children": ["player", "coin_1"] },
    "player":  { "type": "Body2D", "props": { "position": [32, 144], "body": "dynamic" },
                 "scripts": ["scripts/client/player.luau"], "tags": ["player"] },
    "coin_1":  { "type": "Area2D", "props": { "position": [96, 104] }, "tags": ["coin"] }
  }
}
```

- Ids: `lowercase_snake`, stable forever, **unique across the whole package** (so a tap-selection
  or an op never needs a scene path).
- Tree = ordered `children` lists only; parent is derived, never stored (can't disagree).
- Types + typed props come from the catalog (`format/src/catalog.ts`): Folder, Node2D, Sprite2D,
  Body2D, Area2D, Camera2D, Text2D, TileMap2D, Particles2D, Light2D, Lighting2D, SpawnPoint2D, Node3D, Mesh3D, Body3D, Area3D, Camera3D,
  Light3D, Environment3D, SpawnPoint3D, Sound, UIText, UIButton, UIPanel.
  (2026-11-15 polish, additive: Light2D/Lighting2D 2D lighting; `emissive`/`blend` on Sprite2D/Text2D/Particles2D;
  Sprite2D `color` = alias of `modulate`; UIPanel `layout = "stack"`/`gap`/`padding`/`tint`/`radius`/`clip`; UIText `valign`.
  The validator only warns about a missing camera when the entry scene has world entities.)
- Prop values: numbers, bools, strings, `[x,y]`, `[x,y,z]`, `"#rrggbb(aa)"`, enums,
  `"asset:<id>"`, entity id refs. Unset = catalog default.
- Scripts attached to an entity run per-entity (`script.entity`). Client/server scripts not
  attached to anything run once at game start. Shared scripts are modules only.
- Many scenes per game: `entry_scene` starts; scripts switch with `loadScene(path, params)`. A switch tears
  down the scene's entities, attached-script instances and physics; unattached scripts (the "session")
  and loaded modules keep running. The validator errors on literal `loadScene("...")` targets that don't exist.

### 3.4 Edit ops

The harness and in-app edits speak one op language (`format/src/ops.ts`), JSON, addressed by id:

```
set_manifest {key, value}         add_scene {scene, root}         remove_scene {scene}
add_entity {parent, id, type, props?, scripts?, tags?, index?}
set_props {id, props}  (null resets)   update_entity {id, type?, name?, scripts?, tags?}
remove_entity {id}  (subtree)     move_entity {id, parent, index?}
write_file {path, content}        edit_file {path, old, new}  (exact, single match; text files:
                                  notes.md, scripts/**.luau, data/**.luau|json, data/levels/**.txt)
delete_file {path}                put_asset {id, blob, meta}  (bytes from side channel)
remove_asset {id}
```

A batch applies all-or-nothing; failures name the op index. The result is then validated
(schema, tree integrity, prop types, asset/entity refs, manifest rules); issues are written
to be fed straight back to the model. The API runs the same validator on every uploaded package.
Still TODO: Luau compile/typecheck and headless boot test (harness, needs engine).
Versions are immutable; undo = revert (new version with an old package).

### 3.5 Tile maps

**TileMap2D** (2D, no children) draws and collides a whole level grid as one entity. Props: transform2d
(`position` = top-left corner of cell (0,0), `z_index` = layer), `tile_size` (px, default 16),
`tileset` (`"data/tilesets/<name>.json"`), `data` (the grid), `collision` (default true).

Tileset — `data/tilesets/<name>.json`, one entry per single printable-ASCII character:

```json
{
  "tiles": {
    "G": {"sprite": "asset:tile_grass", "solid": true},
    "B": {"sprite": "asset:tile_brick", "solid": true, "tags": ["breakable"]},
    "=": {"color": "#a76f4a", "solid": true},
    "^": {"sprite": "asset:tile_spike", "tags": ["spike"]},
    "c": {"color": "#f4f4f4"}
  }
}
```

`sprite` (`"asset:<id>"` image, stretched to the tile) and/or `color` (fill without sprite, tint with one;
neither = invisible); `solid` (default false); `tags` (lowercase_snake). `"."` and `" "` are always empty.

Grid — text, one line per tile row (top row first), one character per tile. Either inline
(`"data": "....\n.^..\nGGGG"`, small maps) or `"data": "file:data/levels/<name>.txt"` (anything bigger;
plain text, so rows diff and `edit_file` cleanly). Short rows are padded with empty tiles; trailing
blank lines are ignored; max 1024×256 tiles. Every character must be defined in the tileset (or be empty).
Engine: chunked merged meshes; solid tiles merged into row-run rectangles (seam-free floors);
`tileTouched` / `setTile` / `tileAt` in LUAU_API.md.

### 3.6 Dreamsy pack (`.dpk`) — transport and runtime format (2026-11-17)

**Decision:** packages travel and load as Dreamsy packs, not zips. Zip puts its index at the end,
deflates every file (including PNG/OGG that are already compressed), stores timestamps (so the same
content gives different bytes), and can't be read in place. A pack is built for the engine:

- **Index first.** Header + index come before the data, so one small (range) read gives the whole file
  list; the engine can parse `dreamsy.toml` and scenes before the media has arrived.
- **Uncompressed, 16-byte aligned.** Media is already compressed; text is compressed by HTTP
  (brotli/gzip) in transit, which beats zip because it shares context across files (e.g. 34 KB zip →
  20 KB gzip'd pack). The engine needs no decompressor and reads files in place from the pack buffer.
- **Content-addressed.** Every entry carries its SHA-256; the package's identity is the SHA-256 of
  the index. Enables integrity checks, de-duplication across versions and incremental updates
  (fetch only entries whose hash changed).
- **Canonical.** Sorted paths, fixed offsets, zero padding, no timestamps: the same files always give
  the same bytes. Readers accept only the canonical layout.

Layout (little-endian):

```
header, 80 bytes
  0   magic          "DREAMSY" 0x1A
  8   u32 version    1
  12  u32 flags      0 (reserved)
  16  u32 entry_count
  20  u32 index_size
  24  u64 data_offset = align16(80 + index_size)
  32  u64 data_size
  40  u8[32] index_sha256      (= the package content hash)
  72  u8[8]  reserved (0)
index, entry_count entries, paths strictly ascending (byte order), normalized (§3, no "..")
  u16 path_len, path (UTF-8), u8 compression (0 = none; others reserved), u8 reserved (0),
  u64 offset (from data_offset, multiple of 16), u64 size, u8[32] sha256
zero padding to data_offset
data: entries in index order, each at its offset, zero-padded to 16 bytes; the file ends there
```

Limits (reader): ≤ 20,000 entries, ≤ 64 MB per file, ≤ 200 MB total, paths ≤ 1024 bytes.
Reader/writer: `engine/src/pkg/pack.cpp`; `dreamsy-tool pack <dir|zip> <out.dpk>` (validates first),
`dreamsy-tool unpack`, `dreamsy-tool info` (prints the content hash). The C++ engine never reads zips;
the tool converts legacy zip builds. TS reader/writer: `format/src/pack.ts` (`Package.fromPack`, `toPack`,
`contentHash`; pure-TS synchronous SHA-256 so it runs in browsers), byte-identical with the C++ writer (cross-checked
in `format/test/pack.test.ts` against `dreamsy-tool` for every 2D example/showcase game); the format CLI packs to
`.dpk` when the output ends in `.dpk` and reads `.dpk` in `validate`/`unpack`/`apply`. **Still TODO:** the API,
harness and `engine-web` still move zips; switch them to `.dpk`.

## 4. Runtime & multiplayer

### 4.1 Scripting: Luau

- Luau compiled to WASM (`engine-web/luau`), host API implemented in TypeScript. Contract: `format/LUAU_API.md`.
- Why Luau: sandboxed by design, fast, gradual types, and models are heavily trained on it.
- API is Dreamsy's own (not a Roblox clone), but follows the same proven shape:
  client / server / shared scripts, remote events + remote functions, replicated properties.
- Sandbox: no filesystem, no raw network, CPU + memory budgets per script, all I/O via services.

### 4.2 Server

The server is the headless engine (Linux build) running the same package with
`scripts/server` + `scripts/shared`. Clients never trust themselves.

Platform services exposed to server scripts:

| Service    | What                                                                  |
|------------|-----------------------------------------------------------------------|
| Rooms      | real-time sessions, matchmaking, join/leave, replication              |
| DataStore  | persistent per-player and per-world data, typed by `data/schema.luau` |
| Timers     | jobs that fire while players are offline ("build done in 4h")         |
| Async      | snapshot another player's world; run a deterministic sim against it   |
| Ledger     | server-only currency/inventory mutations (marketplace builds on this) |

`server.mode` picks the shape:
- `none` — single-player, runs locally.
- `rooms` — session games (obby, arena, party games).
- `persistent` — a shared world that outlives sessions.
- `async` — CoC-style: own base persistent, raids simulated against snapshots, replays.

Async/replay requires the deterministic path: fixed tick, seeded RNG from the platform,
fixed-point or carefully constrained float math in the sim layer. **OPEN:** how much of
physics we make deterministic vs. limiting async games to a sim-friendly subset.

### 4.3 Targets

> Superseded by §14.7 once the C++ engine reaches parity. The table below describes `engine-web`.

**Decision (2026-11-14):** web engine instead of a Godot fork (the fork was built, then deleted the same day). Games are Roblox-level at most
(sprite games, platformers, block games, clean racing), which web tech handles on phones; in
exchange we get one language across the stack, instant iteration, no native toolchain, play in
iPhone Safari with zero install, and trivial headless screenshots for the harness.

| Where | How |
|---|---|
| Web / iPhone Safari | `engine-web` directly |
| Mobile app | `engine-web` in a WebView (or expo-gl) inside the Expo app |
| Game servers | `engine-web/core` in Node (no renderer), server-authoritative |
| Harness playtest | headless Chromium: boot package, collect script errors, screenshot for Claude |

**2D first:** v1 engine implements the 2D path (orthographic renderer, rapier2d). 3D packages fail
with "not supported yet". The harness only builds 2D games until the 3D path ships.

### 4.4 Cloud topology

```
apps/mobile, apps/web ► services/api ◄── harness workers (claim jobs, upload versions)
                           │
                           └──► services/gameserver (orchestrator ─► headless engine fleet)
```

- **services/api** — ordinary backend, no engine. TypeScript (Hono) + Postgres + S3-compatible
  object storage. Owns users, games, immutable package versions, reference uploads, generation
  jobs (Postgres queue, leased to workers), event streams (SSE), quotas.
- **harness** — stateless workers that pull jobs from the API.
- **services/gameserver** — the room server (§4.5): Node + `ws`, one process, in-memory rooms. Prod: `gameserver`
  container on the same box; Caddy routes `api.dreamsy.dev/rooms*` (WebSocket) to it, everything else to the API.

### 4.5 Multiplayer v1 — rooms, 1v1 red vs blue, family play (2026-11-15)

Goal: "1v1 true red vs true blue, and a game can have many players, so I can share games with family".

**Decision: server-relayed state sync now, server-authoritative simulation later.** Every device runs the whole package
(client + server scripts, as single-player does today) and simulates its own world and avatar. The room server is
authoritative for everything *about* the match — membership, teams, host, shared state, score totals, the result — and
relays avatar samples (15 Hz) and remote events. Remote avatars are visual puppets interpolated 100 ms in the past.
Why not run the game on the server yet: `engine-web/core` does run in Node, but one VM runs client and server scripts
together, entity props have no replication layer, and phones need instant local movement (that means client prediction +
reconciliation for a server-simulated avatar). Relay gives zero-latency controls on phones, works for every existing game
and kit with a few lines (`room.replicate`, `room.finish`), and costs ~nothing on the server (no simulation). Trade-offs,
accepted for family/friends play: clients are trusted for their own position and claims (a modified client can cheat), no
physical interaction between players (puppets have no bodies), shared objects need a host decision (`room.isHost`).

- **Rooms**: 6-char codes (no 0/O/1/I/L); `party` rooms up to `[players] max` (≤ 8), teams balanced red/blue (players can
  switch in the lobby), host starts when everyone is ready (`[players] min`); late joiners drop into the running match.
  **Quick match**: a per-game queue pairs two players into a `duel` room (first red, second blue) that starts at once;
  rematch = both press Rematch. A duel ends as a forfeit when one side leaves. Host = first player, moves on leave.
- **Auth**: the API's HS256 user token in the first message (`{t:"hello", token, name?}`), verified with the same
  `JWT_SECRET`; the web player gets a guest token (`POST /v1/auth/guest`) when signed out, so share links work for family
  without accounts. Player ids are per connection (two tabs of one account = two players). Display name: typed in the
  lobby, else the API handle (`GET /v1/me`).
- **Limits**: 8 KB/message (socket closes > 16 KB), 40 msg/s sustained + 80 burst (excess dropped with `rate_limited`;
  > 400 drops → close 4008), event args ≤ 4 KB, state values ≤ 2 KB, ≤ 64 state keys, 20 s heartbeat.
- **Protocol** (`engine-web/net/protocol.ts`, JSON over one WebSocket): client `hello · create · join · spectate · quick · cancel ·
  ready · team · start · leave · ping` and in a match `st (avatar sample) · ev (event → host | others | player id) · kv ·
  score · end`; server `welcome · room · queued · start · left · error · pong` and `st (+ server ts) · ev · kv · score ·
  ended`.
- **Engine**: `core/net.ts` (NetSession: Luau `players` / `remoteEvent` / `room` on a `NetLink`), `net/client.ts`
  (RoomClient over WebSocket), `net/interp.ts` (clock sync + snapshot interpolation), `net/loopback.ts` (in-memory room for
  tests/harness), `net/lobby.ts` (engine-owned lobby, HUD chips, winner card). Dev page: games with `server.mode = "rooms"`
  and `players.max > 1` open the lobby first (`?room=<code>` joins, `?solo=1` skips, tools never see it); the room server
  URL is derived from the API (`https://api.x` → `wss://api.x/rooms`, local `:8787` → `:8790`) or `?rooms=`.
  Share link: `https://play.dreamsy.dev/?public=<gameId>&room=<code>` (published games; dev: the current URL + `room`).
- **Luau API**: `format/LUAU_API.md` "Players & avatar" + "Networking (multiplayer)". Example: `games/examples/mp-duel`
  (Orb Duel: host spawns orbs, first claim wins, first to 5); the racing kit races versus in a room (KIT.md "Versus").
- **v2**: server-authoritative simulation (engine core per room in Node, input upload + prediction/reconciliation,
  replicated entity props — the §4.2 design), reconnect/resume to the same seat, cross-device physical contact,
  spectators, persistent matchmaking (skill, regions), several gameserver processes (rooms pinned by code), match
  results to the API (`runs`/leaderboards from rooms), moderation of display names.
- **Spectators + presence (2026-11-15)**: `spectate {code}` watches a room (lobby or running): not a player, not counted
  in max, ≤ 16 per room (`LIMITS.maxSpectators`), receives everything players receive (`room`/`start` carry
  `spectator: true`; late spectators get the current `kv` + `score` right after `start`), can't send `st/ev/kv/score/ready/
  team/start/end` (error code `spectator`). `RoomInfo.spectators` = count. Engine: `?room=<code>&spectate=1`, no local
  player (`players.local == nil`, `room.isSpectator`), "player"-tagged entities hidden with their scripts skipped, no touch
  controls, SPECTATING HUD chip + player chips that switch the followed puppet. Presence: the room server tracks each
  userId (in_match > in_room > online, online until 60 s after the last connection closes) and answers
  `GET /internal/presence?users=a,b` (header `x-internal-token` = `WORKER_TOKEN`) → `{presence:{[userId]: Presence}}` for
  services/api's friends list. Lobby: room codes are typed on an on-screen keypad (no system keyboard; paste; auto-join
  at 6), the name field stays above the keyboard (visualViewport), and the room screen has "Invite friends"
  (`GET /v1/me/friends`, `POST /v1/invites`; signed-in users with an API game only).

## 5. Generation

### 5.1 Harness

- Runs in the cloud. Input: user prompt, reference images, current package version, user
  selection (e.g. tapped entity IDs). Output: validated diff-op batches.
- **Opus 5.5** orchestrates: game design, scene construction, all Luau logic, asset requests.
- **Smaller models** handle cheap, frequent work: small edits, naming, metadata, moderation pre-checks.
- Loop: plan → emit ops → validate (schema, typecheck, headless boot test, scripted smoke play)
  → fix → commit version → push to client for hot reload.
- **OPEN:** harness language. Leaning TypeScript (Claude Agent SDK; shares types with web app).

### 5.2 Assets

Opus directs, specialized models make. Opus does not hand-build meshes except simple/procedural ones.

- **2D** (sprites, textures, UI, icons): Gemini image model, with style locked per game from
  the reference images.
- **3D**: Gemini generates reference views → image-to-3D (Hunyuan3D / Trellis self-hosted,
  or Tripo / Meshy API) → cleanup (decimate, UV, compress) → glTF. Characters → auto-rig.
- Audio: **OPEN**.
- Every asset gets `.meta.toml` provenance. Assets are content-addressed and reusable across games.

### 5.3 Cost

Every creator generating is the business risk. Per-user generation quota, small models for
iteration, Opus for builds and hard logic, aggressive caching of assets and plans.

## 6. Clients

- **Mobile app (iOS first, Expo/React Native):** home/discover, play, create. Create = chat + live preview of the running
  game + tap-to-select entities to scope edits. Engine runs in a WebView.
- **Web:** same flows; the engine is native to the web.
- App Store: games are interpreted Luau + data in a sandbox (same basis as Roblox / HTML5 mini-games, guideline 4.7).

## 7. Trust & safety

Required for App Store (UGC, likely minors). Moderate prompts, generated assets, in-game text,
names and chat before publish/display; report + block; age-appropriate defaults.
**OPEN:** build into v1 vs stub until App Store submission.

## 8. Later

Marketplace, avatar skins/ornaments (assets that bind to the platform avatar rig, sold via
Ledger), creator economy, website, Android.

## 9. Roadmap

**Slice 1 — "prompt to playable on iPhone"** (single-player, ugly is fine)
1. `format/` v0: schemas, validator, diff-op applier, 2 golden example packages.
2. `engine-web`: 2D core + renderer + Luau WASM; runs golden + showcase packages in browser and iPhone Safari.
3. Engine in the Expo app (WebView) + harness playtest tool (headless screenshots).
4. `harness/`: prompt + image → package via diff ops, validated with headless boot.
5. `apps/mobile`: chat → harness → hot-reload preview.

> Engine work from 2026-11-17 follows the §14.10 slices (E0–E9).

**Slice 2 — multiplayer:** Linux headless server, Rooms + replication, DataStore.

**Slice 3 — persistence & async:** Timers, Async + deterministic sim, a CoC-style example game.

**Then:** web client, avatar + skins, marketplace + Ledger, moderation hardening.

## 10. Open questions

- Deterministic physics scope (§4.2) — settled by §14.4: all physics deterministic in the C++ engine
- C++ engine questions (§14.11)
- Harness language (§5.1)
- Audio generation (§5.2)
- Moderation in v1 or stubbed (§7)
- Who creates in v1: everyone from day one, or invite-only creators first?

## 11. Platform v1 — social, remix, marketplace (spec, 2026-11-15)

Shared contract for engine, API, app and harness. JSON camelCase; user routes need a bearer token
unless marked **public**.

### 11.1 Orientation (phone layout)
- Manifest `orientation = "portrait" | "landscape"` (default `"portrait"` for new games; existing
  games without it are `"landscape"`). Reference screen keeps the short side = 720: portrait is
  720×1280, landscape 1280×720.
- Engine letterboxes to the reference aspect, respects safe areas (notch/home bar) for UI anchors,
  and lays out touch controls per orientation. The app's Play screen locks to the game's orientation.

### 11.2 Feed, stats, thumbnails
- Every published game has stats: `plays`, `likes`, `remixes`, `trendingScore`.
- `GET /v1/feed?tab=trending|new|top|following&cursor=&limit=&multiplayer=1` → `{ games: FeedGame[], next }`.
  `FeedGame = { id, name, description, orientation, thumbnailUrl, players: {min, max}, multiplayer, creator: {id, handle}, stats: {plays, likes, remixes}, publishedAt, remixOf: {gameId, name} | null }`.
  `players` = the published version's `[players]` (`game_versions.players_min/max`, set on commit); `multiplayer` = max > 1;
  every game view has both (owner/group views: published, else latest). `?multiplayer=1` on feed/search/`GET /v1/games` filters.
- `GET /v1/search?q=&cursor=&multiplayer=1` → same shape (name/description/creator handle, ILIKE is fine for v1).
- Trending score = `(plays_7d + 3·likes_7d + 5·remixes_7d) / (hoursSincePublish + 2)^1.2`, recomputed on write or by a cheap periodic query — keep it simple.
- `POST /v1/games/:id/plays {version}` → counts a play (dedupe one per user per game per hour).
- `PUT /v1/games/:id/like` / `DELETE /v1/games/:id/like`; game views include `viewer: {liked, ownedPasses?}`.
- Thumbnails: the worker uploads `thumbnail` (JPEG, multipart field on `/complete`) taken from the harness playtest; stored per version. `GET /v1/games/:id/versions/:v/thumbnail` (public for the published version) — `thumbnailUrl` points at it.

### 11.3 Remix (fork)
- `POST /v1/games/:id/remix` → creates a new game (public by default, §11.8, so v1 goes live) owned by the caller whose version 1 is a
  copy of the source's published version (or latest, if the caller owns the source).
  `remixOf = {gameId, version}` stored; source `remixes` +1. Name "<source> (remix)".
- Remixes keep a credit line in their public view; store items are removed from the copy's manifest
  (sellers can't resell someone else's items) — the harness/worker never needs to know.

### 11.4 Creators & following
- `GET /v1/users/:id` → `{ user: {id, handle, bio, createdAt}, stats: {games, plays, likes, followers, following}, viewer: {following} }`.
- `GET /v1/users/:id/games` (published only, unless self). `PATCH /v1/me {handle?, bio?}` (handle unique, 3–20 chars `[a-z0-9_]`).
- `PUT|DELETE /v1/users/:id/follow`. Feed tab `following` = recent games from followed creators.

### 11.5 Sharing (public)
- `GET /v1/public/games/:id` → FeedGame + `publishedVersion` (**public**, published only).
- `GET /v1/public/games/:id/package` → published package zip (**public**) so the web player can run
  it without an account. Rate-limit later.
- Share URL: `${WEB_URL}/g/<gameId>` → engine-web serves a play page (`/g/:id` route or
  `?public=<id>`), no login needed. App share sheet shares this URL.

### 11.6 Marketplace
- `GET /v1/marketplace?sort=popular|new|price&cursor=` → store items across all published games:
  `{ items: [{ gameId, gameName, itemId, kind, name, description, price, iconUrl?, sales }], next }`.
  Purchases still go through `POST /v1/games/:id/store/purchase` (in the game's context).
- `sales` counts purchases per item.

**Coins & pay-per-play (2026-11-15).** The Stars ledger (`wallets`, append-only `ledger`) is the
currency, shown to users as **coins**. 10,000 coins = $0.10 (1,000,000 = $10); no real money yet.
- Every account starts with **1,000,000 coins** (`STARTER_STARS`); migration `0011_pay_per_play` topped
  existing wallets up to 1,000,000 with a `grant` ledger entry and seeded the platform account `u_platform`.
- Starting someone else's game costs **`PLAY_PRICE` = 10,000 coins**, split **`CREATOR_SHARE` = 0.9**:
  creator 9,000, platform 1,000. Three ledger rows that sum to zero: `play` (player −10,000),
  `play_earning` (creator +9,000), `platform_fee` (`u_platform` +1,000), linked by `pass_id`.
  Store purchases split the same way (`purchase` / `sale` / `platform_fee`).
- A paid start opens a **30-minute play pass** (`play_passes`, `PLAY_PASS_MINUTES`) for (user, game);
  starts while it's valid are free and return the same pass (reloads, crashes, rematches, multiplayer rejoin).
- Free: the owner playing their own game; group members playing an unpublished draft shared to their group.
- `POST /v1/games/:id/play {version?}` → `{ charged, price, balance, pass: {id, expiresAt}, creatorEarned }`
  (`price` is always the play price; `creatorEarned` 0 unless charged); 402 `{error:"insufficient_coins", balance, price}`.
  One transaction; wallet rows locked in id order, so concurrent starts charge once and never go negative.
  It also counts the play (same 1/user/game/hour dedupe as `POST /plays`, which stays for old clients, free).
  `GET /v1/games/:id/play` is a side-effect-free quote: `{free, reason: "owner"|"draft"|"pass"|null, price, balance, pass|null}`.
- `GET /v1/me/earnings` → `{ totalCoins, todayCoins, paidPlays, usd: {total, today}, games: [{gameId, name, coins, plays}] }`
  (play earnings + store sales); also returned as `earnings` on `GET /v1/me/insights`.
  `GET /v1/me/wallet` → `wallet: {balance, currency: "coins", usd}`. Game views carry `playPrice`.
- v1 gate is client-side: the app calls `POST /play` before opening the player; package fetch does
  not check passes yet. Real-money top-up / cash-out is later.

**Create & remix prices + notifications (2026-11-15).**
- **Create:** a game's *first* build (`POST /v1/games/:id/generations` while the game has no
  versions) costs **`CREATE_PRICE` = 100,000 coins** → platform (two `create` ledger rows). Edits,
  tweaks and sprite edits of a built game are free. Response `{generation, charged}` (0 or 100,000;
  also `generation.charged` / `generation.refunded`); 402 `{error:"insufficient_coins", balance,
  price}`. If that build ends `failed` (final, incl. lease give-up) or `canceled` while the game still
  has no version, the charge is refunded once (`create_refund` rows; `generations.refunded_at`, set
  under the generation row lock). A checkpoint that committed v1 keeps the charge.
- **Remix:** `POST /v1/games/:id/remix` costs **`REMIX_PRICE` = 25,000 coins**, 100% to the original
  game's owner (`remix` −25,000 / `remix_earning` +25,000); free on your own game. Response
  `{game, charged, ownerEarned}`; same 402.
- Prices are exposed: game views `remixPrice` (next to `playPrice`); `GET /v1/me/quota` and
  `GET /v1/me/wallet` carry `createPrice` (top level and in `quota` / `wallet`) and `remixPrice`.
- **Notifications** (`notifications` table, migration `0012_notifications_create_price`): inserted in
  the same transaction as their cause via `notify(tx, userId, kind, title, body, data)`; never to
  yourself. Kinds: `play_earning` (one per paid pass: "You got paid" / "@p played G — +9K coins
  ($0.09)"), `remix_earning` ("@p remixed G — +25K coins ($0.25)"), `sale` ("@p bought I in G — +N
  coins"), `build_done` ("Your game is ready" / "G vN is playable"; on complete, and on the checkpoint
  that commits a new game's v1), `group_join` ("New family member" / "@p joined Group", to the other
  members).
  `GET /v1/me/notifications?cursor=&limit=` → `{items:[{id, kind, title, body, data, read,
  createdAt}], unread, next}`; `GET /v1/me/notifications/unread` → `{unread}`;
  `POST /v1/me/notifications/read {ids?, all?}` → `{unread}`.
- **Push:** `POST /v1/me/push-tokens {token, platform}` / `DELETE {token}` (`push_tokens`; a token
  belongs to its last registrant). After commit the API sends each new notification to the owner's
  Expo tokens (`src/push.ts`: `https://exp.host/--/api/v2/push/send`, ≤100/batch, 10 s timeout,
  fire-and-forget, errors swallowed) as `{to, title, body, data:{...data, kind, notificationId},
  sound:"default", badge: unread}`; tokens reported `DeviceNotRegistered` are deleted.

### 11.7 Safety
- `POST /v1/games/:id/report {reason}`; games with ≥3 distinct reports are hidden from feeds pending review (`hidden` flag).

### 11.8 Visibility (public by default, 2026-11-15)
- `games.visibility = "public" | "private"`, default `"public"`: "all games are public until you set it".
- **Public** ⇒ auto-publish: every committed version (worker checkpoint/complete, revert, a remix's copied
  v1) becomes the live one in the same transaction (`status = published`, `publishedVersion = v`,
  `publishedAt` set once, trending recomputed). Everyone plays the newest version.
- **Private** ⇒ never published; only the owner and groups it's shared with (§13) can play it.
- `PATCH /v1/games/:id {visibility}` (owner): `private` unpublishes; `public` publishes the latest version
  (an empty game just turns public and its first commit goes live). `POST /publish {version?}` = public +
  that version live (pin an older version; the next commit moves live to the newest again).
  `POST /unpublish` = private. `POST /v1/games {visibility?}` may create private up front.
- Owner views include `visibility`. `hidden` (moderation) stays separate: hidden games never show in feeds.
- Migration 0015: existing games `published` → public, everything else → private (nothing private gets
  exposed; old drafts are not auto-published).
- Clients: a Public/Private switch replaces Publish/Unpublish ("Public: everyone can play the newest
  version" / "Private: only you (and groups you share with)"); "Make vN live" pins an older version of a
  public game. Clients fall back to the old publish UI if the API omits `visibility`.

## 12. Genre kits + big-game pipeline (spec, 2026-11-15)

Target: every generated game offers **1–2 hours of play**. Opus designs and fills content; it does
not re-implement core systems per game.

### 12.1 Kits
- A kit is a tested, versioned Luau library shipped with the engine: `engine-web/kits/<kit>/`
  - `init.luau` (+ submodules) — the API, required by games as `require("@kit/<kit>")`
    (submodules `require("@kit/<kit>/battle")`). Read-only to games; sandboxed like game scripts.
  - `KIT.md` — the API reference the harness injects into Opus's prompt when the game uses the kit
    (systems, data formats, example snippets, extension points, do/don't).
  - `schemas/*.json` — JSON Schemas for the kit's content files (e.g. `data/creatures/*.json`); the
    harness validates content against them.
  - `example/` — a small complete game package using the kit (also a golden test).
  - tests — headless core simulation tests in `engine-web/test/kits/<kit>.test.ts`.
- Manifest: `kits = ["rpg"]` (array; validated against the shipped kit list).
  - `kit.json` (optional) — `{ "requires": ["core", "progression"] }`: dependencies are enabled automatically when a game
    lists the kit (engine `expandKits` / `kitDependencies()`; format `registerKitDependencies` for the validator).
- Kits are **data-driven**: content lives in the game package (`data/<kit-area>/*.json`, tilemaps,
  sprites); kits expose hooks/events for custom behaviour.
- v1 kits: `rpg` (overworld grid movement, NPCs/interaction/signs/doors/warps, dialog trees, quests,
  inventory, shops, party, turn-based battles with types/moves/status/XP, creature catching, saving),
  `platformer` (tight controller, enemies library, checkpoints, collectibles, world map/level select,
  bosses), `topdown` (Zelda-like action-adventure: combat, keys/doors, dungeons, items/abilities that
  gate areas, hearts), `tower-defense` (paths, waves, towers/upgrades, economy), `tycoon` (idle/
  incremental: generators, upgrades, prestige, offline progress).

### 12.2 Big-game pipeline (harness)
1. **Director** (Opus, high effort): writes the design bible in `notes.md` + structured
   `data/design/*.json` (world graph: regions/maps/connections/gates; progression & level curve; content
   lists — creatures, items, enemies, NPCs, quests — as specs; milestone plan of 10–20 rounds).
2. **Content builders** (parallel, Sonnet): the director calls `build_content {kind, items:[spec…]}`;
   the harness fans out to N workers, each with the bible + kit schema + its slice of specs, writing
   only its own ids/paths (sprites via draw_sprite, data files, maps); results are schema-validated
   and merged; failures are retried or reported back.
3. **Assembler** (Opus): wires content into scenes/maps, tunes, playtests, art-director review.
4. **Progression check** (static + simulated): world graph reachability with gates (every required
   area reachable in order; no softlocks), tilemap walkability between warps, kit-provided headless
   simulations (e.g. battle balance across the level curve). Failures go back to the director.
5. Rounds continue milestone by milestone (checkpoint per round) until the plan is done.

## 13. Leaderboards, ghosts, groups (spec, 2026-11-15)

Step 1 of competitive/social play. Real-time rooms (1v1 red/blue, up to 8 players) come after, on the §4.2 server.

### 13.1 Model
- **Board**: per game, named (default `"fastest"`), `order = "asc"` (lower is better: times) or `"desc"` (scores).
  A player's **best** per (game, board) is what ranks; every submit is a **run**. Runs keep the game `version`.
- **Scopes**: `public` (everyone), `group:<groupId>` (members of a family/friends group), `me` (my runs).
- **Ghost**: optional recording of a run: the tracked entity's position + flip + animation frame sampled at 10 Hz in
  *game time*, plus the scene id: `{ v: 1, hz: 10, scene, frames: [[x, y, flipX(0|1), frame], ...] }` (≤ 5 min ≈
  3000 frames; ≤ 256 KB JSON). Stored only for a player's best run per board (older ghosts dropped).
- Times are measured by the engine in game time (paused time and time-scale excluded); client-reported for now
  (server-authoritative later with rooms). API rejects absurd values (< 1 s or > 6 h for asc boards).

### 13.2 Luau API (`leaderboard`, client scripts)
```luau
leaderboard.start(board?: string, opts?: { track: Entity? })   -- begin a timed run; ghost tracks opts.track or the entity tagged "player"
leaderboard.finish(board?: string)                               -- stop timer, submit time (+ ghost); shows the results card
leaderboard.submit(board: string, value: number, opts?: { order: "asc"|"desc" })  -- explicit score/time submit (no ghost)
leaderboard.cancel(board?: string)                               -- abandon (death/restart) without submitting
leaderboard.elapsed(board?: string): number                      -- seconds of the running timer (for a HUD)
leaderboard.raceGhost(which: "best" | "pb" | runId)              -- spawn a translucent replay of that ghost in the current scene
leaderboard.result  -- Signal(rank: number, best: number, isPersonalBest: boolean) after a submit resolves
-- implemented extras: finish() returns the time; leaderboard.running(board?): boolean; raceGhost(which, board?);
-- submit order defaults to "desc"; cancel() with no board cancels every running timer. Board names ^[a-z0-9_]{1,40}$ (API).
-- result `best` = the board record (#1 value), as the API returns it.
-- Ghost `frame` = index into the tracked sprite's anim-set textures (deduplicated, file order); 0 without anims.
```
Engine-owned UI: a results card after `finish` (your time, rank, PB, top 5 public + your group, "Race the #1 ghost",
"Play again") and a **Leaderboard** entry in the platform pause menu. Host interface `LeaderboardHost` (like
`StoreHost`): `MemoryLeaderboardHost` for Node/playtests/dev, API-backed in the dev page / app WebView.

### 13.3 API
```
POST /v1/games/:id/runs                    {board, order?, version, value, ghost?} → {run, rank, best, personalBest}
GET  /v1/games/:id/leaderboards/:board     ?scope=public|me|group:<id>&limit=20 → {board, order, entries:[{rank, user, value, runId, hasGhost, version, at}], me?: {rank, value, runId}}
GET  /v1/runs/:runId/ghost                 → ghost JSON (public if the game is visible to the caller)
POST /v1/groups {name}                     → {group, inviteCode}        GET /v1/me/groups
POST /v1/groups/join {code}                → {group}                     GET /v1/groups/:id (members)
POST /v1/groups/:id/leave                  DELETE /v1/groups/:id (owner)
POST /v1/groups/:id/games {gameId}         share a game (even a draft) with the group; GET /v1/groups/:id/games
GET  /v1/games/:id/leaderboards            → {boards:[{board, order, players, best, updatedAt}]}   (boards with runs; dashboard picker)
POST /v1/groups/:id/invite-code            → {inviteCode}   (owner; rotates, old links stop working)
DELETE /v1/groups/:id/games/:gameId        unshare (sharer, game owner or group owner)
```
Implementation notes (services/api `routes/leaderboards.ts`, `routes/groups.ts`, migration `0009_leaderboards_groups`):
- Board names `^[a-z0-9_]{1,40}$`; the first submit fixes a board's order (a different `order` later → 409). Values:
  asc 1 s…6 h, desc |v| ≤ 1e12. `version` ≤ the game's latest. ≤ 30 submits/min/user (in-process) → 429.
- `rank` on submit: a PB → rank of the new best (ties: earlier best first); otherwise where this run would place
  among the other players' bests. `best` = the board's #1 value. Ghost blobs live at `ghosts/<runId>.json`; when a
  new PB lands the previous best's ghost is deleted. Ghost shape is validated (`v: 1`, `frames` of 4 numbers) → 400; > 256 KB → 413.
- `scope=me` lists my runs (best first; `rank` = position among them). `group:<id>` requires membership (404).
- Groups: invite codes are 8 chars from `A–Z 2–9` minus look-alikes, case-insensitive. Joining is idempotent; a full
  group → 409. The owner leaving hands the group to the longest-standing member; the last member out deletes it.
  Only your own game (drafts too) or a published game can be shared.
- Shared-draft visibility: `GET /v1/games/:id` (returns the owner-style view + `shared: true`), version / package /
  thumbnail / assets / plays / likes and leaderboards accept members of any group the game is shared with
  (`canAccessGame` / `canAccessVersion` in services.ts). Store purchases still need the published version.
Groups: ≤ 50 members, invite code is 8 chars (rotatable by owner). Group members can play games shared to the group
even when unpublished (draft visibility check extends to "shared with one of my groups").

#### Spin-off royalties (2026-11-15)
Four parties: platform (Dreamsy), creator, spin-off creator, player. A paid play of a **spin-off** (a remix) still costs 10,000:
platform 1,000 · the spin-off's creator 8,000 · the **direct parent's** owner 1,000 royalty (`royalty` ledger kind + "royalty"
notification). One level only: a spin-off of a spin-off pays the first spin-off's creator, not the grandparent. No royalty when the
parent is your own game (you keep 9,000). `SPINOFF_ROYALTY` (default 1000) is taken from the creator's 90% share.

### 13.4 Friends, invites, presence (2026-11-15)
Mutual friends (not follows), invites into a live room, and "what is my friend doing" from the room server. Spectating and
the engine/app sides (keypad, `room=`/`spectate=1` URL params, invite panel, Friends screen) are specced in the same
contract; this section is the API part.

```
POST   /v1/friends/requests {handle}            → 201 {request:{id(=other user id), user, status:"pending", direction:"outgoing"}}
                                                  | 200 {friend} when they had already asked you (auto-accept)
                                                  | 404 unknown handle | 409 already friends | 400 self
POST   /v1/friends/requests/:userId/accept      → {friend}          (404 no request from them, 409 already friends)
POST   /v1/friends/requests/:userId/decline     → {ok}              (404 no request from them)
DELETE /v1/friends/:userId                      → {ok}              unfriend, cancel my request, or drop theirs (404 none)
GET    /v1/me/friends                           → {friends:[{user:{id,handle,avatar}, since, presence}], incoming:[{user, at}], outgoing:[{user, at}]}
GET    /v1/users/search?q=<prefix>              → {users:[{id, handle, avatar, friendStatus:"none"|"friends"|"incoming"|"outgoing"}]}
POST   /v1/invites {userId, gameId, roomCode}   → {ok}              friends only (403), ≤ 10/min per sender (429)
```
`Presence = {status: "offline"|"online"|"in_room"|"in_match", gameId?, gameName?, roomCode?, mode?: "duel"|"party",
players?, max?, spectatable?}`. "online" = connected to the room server's lobby in the last 60 s.

- **Model**: `friendships(user_a, user_b, status "pending"|"accepted", requested_by, created_at, accepted_at)`, one row per
  pair with ids sorted (`user_a < user_b`, primary key), so a request and its reverse are the same row. Migration `0013_friends`.
  Requests insert first (`ON CONFLICT DO NOTHING`), then lock the row: a repeat request is idempotent (201, no new
  notification); a request to someone who already asked you accepts it.
- **Presence** comes from the room server: `GET $GAMESERVER_INTERNAL_URL/internal/presence?users=id1,id2` with
  `x-internal-token: $WORKER_TOKEN` → `{presence: {[userId]: Presence}}`; 1.5 s timeout; any failure or an unknown
  id → `offline`. Default URL `http://gameserver:8790` (set in deploy/docker-compose.yml). `Deps.presence` swaps the
  fetcher (tests). Friends are sorted in_room, in_match, online, offline, then by handle.
- **Search**: handle prefix, case-insensitive, leading `@` ignored, `%`/`_` matched literally, excludes the caller, ≤ 20,
  ordered by handle. Empty `q` → `[]`.
- **Notifications** (existing notify + Expo push, §11.6): `friend_request` ("Friend request" / "@x wants to be friends"),
  `friend_accept` ("New friend" / "@x accepted your friend request"), both with `data.fromUserId`; `game_invite`
  ("Game invite" / "@x invited you to play <game name>", `data {gameId, version?, roomCode, fromUserId, spectate: false,
  expiresAt}`; `expiresAt` = now + 10 min, ISO). `version` = the request's optional `version`, else the game's published
  version, else absent.
- **Invites**: the game must be visible to the inviter (own, published, or shared with one of their groups; 404 otherwise).
  `roomCode` is upper-cased, 4–12 letters/digits. The rate limit counts the sender's `game_invite` notifications in the
  last 60 s (DB, so it holds across API instances).


#### Onboarding + live (2026-11-15)
New accounts land in the onboarding game (Tidal Dash, `ONBOARDING_GAME_ID`) for a free first play; on the engine's `runEnd` host message (leaderboard finish/submit, Luau `platform.runEnded`, match end) the app/studio shows "Welcome to Dreamsy world" with `GET /v1/live` (people online + what they're playing, Join/Spectate) and featured games, then `POST /v1/me/onboarding`. The package format (§3) is unchanged; `platform.runEnded` is a runtime API addition (format/LUAU_API.md).

## 14. Engine v2 — native C++ 2D/2.5D engine with authoritative multiplayer (spec, 2026-11-17)

**Decision (2026-11-17):** Dreamsy is a **2D and 2.5D engine only**. 3D is dropped from scope (not "later").
The engine is rewritten in **C++** as one core that runs on the web (WebAssembly), iOS, Android and the game server.
Multiplayer moves from relay (§4.5) to **server-authoritative simulation with client prediction**. The TypeScript
engine (`engine-web/`) stays the product and the reference implementation until the C++ engine reaches parity (§14.8).

Why:
- **One simulation everywhere.** The server and every client run the same compiled core, which is what authoritative
  multiplayer, replays and async play (§4.2) need.
- **Size and startup.** `engine-web` ships a 5.9 MB JS bundle + 0.7 MB Luau WASM. Target for the C++ web build: ≤ 1.5 MB
  gzipped including Luau, measured in CI.
- **Native apps without a WebView** (§14.7), from the same code.
- **Determinism.** Box2D v3 is deterministic across platforms; Rapier's compat build is not guaranteed to be.

What does **not** change: the game package format (§3) and the Luau API (`format/LUAU_API.md`) are the contract.
Kits (`engine-web/kits`, ~41k lines of Luau) and generated games carry over unchanged. The harness keeps generating the
same packages.

### 14.1 Stack

| Need | Choice |
|---|---|
| Language | C++20, restricted style (§14.2) |
| Scripting | Luau (vendored `third_party/luau`), linked natively; WASM via Emscripten on the web |
| Physics | Box2D v3 (C17, cross-platform deterministic), replaces Rapier |
| Graphics / app / input | sokol (`sokol_gfx`, `sokol_app`): WebGL2 on the web (WebGPU later), Metal on iOS, GLES3 on Android |
| Audio | miniaudio (sfxr-style synth and chiptune music ported from `render/audio.ts`) |
| Images / fonts | stb_image, stb_truetype |
| Zip / data | miniz (zip), a small TOML reader for `dreamsy.toml`, a JSON parser (simdjson or yyjson) |
| Build | CMake + Ninja; Emscripten for web; Xcode / Android NDK via CMake toolchains |

All third-party code is vendored under `third_party/` (not modified, per CLAUDE.md).

### 14.2 Code style

Clean, readable C++ that a TypeScript/Python developer can learn from. Mostly structs and free functions.

- Errors are values: `Result<T>` / `Status` with a message. Engine code never uses `throw`/`try`. Exceptions stay
  enabled in the compiler only because Luau raises script errors by unwinding through host calls, and destructors must run
  when it does. `-fno-rtti` for engine code.
- No raw `new`/`delete`. Ownership via `std::unique_ptr` or by value; `std::vector`, `std::string`, `std::span`.
- Entities and other engine objects are referenced by **generational handles** (`EntityId { index, generation }`), never
  by pointer across frames. A stale handle fails a check instead of reading freed memory.
- Per-frame scratch memory from an arena that resets each tick.
- No deep templates, no inheritance trees, no operator tricks. Virtual calls only at platform boundaries.
- Naming: types `PascalCase`, functions and variables `snake_case`, files `snake_case.cpp/.h`, namespace `dreamsy`.
- `clang-format` + `clang-tidy` in CI.
- `docs/CPP-FOR-TS-DEVS.md` explains the patterns we use, mapped to TypeScript/Python.

### 14.3 Layout

```
engine/
  CMakeLists.txt
  src/
    base/       Result, handles, arenas, logging, deterministic math + RNG
    pkg/        package loading: zip/dir, manifest, scenes, tilesets, levels, anims, sfx/music, assets
    world/      entities, components, transforms, scene tree, tick loop
    physics/    Box2D v3 wrapper, collision layers, height (z) for 2.5D
    script/     Luau VMs, prelude, host API (the LUAU_API.md surface), CPU/memory budgets
    render/     sokol renderer: sprites, atlases, tilemaps, text, UI, particles, lighting, camera, 2.5D views
    audio/      miniaudio, sfx synth, music
    input/      keyboard, mouse, touch, gestures, on-screen controls
    net/        protocol, snapshots, prediction, reconciliation, interpolation
    platform/   web (Emscripten), iOS, Android, headless
  apps/
    player/     the game player (web/iOS/Android)
    server/     headless authoritative room simulation
    tool/       headless CLI: run a package, scripted playtests, state hashes, screenshots
  tests/        unit tests + the conformance runner (§14.8)
  fuzz/         fuzzers for package loading and the protocol
```

### 14.4 Simulation and determinism

- Fixed tick, 60 Hz. Rendering interpolates between ticks.
- Nothing in the simulation reads the wall clock or the OS RNG. Time comes from the tick counter; randomness from a
  seeded platform RNG (`base/rng`).
- Floats are allowed but constrained: no `-ffast-math`, `-ffp-contract=off`, and the simulation uses `base/math`
  (own `sin`/`cos`/`atan2`/`sqrt`-based helpers) instead of libm transcendentals, which differ across platforms.
  The Luau `math` library inside simulation VMs is overridden with the same functions.
- Box2D v3 with its cross-platform determinism settings.
- A **state hash** per tick (entities, components, physics, script-visible state) is available in debug builds and
  in the tool. Desync detection and the conformance suite use it.

This settles the §4.2 **OPEN** on deterministic physics: all of physics is deterministic.

### 14.5 2D and 2.5D

The world is 2D (`x`, `y`) plus an optional **height** `z`. Physics runs in the 2D plane (Box2D); `z` is handled by the
engine (gravity on `z`, jumping, falling off ledges, landing), in the style of classic beat-'em-ups and isometric games.
The camera is always orthographic.

View modes (manifest, per scene override):

| `view` | Projection | Depth order | Typical games |
|---|---|---|---|
| `side` | x right, y up | layer, then z-index | platformers, runners (today's 2D) |
| `topdown` | x right, y down | layer, then y | top-down RPGs, shooters, tycoon |
| `oblique` | top-down, z draws upward | layer, then y, then z | Zelda-like, beat-'em-ups |
| `iso` | 2:1 isometric diamond | layer, then x+y, then z | city builders, tactics, farming |

Features:
- Depth sorting by view mode; sprites can set an anchor (feet) and a sort offset.
- Height: per-entity `z` and `height`, drop shadows on the ground, collisions only between overlapping `z` ranges.
- Isometric tilemaps with per-tile elevation and stacked tiles.
- Parallax layers.
- Normal-mapped sprite lighting on top of today's Light2D (lights get a height).
- Later: sprite stacking (layered slices) and billboards.

Format changes (manifest `view`, entity `z`/`height`/`anchor`, iso tilesets, elevation grids) are specified in §3 in the
2.5D slice (E7). Until then §3 is unchanged.

### 14.6 Multiplayer v2 — server-authoritative

**Model:** the server simulates; clients send inputs, predict their own player, and interpolate everything else.
Built for co-op and party games up to 8 players (platformers, top-down, racing, arenas). The design leaves room for a
`rollback` mode later (fast 1v1 fighting/duels), which the determinism of §14.4 makes possible.

- **Two VM roles.** The server runs `scripts/server` + `scripts/shared`; each client runs `scripts/client` +
  `scripts/shared`. Single-player runs both roles in one process (as today) without a network.
- **Inputs.** Clients send numbered input frames (buttons, sticks, taps; ≤ 60/s, batched) to the server.
- **Snapshots.** The server sends snapshots of replicated state at 20–30 Hz: quantized, delta-compressed against the
  last acknowledged snapshot, binary.
- **Replication.** Entities in replicated scenes replicate their transform and physics state by default. Script
  properties replicate only when declared (Luau API, specified in `format/LUAU_API.md` in slice E8).
- **Ownership.** An entity can be owned by a player. The owner's client predicts it.
- **Prediction + reconciliation.** The owning client simulates its own entities immediately with local input. When a
  snapshot arrives, it rewinds to the server state and replays unacknowledged inputs. Non-owned entities interpolate
  ~100 ms behind.
- **Remote events** (`remoteEvent`) stay, now delivered through the server.
- **Interest management.** Later: clients receive only nearby entities.
- **Reconnect.** Same seat within 60 s; the server sends a full snapshot.
- **Relay compatibility.** v1 relay games (`room.replicate`, §4.5) keep working in the C++ engine as `net.model = "relay"`
  until they are rebuilt.

**Transport:** binary over WebSocket first (works everywhere). Native clients get UDP/WebTransport later.

**Topology:** the existing Node room server (`services/gameserver`) keeps lobbies, codes, quick match, presence and
spectators. When a match starts, it assigns the room to a simulation process (`engine/apps/server`), which loads the
package and runs the match. One simulation process hosts many rooms.

### 14.7 Targets

| Where | How |
|---|---|
| Web / phone browsers | `engine/apps/player` via Emscripten (WebGL2, WebGPU later) |
| Mobile app, step 1 | the WASM build inside the existing WebView (smaller and faster than today) |
| Mobile app, step 2 | native: an Expo native module that hosts the engine view (iOS Metal, Android GLES3); WebView retired |
| Game servers | `engine/apps/server`, Linux, headless |
| Harness playtests | `engine/apps/tool` headless for logic playtests; screenshots from the web build in headless Chromium until the tool renders offscreen |

App Store: games remain interpreted Luau + data in a sandbox (§6, guideline 4.7).

### 14.8 Migration and parity

- `engine-web` stays the shipping engine and the reference until parity.
- **Conformance suite:** the same packages and scripted playtests run in both engines. They are compared by script output,
  event logs and state at checkpoints. Pixel-exact rendering is not required; screenshots are reviewed by eye.
- **Parity** means: all `games/examples`, `games/showcase` and kit examples pass the conformance suite, and the
  engine-web test cases are ported to C++.
- After parity, `engine-web` is frozen, then removed when the harness, app and web all use the C++ engine.
- Physics behaves differently (Rapier → Box2D). Kits with physics balance sims are re-tuned where needed.

### 14.9 Safety

Packages and scripts are untrusted (AI- and user-generated).
- Luau sandbox (no filesystem, no network), per-script CPU and memory budgets, as today.
- Every size and count read from a package is bounds-checked; limits on textures, entities, audio length, zip size.
- Fuzzers for package loading and the network protocol run in CI.
- CI runs the tests under AddressSanitizer and UndefinedBehaviorSanitizer.
- The server never trusts client inputs beyond their declared shape and rate.

### 14.10 Slices

Each slice ends with tests passing and is built one at a time (CLAUDE.md).

| Slice | Delivers | Done when |
|---|---|---|
| E0 Scaffold | `engine/` CMake, vendored deps, test runner, CI with sanitizers, native + web "hello", `docs/CPP-FOR-TS-DEVS.md` | builds on macOS, Linux, web; CI green |
| E1 Packages | Dreamsy pack (§3.6) + dir loading, manifest, scenes, tilesets, levels, anims, sfx/music, asset index, full validator port (same issue codes as the TS validator); fuzzers | loads every package in `games/`; conformance with format/src/validate.ts |
| E2 Scripting | §14.13: native Luau, client/server VMs, prelude + host API core, require/kits, budgets, errors with traces, deterministic math, `dreamsy-tool check` (type checking against `dreamsy.d.luau`) | script-only examples run headless; every game type-checks |
| E3 World + physics (2.5D-native) | entities with `x, y, z` + `height` from day one, view modes in the data model, tick loop, Box2D v3 in the ground plane + engine-handled z (gravity, jumps, ledges), collision layers, state hash | coin-dash runs headless and passes conformance; a z-jump test scene behaves identically on every platform |
| E4 Renderer (2.5D-native) | sokol: batched sprites, atlases, tilemaps, text, UI, camera, particles, lighting; depth sorting per view mode (§14.5), drop shadows; web build | examples look right in a browser; side/topdown/oblique/iso test scenes sort correctly |
| E5 Input, audio, save, shell | touch/keys/gestures, on-screen controls, audio, save, platform menu, dialogs | feature-demo works on a phone browser |
| E6 Parity | full host API, all kits, conformance suite green; harness playtests and app WebView switch to the C++ build | §14.8 parity |
| E7 2.5D content | iso tilemaps with elevation and stacked tiles, normal-mapped lighting, parallax, §3 format fields, kit updates (topdown/rpg/farming get oblique/iso) | an iso and an oblique example game |
| E8 Netcode v2 | §14.6, `engine/apps/server`, gameserver integration, `LUAU_API.md` replication API | mp-duel and racing versus run authoritative |
| E9 Native mobile | Expo native module, iOS + Android builds | showcase games run natively on both |
| E10 Full engine | remaining §14.12 items not landed in E4–E9 | §14.12 quality bars met |
| Later | rollback mode, UDP/WebTransport, interest management, offscreen screenshots | |

Parity (E6) is the floor, not the goal. Each slice from E4 on includes the §14.12 features for its area.

2.5D is built into the world model (E3) and renderer (E4) from the start, not added later: every entity
has `z` and `height`, and depth sorting follows the scene's view mode. E7 adds the 2.5D content features.

**E4 decisions (2026-11-17):** the renderer consumes a plain draw list (`engine/src/render/draw_list.h`)
filled by the world; `z_index` is a sub-layer under §14.5's depth keys (layer, z_index, then y / x+y / z);
alpha and additive blending share batches via premultiplied alpha; pixel-art styles render into a
reference-size target with nearest upscaling; shaders are hand-written MSL + GLSL ES 3.0 until custom
materials need sokol-shdc; bundled fonts are Press Start 2P, Nunito, Inter, Source Serif 4 (OFL; Latin-1
subsets); WebP is deferred (clear error) because no package uses it and libwebp costs ~100 KB.

**E5 input + platform UI decisions (2026-11-17):** script-visible input follows engine-web exactly
(`engine/src/input/input_state.h`: pressed for the one tick after an edge, live held, pointer visible one tick
after release, swipes ≥ 40 px within 0.6 s with px/s velocity, everything hidden while a blocking dialog is
open, `recentlyRead` = 45 ticks). The platform UI is drawn by the engine into the draw list, not as HTML:
UI entities, toasts, dialogs, on-screen controls and the pause button/menu share one layout module
(`engine/src/ui/layout.h`) for drawing and hit testing. On-screen controls keep engine-web's sizes in CSS px
(points), converted to reference px per window, but sit inside the letterboxed game rect (engine-web places
them in the container). The renderer has no scissor yet, so scroll lists clip rects/images exactly and drop
text lines outside the clip. Characters outside the Latin-1 font subsets (▶, ▼) are replaced by » and a
drawn marker. Headless `tap_screen` keeps engine-web's `uiHit` rules (global z_index, no safe area); device
taps use the drawn stacking order.

### 14.11 Open questions

- **OPEN:** WebGPU from the start or after WebGL2 parity (default: after).
- **OPEN:** whether the harness moves screenshots to the native tool (offscreen rendering) or keeps headless Chromium.
- **OPEN:** remove the 3D entity types from the format at E7 (format version bump) or immediately.
- **OPEN:** whether the engine/format/kits are released as open source, and under which license (MIT or Apache-2.0).

### 14.12 Full engine scope (not a toy)

The target is a complete, production 2D/2.5D engine: everything a team would expect to ship a commercial 2D game,
built natively for 2D (no 3D scene graph underneath).

**Rendering**
- Batched sprite renderer: one draw call per atlas + material; textures packed into atlases at load (stb_rect_pack).
- Materials and custom shaders: GLSL written once, cross-compiled to Metal / GLES3 / WebGL2 / WGSL with `sokol-shdc`.
- Render layers, render targets, and a post-processing stack (bloom, color grading LUT, vignette, pixelate/CRT, distortion).
- Pixel-perfect mode (integer scaling, snapped camera) and smooth mode.
- 2D lighting: point/spot/ambient lights, normal maps, shadows cast by occluders.
- Crisp text at any size (MSDF fonts), 9-slice sprites, lines/shapes/debug draw.

**Animation**
- Frame animations, tweens and easing (as today).
- 2D skeletal animation: bones, skinned meshes, IK, in Dreamsy's own JSON format.
- Animation state machines with transitions and events.

**World**
- Scene tree, prefabs (instancing with overrides), tags/groups, scene transitions, entity pooling.
- Chunked tilemaps for large worlds; rule-based autotiling, animated tiles, collision generated from tiles; iso + elevation.
- Native pathfinding: A* on grids, flow fields for crowds, navmesh for non-grid levels.

**Physics** (Box2D v3)
- Bodies, shapes, joints, sensors, ray and shape casts, continuous collision.
- Character controller helpers: slopes, one-way platforms, moving platforms, coyote time.

**Audio**
- Mixer with buses (music, sfx, UI), ducking, 2D positional audio.
- Streaming music (Ogg Vorbis via stb_vorbis) plus today's synthesized sfx and chiptune music.

**Input and UI**
- Action mapping over keyboard, mouse, touch and gamepad; rebinding; gestures; on-screen controls.
- Retained UI with flex-style layout, theming, scrolling, focus navigation (gamepad/keyboard), safe areas.
- Text input with IME on web and mobile. UTF-8 everywhere, font fallback; complex-script shaping **OPEN** (HarfBuzz).

**Platform services**
- Versioned saves, localization string tables, app lifecycle (pause/resume), orientation, haptics, asset cache.

**Tooling** (dev builds only, compiled out of release)
- Hot reload of scripts and assets.
- Dev overlay (Dear ImGui): entity inspector, physics debug draw, profiler (per-system CPU, draw calls, memory), network
  graph, log console. Tracy profiler hooks.
- Input recording and deterministic replay; state-hash diffing between runs and engines.
- Asset packer at publish time (atlases, MSDF fonts, audio), cached by content hash.

**Quality bars** (measured in CI or on devices)
- 60 fps with 5,000 animated sprites + 200 physics bodies on an iPhone 12 and a mid-range Android, native and web.
- Web engine download ≤ 1.5 MB gzipped; first frame ≤ 1 s after download on a mid-range phone.
- Clean under AddressSanitizer + UndefinedBehaviorSanitizer; fuzzers run nightly.
- Identical state hashes on macOS, Linux, iOS, Android and web for the conformance suite.
- Every Luau-facing API documented in `format/LUAU_API.md`.

### 14.13 Scripting (E2)

The Luau API contract (`format/LUAU_API.md`) is unchanged: every kit and game runs as is. The host improves:

- **Native Luau.** Linked as C++, not WASM-in-JS: no JS↔WASM call cost per host call. Luau native code
  generation where the platform allows JIT-style code (desktop, Android, servers); the interpreter on iOS
  and the web.
- **Same prelude, native host.** The Luau prelude (engine-web/core/prelude.ts, plain Luau calling numbered host
  ops) runs unchanged; the ops are implemented in C++. Same op numbers and value tags, so behavior matches by
  construction and the two engines can be diffed op by op.
- **VMs.** Single-player (`server.mode = "none"`) keeps one VM for all scripts, as engine-web does: client and
  server scripts share module tables, and games rely on that. Server-authoritative multiplayer (§14.6) runs a
  server VM (`scripts/server` + `scripts/shared`) and a client VM (`scripts/client` + `scripts/shared`). Each
  script runs in its own sandbox thread.
- **OPEN: fast vectors.** Luau's native `vector` type would make vector math allocation-free, but it can't tell
  `Vec2` from `Vec3` (`tostring`, prop encoding and type checks depend on that). Decide after profiling E3.
- **Budgets.** Per-callback CPU deadline via the interrupt callback (a script stuck in a loop is killed with
  a clear error, and `pcall` can't swallow it); memory cap per VM.
- **Errors developers and models can act on.** `scripts/client/player.luau:12: attempt to index nil with
  'position'` plus a stack trace with script paths. Errors in callbacks are reported once with the callback's
  origin.
- **Deterministic math.** `math.sin/cos/tan/atan2/exp/log/pow` use the engine's deterministic
  implementations (§14.4); `math.random`/`random()` use the seeded platform RNG.
- **Type checking before play.** `dreamsy-tool check <package>` runs Luau's analyzer over every script against
  `engine/script/dreamsy.d.luau` (typed declarations of the whole API, kept in sync with `LUAU_API.md`) and
  reports `path:line: message`. The harness runs it before playtests, so wrong field names, missing
  arguments and nil mistakes are fixed before a game ever boots. Non-strict scripts get warnings; `--!strict`
  scripts get errors. (Built 2026-11-17: declarations in `format/dreamsy.d.luau`, Entity props generated from the
  catalog; Luau's old solver, since the new one crashes in Luau 0.747. Lenient by design: possibly-nil values,
  mixed list literals and untyped `{}` tables are warnings even in strict scripts, because they rarely fail at
  runtime. Every valid game in the repo checks with zero errors. `--strict` analyzes every script strictly.)
- **Per-script profiling.** CPU time per script and callback, shown in the dev overlay (§14.12).
- **Hot reload** (dev builds): a changed script re-runs without restarting the game.
