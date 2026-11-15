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
7. **Web engine, one language.** The engine is TypeScript (three.js + Rapier + Luau→WASM): the same
   code runs in the browser, in the app, on the game server (Node) and in harness playtests.
8. **2D first, 3D later.** Scope is Roblox-level at most. v1 ships 2D only; the format keeps 3D types.

## 2. Monorepo layout

```
dreamsy/
  DREAMSY.MD            this file
  engine-web/           the engine: core (no DOM, runs in Node) + three.js renderer + input + Luau WASM
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

A game is a directory (zipped for transport), content-addressed and versioned.

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
- **Protocol** (`engine-web/net/protocol.ts`, JSON over one WebSocket): client `hello · create · join · quick · cancel ·
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

**Slice 2 — multiplayer:** Linux headless server, Rooms + replication, DataStore.

**Slice 3 — persistence & async:** Timers, Async + deterministic sim, a CoC-style example game.

**Then:** web client, avatar + skins, marketplace + Ledger, moderation hardening.

## 10. Open questions

- Deterministic physics scope (§4.2)
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
- `POST /v1/games/:id/remix` → creates a new **draft** game owned by the caller whose version 1 is a
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
