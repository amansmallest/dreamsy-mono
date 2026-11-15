# racing kit

Top-down arcade racing (portrait or landscape): tile tracks with a racing line, kinematic car physics (grip/drift,
brakes, nitro, boost pads, oil, ramps, off-road, wall bounces, car bumps), ordered checkpoints with shortcut detection,
lap/split/best timing, positions, AI racers with difficulty presets + bounded rubber-banding, items, race modes (race,
cup, time trial with ghost, elimination), garage (cars, unlocks, upgrades on `core.wallet`), HUD + mini-map + countdown +
podium, and headless balance sims. Requires `core`, `progression`, `juice`, `ai` (auto-enabled via kit.json).
Example: `games/examples/kit-racing` (Sprout Speedway: 1 cup × 3 tracks, 4 cars, time trial with ghost, garage).

## Setup
```toml
kits = ["racing"]          # core, progression, juice, ai come with it
orientation = "portrait"
```
```luau
local Racing = require("@kit/racing")
local C = Racing.content.load()          -- data/racing.json + data/tracks|cars|cups/*.json (engine data.read; id = file name)
-- race scene script: ONE call builds the whole race
Racing.view.race({
  track = C.tracks.pea_patch, tileset = "data/tilesets/garden.json",
  player = { sprite = "asset:car_red", stats = garage:stats() },
  rivals = { { id = "moss", name = "Moss", sprite = "asset:car_green", stats = Racing.car.stats(C.cars.snap_pea), preset = "normal" } },
  mode = "race", laps = 3, music = "race",
  buttons = { { "AGAIN", function() loadScene("scenes/race.scene.json") end } },   -- default podium; or onFinish(results, h)
})
```
Coordinates: world px, y down. Heading `a` radians, **0 = up, clockwise**; forward = (sin a, −cos a). Draw car art facing **up**
(sprite `rotation = deg(a)`). Default car sprite size 34×54 on 64 px tiles (road = 3 tiles wide).

## Tracks — `Racing.track.new(def)` (`data/tracks/<id>.json`, `schemas/track.schema.json`)
```json
{ "name": "Pea Patch Loop", "tileSize": 64, "width": 1.5, "tileset": "data/tilesets/garden.json", "laps": 3, "start": 3,
  "checkpoints": 5, "line": [[3,4],[8,3],[10,5],[10,11],[8,14],[10,18,380],[10,23],[8,25],[4,25],[2,22]],
  "hazards": [{"kind":"boost","at":0.3}, {"kind":"oil","at":0.52,"offset":0.8}, {"kind":"ramp","at":0.6}, {"kind":"item","at":0.75}],
  "medals": {"gold": 39, "silver": 43, "bronze": 48} }
```
- `line` = racing line waypoints in driving order, cells (`[col,row,speed?]`, `units:"px"` for pixels). Closed loop unless `loop:false`.
  Optional 3rd value = max speed hint (px/s) for the AI on that segment.
- `grid` absent ⇒ **rasterized** from the line: road `=` within `width` tiles, curb `c`, off-road `,` up to `wall` (width+3), hedge/wall `#`
  beyond and on the border, finish `F` across the start, hazards stamped (`>` boost, `o` oil, `^` ramp, `?` item). Rename chars with `chars`.
  Or hand-draw: `"grid": "file:data/levels/x.txt"` (same chars or your own + `tiles`/`tileset` giving `solid` and `tags`).
- Surface = tile tags: `offroad` (top speed ×0.5), `boost`, `oil` (spin), `ramp` (airborne 0.55 s), `item`, `finish`; `solid` = wall.
  The kit reads them from the tileset JSON (`data.read`), so the TileMap2D only draws (`collision = false`).
- `start` = segment index; the finish line is the middle of segment start→start+1 (or `startAt` 0..1). Put it on a long straight.
- `checkpoints`: N evenly spaced gates or a list of waypoint indices. Gate 1 = finish line. Gates are segments across the road
  (`width + 2.5` tiles half-width, `gateWidth` to override).
```luau
tr:pointAt(s) -> x, y, tx, ty, seg      tr:closest(x, y, hintSeg?) -> seg, s, lateral(+ right), tx, ty      tr.length  tr.gates  tr.startS0
tr:turn(s, ahead) -> max heading change (rad)    tr:speedAt(s)    tr:surface(x, y) -> tag set    tr:solidAt(x, y)    tr:tileAt(x, y)
tr:collide(x, y, r) -> nx, ny, depth | nil       tr:gridSlot(k) -> x, y, a (k-th start slot, 2 abreast)    tr:sample(n)    tr:bounds()
tr.gridText (TileMap2D data)    Racing.track.rasterize(def) -> grid text
```

## Car physics — `Racing.car`
```luau
local st = Racing.car.stats(carDef | {stats}, mods?)   -- DEFAULTS < def.stats < mods { {stat, add?, pct?} } (garage upgrades)
local c = Racing.car.new(st, x, y, a, { nitro = 0.5 })
local events = c:step(dt, { steer = -1..1, throttle = 0..1, brake = 0..1, nitro = bool }, track?)   -- "wall" v, "boost", "oil", "ramp", "land"
c:speed()  c:topSpeed()  c.x c.y c.a c.vx c.vy  c.nitro (0..1)  c.drifting  c.offroad  c.air  c.spin  c.usingNitro
Racing.car.collide(a, b) -> impact speed | nil         -- circle push-apart + impulse (mass)
```
Stats (defaults): `maxSpeed 520` px/s, `accel 420`, `brake 900`, `reverse 160`, `coast 140`, `turn 3.0` rad/s, `grip 10` (lateral slip
decay 1/s), `driftGrip 3.2` (|steer| ≥ `driftSteer 0.75` above `driftMin 260`), `radius 18`, `mass 1`, `offroadSpeed 0.5`, `offroadDrag 1.6`,
`nitro 2.0` s tank, `nitroAccel 520`, `nitroSpeed 0.28` (+28 % top), `nitroRegen 0.06`/s, `driftCharge 0.25`/s (drifting refills nitro),
`boostSpeed 0.35`, `boostTime 0.9`, `oilSpin 0.8`, `rampTime 0.55`, `restitution 0.35`.
Measured (tests): 0→90 % top in ≈ 1.55 s (accel 400, top 500); braking distance = v²/2·brake (125 px from 500); off-road top = 50 %.

## Race — `Racing.race.new(track, { laps?, mode = "race"|"time_trial"|"elimination", countdown = 3, bumps = true, items = {"nitro","oil"} })`
```luau
local r = race:add(id, car, { name?, player?, driver? })   -- racer: lap, lapTimes, best, splits, bestSplits, prog, place, finished, time, out, item, wrongWay, missed
local events = race:step(dt, { [id] = input })             -- racers with a driver steer themselves; events = { {name, data} }
race:order()  race:positionOf(id)  race:leader()  race:results() -> { {id, name, place, time, best, out, player, estimated, lapTimes} }
race:finishAll()      -- end now: estimates the others' times from their pace (call ~3 s after the player finishes)
race:dropOil(x, y)    race.t  race.phase ("countdown"|"racing")  race.done  race.oils
```
Events: `countdown` {n} · `go` · `checkpoint` {id, gate, split, delta (vs best lap)} · `missed` {id} (crossed the line with checkpoints
skipped: **lap not counted**) · `lap` {id, lap, time, best} · `finish` {id, place, time} · `eliminated` {id} · `wall` {id, v} · `bump` {a, b, v} ·
`boost`/`oil`/`ramp`/`land`/`item`/`item_used` {id} · `oil_dropped` · `done`.
Laps count only when every gate was crossed in order (forward). Ranking progress is clamped at the next unpassed gate, so cutting
across grass never gains places. Elimination: each time the leader completes a lap, last place is out.

## AI — `Racing.driver`
`Racing.driver.new("easy"|"normal"|"hard"|"expert" | { preset, skill, corner, jitter, nitro, mistakes, cornerFactor = 0.62, rubber = false | {min,max,range,strength}, seed })`
→ `drv:input(racer, race, dt)` (assign as `driver` in `race:add`). Follows the racing line with a speed-scaled lookahead (ai kit
`steer.seek`), slows by the heading change within braking distance (+ waypoint speed hints), wanders lanes / dodges the car ahead,
uses nitro on straights, makes rare lifts, reverses out when stuck.
Rubber band: `Racing.driver.rubber(gap)` = speed × in **[0.92, 1.08]** (default `RUBBER = {min, max, range = 700, strength = 0.08}`), gap =
racer progress − player progress. Presets: skill (top-speed ×) easy 0.84 · normal 0.91 · hard 0.97 · expert 1.0 (+ corner ×, jitter, mistakes).

## Ghost — `Racing.ghost`
`rec = Racing.ghost.recorder(0.1)` · `rec:add(tSinceLapStart, car)` · `g = rec:finish(lapTime)` (≈ 30 numbers/s, ~6 KB per 60 s lap) ·
`Racing.ghost.at(g, t) -> x, y, a | nil` · `Racing.ghost.best(trackId)` · `Racing.ghost.submit(trackId, g) -> newRecord` (save key `racing_ghost_<id>`).
`view.race` does this for you: `ghost = Racing.ghost.best(id), recordGhost = id` (best-lap ghost, replays each lap).

## Cup — `Racing.cup.new(def, entrantIds)` (`data/cups/<id>.json`)
`cup:track()` (current) · `cup:record(order | race:results()) -> {id = points}` · `cup:standings() -> { {id, points, wins, place} }` (ties: wins,
then last result) · `cup:placeOf(id)` · `cup:isDone()` · `cup.race` · `serialize()/deserialize()` (keep it in a `core.save.section`). Points default `{10,7,5,3,2,1}`.

## Garage — `Racing.garage.new({ cars = C.cars, upgrades = C.config.upgrades, currency = "coins", start = "starter" })`
Car def (`data/cars/<id>.json`): `{ name, sprite, price, unlock? (core condition), lockedText?, stats {…}, upgradeLevels?, upgradeCost? }`.
Upgrade track: `{ name, stat, pct | add, levels = 5, cost = { base, growth } }` (default engine/turbo/tires/nitro), cost = base·growth^level.
`g:list()` · `g:owns(id)` · `g:isUnlocked(id)` · `g:canBuy(id) -> ok, "owned"|"locked"|"cost"` · `g:buy(id)` (pays `core.wallet`) · `g:select(id)` ·
`g.selected` · `g:level(car, up)` · `g:upgradeCost(car, up)` (nil = max) · `g:upgrade(car, up) -> ok, reason` · `g:stats(car?)` (physics stats with
upgrades) · `g:rating(car?) -> {speed, accel, handling, nitro}` 0..1 · saved as core save section `"garage"`. Events `car_bought`, `car_upgraded`.

## View + HUD — `Racing.view.race(opts) -> h { race, track, player, hud, camera, results, newRecord, stop() }`
opts: `track`, `tileset`, `player {id?, name?, sprite, size?, stats}`, `rivals {…, preset?, color?}`, `mode`, `laps`, `countdown`, `difficulty`,
`rubber`, `ghost`, `recordGhost`, `autopilot` (player drives itself: attract mode/tests), `zoom`, `sfx` (map; defaults `beep go lap finish crash
bump boost oil nitro deny pickup jump`, missing ids are ignored), `music`, `oilSprite`, `decor(track, layer)`, `input()`, `onEvent(name, d, h)`,
`onFinish(results, h)`, `buttons`, `names`, `extra(row)`, `finishDelay = 3`, `hudTop = 140`.
Input: stick/arrows steer, **auto-throttle**, down = brake/reverse, A (`action`) = nitro, B (`action2`) = use item.
HUD (`Racing.hud.new(race, track)`): LAP n/N · POS 2nd/4 · time · best · split (green/red) · mini-map (left) · speed + nitro bar (bottom
centre, clear of the stick and buttons) · banners (countdown, LAP 2, FINAL LAP, MISSED, SPIN!, WRONG WAY). `h.hud:results(list, {title,
names, value(row), extra(row), note, buttons})` = podium + table (reuse it for cup standings). Camera leads the car (sees ahead).
Gameplay freezes on `core.pause` (menus) and `juice.hitstop`. Juice: shake on walls/bumps, sparks, zoom punch on boost, confetti on podium.

## Balance — `Racing.balance`
`Racing.balance.laps(track, stats, preset, {laps = 2, dt = 1/30})` → `{laps, best, finished, walls, offroad, missed}` ·
`Racing.balance.report(track, stats)` → reference bot + easy/normal/hard/expert with `ratio` = best lap / reference. Example tracks,
starter car (best lap s, ratio): Pea Patch ref 12.50 · easy 13.67 (1.09) · normal 12.77 (1.02) · hard 12.37 (0.99) · expert 12.00 (0.96);
Teapot 15.63 · 17.90 (1.15) · 16.53 (1.06) · 16.37 (1.05) · 15.17 (0.97); Greenhouse 18.53 · 20.80 (1.12) · 19.37 (1.05) · 18.33 (0.99) · 17.80 (0.96).
Every preset finishes every track with 0 walls / 0 missed checkpoints — run it whenever a track changes. Set medal times from the reference:
gold ≈ laps × ref × 1.03, silver × 1.13, bronze × 1.27 (a human on the starter car ≈ normal AI).

## How to build a 1–2 hour racing game
**Content counts:** 3–4 cups × 3–4 tracks (9–14 tracks; reuse a track reversed/with new hazards as a later cup's variant), 6–8 cars
(1 starter, 2–3 buyable early, 2 unlocked by cup wins / driver level, 1 "dream car"), 4 upgrade tracks × 5 levels, 3 difficulties (cups
get harder: normal → hard → expert, rivals +3 % per race), time trial on every track with 3 medals, optional elimination events.
**Pacing:** lap 15–35 s, 3 laps ⇒ 1–2 min races; a cup ≈ 6–10 min with menus. Prize per race (1st..4th ≈ 120/80/50/30) so one cup buys
one car or 3–4 upgrades; first car purchase after cup 1 (~10 min); each new cup's AI ≈ +5 % (ratio) so the player needs ~6 upgrade
levels between cups; medals pay out once (bronze 60 / silver 120 / gold 250) as a side income for replays. Total: cups 40–60 min +
time-trial golds + garage completion ⇒ 1–2 h.
**Track design (portrait):** long vertical straights (the camera sees 1280 px ahead/behind), 6–12 corners, one hairpin per track, 1–2
boost pads after slow corners, oil on the racing line's apex side, an item pair before the main straight, ramps only on straights.
Keep parallel road segments ≥ 6 tiles apart (else drivers see the other road); cutting across grass is legal but slow and never skips a gate.
**Feel:** auto-throttle, steer-only on phones; nitro button refilled by drifting; show split delta at each checkpoint; ghost for TT.

## Do / don't
- Do keep tracks/cars/cups in data; script only menus + the finish flow. Do run `Racing.balance.report` after editing a track.
- Do put the finish line on a straight (`start`), not at a corner; ≥ 4 checkpoints per lap.
- Don't give cars Body2D physics — the kit integrates positions itself (deterministic; works headless and on servers).
- Don't sell race wins, cars or random items for Stars; garage currency is in-game only.
