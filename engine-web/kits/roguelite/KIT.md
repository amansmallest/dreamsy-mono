# roguelite kit

Run-based games (Hades / Isaac / Slay-the-Spire structure, real-time or turn-based fights): biomes and floors from data,
a branching door path per floor (combat · elite · treasure · shop · event · rest · boss), relics with stacking + tag
synergies, active items, classes with unlocks, run gold vs persistent meta currency, a meta tree, Heat levels after a win,
seeded daily runs, mid-run save/resume, run summary, and a headless balance sim. Thin layer: stats = progression mods,
effects/conditions = core data language, floors/arenas = procgen, fights = combat + ai, feel = juice.
Requires (auto-enabled via kit.json): core, progression, juice, combat, ai, procgen. Example: `games/examples/kit-roguelite`.

## Setup
```toml
kits = ["roguelite"]
[physics]
layers = ["player", "enemy", "world"]
```
```luau
local core = require("@kit/core")
local R = require("@kit/roguelite")
core.setup({ save = { key = "mygame", version = 1 }, theme = {...} })   -- once (session script / scene script guarded)
R.setup()            -- loads data/{classes,biomes,relics,synergies,actives,events,enemies,meta}/*.json + data/roguelite.json
core.save.load()     -- meta tree, embers, records, saved run
```
`R.setup({ content = { relics = {...}, ... }, config = {...}, data = pathMap, load = true })` for tests / inline content.

## Run flow (pure state machine — `R.Run`, no entities)
```luau
local run = R.newRun({ class = "warden", heat = 0, seed = nil|n, daily = false })   -- live run (R.run); emits run_started; saved
run.state       -- "choose" → enter(i) → "room" → clear() → ("reward" → takeRelic(i)|skipReward()) → "choose" … → "won" | "dead"
run:choices()   -- rooms behind the doors of the next step: { {type, enemies?, boss?, elite?, event?, seed, biome, floor, step} }
run:enter(i)    -- → room; fires roomEnter; shop rooms get room.stock, rest rooms room.options
run:clear()     -- after the fight / when leaving: → reward {gold, relics = {ids}?}; recharges active, regen, roomClear triggers,
                --   advances step/floor (floorStart), boss → boss_defeated, last floor → "won"
run:takeRelic(i|id)  run:skipReward()            -- resolve a pending relic choice (+10 gold on skip)
run:buy(i) -> ok, "sold"|"gold"                  -- shop (relic / active / heal; heal re-buyable at 1.5x)
run:rest("heal"|"maxHp")                         -- campfire (config.rest) — clears the room
run:eventDef()  run:eventChoices() -> {index, text, ok}   run:choose(i)   -- event: cost {gold,hp} then effects, then clear
run:useActive() -> def|nil   run:activeReady() -> ok, def   run:addCharge(n)   run:setActive(id)
run:addRelic(id)  run:relicCount(id)  run:synergies()  run:hitStatuses()  run:heal(n)  run:hurt(n)  run:addGold(n, raw?)
run:statsNow() -> stats (cached; run:dirty() after manual mod edits)   run:maxHp()   run:enemyScale(room?) -> hpMult, dmgMult
run:fire(event, data)   run:onKill(enemyId, "elite"|"boss"|nil)   run:die()   run:summary()
run:planFloor(f) -> { biome, floor, boss, steps = { {choices} } }   run:where(f) -> biome, floorInBiome, isLast, biomeIndex
local sum = R.finish(run?)  -- records meta (runs, wins per class, best, Heat unlocks, daily), awards meta currency → summary
R.save()  R.resume() -> run|nil  R.hasSavedRun()     -- mid-run save (whole run state; an interrupted fight restarts)
```
Floor rules: step 1 is one combat door; middle steps offer `choices` (2–3) distinct non-combat types by `weights`
(biome overrides), no elites before `eliteFromStep`, ≤1 shop per floor; boss floors end with rest/shop(/treasure) → boss;
other floors end with an elite gate (`gate = "combat"` to soften). Every floor/room derives its rng from `seed*1000+floor`
→ same seed = same run (shareable, daily). Encounters: `procgen.waves.encounter(biome.enemies, budget)` with
`budget = budgetBase + budgetPerFloor·(floor−1) + 0.35·(step−1)` (elites ×`eliteBudget` from `biome.elites`).
Enemy scaling: hp ×(1 + hpPerFloor·(floor−1))·enemyHp stat, damage ×(1 + damagePerFloor·(floor−1))·enemyDamage (elite ×eliteHp/eliteDamage).

## Fights (combat + ai glue)
```luau
local level = R.arena(room, { w = 15, h = 20 })   -- procgen per biome.arena {kind = "open"|"caves"|"dungeon", …}; level.spawns = cells per enemy
map.data = procgen.toTileMap(level, { ["#"] = "W", ["."] = "f" })
local hero = combat.add(player, R.heroDef(run, { radius = 5 }))          -- hp/maxHp/armor/crit from run stats, team "player"
local bind = R.bindCombat(combat, hero, run)    -- kill/eliteKill/bossKill/hit/crit/hurt/lowHp triggers, lifesteal, thorns, dodge,
                                                --   run.hp sync, hero death → run:die(). bind.disconnect() before the next room
local f = combat.add(body, R.enemyDef(run, enemyData))                   -- scaled hp + contact; f.data = {id, boss, elite, damageMult}
ai.attach(body, enemyData, { grid = grid, canAct = function() return not f:busy() end, ... })
combat.swing(hero, { amount = run:statsNow().damage, status = run:hitStatuses(), ... })   -- relic on-hit statuses
-- all enemies dead → run:clear(); run.state == "dead" → R.finish(run)
```
Turn-based games skip bindCombat: call `run:hurt(n)`, `run:onKill(id)`, `run:fire("hit")` from your battle code.

## Stats (progression `stats.apply`: (base + Σadd)·(1 + Σpct)·Πmul)
Base = `config.baseStats` overlaid by `class.stats`: `hp damage fireRate speed crit critMult armor dodge lifesteal regen thorns
luck goldMult healMult range projectiles enemyHp enemyDamage shopDiscount relicChoices activeCharge` (add your own; the game reads them).
Mod sources in order: class.mods → meta tree mods (snapshot at run start) → relic mods × copies (`stack = false` counts once,
`maxStack` caps offers) → active synergies → Heat mods 1..heat. `R.relics.modList(run)` lists `{source, mod}` for tooltips.

## Content (schemas/*.json)
```jsonc
// data/classes/warden.json
{ "name": "Warden", "icon": "asset:warden", "stats": { "hp": 34, "damage": 3, "fireRate": 1.6 }, "relics": ["lantern_oath"],
  "active": "ember_bomb", "unlock": { "skill": "unlock_tinker", "tree": "meta" }, "unlockText": "40 Embers", "weapon": { ... } }
// data/biomes/glimmer.json  (order = run order)
{ "name": "Glimmer Caves", "order": 2, "floors": 1, "steps": 7, "enemies": ["bat","spitter"], "elites": ["golem"], "boss": "matron",
  "weights": { "event": 14 }, "arena": { "kind": "caves", "fill": 0.36 }, "tiles": {...}, "music": "depths" }
// data/relics/vampire_fang.json
{ "name": "Vampire Fang", "rarity": "uncommon", "tags": ["blood"], "icon": "asset:i_fang", "description": "Heal 1 every 3 kills.",
  "mods": [{ "stat": "damage", "add": 1 }], "stack": true, "maxStack": 3,
  "triggers": [{ "on": "kill", "every": 3, "chance": 1, "condition": {...}, "effects": [{ "heal": 1 }] }],
  "onHit": { "name": "burn", "chance": 0.25, "duration": 2 }, "effects": [ /* applied once on pickup */ ] }
// data/synergies/wildfire.json — tiers by the first tag's count, or flat { "tags": {"frost": 2} } / { "relics": ["a","b"] }
{ "name": "Wildfire", "tags": { "fire": 0 }, "tiers": [ { "count": 2, "mods": [{ "stat": "damage", "mul": 1.2 }] }, { "count": 3, "mods": [...] } ] }
// data/actives/ember_bomb.json — game plays `action` (event active_used); effects apply on use
{ "name": "Ember Bomb", "charge": 2, "action": "bomb", "effects": [] }
// data/events/shrine.json
{ "title": "Shrine", "text": "...", "minFloor": 1, "biomes": ["mossdeep"], "choices": [
  { "text": "Offer blood: relic", "cost": { "hp": 6 }, "effects": [{ "relic": "random" }] }, { "text": "Leave" } ] }
// data/meta/vigor.json — a progression skill; costs in the meta currency
{ "name": "Vigor +4 HP", "maxRank": 3, "cost": [{ "embers": 15 }, { "embers": 30 }, { "embers": 50 }], "requires": [], "mods": [{ "stat": "hp", "add": 4 }] }
// data/enemies/*.json — the ai kit enemy format (+ "boss": true, "dps": n for the sim, "size")
// data/roguelite.json — config overrides (heat list, scaling, rewards, rarity, shop, rest, meta reward, roomTime, sim)
```
Trigger events: `kill eliteKill bossKill hit crit hurt roomEnter roomClear floorStart lowHp (once/room) activeUsed relicGained`.
Effect kinds added to core: `heal` · `healPct` · `maxHp` · `gold` (`raw: true` skips goldMult) · `charge` · `shield` · `hurt` ·
`relic` (`"random"` | id | rarity weights) · `meta` (meta currency). Condition kinds: `relic` (+count) · `class` · `heat` · `runFloor` ·
`hpBelow` (fraction) · `runGold` · `wins` · `classWins` (+count). Rarities: `starter` (never offered) `common uncommon rare boss`.
Core events emitted: `run_started room_entered room_cleared boss_defeated floor_started relic_gained active_used shop_bought
enemy_defeated run_won run_lost run_finished` — quests/achievements can count them.

## Meta, Heat, daily
```luau
R.classes() -> { {id, def, unlocked, wins, maxHeat} }     R.unlocked(id)   R.maxHeat(id)   -- Heat: 0 until a win, then best won + 1
R.metaTree() -- progression tree "meta": t:list(), t:unlock(id), t:mods()      R.metaCurrency()
R.meta.data  -- { runs, wins, bestFloor, classes = {id = {runs, wins, heat, bestFloor}}, history (last 10), daily }
R.daily(now?) -> { day, seed, class (fixed, from unlocked), played, best, won }    R.newRun({ daily = true })
```
Meta reward = (floorsCleared·perFloor + bosses·perBoss + kills·perKill + win) · (1 + heat·heatBonus). Daily seed = hash of the
UTC day from `clock.now()` (playtests use a fixed clock).

## UI (`R.ui`, portrait, core.menus based)
`classSelect({classes, onPick(cls, heat), onBack?})` · `heat(cls, max, onPick)` · `doors(run, onPick(i))` (set `R.ui.ICONS[type] = "asset:x"`) ·
`relicChoice(run, onDone(id|nil))` · `shop(run, onDone)` · `rest(run, onDone)` · `event(run, onDone)` · `summary(sum, onDone)` ·
`metaTree(onClose)` · `relicList(run)` · `card(parent, x, y, w, h, icon, title, body, accent, onTap)`. `R.ui.LABELS`/`RARITY` editable.

## Balance sim (headless; same plans, relics, triggers, shop, events as the game)
```luau
local job = R.sim.job({ classes = {"warden","tinker"}, heats = {0,1,2,3}, runs = 100, seed = 7, metaMods? , policy? })
onTick(function() if job:step(10) then print(job.result.warden["0"].winRate) end end)   -- 250 ms/callback budget: use jobs
R.sim.run({ class, heat, seed }) -> summary + hp      R.sim.batch(opts) (small, synchronous)   R.sim.policy (door/relic/shop/rest/event)
```
Fight model: hero DPS = damage·fireRate·projectiles·(1+crit·(critMult−1)); time = Σhp/DPS + approach; taken = Σ alive enemy dps·time·exposure
·(1−dodge) − armor/hit, ±25 %. Enemy dps = `dps` | contact/1.2 s | projectile/fireEvery. Tune `config.sim.exposure` until bot win
rates match playtests; `roomTime` adds non-fight seconds for run-length estimates.

## How to build a 1–2 h roguelite with this kit
- **Content for ~1.5 h**: 2–3 classes (1 unlockable), 3 biomes × 1–2 floors × 6–8 steps (≈20–25 rooms ≈ 12–18 min/won run),
  8–12 enemies (+2–3 elites via `elites` lists), 2–3 bosses with 2–3 phases, 20–30 relics in 3–4 tags + 3–5 synergies,
  3–4 actives, 6–10 events, 8–12 meta nodes costing ~400 meta currency total, 3–5 Heat levels.
- **Pacing targets** (check with `R.sim.job`): fresh save, Heat 0 win rate 25–40 % for the starter class → first win in
  3–6 runs; meta tree fully bought ≈ 10–20 runs; each Heat level −15–25 % win rate. Avg run 8–15 min → 1–2 h total.
  Example (Lanternfall, 100 bot runs each): warden H0 56 %/H1 44 %/H2 21 %/H3 1 %, tinker H0 17 %, full meta 100 %.
- First room of each floor is always a fight; put a shop + campfire before every boss (kit does); keep treasure rare (weights).
- Make relics change *how* you play (on-hit statuses, triggers) not only +numbers; give every tag 3+ relics so synergies show up.
- Daily run: one button on the title (`R.daily().played` disables it). Mid-run: call `R.save()` after every room (afterRoom).

## Do / don't
- Do keep all numbers in data (roguelite.json, relics, meta) so the harness can tune; read stats from `run:statsNow()`.
- Do disconnect `R.bindCombat` handles and `combat.reset()` between rooms.
- Do run sims with `R.sim.job` across ticks (a 100-run batch takes ~0.5–1 s).
- Don't mutate `run.relics`/`run.metaMods` directly — use addRelic/effects (or call `run:dirty()`).
- Don't give paid randomness: relic offers are in-game only; Stars may gate cosmetic classes, never meta power.
