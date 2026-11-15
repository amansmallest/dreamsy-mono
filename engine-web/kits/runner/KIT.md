# runner kit

Two portrait modes in one kit: **endless lane runner** (auto-forward, swipe left/right/up/down + tap, speed ramp by
distance, seeded segment sequencing by difficulty tier and biome, coins/gems, magnet/shield/2x, missions, daily challenge,
unlockable runners, best distance) and **obby** (hand-authored + procgen climbing stages: moving/vanishing/conveyor/bounce
platforms, spinners, spikes, checkpoints, timer, best-run ghost). Sims are pure and deterministic (testable headless);
views draw them. Thin layer over core (content, wallet, save, effects, events), progression (difficulty tiers, character
tree, stat mods) and procgen (rng). Requires (auto): core, progression, juice, procgen. Example: `games/examples/kit-runner`.

## Setup
```luau
local core = require("@kit/core")
local R = require("@kit/runner")
core.setup({ save = { key = "mygame", version = 1 } })     -- once per session (shared module init guard)
R.setup({ load = true })   -- data/{segments,missions,characters,stages}/*.json + data/runner.json; validates every segment; loads the save
```

## Endless
```luau
local sim = R.newRun({ seed?, daily? })   -- selected character's params; daily = today's seed + modifier
local view = R.view.endless(sim, { root = entity("track"), sprites = { player, shadow, block, low, high, coin, gem, magnet, shield, double, bubble },
  decor = { "asset:tree" } (mutable list, side props), horizon = 300, playerY = 1000, laneWidth = 200, depth = 9 (perspective), sizes? })
local ctl = R.controls.new({ swipe = 60, tap = "jump"|false, keys = true, pointer = true })
onTick(function(dt)
  local events = sim:step(dt, ctl:poll())   -- "left"|"right"|"jump"|"slide"|nil
  view.update()
  if not sim.alive then local sum = R.finish(sim) end   -- banks coins, best, missions (final), daily, saves
end)
```
State: `sim.dist speed tier lane x air slide alive coins score time power = {magnet, shield, double} objects stats lives`,
`sim:height()` (0..1 jump arc), `sim:cell()`, `sim:summary() -> {distance, coins, score, time, jumps, slides, lanes, powerups, gems, tier}`.
Step events: `jump slide lane{dir} coin{value,kind} powerup{kind} powerupEnd shieldBreak hit dead` → sfx/juice.
Rules: blocks (B) need a lane change; low bars (J) need to be airborne; high bars (S) need a slide (slide cancels a jump —
fast fall). A shield absorbs one hit. Magnet pulls coins in all lanes within `magnetRange` m. 2x doubles coin value.
`player.lives` > 1 gives extra hits (1 s grace).
Controls: swipe left/right = lanes, swipe up or tap = jump, swipe down = slide; keyboard/gamepad: move_x edges, up/jump,
down/action. `ctl:feed(x, y|nil)` injects pointer samples (tests).

### Segments (`data/segments/<id>.json`)
```json
{ "tier": 2, "weight": 1, "biomes": ["canyon"], "rows": ["BJ.", "...", ".SB", "C.."] }
```
One char per lane (`config.lanes`, default 3), first row nearest, `rowLength` m apart (4), `gapRows` empty rows between
segments (2). Chars: `.` · `B` block · `J` low bar · `S` high bar · `C` coin · `G` gem (10) · `M` magnet · `H` shield · `X` 2x.
`R.track.validate(seg)` (run by setup → script error): every row passable and, from every start lane, a path changing ≤ 1 lane
per row exists. Sequencing (`R.track.sequencer({seed, tier?})`): eligible tiers `tier − tierSpread .. tier` at the current
distance (difficulty from `config.speed`), weighted ×3 for the exact tier, current biome only (`biomes` absent = any), never
the last 2 if avoidable (never the same twice in a row if any alternative). `tags: ["start"]` = only at distance 0.

### Speed / difficulty / biomes (`data/runner.json`)
```json
{ "speed": [ { "at": 0, "params": { "speed": 10, "tier": 0 } }, { "at": 300, "params": { "speed": 12.5, "tier": 1 } }, "…" ],
  "biomes": [ { "id": "meadow", "name": "Meadow Lane", "length": 500, "bg": "asset:bg_meadow", "decor": ["asset:tree"], "music": "run" } ],
  "player": { "jumpTime": 0.62, "slideTime": 0.6, "laneTime": 0.12, "magnetTime": 8, "shieldTime": 12, "doubleTime": 10, "magnetRange": 10, "lives": 1, "coinValue": 1 },
  "dailyModifiers": [ { "id": "rush", "name": "Rush hour", "params": { "speedMult": 1.25 } }, { "params": { "coinMult": 2 } }, { "params": { "noPowerups": true } } ],
  "daily": { "base": 600, "spread": 400, "reward": [ { "earn": "coins", "amount": 150 } ] }, "missionSlots": 3,
  "procStages": [ { "id": "gen_a", "name": "Breezy", "seed": 101, "difficulty": 3, "platforms": 14, "order": 4 } ] }
```
Speed tiers are progression difficulty tiers (numbers lerp by distance). Biomes cycle by `length`; `R.track.biomeAt(dist)`.

## Meta (coins = core wallet `config.currency`; save section "runner")
```luau
R.missions() -> { {id, text, progress, target, done} }   R.progress(sim:summary(), false) -> newly reached (live toasts)
R.daily(now?) -> { day, seed, modifier, target, done, best }       R.best()   R.coins()
R.characters() -> { {id, def, owned, selected, cost} }   R.buyCharacter(id) -> ok, why   R.selectCharacter(id)   R.params()
```
Missions (`data/missions/*.json`): `{ "text", "stat": distance|coins|jumps|slides|lanes|powerups|gems|runs|score, "target",
"scope": "run"|"total", "reward": [core effects], "order" }` — `missionSlots` active at once in `order`; completed ones are
rewarded at `R.finish` and replaced. Characters (`data/characters/*.json`): a progression tree "characters":
`{ "name", "cost": { "coins": 400 } (0 = free), "mods": [ {stat: player param, add|pct|mul} ], "tint", "sprite" }`.
Events: `run_started run_finished mission_completed daily_completed stage_completed`; flag `runner_best`.

## Obby
```luau
local o = R.obbyRun(stageId)                      -- R.obby.new(stage, { ghost = best ghost })
local view = R.view.obby(o, { root = entity("course"), sprites = { solid, move, vanish, conveyor, bounce, spike, checkpoint, goal, spinner, hub, player, ghost }, tintAll = true, colors? })
cam.follow = view.player                          -- Camera2D in the scene; set limit_max = (stage.width, stage.height + 300)
onTick(function(dt)
  local jp, jh = R.controls.jump()
  for _, e in o:step(dt, R.controls.axis(), jp, jh) do   -- jump bounce land crumble vanish appear death{why} respawn checkpoint{index} finish{time,deaths}
    if e.name == "finish" then R.finishStage(stageId, o) end    -- best time + ghost (saved)
  end
  view.update()
end)
R.stages() (authored by `order`, then procStages)  R.stage(id)  R.stageRecord(id) -> {best, deaths}  R.stageUnlocked(i)
```
Stage (`data/stages/<id>.json`, stage px, y down, climbs upward; (x, y) = top-left):
`{ "name", "order", "width": 720, "height", "spawn": {x, y (feet)}, "par", "parts": [ … ] }` with parts
`solid` · `move {dx, dy, period, phase}` (eased ping-pong, carries the player) · `vanish {on, off, step = true}` (stood on → blinks
`on` s → gone `off` s; `step = false` = timed cycle with `phase`) · `conveyor {speed}` · `bounce {power}` · `spinner {r, speed °/s,
arms, angle}` (x, y = hub; arms kill) · `spike` (kills) · `checkpoint` (trigger area; numbered bottom→top) · `goal`.
Platforms are one-way (jump through from below, land on top). Physics in `config.obby` (gravity 2600, jump 1000 → ~190 px
apex, run 330, coyote 0.1 s, jump buffer 0.12 s, variable jump height, respawn 0.5 s at the last checkpoint).
Procgen: `R.obby.generate({ seed, difficulty = 1..10, platforms = 14, checkpointEvery = 5 })` — every rise/gap inside the jump
envelope (`R.obby.check(stage)`), difficulty mixes movers, vanishers, conveyors, spinners (2 arms ≥ 7), spikes, bounce pads.
Ghost: sampled every `ghostEvery` ticks, 4 px grid, 4 chars/sample (~2.4 KB/min); `o:ghostAt(t)`; best per stage only.

## Bots + balance
```luau
R.endless.botAction(sim, botState, { reaction = 0.25, miss = 0.02, rng }) -> action    -- lane planning + timed jump/slide
R.obby.botInput(o, botState) -> ax, jumpPressed, jumpHeld                             -- greedy climber (demo/attract only)
local job = R.balanceJob({ runs = 16, maxDist = 3000, skill? })   -- per difficulty tier (fixed speed): {distances, mean, p10, p50, p90}
onTick(function() if job:step(5000) then print(job.result["3"].p50) end end)          -- spread over ticks (250 ms budget)
```
Example (Pebble Dash, 16 bots/tier, 2 % miss per obstacle): tier 0–1 ≥ 2.6 km mean (capped 3 km), tier 2 1.2 km, tier 3 0.95 km,
tier 4 0.56 km, tier 5 0.49 km.

## How to build a 1–2 h runner with this kit
- **Endless content**: 3 biomes × ~500 m; 18–30 segments spread over tiers 0–5 (≥ 4 per tier so sequencing varies; 1–2
  biome-specific per biome); power-up segments at low weight (0.5). Target bot p50 ≈ 600–1000 m at tier 3: a skilled run of
  1.5–3 km takes 2–4 min.
- **Meta loop for 1–2 h**: 10–15 missions (3 active) paying 40–250 coins; 4–6 runners costing 400–3000 coins with perks;
  daily challenge (+150) → ~25–40 runs to unlock everything.
- **Obby**: 6–10 stages, first 2–3 hand-authored tutorials (one mechanic each), then procStages with difficulty 3 → 9;
  15–40 s par each; checkpoint every 4–6 platforms; the ghost turns each stage into a time trial (replay value).
- Juice: `juice.stretch` on jump, `say(biome.name)` on biome change, sfx per step event, confetti on new best.

## Do / don't
- Do keep everything tunable in data (speed tiers, player params, segments) and check `R.track.validate` failures at setup.
- Do draw with `R.view.*` or your own renderer from sim state — never move obstacles with physics.
- Do call `R.progress(sim:summary(), false)` every ~0.5 s for live mission toasts and `R.finish(sim)` once at the end.
- Don't put two blocks in adjacent rows that force a 2-lane move at high tiers (humans need ≥ 2 empty rows between).
- Don't store ghosts for many stages beyond the 64 KB save cap (best ghost per stage only; ~60 s of play = 2.4 KB).
