# topdown kit

Zelda-like action-adventures (original IP only) built from layered ASCII tile maps + JSON content. The kit owns
the hero (8-direction movement with corner sliding, sword, items, knockback, i-frames, hearts in half-heart
steps), enemies and bosses from data, items/abilities that gate areas (bombs break cracked walls, hookshot
crosses pits, boots pass rough ground, any item can `pass`/`break` tile tags), small keys + locked doors and a
boss key, plates/blocks/switches/gates/shutters, rooms with a room-locked camera + slide transitions, warps
(overworld ↔ dungeons), NPC dialog/shops (engine `ui.dialog`/`ui.choice`), chests, pickups, a minimap and save.
An area scene needs ~3 lines of Luau.

Built on the foundation kits (enabled automatically): **core** (content registry, `core.bag` owned items,
`core.wallet` "rupees", `core.flags` story flags, `core.save` section "topdown", `core.dialog` trees), **ai**
(`"behaviour": "ai"` enemies), **juice** (shake, particles, sfx). Quests/achievements can count the kit's facts:
`core.emit` `enemy_defeated` {enemy, area}, `boss_defeated` {boss, area}, `talked` {npc} (+ core's `item_gained`,
`currency_changed`, `flag_changed`).

Collision is the kit's own deterministic box-vs-tile code (no physics): the hero/enemies are Node2D/Sprite2D;
tile behaviour comes from **tileset tags**. Positions are the hero's *feet box* (10×10); the sprite sits above.

## Setup
```toml
kits = ["topdown"]
orientation = "portrait"
```
```luau
-- scripts/shared/game.luau
local kit = require("@kit/topdown").setup()   -- reads data/items|enemies|bosses|npcs/*.json + data/warps.json
return kit                                    -- (tests may pass tables: setup({ items = {...}, ... }))

-- scripts/client/area.luau (attached to the objects TileMap2D of every area scene)
local kit = require("../shared/game")
local area = kit.area.start({ id = "overworld", room = { 15, 13 }, art = ART, sounds = SOUNDS, anims = { down = "down", up = "up", side = "side" } })
area.events:on("bossDefeated", function(b) kit.progress.setFlag("dungeon1_done") end)
```

### Area scene
- Two `TileMap2D`s tagged `area_map` (same size/position, tile 16, `collision = false`): **floor** first (grass,
  floor, `plate`) and **objects** (walls, doors, markers). Opening a door clears the objects cell and reveals
  the floor. A `Camera2D` (zoom 3 → 240×427 view on portrait; a 15×13-tile room fills the width; the kit masks
  everything outside the room with `room_mask` color and puts the HUD above it).
- Hero `Node2D` tagged `player` with a `Sprite2D` child (`anims` with `down`, `up`, `side` walk cycles; side art
  faces right; optional `idle_*`, `attack_*`).
- `room = {w, h}` splits the map into rooms (camera locks to a room; crossing an edge slides to the next one;
  enemies spawn per room, respawn on re-entry). Omit it for one free-scrolling area.

### Tileset tags
| tag | behaviour |
|---|---|
| `solid` `wall` | block |
| `water` `gap` | block walking; flying enemies, hookshot cross them |
| `cracked` | blocks; bombs (`breaks`) destroy the whole connected wall (saved) |
| `locked` | small key door (keys are per `dungeon`); bump to open, connected cells open together (saved) |
| `boss_locked` | boss key door |
| `rough` (any tag) | blocks unless an owned item `passes` it (boots) |
| `bush` | blocks; the sword cuts it (random drops) |
| `hook` `hookable` | hookshot targets (post in a wall; the cell in front must be floor) |
| `block` | pushable (push 0.3 s; stays in its room) |
| `plate` (floor layer) | pressed by a block or the hero; all plates in a room pressed → its `gate`s open |
| `switch` | hit with sword/arrow → room gates open for good (saved) |
| `gate` | closed bars; open via plates/switches, or when the room's enemies are dead if it has neither |
| `shutter` | open until you enter a room with enemies; closes during the fight |
| `sign` + `<npc id>` | readable tile |
| `rupee` `heart` `key` `boss_key` `heart_container` `item` + `<item id>` | pickups (keys/containers/items saved) |
| `hazard` | hurts and returns the hero to the room entry point |
| `warp` + `<warp id>` | load `data/warps.json[id]` (must step off the arrival warp first) |

Markers (replaced at start): `player_start`, `entry` + `<id>` (+ `face_up|down|left|right`), `enemy` + `<id>`,
`boss` + `<id>` (not respawned once beaten), `npc` + `<id>`, `chest` + `<item id>`.

## API
```luau
kit.setup(content?) -> kit                   -- kinds not given are read from data/
kit.content.get(kind, id) .has .all(kind) .register(kind, id, def | {[id]=def}) .load(kind)   -- on core.content
kit.area.start(opts) -> Area                 -- Area.current = last started
  area.events:on(name, fn)    -- roomEnter(room, first) roomLeave(from, to) roomCleared(room) puzzleSolved(room)
                              -- switch(c, r) blockPushed(c, r) doorOpened(tag, c, r) broke(tag, c, r) explode(x, y)
                              -- item(id, def) used(id) useItem(id, def) [custom items] chest(item) talk(npcId)
                              -- bought(item, price) hurt(n, hp) death enemyKilled(en) bossStart(b) bossPhase(b, n)
                              -- bossDefeated(b) hooked(c, r) hookLanded warp(id, w) enemy_<shoot|slam|...>(en)
  area:give(itemId, quiet?)  area:useItem()  area:cycleItem()  area:interact()  area:talk(npc)
  area:openChest(ch)  area:openShop(npc)  area:hurtHero(n, fromX?, fromY?)  area:die()  area:warp(id)
  area:teleport(x, y, facing?)  area:roomCell(rx, ry, c, r) -> x, y  area:addEnemy(id, x, y)  area:addBoss(id, x, y)
  area:dropPickup(item, x, y)  area:damageEnemy(en, n)  area:damageBoss(b, n)  area:breakTiles(x, y, r, tags)
  area:shoot({x, y, vx, vy, w, h, damage, owner, life, sprite, breaks?})
  area.hero (hp, maxHp, facing, iframes, o.sword), area.body, area.grid, area.room, area.enemies, area.bosses, area.hud
kit.progress.get() (section table) .save() .reset() (core.newGame) .has(item) .items() .giveItem(id) .ammo(id) .addAmmo(id, n, max?) .rupees() .addRupees(n)
             .keys(dungeon) .addKey(dungeon) .useKey(dungeon) .hasBossKey(d) .giveBossKey(d) .flag(name) .setFlag(name, on?)
             .isDone(key) .markDone(key) .visited(area) .bossDefeated(id) .defeatBoss(id) .events
kit.enemies.define(name, fn(enemy, dt, grid, ctx))   -- ctx = {player, shoot, summon, random, event}
kit.player.new(opts, x, y) / hero:step(dt, inp, grid)  kit.grid.new(maps)  kit.hud.new(opts, art)
```
`area.start` opts: `id` (save scope, default scene path), `dungeon` (key scope, default id), `maps`,
`player_entity`, `room` {15,13}, `transition_time` 0.4, `hearts` 3 (fresh save), `start_items` {},
`sword_item` "sword" (false = sword from the start), `respawn_delay` 1.2, `push_time` 0.3, `boss_drop`
"heart_container", `drop_table` {{item, chance}}, `buttons` {attack="action", item="action2"}, `player`
{speed 80, size {10,10}, iframes 1, knockback 170, corner_nudge 5, sword {damage 2, time 0.22, reach 14}},
`player_offset` {0,-4}, `art` {heart, heart_half, heart_empty, chest, chest_open, bomb, hook, rupee,
heart_pickup, slash, arrow}, `sounds` {sword, hit, hurt, die, enemy_die, pickup, rupee, key, door, chest,
item, bomb, explode, secret, push, warp, shop, error, boss_hit, boss_defeat, hook, select, cut}, `anims`,
`hud` (false = none), `room_mask` color|false, `on_death(area)` (default: reload at this area's entry, full
hearts), `on_warp(id, w)`, `input(inp) -> inp`.

Save: one core save (`core.save`, default key "core"), loaded on first progress access; items live in `core.bag`,
rupees in `core.wallet` ("rupees"), flags in `core.flags`, everything else in section "topdown" (`kit.progress.get()`).
Configure the key/version with `core.save.configure` before the first area starts.

Controls: ATTACK talks/opens when something is in front, else swings (once you own the sword); ITEM uses the
equipped item; tap the HUD item slot to cycle items.

## Content files (schemas/)
- `data/items/<id>.json` (`item.json`): `kind` sword | bow | bomb | hookshot | boots | passive | wand | custom |
  key | boss_key | heart_container | heart | rupee | ammo; `name`, `sprite`, `message` (first-pickup tip),
  `damage`, `speed`, `range`, `ammo`/`max`, `fuse`, `radius`, `breaks` [tags], `passes` [tags], `speed_mult`,
  `amount`, `ammo_for`, `equip`.
  ```json
  { "id": "bombs", "kind": "bomb", "ammo": 8, "max": 15, "breaks": ["cracked"], "sprite": "asset:bomb" }
  { "id": "boots", "kind": "boots", "passes": ["rough"], "speed_mult": 1.3, "equip": false }
  ```
- `data/enemies/<id>.json` (`enemy.json`): `behaviour` wanderer | chaser (`aggro`) | charger (`charge`
  {speed, windup, stun}; charges when lined up) | archer (`shoot` {interval, speed, range, keep, aligned}) |
  spawner (`spawn` {enemy, interval, max}) | ai (`ai` = any @kit/ai spec: patrol, turret, keep_distance, fsm, utility,
  boss phases…; steered by the ai brain, moved by the kit's grid; `shoot` params shape its shots); `hp`, `damage` (half hearts), `speed`, `size`, `flying`, `drops`.
- `data/bosses/<id>.json` (`boss.json`): `hp`, `phases` [{until, speed_mult, steps}] with steps `wait`,
  `move {to [dx,dy]|player|random}`, `teleport`, `chase {time}`, `charge {speed, windup}`,
  `shoot {pattern ring|aimed|spread, count, spread, volleys, interval}`, `summon {enemy, count}`, `vulnerable`.
- `data/npcs/<id>.json` (`npc.json`): `name`, `sprite`, `dialog` [lines] | "<core dialog tree id>",
  `dialog_if` [{flag|not_flag|item|if (any core condition), lines}],
  `gives` item (once), `sets_flag`, `shop` [{item, price, once}].
- `data/warps.json` (`warps.json`): `{ "<warp id>": { "scene": "scenes/dungeon1.scene.json", "entry": "<entry id>" } }`.

## How to build a 1–2 hour game with this kit
- **Structure**: an overworld of 4×4–6×6 rooms (15×13) with a village (NPCs, shop, signs), 3–4 dungeons of
  9–16 rooms each, 1 boss each. One new item per dungeon that opens the next part of the world
  (bombs → cracked cave walls; hookshot → river pits; boots → rough marsh; bow → far switches).
- **Dungeon recipe** (12 rooms, ~15 min): entrance → hub with shutters → 2–3 small keys behind combat rooms,
  a block/plate puzzle and a bombable wall → the dungeon item in a mid-dungeon chest, immediately required to
  reach the boss key → boss door → boss (2–3 phases) → heart container + warp out.
- **Pacing**: teach each item in a safe room (pit with a post and nothing else), then combine with enemies.
  Put 1 heart container per dungeon + 2–4 hidden in the overworld (behind items from later dungeons:
  backtracking adds 20–30 min). Shops sell ammo/hearts so rupees matter.
- **Difficulty curve**: dungeon 1 wanderers/chasers, 2 + archers/chargers, 3 + spawners and mixed rooms;
  enemy hp 2–6, damage 1–2 half hearts; bosses 12–24 hp, hero starts at 3 hearts and ends at 6–8.
- **Content counts** for 1–2 h: 40–80 rooms, 8–12 enemy types, 3–4 bosses, 4–6 key items, 10–15 NPCs,
  3 music tracks (village, overworld, dungeon) + boss.

## Do / don't
- Do keep dungeon doors on the room grid (shared edges, 2-thick walls; put door tiles in both rooms' walls).
- Do leave the cell in front of each `hook` post walkable, and put arrival entries ≥ 2 tiles from their warp.
- Do give each `entry` a facing tag; use flags (`kit.progress.setFlag`) for story state.
- Don't make the hero/enemies Body2D or set `follow` on the camera (the kit drives it).
- Don't gate the critical path behind shop items or randomness.
