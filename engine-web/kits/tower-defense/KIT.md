# tower-defense kit

`kits = ["tower-defense"]` in dreamsy.toml, then `local TD = require("@kit/tower-defense")`.
Data-driven tower defense: maps from TileMap2D grids or waypoint paths, enemies / towers / waves / levels /
campaign from JSON, a deterministic `Sim`, a `View` (entities, radial build/upgrade menus, range preview),
a portrait `Hud`, `Campaign` progress + save, and a headless balance bot. Golden example:
`games/examples/kit-tower-defense` ("Bramble Watch": 3-level campaign, 5 towers × 2 branches, 7 enemies + boss, endless).

All sim positions are in **tiles** (cell (c, r) spans [c, c+1) × [r, r+1), center (c+0.5, r+0.5); row 0 = top).
Speeds are tiles/s, ranges and radii are tiles. The View converts with the map's `position` + `tile_size`.

## Content (data/…)

Schemas: `engine-web/kits/tower-defense/schemas/{enemy,tower,waves,level,campaign}.schema.json`. Ids = file names (lowercase_snake).

`TD.content()` reads these files with the engine data reader (`data.list/data.read`; cached per game) and resolves
`"file:"` grids. `TD.content("data/td")` reads another root; `TD.content(tbl)` normalizes a table (tests). No generated modules.

`data/enemies/<id>.json`
```json
{ "name": "Bark Beetle", "hp": 32, "speed": 1.0, "bounty": 4, "lives": 1, "armor": 0,
  "resist": { "magic": -0.3, "explosive": 0.5 }, "flying": false, "boss": false, "regen": 0,
  "split": { "into": "slimelet", "count": 3 }, "heal": { "amount": 8, "radius": 1.5, "interval": 2.5 },
  "immune": ["slow", "dot"], "sprite": "asset:enemy_beetle", "size": 0.55, "color": "#7a4a2a" }
```
- Damage = hit → armor (flat, every type except `magic`/`true`; ≥ 20% of the hit always lands; `armor_pierce` on the tower
  subtracts) → × (1 − resist[type]) (negative = weakness; `true` ignores resist) → tower `bonus` (boss/air) → `hooks.damage`.
- `flying`: flies the straight line first→last path point; only towers with `"air": true` hit it.
- `split`: on death spawns `count` × `into` at the same spot (same wave, same hp scaling). `heal`: heals others in radius.
- `boss`: big hp bar + `bossSpawned`. `lives`: lives lost on leak (boss: 10+).

`data/towers/<id>.json`
```json
{ "name": "Thorn Shooter", "cost": 50, "range": 2.4, "rate": 1.2, "damage": 6, "damage_type": "physical",
  "ground": true, "air": true, "targeting": "first",
  "splash": { "radius": 1, "falloff": 0.5 }, "slow": { "factor": 0.55, "duration": 1.5 },
  "chain": { "count": 3, "range": 1.6, "falloff": 0.75 }, "dot": { "dps": 12, "duration": 3, "type": "fire" },
  "aura": { "range": 1.6, "damage": 0.15, "rate": 0.2, "range_bonus": 0 }, "income": 0, "armor_pierce": 0,
  "bonus": { "boss": 2, "air": 1.5 },
  "sprite": "asset:tower_thorn", "icon": "asset:tower_thorn", "projectile": { "color": "#c9e265", "speed": 12, "size": 0.14, "beam": false },
  "upgrades": [ { "name": "Sharp Thorns", "desc": "+3 damage", "cost": 45, "add": { "damage": 3 } }, … ],
  "branches": [ { "id": "a", "name": "Briar Sniper", "sprite": "…", "icon": "…", "tiers": [ { "cost": 120, "mul": { "damage": 2.4 }, "set": { "armor_pierce": 5 } }, … ] },
                { "id": "b", "name": "Bramble Volley", "tiers": [ … ] } ] }
```
- Upgrade tree: all `upgrades` (common tiers) in order, then the player picks ONE of ≤ 2 `branches` and climbs its `tiers`.
- An upgrade step = `set` / `add` / `mul` on stats, dotted keys allowed (`"splash.radius"`, `"slow.factor"`); applied set → add → mul.
  `set` can add whole effects (`"set": {"slow": {...}}`).
- Support towers: `damage: 0, rate: 0` + `aura` (towers in range get +damage/+rate/+range fractions; best aura per stat, no stacking)
  and/or `income` (money at every wave start). `slow`: strongest factor wins, duration refreshes. `dot`: one per source tower, ignores armor.
- Targeting modes: `first` (closest to exit), `last`, `strong` (most hp), `close` (nearest the tower). Players cycle them in the tower menu.

`data/waves/<id>.json`
```json
{ "scaling": { "hp": 0.05 },
  "waves": [ { "groups": [ { "enemy": "beetle", "count": 8, "interval": 1.2, "delay": 0, "path": "S", "hp_mult": 1 } ], "bonus": 20 } ],
  "endless": { "pool": ["beetle", "ant"], "boss": "stag", "boss_every": 10, "hp_growth": 1.08, "count_base": 6, "count_growth": 1.2, "interval": 0.8, "bonus": 40 } }
```
Group spawn times = `delay + i·interval` after the wave starts. `path`: path id, or `"*"`/omitted = round-robin across paths.
Wave n hp × (1 + scaling.hp·(n−1)). Past the scripted waves (endless mode only) waves are generated from `endless`
(2 rotating pool groups, count = base + growth·(k−1), hp × hp_growth^(k−1), boss every `boss_every`).

`data/levels/<id>.json`
```json
{ "name": "Mossy Meadow", "map": { "grid": "file:data/levels/meadow.txt", "tile_size": 64,
    "legend": { "path": "#", "spawns": "ST", "exits": "E", "build": "o" } },
  "waves": "meadow", "money": 200, "lives": 20, "interest": { "rate": 0.03, "cap": 20 },
  "sell_ratio": 0.7, "between": 8, "early_bonus": 2 }
```
- Grid = the same `.txt` the scene's TileMap2D draws. Walkable = path + spawn + exit chars; each spawn tile BFS-routes to the
  nearest exit (path id = spawn char, "S2"… for repeats). Edge spawns walk in from past the map edge; paths end on the exit tile. Build only on `build` chars.
  Anything else (`.`, trees, water) is decor. Instead of a grid: `"paths": [{"id": "p", "points": [[x,y],…]}], "build_spots": [[c,r],…]`.
- Economy: `money` start; bounty per kill; wave `bonus` when that wave's last enemy dies/leaks; `interest` = min(cap, money·rate) at each
  wave start after the first; calling a wave early pays `early_bonus` × seconds saved; selling refunds `sell_ratio` × everything spent on it.
- Flow: wave 1 starts when the player presses START (`sim:startWave()`); after a wave has fully spawned and the field is empty, a
  `between`-second countdown auto-starts the next. The next wave can be called any time the current one has finished spawning.

`data/campaign.json`
```json
{ "start_towers": ["thorn", "acorn"], "locked_branches": ["thorn.b", "acorn.b"], "stars": { "two": 0.5, "three": 0.9 },
  "levels": [ { "level": "meadow", "unlock": { "towers": ["frost"], "branches": ["thorn.b"] } },
              { "level": "stump", "requires_stars": 3 } ],
  "endless": { "level": "stump", "waves": "endless", "requires": "stump" } }
```
Level i is playable when level i−1 is cleared and total stars ≥ `requires_stars`. Clearing a level grants its `unlock`.
Stars: win = 1, lives ≥ two·max = 2, ≥ three·max = 3.

## API

```luau
local TD = require("@kit/tower-defense")
local C = TD.content()                                    -- read data/** + cross-check (clear errors on bad ids)

-- one call: sim + view + hud wired to onTick; finishing a level records stars/unlocks in the campaign and saves
local game = TD.play(C, "meadow", { map = entity("meadow_map"), root = entity("meadow_layer"), campaign = camp,
  endless = false, theme = {...}, hudTheme = {...}, sfx = {...}, onWin = function(res) end, onLose = function(res) end })
game.sim, game.view, game.hud
```
Requires `core` + `progression` + `juice` (auto-enabled). On finish `TD.play` emits core events `td_level_won` / `td_level_lost`
`{level, stars, wave, endless}` (count them in quests/achievements).

**Sim** (pure Luau; same in game, tests, harness) — `TD.Sim.new(C, levelId, opts)`
opts: `towers` (unlocked ids), `lockedBranches` (`{"thorn.b"}`), `endless`, `waves` (wave-set override), `seed`, `autoWaves` (true),
`hooks = { damage = fn(sim, tower, enemy, dmg, type) -> dmg, bounty = fn(sim, enemy, n) -> n, canBuild = fn(sim, towerId, c, r) -> bool }`.
```luau
sim.money  sim.lives  sim.maxLives  sim.wave  sim.waveCount  sim.state ("build"|"running"|"won"|"lost")  sim.speed  sim.countdown
sim:step(dt)                       -- real seconds; fixed 30 Hz ticks × speed
sim:setSpeed(1|2|3)
sim:startWave() / sim:canStartWave()
sim:canBuild(id, c, r) -> ok, reason ("locked"|"tile"|"occupied"|"money"|"over")
sim:build(id, c, r) -> tower?, reason
sim:upgradeOptions(t) -> { {kind="common"|"branch", branch, branchName, tier, cost, name, desc, locked, affordable} }
sim:upgrade(t, branch?) -> ok, reason ("choose"|"locked"|"money"|"max")
sim:sell(t) -> refund        sim:sellValue(t)
sim:setTargeting(t, mode)    sim:cycleTargeting(t)
sim:towerAtCell(c, r)  sim:isBuildable(c, r)  sim:towerList()  sim:enemyList()  sim:availableTowers()
sim:spawnEnemy(id, pathId, {dist, hpMult, wave})   sim:damage(enemy, n, type, tower?)   sim:pickTarget(t)
sim:result() -> {level, won, lost, lives, maxLives, stars, wave, waves, kills, leaked, spent, time, endless}
sim:snapshot() (between waves only; plain table for save.set)    TD.Sim.restore(C, snap, opts)
sim:on(event, fn) -> {disconnect}
```
Tower: `t.id, t.def, t.c, t.r, t.up = {common, branch, tier}, t.base` (stats), `t.stats` (with auras), `t.spent, t.kills, t.damage, t.targeting`.
Enemy: `e.id, e.def, e.hp, e.maxHp, e.x, e.y, e.dist, e.path, e.flying, e.boss, e.slow, e.wave`.

Events: `waveStarted(n, schedule)`, `waveSpawned(n)`, `waveCleared(n, bonus)`, `countdown(s)`, `enemySpawned(e)`, `bossSpawned(e)`,
`enemyDamaged(e, dmg, type, tower)`, `enemyKilled(e, bounty, tower)`, `enemyLeaked(e, lives)`, `heal(e, healedList)`,
`towerBuilt(t)`, `towerUpgraded(t, option)`, `towerSold(t, refund)`, `towerChanged(t)`, `shot(t, target)`, `splash(t, x, y, r)`,
`chain(t, x, y, e)`, `income(t, n)`, `moneyChanged(money, delta, why)`, `livesChanged(lives, delta)`, `speedChanged(s)`,
`levelWon(result)`, `levelLost(result)`.

**View** — `TD.View.new(sim, { map, root, origin, tile, theme, sfx, names, input = true, stepSim = true, timeScale = true })`; call
`view:update(dt)` per frame (`TD.play` does). Taps come from `map.tileTapped` (a full-map tap catcher without a map). Sim speed drives
`game.timeScale` (projectiles/particles fast-forward; 0 = pause); reset to 1 on finish, `view:destroy()` or scene change. Effects use `@kit/juice`. Spawns sprites from `sprite`/`color`/`size`, hp bars (shown once damaged; bosses always), projectiles/beams, particle
bursts, floating bounties, tower tier labels (`||`, `A1`, `B2`) and branch sprites. Tap a build tile → radial menu of unlocked towers
(cost; grey if unaffordable); tap an item once = preview (range circle, "OK?"), again = buy. Tap a tower → next upgrade(s) (both branch
choices when due; "LOCK" if locked), targeting toggle, sell. Menus stay inside the map. theme keys: `button, buttonTexture, selected,
ok, poor, locked, text, outline, range, rangeTexture, hpBack, hp, hpBoss, bounty, font, sellIcon, targetIcon`. sfx keys: `build, upgrade,
sell, kill, leak, wave, deny, select, shoot = {[towerId] = id}`. View events: `menuOpened(kind, c, r)`, `menuClosed`, `previewTower(def, c, r)`,
`previewUpgrade(t, option)`, `tileTapped(c, r)`. `view:closeMenu()`, `view:destroy()`.

**Hud** (portrait) — `TD.Hud.new(sim, { theme = {panel, button, buttonAlt, text, money, lives, wave, star, starOff, font, icons = {money, lives, wave, star}}, labels = {start, next} })`:
top bar (money, lives, wave n/N), bottom bar (speed 1x/2x/3x, START / NEXT with countdown + early bonus). `hud:update()` per frame,
`hud:banner({ title, subtitle, stars, buttons = {{text, onPress, primary}} })` (a `core.menus` modal), `hud:closeBanner()`.
`button`/`text`/`font` default to `ui.theme()` ([ui] in dreamsy.toml).
Layout for 720×1280: HUD 0–96 and 1152–1280; put the map between (11×15 tiles of 64 px at `position = [8, 112]`).

**Campaign** — `TD.Campaign.load(C, key?)` (from `save`, key `"td_progress"`) / `TD.Campaign.new(C, progressTable?)`:
`camp:levels()` (index, id, name, unlocked, stars, requiresStars, waves), `isUnlocked(id)`, `stars(id)`, `totalStars()`,
`unlockedTowers()`, `simOptions(id, extra)`, `endlessOptions(extra) -> opts, levelId`, `endlessUnlocked()`, `endlessBest()`,
`complete(result) -> {stars, newBest, unlocked = {towers, branches}, wavesSurvived?}`, `save(key?)`, `serialize()`, events `levelCompleted`, `endlessFinished`.
`Campaign.load` also registers the campaign as `core.save` section `"td_campaign"`, so `core.save.save()/load()` include it.

**Balance** (headless; harness only — too slow for a frame) — `TD.Balance.runLevel(C, id, opts)`, `TD.Balance.campaign(C, {endlessWaves})`.
Runs on `progression.balance.simulate`. The reference bot greedily buys the affordable action with the best value/cost (dps × path coverage × effectiveness vs. the level's
enemy mix: armor, resist, air, overkill; spreads tower types). TS: `balance(pkg)` in `harness.ts`, or
`npx tsx kits/tower-defense/cli.ts balance <pkg>` → per level `won, lives, stars, livesByWave, leaksByEnemy, towers, seconds` + endless
waves survived + `problems` (reads the package's data/**). `validateContent(pkg)` / `cli.ts validate <pkg>` check data against the schemas.

## Building a 1–2 hour TD game

Content counts (≈ 75–110 min first clear, more for stars/endless):
- 10–15 levels × 10–20 waves (≈ 5–8 min each at 1x incl. building) + endless. 3 stars on every level ≈ +50% playtime.
- 6–8 towers (unlock 1 every 1–2 levels: never more than one new mechanic per level), each 2 common tiers + 2 branches × 2–3 tiers.
- 10–14 enemy types: basic, fast, armored, flying, splitter, healer, regenerating, shielded/resistant + 2–3 bosses (mid + final).
  Introduce each new enemy alone in an early wave of the level that introduces it, before mixing.
- Maps: 1 path for levels 1–3, then 2 spawns / merging paths, then separate paths; vary build-spot scarcity.

Pacing + balance formulas (what Bramble Watch uses):
- Tower value: dps/cost ≈ 0.12–0.2 for basic towers; specialists (splash/chain/slow) lower raw dps but multiply vs groups.
  Range 2–2.6 tiles (snipers 3.5+). Splash radius ~1 tile. Slow factor 0.45–0.6 for 1.5 s.
- Upgrades: common tier ≈ +40–60% dps for 80–100% of base cost; branch tiers ≈ +80–150% for 2–4× base cost.
  Branch A vs B should answer different problems (single-target/boss vs crowds, damage vs economy).
- Enemy hp per wave: hp × (1 + 0.04–0.06·(n−1)); total wave hp should grow ~12–20% per wave while income grows ~10–15%.
- Bounty ≈ hp / 8 (fast/flying a bit more), wave bonus 20 → 60 over a level, start money ≈ 3–4 basic towers.
- Armor ≈ 30–50% of a basic tower's hit (never above it: min 20% makes armor feel like a wall). Give every armored/resistant enemy a
  counter that is unlocked by then.
- Flyers skip the maze — keep their counts low until air towers are unlocked; place build spots near their straight line.
- Boss: ≈ 25–40× a basic enemy's hp, slow (0.35–0.45), lives 10, splits into small fry; last wave of a chapter.
- Difficulty target with the reference bot: level 1 wins with 3★, mid levels 1–2★ (humans do better), every level winnable,
  no level where the bot leaks nothing past level 1. Run the balance sim after every content change; fix `problems`.

Do: keep all numbers in data; use hooks/events for special rules (e.g. `hooks.damage` for "+50% vs bosses on fire");
use `sim:snapshot()` between waves for mid-level save. Don't: move enemies or towers yourself (the sim owns positions);
call `TD.Balance` in a live game; set `game.timeScale` yourself while a View runs (use `sim:setSpeed`).
