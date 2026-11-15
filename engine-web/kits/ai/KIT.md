# ai kit

Foundation kit for enemies/NPCs: a data-driven behaviour library (`data/enemies/*.json` → `"behavior": "chase"` + params),
FSM / utility / boss-phase brains, steering, grid A* (over TileMap2D solids, procgen grids or text) and graph A*,
line of sight, aggro radius + leash. Brains are pure (testable headless); `ai.attach` drives an entity.
Example: `games/examples/kit-roguelike-demo`.

## Setup
```luau
local ai = require("@kit/ai")
local grid = ai.grid(entity("map"), { solid = "#+" })   -- which tile chars block (TileMap default: the tileset's `solid` flag, map:isSolid)
local ctl = ai.attach(body, enemyData, { grid = grid, target = player })
```

## API
```luau
ai.attach(entity, spec, opts?) -> controller { brain, home, update(dt), stop() }
  opts: target = Entity | fn()->Entity|{x,y} (default first entity tagged "player"), grid = PathGrid | TileMap2D (+ solid),
        mode = "topdown" | "platformer" | "flyer", onAction = fn(name, data, entity, ctl) -> Entity? (return the spawned entity for "spawn"),
        canAct = fn()->bool (e.g. not fighter:busy()), speedMult = fn()->number, hp = fn()->(hp, maxHp) (boss phases, hp conditions),
        rand = fn()->[0,1), sight = false (ignore LOS), flip = false (don't flip the sprite), tick = false (call ctl.update yourself)
  Body2D: sets velocity (top-down: dynamic + gravity_scale 0; platformer: only x, gravity keeps y). Others: moves position (grid-collides).
ai.brain(spec) -> brain with brain:update(ctx) -> vx, vy?        -- vy nil = leave vertical velocity (platformers)
ai.step(brain, agent{x,y,vx,vy,home?,hp?,maxHp?,radius?}, world{target, grid, mode, gravity, rand, children}, dt) -> actions
                                                                    -- pure sim (tests, server, non-physics agents)
ai.grid(source, { solid, tileSize = 16, origin = {x,y}, diagonal = false }) -> PathGrid   -- source: TileMap2D | procgen Grid | "text"
grid:find(cx, cy, gx, gy, { diagonal?, maxNodes = 4000, nearest = false, cost = fn(x,y) }) -> { {x,y} cells } | nil
grid:findWorld(wx, wy, tx, ty, opts) -> { {x,y} world points }   grid:los(x0,y0,x1,y1) (world)   grid:losCells(...)
grid:solid(cx, cy)   grid:solidAt(wx, wy)   grid:toCell(wx, wy)   grid:toWorld(cx, cy)   grid:block(cx, cy, on?)  (doors/towers)
ai.graphPath(nodes, from, to) -> ids, cost    -- nodes = { id = { x?, y?, links = {"b","c"} | { b = cost } } } (world maps, level select)
ai.steer.seek/flee/arrive/pursue(px,py, tx,ty, speed, ...) -> vx, vy    ai.steer.separation(px,py, neighbours, radius)   ai.steer.avoid(grid, px,py, vx,vy)
ai.alive(entity) -> bool
```

## Behaviours (spec = `{ behavior = "...", ...params }` or `{ behavior, params = {...} }`)
| behavior | params (defaults) | actions emitted |
|---|---|---|
| `idle` | — | |
| `wander` | speed 40, radius 64 (around home), pause {0.5,1.5} | |
| `patrol` | points {{x,y}…} (+relative), speed 50, wait 0.5, loop true (false = ping-pong). No points: distance 64 back-and-forth, turns at walls / ledges (`ledges` true) — platformer walkers | |
| `chase` | speed 70, aggro 140, leash 320, forget 2 s, stopAt 0, idle "idle"\|"wander"\|"patrol" (+its params). LOS-gated; A* around walls | aggro, lost, leash |
| `flee` | speed 70, range 120 | |
| `keep_distance` | speed 50, min 80, max 150, aggro 220, fireEvery 1.5, firstShot 0.8 (strafes in band) | shoot {x,y,dx,dy,target} |
| `charge` | range 150, windup 0.6, speed 240, duration 0.45, cooldown 1.2, walk 30 | telegraph {dx,dy}, charge |
| `jump_at` | range 140, jump 330, speed 110, cooldown 1 (platformer hopper) | jump {dir} |
| `swoop` | hover 70, speed 60, swoopSpeed 210, every 2.2, range 200, bob 6 (flyer dive-bomb) | swoop {x,y} |
| `turret` | range 200, fireEvery 1, burst 1, spread 0°, firstShot 0.5 (never moves; LOS) | shoot |
| `spawner` | every 3, max 3 (alive children), spawn "bat", range? | spawn {kind,x,y} |
| `boss` | phases (below) | phase {index}, + step actions |

Composition:
```json
{ "fsm": { "start": "guard", "states": { "guard": { "behavior": "patrol", "points": [[0,0],[64,0]], "relative": true },
                                       "hunt": { "behavior": "chase", "speed": 80 }, "run": { "behavior": "flee" } },
  "transitions": [ { "from": "guard", "to": "hunt", "when": "see" }, { "from": "*", "to": "run", "when": "hp<0.3" },
                   { "from": "hunt", "to": "guard", "when": "lost" } ] }, "aggro": 150 }
{ "utility": [ { "behavior": "chase", "score": "target_near" }, { "behavior": "flee", "score": "hp_low", "weight": 2 } ] }
{ "behavior": "boss", "phases": [
  { "hp": 1.0, "pattern": [ { "behavior": "chase", "time": 2.5, "speed": 28 }, { "action": "ring", "count": 8, "wait": 0.8 } ] },
  { "hp": 0.5, "pattern": [ { "action": "summon", "kind": "bat", "wait": 0.6 }, { "behavior": "charge", "time": 2 }, { "action": "slam", "wait": 0.8 } ] } ] }
```
Conditions: `see`, `lost`, `near:<px>`, `far:<px>`, `hp<f`, `hp>f`, `after:<s>`, `always`, or a Luau fn(ctx, brain).
Utility scores: number | `hp_low` | `target_near` | `target_far` | `sees` | `always` | fn(ctx); re-evaluated every 0.25 s.
Boss: active phase = lowest `hp` threshold ≥ current fraction; steps run in order and loop (`loop: false` holds the last);
`{behavior, time}` runs a behaviour, `{action, wait, ...}` emits `action` with the step's fields + x, y, target.

## Content files
`data/enemies/<id>.json` (`schemas/enemy.json`): behaviour + combat stats + procgen budget in one file:
`{ "id": "archer", "sprite": "asset:skeleton", "hp": 4, "cost": 2, "minLevel": 2, "behavior": "keep_distance",
   "params": { "min": 48, "max": 90, "fireEvery": 1.8 }, "projectile": { "speed": 150, "status": {"name": "slow"} }, "loot": "common" }`
Your onAction handler turns actions into effects (combat.shoot, spawn, camera.shake).

## Do / don't
- Do pass `canAct`/`speedMult` from the combat fighter so stuns, slows and knockback work.
- Do rebuild `ai.grid(map)` after replacing `map.data` (size changes); `grid:block` for runtime blockers.
- Use circle-shaped bodies narrower than a tile for path following in 1-tile corridors.
- A* cost: `maxNodes` caps work (≈1 ms / 1000 nodes); chasers re-plan every 0.4 s only when the target is out of sight.
- Don't set velocity on an attached entity yourself unless `canAct` returns false for those ticks.
