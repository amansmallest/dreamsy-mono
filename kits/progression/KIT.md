# progression kit

Numbers that make a game last: XP/level curves, stat scaling + modifiers, skill/unlock trees, prestige layers,
daily streak rewards, milestones, difficulty curves, and headless balance simulations. Standalone; with the
core kit enabled it binds automatically (condition/effect kinds, events, save section "progression").

## Setup
```toml
kits = ["core", "progression"]   # kit.json: no deps (binds to core when enabled)
```
```luau
local prog = require("@kit/progression")
local level = prog.leveler({ name = "player", curve = { kind = "quadratic", base = 15, linear = 25, maxLevel = 30 } })
local skills = prog.tree({ points = 1 })              -- defs from data/skills/*.json (core content kind "skills")
level:onLevelUp(function(L, gained) skills:addPoints(gained) end)
```
Named objects (`leveler`, `tree`, `layer`, `streak`, `milestoneSet` — or `prog.register(name, obj)`) are saved in the core
save under "progression" and reachable from content via `track`/`tree`/`layer`/`set`. Create them in the same place you call
`core.setup` (session script / shared module), before `core.save.load()`.

## Curves — `prog.curve(spec)`
`total(L)` = XP to reach level L from 1 (`total(1) = 0`), rounded unless `round = false`.
| kind | formula | params |
|---|---|---|
| `linear` | base·(L−1) | `base` |
| `quadratic` (default) | base·(L−1)² + linear·(L−1) | `base`, `linear` |
| `exponential` | toNext(L) = base·growth^(L−1) | `base`, `growth` (1.15) |
| `power` | base·(L−1)^exponent | `base`, `exponent` (1.5) |
| `table` | totals list, `table[1] = 0` | `table` (maxLevel = #table) |
| `custom` | fn(L) → total | `fn` |
All take `maxLevel` (99). Methods: `c:total(L)` `c:toNext(L)` (`math.huge` at max) `c:levelAt(xp)` `c:progress(xp) -> level, into, need, frac` `c:rows(n?)`.

## Leveler — `prog.leveler({ curve, name? ("player"), xp?, onLevelUp?(L, gained, lv) })`
`lv:add(xp) -> levelsGained` (capped at max) · `lv.level` `lv.xp` (total) · `lv:progress() -> level, into, need, frac` · `lv:setLevel(L)` ·
`lv:isMax()` · `lv:onLevelUp(fn)`. With core: emits `level_up` {track, level, gained}; effect `{"xp": 20, "track"?: "player"}`; condition `{"level": 3}`.

## Stats — `prog.stats`
```luau
prog.stats.linear(base, perLevel, L)  prog.stats.percent(base, pct, L)  prog.stats.compound(base, rate, L)
prog.stats.diminishing(x, cap, half)                 -- cap·x/(x+half): crit/dodge caps
prog.stats.block({ hp = { base = 20, per = 5 }, atk = { base = 4, growth = 0.08 }, spd = { base = 10, pct = 0.02, max = 30 }, crit = 0.05 }, L, round? (true))
prog.stats.apply(stats, mods) -> stats               -- mods { {stat, add?, pct?, mul?} }: (base + Σadd)·(1 + Σpct)·Πmul
```

## Skill / unlock trees — `prog.tree(opts)` (`data/skills/<id>.json`, schema `schemas/skill.schema.json`)
```json
{ "name": "Golden Touch", "description": "+3 gold per slime", "icon": "asset:coin", "branch": "combat", "tier": 2, "pos": {"x":1,"y":2},
  "maxRank": 1, "cost": {"points": 1, "gold": 20}, "requires": [{"id":"strong_arm","rank":1}], "requiresAny": ["a","b"],
  "condition": {"quest":"apple_pie","is":"done"}, "effects": [{"set":"golden"}], "mods": [{"stat":"gold_bonus","add":3}] }
```
`cost`: number (= skill points) | `{points?, <currency>?}` | list per rank. Currencies are paid via `core.wallet` (or `opts.wallet`).
`effects` apply on every rank; `mods` stack per rank.
```luau
local t = prog.tree({ name? ("skills"), defs? (list|map; default core content "skills"), kind? ("skills"), points? (0), wallet?, onUnlock?(id, rank, t) })
t:canUnlock(id) -> ok, reason ("max"|"requires"|"condition"|"points"|"cost"), detail
t:unlock(id, free?) -> ok, reason      t:rank(id)  t:has(id, rank?)  t:cost(id) -> {points=…, gold=…}  t:addPoints(n)  t.points
t:available() -> {ids}   t:list(branch?) -> { {id, def, rank, state = "owned"|"max"|"available"|"unaffordable"|"locked", reason} }
t:mods() -> mods for prog.stats.apply     t:respec(refundPct? = 1)     t:onUnlock(fn)
```
Unknown `requires` ids are errors at creation. Use several trees for different unlock graphs (skills, map unlocks, shop
upgrades with currency costs): `prog.tree({ name = "upgrades", kind = "upgrades" })` reads `data/upgrades/*.json`.
With core: event `skill_unlocked` {skill, rank, tree}; condition `{"skill":"id","rank"?,"tree"?}`; effects `{"skillPoints":1}` `{"unlockSkill":"id"}`.

## Prestige — `prog.layer(opts)` / `prog.prestige.new(opts)`
`{ name? ("prestige"), threshold (1e6), exponent (0.5), scale (1), bonusPer (0.1), multiplier?(points), cumulative?, onPrestige?(gained, layer) }`
gain = floor(scale·(x/threshold)^exponent) (minus already-earned points when `cumulative`).
`l:pending(x)` · `l:nextAt(x)` (x needed for one more point) · `l:prestige(x, resetFn?) -> gained` (0 = not allowed, nothing happens) ·
`l:multiplier()` (1 + points·bonusPer) · `l:spend(n)` · `l.points` `l.total` `l.count`. Condition `{"prestige":1,"layer"?}` (count ≥).

## Daily streaks — `prog.streak(opts)` / `prog.daily.new(opts)`
`{ name? ("daily"), rewards = { r1, r2, … }, cycle? (true), grace? (0 missed days allowed), dayLength? (86400), now?() }`
Rewards that are core effect lists are applied on claim. `d:status(now?) -> { canClaim, streak, index, reward, nextIn }` ·
`d:claim(now?) -> reward, index` (nil if already claimed this day) · `d.streak` `d.claims`.
Clock: `opts.now` → `prog.setClock(fn)` → engine `clock.now()` (real unix seconds; tests: `Game.load(pkg, { clock })`). Event `daily_claimed`.

## Milestones — `prog.milestoneSet(list, opts?)` / `prog.milestones.new`
`list = { { id?, at = 100, reward? (effects), label? } }`, `opts = { name? ("milestones"), onReach?(m) }`.
`m:check(value) -> newly reached list` (once each) · `m:next(value) -> milestone, fraction` · `m:reached(id)`. Condition `{"milestone":"id"}`.

## Difficulty — `prog.difficulty.new({ tiers, interpolate? (true), beyond? })`
`tiers = { { at = 0, params = { speed = 80, count = 3, enemy = "slime" } }, { at = 10, params = {…} } }` (by level/wave/minute/0..1).
`d:at(x) -> params` (numbers lerp between tiers; others from the lower tier; `beyond = { speed = 5 }` extrapolates per unit past the
last tier) · `d:tier(x)` · `prog.difficulty.ramp(x, from, to, over, easing?)`.

## Balance — `prog.balance` (headless; use in tests/harness checks)
```luau
prog.balance.timeToLevel(curveSpec, xpPerSec | fn(level) -> xp/s, maxLevel?) -> { {level, seconds, total} }
prog.balance.idle({ start?, income = fn(owned, t) -> per s, items = { { id, cost = n | fn(n), growth?, max? } }, dt?, maxTime? })
  -> timeline { {id, n, time, cost} }, endTime            -- greedy buy-cheapest-asap (generators, towers, shop upgrades)
prog.balance.simulate({ state, step = fn(s, dt, t), done = fn(s, t), dt?, maxTime? }) -> time, state
prog.balance.format(seconds) -> "1h 02m"
```
Target 1–2 h of play: check `timeToLevel(...)[maxLevel-1].total` and the idle timeline end time against the design.

## Do / don't
- Do name every object you want saved; create them before `core.save.load()`.
- Do keep costs/curves in data (skills JSON, a `data/design/*.json` balance block) so the harness can tune them.
- Don't tie daily rewards / offline progress to `time()` (play time) — the default `clock.now()` is the wall clock.
- Don't give paid randomness (Stars) through daily/prestige; these are in-game currencies only.
