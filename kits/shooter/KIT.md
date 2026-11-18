# shooter kit

Vertical shmups, bullet-hell bosses and twin-stick arenas, portrait-first. Content is data (`data/shooter.json`,
`data/{ships,weapons,emitters,enemies,stages}/*.json`); the kit runs a stage in the current scene: ship + virtual stick +
auto-fire, weapons/upgrades, scripted enemy waves, data-driven bullet emitters, ai-driven bosses with hp phases, pickups,
score/chain/multiplier/graze, lives/bombs/continues, stage results, a between-stage shop, ship unlocks and saving.
Thin layer: HP/i-frames/collisions/projectiles = **combat**, boss phases + arena AI = **ai**, arena waves + seeded rng =
**procgen**, feel = **juice**, wallet/save/menus = **core**. Example: `games/examples/kit-shooter` (Starling Drift).

## Setup
```toml
kits = ["shooter"]          # pulls core, progression, juice, combat, ai, procgen
orientation = "portrait"
```
```luau
-- scripts/shared/game.luau (session state; modules survive loadScene)
local S = require("@kit/shooter")
local C = S.setup({ core = { save = { key = "mygame", version = 1 }, theme = { primary = "#5b4bd6", accent = "#ffd34d", font = "bold" } } })
G.run = S.newRun({ ship = "starling" })                         -- lives, bombs, weapon, score, credits for one playthrough
loadScene("scenes/play.scene.json", { stage = G.run:nextStage() })
-- scripts/client/play.luau (attached to the play scene root)
S.play(G.run, sceneParams().stage, {
  onClear = function(res) S.ui.results(res, function() S.ui.shop(G.run, function() loadScene("scenes/play.scene.json", { stage = G.run:nextStage() }) end) end) end,
  onGameOver = function(res) S.ui.results(res, function() loadScene("scenes/title.scene.json") end, { nextLabel = "Title" }) end })
```
`S.setup` loads content once (cached), calls `core.setup` (currency = `config.currency`, default "credits"), registers the
save section "shooter" and loads the save. One play scene is enough: `S.play` builds background, ship, HUD, everything.

## Runtime API
```luau
S.setup(opts?) -> C                  -- opts.core = core.setup options; opts.content = raw table (tests); autoload = true
S.newRun({ ship?, lives?, bombs?, continues?, seed? = 1, content? }) -> run
  run.lives run.bombs run.continues run.score (Score) run.weapon (Weapon) run.weaponId run.sub (option weapon | nil)
  run.stageIndex run.results {res…} run:nextStage() -> id|nil (config.campaign order) run:setWeapon(id, keepLevel? = true)
S.play(run, stageId, { onClear(res), onGameOver(res), autoFire? (config.autoFire), hud = true, seed?, invincible?,
                       bounds? {x0,y0,x1,y1} (shmup ship area, default 40,150..680,990: above the thumb zone), noContinue? }) -> ctl
  res = { stage, cleared, score, stageScore, kills, bestCombo, grazes, credits, time, deaths, noMiss }
  ctl:bomb() -> bool  ctl:clearBullets(toScore?)  ctl:spawnEnemy(id, x, y, path?)  ctl:spawnPickup(kind, x, y)  ctl:finish(cleared)
  ctl.player ctl.fighter (combat Fighter) ctl.enemies { {e, f, def, t} } ctl.boss {e, f, def, b} ctl.runner (stage) ctl.t ctl.over ctl.hud
S.current() -> ctl | nil
S.buy(run, itemId) -> ok, reason   S.canBuy(run, id) -> ok, "max"|"credits"|"owned"|"unknown"   S.shopItems(run) -> { {id, def, ok, reason, bought} }
S.shipState(C, id) -> "owned"|"buyable"|"locked"   S.unlockShip(C, id) -> bool   S.meta() -> { ships, best = {stage = score}, highScore, cleared }
S.ui.results(res, onNext, { nextLabel? })   S.ui.shop(run, onDone, { title?, doneLabel? })   S.ui.ships(C, onPick(id))   -- core.menus modals
S.events:on(name, fn)   -- kill {enemy, score} · death {lives} · continue · bomb {left} · pickup {kind} · extend {lives} · boss_phase {boss, phase}
                        -- boss_defeated {boss} · stage_clear res · game_over res · bought {item}
```
Controls: `input.axis("move_x/move_y")` → on-screen stick; auto-fire (config `autoFire = false` → hold `action`); `action2` = bomb
(shows the B button). Arena aim: `look_x/look_y` if non-zero, else auto-aim nearest enemy within `autoAimRange` (650), else movement.
Player hitbox is tiny (`hitbox` 6–8 px, white core dot in shmup mode); i-frames after a hit (`iframes`, 2 s) + blink; death drops one
power level as a pickup, clears bullets; lives 0 → continue prompt (`continues`) → `onGameOver`. Grazing (bullet within
`grazeRadius` 26) scores. Bombs clear bullets (to score), hit all enemies (`bombDamage` 30, boss `bombBossDamage` 20), give i-frames.
Shmup mode scrolls `background` (two copies) + parallax specks; arena mode = `width×height` floor + border + Camera2D follow.

## Pure modules (deterministic; use in tests / balance)
```luau
S.emitter.resolve(def) · .volley(d, v, dx, dy) -> shots · .volleyTime(d, v) · .new(def) -> em; em:update(dt, {x, y, tx, ty}) -> shots (each with age)
S.emitter.preview(def, seconds, ctx) -> all shots      -- same result for any dt
S.motion.at(bullet, age, angle0, speed0) -> speed, angle   .velocity(...) -> vx, vy   .position(b, s, x, y, a, sp)   .dynamic(b)
S.motion.path(path, t, x0, y0, {lockX}) -> x, y        -- enemy paths
S.weapons.stats(def, L) · .volley(def, L, x, y, aim) · .beam(...) · .orbs(def, L, t, x, y) · .dps(def, L, acc) · .new(def, L) -> w (w:update(dt, firing, x, y, aim) -> {shots, beam?, orbs?}, w:upgrade(n), w:isMax())
S.score.new({ comboWindow = 2, multEvery = 10, maxMult = 8, grazePoints = 10, extends = {…}, onExtend }) -> s:kill(pts) s:graze(n) s:hit() s:update(dt) s.score s.combo s.mult
S.stage.timeline(def, enemies, procgen) -> entries · S.stage.new(def, enemies, procgen) -> r:update(dt, alive) -> due, r:finished(alive), r.holding
S.boss.new(def, emitterDefs, ai, {x, y, bounds?, enter?}) -> b:update(dt, target, hp) -> { shots, summons, phase? }
S.balance.stage(C, id, {weapon, level, accuracy}) · S.balance.campaign(C, {procgen, retries = 0.6, shopSeconds = 30, target = {3600, 7200}}) · S.balance.fmt(s)
```
Angles are degrees, screen space: 0 = right, **90 = down**, −90 = up.

## Content files (schemas/)
**`data/shooter.json`** (`config.schema.json`): `lives 3, bombs 2, maxBombs 5, continues 2, currency "credits", autoFire true,
campaign ["stage_1", …] (default: shmup stages in `order`), startShip, grazeRadius, magnet 150, autoAimRange, bombDamage,
score {comboWindow, multEvery, maxMult, grazePoints, extends [60000, 200000]}, pickups {power|bomb|life|coin: "asset:x"},
shop [{id, name, cost, max?, effect: {power:1}|{life:1}|{bomb:1}|{weapon:"fan"}|{sub:"orbit"}|{continue:1}}]`.

**`data/ships/<id>.json`**: `{ name, order, sprite, size [76,76], weapon, sub?, speed 420, hitbox 7, iframes 2, lives?, bombs?, cost? (credits) | unlock {score|clear} }`.

**`data/weapons/<id>.json`**: `{ name, kind: shot|spread|laser|homing|orbital, sprite, size, color, sfx, levels: [ {…}, {…only changes} ] }`
— level fields: `rate count gap spread damage speed pierce radius lifetime` (projectiles), `homing homingRange` (homing),
`dps width length tick` (laser: a beam, pierces), `orbs orbitRadius orbitSpeed orbDamage orbHitEvery orbRadius blocks` (orbital: circling
hitboxes that erase bullets). Power pickups/shop raise the level (max = #levels). `sub` weapons (orbital/homing "options") fire alongside.

**`data/emitters/<id>.json`** (`emitter.schema.json`):
`{ pattern: aimed|fan|ring|spiral|wave|line, count, spread, angle 90, aim, spin (deg/s), spinPerVolley, waveAmp, waveFreq, rate (volleys/s),
burst, burstGap, delay, duration, volleys, speed, speedStep, offset [x,y], bullet {…} }`
bullet: `sprite, color, size, radius 6, damage 1, lifetime 8` + curves `accel minSpeed maxSpeed speedCurve [[age, mult]…] turn turnAfter
angleCurve [[age, deg]…] waveAmp waveFreq`. Recipes: flower = ring 20 + `speedCurve [[0,1],[0.6,0.15],[1.4,1.2]]` + spinPerVolley 9;
curving ring = ring 16 + `turn 28`; spiral = `spiral count 3 spin 115 rate 10`; sweep = `wave count 5 spread 60 waveAmp 35`; sniper line = `line count 5 speedStep 45`.

**`data/enemies/<id>.json`** (`enemy.schema.json`): `{ name, sprite, size, radius, hp, score, path {kind…}, emitters [id|inline], bullet?, drops {power, bomb, life (chances), coins} }`
paths: `straight {speed, angle}` · `sine {speed, amp, freq}` · `stop {speed, stopY, hold, exitSpeed}` (gunship: enters, fires, leaves) ·
`swoop {speed, turn, angle}` · `dive {speed, at, diveSpeed}` (locks onto the player's x) · `hover {y, sway}`.
Arena enemies: `behavior` (ai kit: chase, keep_distance, wander, charge, turret …) + params, `cost` / `minLevel` for wave budgets; `shoot`
actions fire `bullet`. **Bosses**: `boss: true, hp, enter {y, speed}, bounds, music?, phases [{hp, pattern: [steps]}]` — steps:
`{action:"fire", emitter|emitters, for, wait}` · `{action:"summon", enemy, count, wait}` · `{behavior:"patrol", points, relative:true, speed, time}` (any ai behaviour) · `{wait}`.
Phase = lowest `hp` threshold ≥ current fraction; changing phase stops emitters, clears bullets to score, banner "PHASE n".

**`data/stages/<id>.json`** (`stage.schema.json`): `{ name, order, mode: shmup|arena, background, bgColor, scroll 80, music, speckColor,
specks 36, width/height (arena), reward {credits, noMiss}, events: [...], waves? }` — events: `{t, enemy, x (0..1 = fraction) | xs [..], count, gap, dx, y, path?, waitClear?}` ·
`{t, text}` (banner) · `{t, pickup:"power", x}` · `{t, boss, waitClear = true}` (waits until the screen is clear). Arena `waves {count, budget,
growth, gap, rest, enemies [ids], boss {id, every}, seed}` → procgen budgets; each wave waits for the previous one to be cleared.
Stage clears when every entry is released and nothing (incl. the boss) is alive.

## How to build a 1–2 h shooter
- **Content counts** (target ~75 min first clear + retries): 6–8 shmup stages (2.5–4 min each: 60–90 s script + 30–90 s boss) + 2–3 arenas
  (6–10 waves) as bonus/unlock stages; 10–14 enemy types (≥ 2 new per stage, mix paths), 18–30 emitters, one boss per stage
  (2–3 phases, last boss 3–4), 3–5 weapons × 4–5 levels, 2 options (orbital/homing), 3–4 ships (unlock via credits/clears/score),
  6–8 shop items. Loop the campaign on "Hard" (`config` copy with faster bullets) for replay.
- **Pacing**: early stage enemies die in < 1 s at level 1 (`hp ≤ dps·0.6`), gunships 2–4 s; boss TTK 30–120 s (`balance.campaign` notes flag
  outliers and enemies that outlive their screen time). Peak bullets/s: stage 1 ≤ 35, mid 40–60, finale 70–90 (`row.peakBullets`).
  Credits per stage ≈ 1.5× the cheapest shop item; total ≈ 60% of the shop so choices matter.
- **Difficulty knobs** in data: emitter `rate`, `speed`, `count`; `delay` before first volley (fairness: ≥ 0.6 s); `aim` vs fixed patterns;
  arena wave `budget/growth`. Keep the first 20 s of stage 1 dodgeable without moving much.
- Check with `S.balance.campaign(C, { procgen = require("@kit/procgen") })` in a test (`withRetries` within target, no notes).

## Do / don't
- Do keep `bounds` y-max ≤ 990 in portrait (the stick lives in the bottom 300 px); HUD sits in the top 132 px, pause button top-right.
- Do give every emitter a `bullet.sprite` (round 22 px SVG with a light core reads best); player shots elongated, distinct hue.
- Do use `waitClear` before bosses and at the end of big set pieces.
- Don't author bullets in scripts — add an emitter file; don't move enemies in scripts — use `path` or an ai `behavior`.
- The kit sets `combat.setup({ flash = false, tint = false })` while playing (it flashes sprites itself); `combat.reset()` runs on every `S.play`.
- `config.invincible = true` (or `S.play(..., { invincible = true })`) is a playtest aid for checking full stage flow headless; never ship it.
