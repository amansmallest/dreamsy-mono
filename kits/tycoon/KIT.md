# tycoon kit

Idle / incremental games (cookie-clicker, idle-tycoon style): generators that produce currency, cost curves,
upgrades and multipliers, managers (automation), milestones, prestige with permanent bonuses, offline progress,
achievements, tappable events/boosts, big-number formatting, portrait shop UI helpers and save. The economy is a
pure deterministic simulation (`t:step(dt)`); your game script is only UI + feedback. Example:
`games/examples/kit-tycoon` (Crumbtown Bakery: 8 generators, 15 upgrades, 1 prestige layer).

## Setup
```toml
kits = ["tycoon"]
orientation = "portrait"
```
```luau
local Tycoon = require("@kit/tycoon")                 -- enables core + juice automatically
local t, offline = Tycoon.restore("save")             -- reads data/*.json; new game, or the saved one (+ offline report)
local UI, fmt = Tycoon.ui, Tycoon.format
onTick(function(dt) t:step(dt) --[[ update UI ~10×/s ]] end)
every(5, function() Tycoon.persist(t, "save") end)
```
The kit reads its content itself (`data.list`/`data.read`); pass a content table instead only for tests/tools.

## API — state `t = Tycoon.new(content?, { seed?, now? })` (content nil = `Tycoon.read("data")`)
Currencies: `t:get(cur?)` (default main) · `t:add(cur, n)` (n<0 removes) · `t:canAfford(cur, n)` · `t.allTime[cur]` · `t.earned[cur]` (this run)
Generators: `t:costOf(gid, k=1)` (closed-form geometric sum) · `t:maxAffordable(gid)` · `t:buyCount(gid, mode)` ·
`t:buy(gid, mode)` → bool, mode `1 | 10 | 100 | "max" | "next"` (to next milestone) · `t.owned[gid]` · `t:isUnlocked(gid)` ·
`t:rate(gid)` (/s) · `t:income(cur?, {manual=0..1}?)` (/s of automated gens; manual share for tapped gens) ·
`t:payout(gid)` · `t:cycleTime(gid)` · `t:cycleProgress(gid)` (0..1) · `t:isRunning(gid)` · `t:isAuto(gid)` ·
`t:run(gid)` (start one cycle of a non-automated gen = a tap on it) · `t:nextMilestone(gid)` · `t:outputMult(gid)`
Managers: `t:managerCost(gid)` · `t:canHire(gid)` · `t:hireManager(gid)` (gen becomes automatic; `t.managers[gid]`)
Upgrades: `t:upgradeAvailable(id)` (requirements met, not bought) · `t:availableUpgrades()` · `t:buyUpgrade(id)` · `t:hasUpgrade(id)`
Tap: `t:tapValue()` · `t:tap()` → amount (tap.amount + income×tap.rate_fraction, × tap effects/boosts)
Prestige: `t:prestigeGain(layer?)` · `t:canPrestige(layer?)` · `t:doPrestige(layer?)` → gain · `t:prestigeTotal(layer?)` ·
`t:prestigeNeeded(layer?, units)` (all-time source currency for gain = units) · `t:prestigeBonus(layer?, extra?)` (output ×) · `t.prestige[layer] = {claimed, count}`
Boosts/events: `t:boost(id, effects, seconds)` · `t:activeBoosts()` (`{id, effects, left, duration}`) · `t:pendingEventInfo()` (`{id, left}`) ·
`t:claimEvent()` → id · `t:spawnEvent(id?)`
Achievements: `t.ach[id]` · `t:achievementDone(id)`
Offline/save: `t:serialize(now?)` → JSON-safe table · `t:deserialize(tbl)` · `t:applyOffline(now)` → `{seconds, credited, earned={[cur]=n}}`|nil ·
`t:offlineCap()` · `Tycoon.persist(t, key, now?)` · `Tycoon.restore(key, opts?)` / `Tycoon.restore(content, key, opts?)` → `t, offlineReport` ·
`Tycoon.bindSave(t, name="tycoon")` (store `t` as a `core.save` section instead; `core.save.load()` applies offline progress) ·
`Tycoon.wallClock()` = engine `clock.now()` (unix s; fixed in playtests — tests inject `Game.load(pkg, { clock })`)
Format: `Tycoon.format(n, {digits=3, notation="letters"|"scientific", trim})` → `999`, `1.23K`, `4.56M`, `7.89B`, `1.00T`, `1.00aa`…`zz` ·
`Tycoon.duration(s)` → `"3m 05s"`. Numbers are doubles: keep content < 1e300 (max ≈ 1.8e308; JSON can't store inf).
Stats: `t.stats = {taps, playTime, purchases, prestiges}`, `t.runTime`, `t.t`.

**Signals** (`t.on.<name>:connect(fn)` → `{disconnect}`): `purchased(gid, n, cost)` · `upgraded(id)` · `managerHired(gid)` ·
`milestone(gid, at, mult)` · `unlocked(gid)` · `achievement(id)` · `prestiged(layer, gain)` · `boostStarted(b)` · `boostEnded(b)` ·
`eventSpawned(id)` · `eventExpired(id)` · `eventClaimed(id)` · `produced(gid, amount)` · `tapped(amount)` · `offline(report)` · `changed()`.
**Hooks** (set functions on `t.hooks`, then `t:invalidate()`): `outputMult(gid, mult)→mult` · `costMult(gid, mult)→mult` ·
`prestigeGain(layer, gain)→gain` · `tapAmount(amount)→amount`. Use them for custom rules (e.g. weather, combo streaks).

## UI helpers — `Tycoon.ui` (reference px, portrait 720×1280)
`UI.panel(parent, props)` · `UI.text(parent, props)` · `UI.button(parent, props, onPress)` (default 200×88) ·
`UI.tapTarget(parent, props, onTap)` (tappable UIPanel/image) · `UI.progress(parent, props, color)` → `{set(frac)}` ·
`UI.list({rect={x,y,w,h}, rowHeight, gap, count, build(i,row)→state, update(i,row,state), arrows={x,y,w,h}?, rowBackground?})` →
`:refresh()` (call ~10×/s) `:setCount(n)` `:page(±1)` `:scrollTo(y)` `:dragging()` `:destroy()` — rows are UIPanels, positions inside a
row are relative to it; rows not fully inside the viewport are hidden; scrolling snaps to whole rows. Always pass `arrows` (page
buttons): touch-drag scrolling only works where the engine reports `input.pointer()` over UI.
`UI.buyModes(parent, {offset, modes={1,10,"max"}}, onChange)` → `{get()}` · Juice: `UI.floatText(text, screenPos, {color,size,rise,seconds})` ·
`UI.pop(e)` (font pop) · `UI.flash(e, hex)` · `UI.burst(worldPos, {color,count,speed})` · `UI.sfx(id?, opts)` (flash/burst/sfx are
`@kit/juice`; use juice directly for shake, rollup, confetti) · `UI.format`. Unset colors default to `ui.theme()` (text/accent/primary).

## Content files (JSON Schemas in `schemas/`; read by `Tycoon.read`, id = file name)
`data/tycoon.json` (schemas/tycoon.json):
```json
{ "currencies": [{"id":"coins","name":"Coins","icon":"asset:icon_coin","start":5}, {"id":"gems"}],
  "tap": {"amount": 1, "rate_fraction": 0.05},
  "offline": {"cap_hours": 2, "rate": 0.5},
  "milestones": [{"at":25,"mult":2},{"at":50,"mult":2},{"at":100,"mult":2}],
  "prestige": [{"id":"rebirth","currency":"gems","from":"coins","threshold":2.5e6,"exponent":0.33,"bonus":0.05}],
  "events": {"first_delay": 90} }
```
First currency = main. Prestige gain = `floor(scale·(allTime(from)/threshold)^exponent) − claimed`; bonus = `1 + bonus·claimed`
(`bonus_on:"held"` uses unspent currency instead). A prestige resets non-prestige currencies to `start`, generators, managers
(unless `keep_managers`), non-permanent upgrades, boosts; keeps achievements, prestige currency, permanent upgrades, all-time stats.
`data/generators/<id>.json`: `{"name","icon","order","cost":{"base","growth"},"output":<per cycle per unit>,"cycle":<s>,
"manager":{"cost"},"unlock":{"owned":{"<gid>":10}} | {"earned":N} | {"prestiges":1},"milestones":[…]?,"currency"?,"auto"?}`
— without `manager` a generator is automatic; with one it runs only when tapped (`t:run`) until the manager is hired.
Milestones: `{at, mult, kind:"output"|"speed", target:"all"|gid?}`.
`data/upgrades/<id>.json`: `{"name","desc","icon","order","cost":{"amount","currency"?},"effect"|"effects":[{"kind","target","value"}],
"requires":{"owned":{…},"upgrades":[…],"earned","prestiges"}}`. Effect kinds: `output` ×, `speed` (cycle ÷), `cost` ×, `tap` ×,
`offline_hours` +, `offline_rate` +, `prestige` (gain ×); target `"all"` (default) or a generator id. Paid in a prestige currency ⇒ permanent.
`data/achievements/<id>.json`: `{"name","desc","when":{"owned":{…}|"owned_total"|"earned"|"prestiges"|"taps"|"upgrades"|"managers"},"reward":{"mult":1.05,"amount","currency"}}`
`data/events/<id>.json`: `{"name","effect":{"kind":"output","value":3},"duration":30,"lifetime":10,"every":[120,200],"weight":1,"reward":{"income_seconds":90}}`
— the sim spawns one every `every` seconds (seeded); show it on `eventSpawned`, call `t:claimEvent()` on tap.

## How to build a 1–2 hour game
**Content counts:** 6–10 generators, 12–25 upgrades (one ×3 per generator + 2–4 global ×2 + tap/speed/offline + 3–5 permanent
prestige upgrades), 10–20 achievements (+5% each), 1–3 events, 1 prestige layer (2 only for >2 h). One currency + one prestige currency.
**Curves (the example's, proven by the balance sim):**
- Tier i (0-based): `base_cost = 5·15^i`, `rate/unit = 6^i /s` (`output = rate·cycle`), cycle 1→40 s, `growth = 1.07` (tier 0) then
  `1.15 − 0.005·i`. Each tier's payback is ~2.5× the previous one, so a new tier always feels strong.
- Unlock tier i+1 at 10 of tier i. Managers ≈ 12× the base cost (first manager ≈ 1 min in).
- Milestones ×2 at 25/50/100/150/200/300 owned. Per-tier ×3 upgrade at 25 owned costing ≈ 60× base cost; global ×2 at ≈ 200× base of tier 2/5.
- Prestige: cube-root (`exponent 0.33`), `threshold` such that the first reset is worth ~20 units at the all-time total you
  expect around minute 30 (`threshold = allTime@30min / 20^(1/exponent)`, read it from the sim's `samples`); `bonus 0.05` ⇒ the
  first reset ≈ ×2. Square root (0.5) makes later runs very short (resets every ~5 min).
**Pacing targets** (check with the balance sim): first purchase gap < 10 s, a new generator every 1–5 min until all are out
(~20–25 min), first prestige 20–35 min, later runs 10–20 min, all upgrades bought by 45–90 min, median wait between purchases
< 30 s, no wait > 3 min (`stalls` empty).
**Feel:** big tap target (≥ 200 px) that pays `rate_fraction` of income; ×1/×10/MAX toggle; float "+N" on every buy/tap; burst +
sfx on milestones/upgrades; toast unlocks/achievements; show the next milestone and the next prestige unit; disabled (grey) buttons
when unaffordable; keep ≤ 4–5 rows visible with `arrows`.

## Balance simulation (harness)
`balance(pkg, {hours=2, dt=1, prestigeRatio=2, stallSeconds=180})` in `kits/tycoon/harness.ts` (or
`npx tsx kits/tycoon/cli.ts balance <packageDir> [--hours 2]`; runs headless on the C++ engine, `dreamsy-tool eval`) runs
`@kit/tycoon/balance` on the package's own data (greedy player: buys the best payback among generators/upgrades/managers, taps for the first minute of a
run, restarts manual gens every 3 s, claims events, resets when the prestige bonus would double or when stuck) and returns
`{firstPrestige, prestiges[{t,gain}], unlocks, firstBuy, allGeneratorsAt, allUpgradesAt, purchases, gaps{median,p90,max}, stalls[], smooth, samples[{t,income,allTime}], final}`
(seconds). In Luau: `B.runner(content?, opts)` → `{advance(seconds) → done, report(), state}` (each script call has a 250 ms budget —
advance in slices across ticks), or `B.simulate(content, opts)` for short runs.

## Do / don't
- Do keep all numbers in data; script only UI. Do call `t:step(dt)` once per tick and refresh text ~10×/s, not every tick.
- Do persist every few seconds and after prestige; saves are ~2–4 KB (64 KB limit).
- Don't spawn/destroy rows every frame — build once per tab, update texts. Don't put real money (Stars) on random rewards.
- Don't exceed ~1e300 in content.
- With `core.setup()`, pass `achievements = {}` (or `data`): otherwise core also loads the tycoon's `data/achievements/*.json`.
