# survival kit

Gather → craft → build → survive the night. A procgen island/world (biomes, resource nodes, POIs; always connected),
gathering with tool kinds + tiers, a data-driven crafting tree with stations, grid building (walls, doors, stations,
fires, storage, beds), hunger/thirst/health/temperature, day-night with night waves (ai chasers that break walls),
death/respawn rules, milestones, save. Pure `Sim` (headless-testable) + one-call runtime `S.play`. Thin layer over
core (inventory, events, conditions, menus, save), procgen (terrain, waves), ai (chase), combat (fighters), juice.
Example: `games/examples/kit-survival` (Ember Isle: 2 biomes + beach, 15 recipes, 7 structures, 3 night waves).

## Setup
```toml
kits = ["survival"]                 # core, progression, juice, combat, ai, procgen come with it
[physics]
layers = ["player", "enemy", "world"]
```
Scene: `map` TileMap2D (biome chars), optional `objects` TileMap2D above it (z 1; nodes/structures/POIs on a transparent
layer so tiles keep their ground), a `player` Body2D (dynamic, circle ~0.6 tile, gravity_scale 0, lock_rotation, tag
`player`) with a Sprite2D child, a Camera2D following the player (limit_max = world size). One tileset defines every char.
```luau
local core = require("@kit/core")
local S = require("@kit/survival")
core.setup({ bag = { slots = 24 }, save = { key = "my_isle", version = 1 } })   -- loads data/items
local C = S.content.load()            -- data/survival.json + data/nodes|recipes|structures|nights|pois|enemies
local s = S.new(C)                    -- generates the world from config.world.seed
S.bind(s)                             -- save section "survival" + condition/effect kinds
core.save.load()
local game = S.play(s, { objects = entity("objects"), glow = "asset:glow", stashSprite = "asset:stash",
  sfx = { hit = "hit", ["break"] = "break", craft = "craft", build = "build", hurt = "hurt", swing = "swing", pickup = "pickup", night = "night", dawn = "dawn" } })
```

## Content
`data/survival.json` (`schemas/config.json`) — all optional except biomes:
```json
{ "world": { "w": 40, "h": 40, "tile": 48, "seed": 7, "scale": 0.07, "island": 0.35, "clearRadius": 3 },
  "biomes": [ { "id": "sea", "char": "~", "maxE": 0.25, "walkable": false, "temp": 14 },
              { "id": "beach", "char": "s", "maxE": 0.3, "temp": 24, "nodes": { "spring": 0.02 } },
              { "id": "pinewood", "char": "f", "minM": 0.52, "temp": 15, "nodes": { "tree": 0.22, "iron": 0.05 } },
              { "id": "meadow", "char": "g", "temp": 21, "nodes": { "tree": 0.07, "rock": 0.05, "bush": 0.05 } } ],
  "day": { "length": 300, "night": 0.33, "start": 0.04, "nightTemp": -12 },
  "needs": { "hunger": { "decay": 2.5, "damage": 6 }, "thirst": { "decay": 3.5 }, "temperature": { "min": 10, "max": 32 } },
  "death": { "drop": "half", "keepTools": true, "respawn": "bed", "restore": { "health": 60 } },
  "player": { "speed": 190, "swing": 0.4, "damage": 1 }, "start": { "items": { "berries": 3 } }, "nightGrowth": 1.3,
  "milestones": [ { "id": "pick", "label": "Craft a Crude Pick", "item": "crude_pick" }, { "id": "fire", "structure": "campfire" }, { "id": "n3", "night": 3 } ] }
```
Biomes: ordered, first match on elevation e / moisture m ∈ [0,1] wins (procgen.terrain); `nodes` = chance per cell. Need rates are **per minute**;
defaults hunger 100 −2/min (−6 hp/min at 0), thirst −3/min (−8), health regen +6/min while both ≥ 50, temperature follows
the environment (biome temp + nightTemp at night + best fire warmth in radius); outside [min,max] → −5 hp/min.
- `data/nodes/<id>.json` (`node.json`): `{ "tile": "T", "hp": 4, "tool": "axe", "tier": 0, "drops": [{"item":"wood","count":[2,3]}], "respawn": 180, "solid": true }`
  — hits = ceil(hp / tool power); `tier` 0 = bare hands OK (power 1); tier ≥ 1 needs a `tool` of that kind with tier ≥.
- `data/items/<id>.json` (core item): genre fields in `data`: `tool {kind, tier, power}`, `weapon {damage}`, `food {hunger, thirst, health, temperature}`,
  `place: "<structure id>"` (a placeable kit item).
- `data/recipes/<id>.json` (`recipe.json`): `{ "needs": {"wood":3,"rope":1}, "gives"?: id (default file id), "count"?: 1, "station"?: "workbench", "category"?, "unlock"?: condition }`.
  Station = a structure id; the player must stand within its `radius` (min 1).
- `data/structures/<id>.json` (`structure.json`): `{ "tile": "W", "kind": "wall|door|station|fire|storage|bed|light|floor|decor", "hp": 24, "solid"?, "radius"?, "warmth"?, "slots"?, "limit"?, "adjacent"?: "wall", "biomes"? }`
  Doors: player passes, enemies don't. `fire`/`station` with `warmth` heat cells in `radius`. `bed` = respawn point.
- `data/nights/<id>.json` (`night.json`): `{ "night": 1, "budget": 3, "enemies": ["shade"], "boss"?: "brute", "spawnEvery": 3, "minDist": 7 }`
  — procgen.waves.encounter over `data/enemies` costs; nights past the last file scale budget by `nightGrowth`^n.
- `data/enemies/<id>.json` (ai `enemy.json`): `{ "sprite", "hp", "cost", "minLevel"?, "behavior": "chase", "params": {"speed": 75}, "contact": {"amount": 8}, "size": 0.7 (tiles), "breakDamage"?: 4, "drops"?: [...] }`
- `data/pois/<id>.json` (`poi.json`): `{ "tile": "X", "foundTile": "x", "biomes": ["meadow"], "count": 2, "minDist": 8, "loot": [{"item":"ore","count":2}], "effects"?, "message"? }`

## Sim API (`S.new(C, opts?)` → s; opts `{ seed?, bag? (core inventory, default core.bag), rand?, quiet? (no core events) }`)
```luau
-- clock
s:tick(dt)   s.time   s:dayNumber()   s:timeOfDay() (0 = dawn)   s:isNight()   s:phase() "day"|"dusk"|"night"|"dawn"
s:darkness() 0..1   s:clockText() "Day 2  18:40"   s:secondsUntilNight()   s.night (nights started)   s.stats.nightsSurvived
-- world (cells 0-based; s.world = { w, h, grid, start, nodes, pois, report })
s:biomeAt(x,y)  s:nodeAt(x,y)  s:structureAt(x,y)  s:poiAt(x,y)  s:passable(x,y, forEnemies?)  s:tileChar(x,y, layer?)  s:tileString(layer?)
s:setPlayer(x,y)  s.player {x,y}  s:distance(x,y) (chebyshev)
-- needs
s.needs { health, hunger, thirst, temperature }   s:consume(item) -> ok, why   s:hurt(n, cause?) -> died   s:temperatureAt(x,y)   s:warmthAt(x,y)
-- gathering
s:bestTool(kind) -> itemId?, tool   s:canGather(x,y) -> ok, "none"|"tool"|"tier", node, power   s:hit(x,y) -> {ok, reason, damage, broken, drops}
s:gather(x,y) (all hits; .hits)   s:hitsFor(nodeId)
-- crafting
s:canCraft(rid) -> ok, "unknown"|"locked"|"station"|"items"|"space", missing {{item, need, have}}   s:craft(rid)   s:stationNear(sid, x?, y?)
s:recipeList(category?) -> {{id, def, state, missing, depth}}
-- building
s:canPlace(sid, x, y, {free?, reach?}) -> ok, "bounds"|"terrain"|"biome"|"occupied"|"player"|"limit"|"adjacent"|"item"|"reach"
s:place(sid, x, y, opts?) -> structure | nil, why    s:removeStructure(x, y, refund? = true)   s:damageStructure(x, y, n) -> destroyed
s:storage(x, y) -> core inventory (storage kind)   s:count(sid)   s:base() -> {x,y} (bed > fire > station > player)   s:placerItem(sid)
-- nights, death, POIs, milestones
s:nightDef(n)  s:nightWave(n) -> {night, ids, spawns = {{id, x, y, delay}}}
s:die(cause) -> stash, respawnCell   s:collectStash(x,y)   s.stashes
s:discover(x,y) -> loot | nil   s:nextMilestone() -> def | nil   s:milestoneDone(m)
-- save
s:serialize() / s:deserialize(t)   (S.bind registers it as core save section "survival"; world regenerates from seed, diffs are saved)
-- hooks (set by S.play; set your own when not using it)
s.onTile(x,y)  s.onNight(n, wave)  s.onDawn(n)  s.onDeath(cause, stash, cell)
```
Core events: `gathered {item,count,node}` `node_depleted` `node_respawned` `crafted {recipe,item}` `built {structure,x,y}`
`structure_destroyed` `consumed` `need_low {need}` `night_started {night, wave}` `dawn {night}` `player_died {cause}` `stash_recovered`
`poi_found {poi}` `milestone_reached {milestone}` + `enemy_defeated {enemy}` from the runtime — quests/achievements can count them.
Conditions (after `S.bind`): `{"built":"campfire"}` `{"nights":3}` `{"day":2}` `{"found":"ruins"}`; effects `{"feed":{"hunger":20}}` `{"heal":10}`.

## Runtime — `S.play(s, opts) -> game`
opts: `map` (default `entity("map")`), `objects` (2nd TileMap2D, recommended), `player`, `hotbar` (5), `glow` (soft round
image drawn above the night overlay at fires), `stashSprite`, `sfx` (ids above; missing ids are ignored), `autosave` (30 s; also at dawn),
`objectives` (true: "Goal: …" line from milestones), `doneText`, `onAction(name, data)` (`gather` `craft` `build` `kill` `night` `dawn`),
`enemyLayer`/`enemyMask`, `toasts`.
Controls: stick moves; **action** = use (attack enemy in reach → gather/search/open station in the faced cell → any adjacent);
**action2** = craft menu; tap a tile next to you = use it. HUD: needs bars + clock (top), goal line, hotbar row (y ≈ 970) with a
Craft button; tapping a placeable enters build mode (green/red ghost on the faced cell; tap a tile within 2 cells or press action).
Night: world-space darkness + fire glow; wave enemies spawn on a ring 7–13 cells from `s:base()` (ai chase, combat contact damage →
`s:hurt`), chew walls/doors they touch (`breakDamage`/s), fade at dawn. Death → stash marker, respawn at bed.
`game` = `{ s, hero, grid, enemies, spawnEnemy(id, x, y), openCraft(), use(), refreshHud(), refreshBar(), hud, objective, craftButton }`.

## Analysis + balance (headless)
```luau
local a = S.recipes.analyze(C)   -- { ok, problems, obtainable[item]=depth, recipeDepth, order, maxDepth, tools }
S.recipes.raw(C, "iron_pick")    -- { ore = 6, wood = 7, fiber = 6 } (expanded down to gathered resources)
S.world.generate(C, seed).report -- procgen.validate: { ok, problems, nodes, pois, nodeCounts }: every free cell, node and POI reachable
local r = S.balance.run(C, { seed?, maxTime = 7200, pathFactor = 1.4 })  -- greedy bot through config.milestones
-- r = { ok, milestones = {{id, t}}, missing, deaths, nights, log }   S.balance.fmt(seconds)
```
The bot is optimal (knows the map, never fights): **a first-time player takes ~3–4× its crafting times**. Nights are wall-clock.

## How to build a 1–2 h survival game
- World 48–64² cells (tile 48), 3–4 walkable biomes with distinct temps + 1 unwalkable; 6–10 node kinds (2–3 per biome; one rare
  ore per tier, gated by tool tier), 3–5 POI kinds (8–15 total) that hand out next-tier materials early.
- 35–60 recipes over 5–7 depth layers: tools (3 tiers × pick/axe/weapon), materials (rope, bars, planks), 10–15 structures,
  4–6 foods (raw → cooked at campfire). Every station recipe + the ore it needs must be reachable (`analyze().ok`).
- Day 360–480 s, night 30–35 %. 8–12 hand-made nights (1–2 enemy kinds per night, a boss every 3–4), then `nightGrowth` 1.2–1.35.
- Milestones = the design's spine (10–16): first tool, workbench, first fire before night 1, walls, bed, each tool tier, each new biome
  POI, boss nights. Pace: bot milestone gaps 1–4 min (= 4–12 min for players), last tier by bot ~25–35 min, final night ≈ 90 min.
- Assert in tests: `analyze(C).ok`, `world.generate(C, seed).report.ok` for many seeds, `balance.run(C).ok` and gap/total bounds.

## Do / don't
- Do give every char used by biomes/nodes/structures/POIs a tileset entry; solid tiles for walls, nodes, stations; doors non-solid.
- Do keep tile SVGs transparent and use the `objects` layer so ground shows through.
- Do keep `tier: 0` on the first wood/food nodes (bare hands) or the tree is unwinnable — `analyze` reports it.
- Don't put night threats in `data/enemies` without `cost` (budget) — waves use procgen costs.
- Don't call `s:tick` yourself when using `S.play` (it ticks; respects `core.pause` and juice hitstop).
