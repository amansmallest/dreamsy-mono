# platformer kit

Side-scrolling platformers (Mario/Celeste-style) built from ASCII tile levels + JSON content. The kit owns the
controller (accel/decel, variable jump, coyote time, jump buffer, wall slide/jump, dash, double jump, ladders),
level features (one-way/moving/falling platforms, springs, hazards, breakables, secret walls), enemies and
bosses from data, stomp + projectile combat, checkpoints/respawn, collectibles, goal, camera (look-ahead,
room locks), parallax, HUD, a world map with unlock rules, and save. A level scene needs ~3 lines of Luau.

Collision is the kit's own deterministic box-vs-tile code (not physics): **player/enemies are Node2D/Sprite2D,
never Body2D**; tile behaviour comes from **tileset tags** (read via `map:tileDef`).

Built on `core` (content registry, save section "platformer") and `juice` (shake, particles, sfx); both are
enabled automatically. Progress lives in the core save: `core.save.load()`/`save()` include it, and the kit
emits `level_completed` {level, time, coins, first, newBest} / `ability_unlocked` {ability} on `core.events`
for quests/achievements.

## Setup
```toml
kits = ["platformer"]          # core + juice come with it
orientation = "landscape"
```
Content is read from the package (`data/enemies/*.json`, `data/bosses/*.json`, `data/world.json`) on first use;
no setup call is needed.
```luau
-- scripts/shared/game.luau (module, shared by every scene)
local kit = require("@kit/platformer")
return kit

-- scripts/client/level.luau (attached to each level's TileMap2D)
local kit = require("../shared/game")
music.play("level")
local level = kit.level.start({ map = script.entity, art = ART, sounds = SOUNDS, anims = { idle = "idle", run = "run", jump = "jump", fall = "fall" } })
level.events:on("gem", function(i) print("gem", i) end)

-- scripts/client/map.luau (attached to the world map scene root)
kit.worldmap.start({ art = { node = "asset:node", node_done = "asset:node_done", node_locked = "asset:node_locked", cursor = "asset:hero" } })
```

### Level scene
- `TileMap2D` (tile 16, the level grid; optional extra aligned layers via `maps = {...}`), a `Camera2D` (zoom 3 →
  view 427×240 = 15 tile rows; levels are 15 rows tall), the player `Node2D` tagged `player` with a `Sprite2D`
  child (art faces **right**; `anims` set for `idle/run/jump/fall/climb/dash/wall/hurt`).
- Optional: `Area2D` tagged `camera_room` (camera clamps to its rect while the player is inside; boss arenas
  lock it until the boss dies), background sprites tagged `parallax_NN` (NN = % of world-lock: `parallax_0` =
  fixed to screen, `parallax_20` = far hills).

### Tileset tags (data/tilesets/*.json)
| tag | behaviour |
|---|---|
| `solid` | blocks every side (tag or tileset `"solid": true`) |
| `oneway` | jump up through, land on top, down+jump drops through |
| `ladder` | climb with up/down; its top is a one-way ledge |
| `hazard` / `spike` | damage `hazard_damage` (default instant death) |
| `spring` | (solid) launches to `spring_height` |
| `breakable` | solid; breaks when bonked from below or hit by a dash |
| `ice` | slippery floor |
| `fake` | looks solid, isn't — connected groups count as secret areas |
| `coin` | collect (counter, best saved per level) |
| `gem` | big secret collectible, saved individually (index = scan order) |
| `heart` | heal 1 |
| `powerup` + `<ability>` | unlock `double_jump`/`wall_jump`/`dash`/`shoot`/… permanently |

Marker tiles (replaced by entities at start; make them invisible: `{"tags": [...]}`): `player_start`,
`checkpoint`, `goal`, `enemy` + `<enemy id>`, `boss` + `<boss id>`, `platform` + `move_x`|`move_y`|`fall`
(+ `range_N` tiles, `speed_N` px/s, `solid`; horizontal runs = one platform).

## API
```luau
kit.setup({ enemies?, bosses?, world? }) -> kit   -- optional Luau tables (tests); override data/ files
kit.level.start(opts) -> Level          -- opts below; Level.current = last started
  level.events:on(name, fn)             -- coin(n) gem(i) heart secret(i) powerup(ability) checkpoint(cp)
                                        -- hurt(dmg, hp) death(cause) respawn gameOver stomp(en) enemyKilled(en, how)
                                        -- enemySpawned(en) bossStart(b) bossPhase(b, n) bossDefeated(b)
                                        -- spring break(c, r) complete(stats, {first, newBest})
  level:complete()  level:die(cause?)  level:hurt(n, fromX?)  level:heal(n?)  level:respawn()
  level:unlock(ability, quiet?)  level:addEnemy(id, x, yBottom)  level:addBoss(id, x, yBottom)
  level:shoot({x, y, vx, vy, w, h, damage, owner = "player"|"enemy", gravity?, life?, sprite?})
  level:hitBoss(b, n)  level:stats() -> {time, coins, coinsTotal, gems, gemsFound, gemsTotal, secrets, deaths}
  level.ctl (controller), level.body {x, y, w, h, vx, vy}, level.tiles, level.enemies, level.bosses, level.cam, level.hud
kit.worldmap.start({ art, sounds = {move, enter, locked}, node_size?, spacing?, row_gap?, origin?, on_enter?(level), input? })
kit.world.setData(t)  .levels()  .level(id)  .worlds()  .isUnlocked(id)  .lockReason(id)  .nextLevel(id)
          .levelForScene(path)  .mapScene()  .summary() -> {levels, complete, gems, gemsTotal}
kit.progress.get()  .save()  .reset()  .isComplete(id)  .best(id)  .gemsFound(id)  .totalGems()  .totalCoins()
             .completedCount()  .hasAbility(name)  .unlockAbility(name)  .completeLevel(id, stats)  .events
kit.enemies.define(name, fn(enemy, dt, tiles, ctx))   -- custom behaviour; ctx = {player, shoot, summon}
kit.controller.new(params, body) / ctl:step(dt, inp, tiles)   -- pure; for custom player setups/tests
kit.tiles.new(maps)  kit.camera.new(cam, bounds, opts)  kit.hud.new(opts, art)  kit.content.register(kind, map)
```
`level.start` opts (all optional): `map`/`maps`, `player`, `id` (default: world.json level whose scene is
this scene), `health` 3, `lives` nil (=infinite), `iframes` 1.2, `hazard_damage` 99, `respawn_delay` 0.9,
`complete_delay` 1.8, `player_size` {12,14}, `player_offset` {0,0}, `buttons` {jump="jump", dash="action",
shoot="action2"}, `shot` {speed, size, life, damage, cooldown}, `stomp_height` 28 / `stomp_height_held` 56,
`controller` {...}, `camera` {look_ahead 40, lerp_x 10, lerp_y 6, offset_y -12, deadzone_y 24},
`hud` (false = none) {font_size, show_time, show_coins, show_gems}, `art` {checkpoint, checkpoint_on, goal,
platform, shot, enemy_shot, heart, heart_empty}, `sounds` {jump, land, coin, gem, stomp, hurt, die,
checkpoint, powerup, shoot, dash, spring, break, clear, boss_hit, boss_defeat}, `anims`, `boss_completes` true,
`boss_wake` 220, `on_complete(stats, res)` (default: back to the world map), `on_death`, `on_game_over`,
`input(inp) -> inp` (cutscenes/replays), `ability_names` {ability = "banner text"}, `solid_chars`.

Controller params (`controller = {...}`): `run_speed` 140, `ground_accel` 1600, `ground_decel` 2000,
`turn_accel` 2800, `air_accel` 1100, `air_decel` 500, `jump_height` 56 px, `jump_time` 0.36 s (gravity is derived:
apex is exactly `jump_height`), `fall_gravity_mult` 1.6, `max_fall` 420, `jump_cut` 0.45, `coyote_time` 0.1,
`jump_buffer` 0.12, `air_jumps` 1, `double_jump_height` 40, `wall_slide_speed` 60, `wall_jump_x` 160,
`wall_jump_height` 48, `wall_jump_lock` 0.14, `dash_speed` 340, `dash_time` 0.14, `dash_cooldown` 0.3,
`dash_dirs` 8|2, `climb_speed` 80, `spring_height` 120, `abilities` {variable_jump, coyote, buffer, ladder: on;
wall_slide, wall_jump, dash, double_jump, shoot: off}. Saved abilities are re-applied on every level start.

## Content files (schemas/)
- `data/enemies/<id>.json` — `schemas/enemy.json`. `behaviour`: `patroller` (walks, turns at walls/ledges,
  `range`), `hopper` (`hop` {interval, height, speed, toward_player}), `flyer` (`fly` {pattern sine|hover|circle|swoop,
  amplitude, period, range}, no gravity), `shooter` (faces player, `shoot` {interval, speed, range, aim
  player|facing|fixed, angle, count, spread, size, gravity, sprite}), `chaser` (`chase` {range, speed_mult,
  jump_height}), `turret` (stationary shooter). Common: `sprite`, `size` (hitbox, bottom-aligned on its marker),
  `draw_size`, `faces`, `hp`, `speed`, `damage`, `stompable`, `shootable`, `contact`, `drops` coin|heart.
  ```json
  { "id": "beetle", "behaviour": "patroller", "sprite": "asset:beetle", "size": [14, 8], "speed": 32 }
  ```
- `data/bosses/<id>.json` — `schemas/boss.json`: `hp`, `size`, `iframes`, `needs_vulnerable`, `phases`:
  `[{ "until": 0.5, "speed_mult": 1, "steps": [...] }]` (phase lasts while hp/max > until). Steps loop:
  `wait {time}`, `face {toward}`, `walk {speed, time, toward player|home|left|right|turn}`, `charge {speed,
  windup}` (stops at walls, shakes), `jump {height, toward, distance}`, `move {to [dx,dy] | "player", speed}` (fly),
  `land`, `shoot {count, spread, speed, volleys, interval, aim, sprite}`, `summon {enemy, count}`,
  `vulnerable {time}`, `anim {name}`.
- `data/world.json` — `schemas/world.json`: `{ map_scene, worlds: [{ id, name, levels: [{ id, name, short, scene,
  map_pos, coins, gems, boss, secret, unlock }] }] }`. `unlock` (all must hold; default = previous level clear):
  `"open"`, `{after: [ids]}`, `{gems: n}`, `{coins: n}`, `{levels: n}`, `{ability: name}`, `{world: id}`.

## Extension points
- `level.events` (above), `kit.progress.events` (`levelComplete`, `ability`, `saved`); `core.events` facts.
- `kit.enemies.define("spinner", fn)`; any def field is readable in it (`enemy.def`).
- `opts.input` to script inputs; `opts.on_complete` / `on_death` / `on_game_over` to replace flow.
- `level.ctl:setAbility(name, on)` for temporary powers (e.g. a level-only dash).

## How to build a 1–2 hour game with this kit
- **Structure**: 5–7 worlds × 5–7 levels (+1 boss level per world) ≈ 35–45 levels; each level 150–300 cols
  × 15 rows, 1–2 checkpoints, 60–120 coins, 3 gems (one obvious, one off-path, one behind a `fake` wall or a
  later ability). A first-play clear is 1.5–3 min/level → 1–1.5 h; gem hunting and best times add the rest.
- **Pacing**: introduce one idea per level (show it safe → test it → combine it). Power-ups gate a world each
  (W2 double jump, W3 wall jump, W4 dash): place the orb at the start of that world's first level and
  design that world around it; earlier levels hide gems that need it (replay value). Unlock secret levels
  with `{ "gems": N }` and the final world with `{ "world": "w5" }`.
- **Difficulty curve**: W1 patrollers + wide platforms; W2 hoppers/flyers + gaps of 4–5 tiles; W3 shooters/
  turrets + moving platforms; W4 chasers + falling platforms + spikes; W5+ combos and precise wall/dash
  chains. Keep jumps under 3 tiles high (single), 5 wide; checkpoint before every hard section.
- **Bosses**: 6–12 hp, 2–3 phases, each phase adds one pattern; arena = `camera_room` Area2D, 2 platforms.
- **Content counts** for 1–2 h: 8–12 enemy types, 5–6 bosses, 3–4 abilities, 2 music tracks per world theme.

## Do / don't
- Do keep levels exactly 15 rows at zoom 3 (landscape) and leave row 14 solid or a pit.
- Do give every marker char a unique tileset entry; markers are cleared at start.
- Do put content ids in tile tags (`["enemy", "beetle"]`); the second tag is the id.
- Don't make the player a Body2D, don't set `follow` on the level camera (the kit drives it).
- Don't call `loadScene` from level code for completion — use `level:complete()` (saves progress first).
