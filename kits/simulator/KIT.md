# simulator kit

Roblox-style collect/upgrade simulators: tap (or auto-swing) nodes → fill a backpack → sell → buy better tools/backpacks →
unlock zones with tougher, richer nodes → hatch pet companions from eggs bought with **in-game coins** → rebirth for a
permanent coin bonus. Offline earnings, quests/daily rewards, leaderboard-ready stats. Portrait UI pieces included.
Thin layer: coins = `core.wallet`, events → `core.events` (quests/achievements count them), save = a `core.save` section,
rebirth = a progression prestige layer (`"rebirth"`), daily = `prog.streak`, feel = juice.
Example: `games/examples/kit-simulator` (Pebble Pals: 4 zones, 6 tools, 4 backpacks, 12 pets in 3 eggs, 8 quests, rebirth).

## Setup
```toml
kits = ["simulator"]        # pulls in core, progression, juice (kit.json requires)
orientation = "portrait"
```
```luau
-- scripts/shared/game.luau (call G.get() from the scene script; start once per session)
local Sim = require("@kit/simulator")
local s, offline = Sim.start({
  core = { save = { key = "mygame", version = 1 }, theme = { primary = "#4f8fd6", accent = "#ffcf3f", background = "#3a2f4a", text = "#fffaf0", font = "rounded" } },
  daily = { rewards = { { { earn = "coins", amount = 100 } }, { { hatch = "meadow_egg" } } } },   -- optional prog.streak
})
-- scene script (attached to the scene root): UI
local UI = Sim.ui
UI.hud(s, { coinIcon = "asset:coin", bagIcon = "asset:bag" })
UI.field(s, { area = { 40, 230, 640, 770 }, count = 6, size = 140, ground = entity("ground"), shadow = "asset:shadow", ring = "asset:ring" })
UI.bar({ { label = "SELL", wide = true, onPress = function() UI.sellFx(s, s:sell(), vec2(360, 860), camera.screenToWorld(vec2(60, 50))) end },
         { label = "Eggs", onPress = function() UI.eggs(s) end }, { label = "Pets", onPress = function() UI.pets(s) end },
         { label = "Map", onPress = function() UI.zones(s) end } })
if offline then UI.offline(s, offline) end
```
`Sim.start(opts)` = content from data files (`data.read`), `core.setup` (quests/achievements/dialog from `data/<kind>/`),
`core.save.load()`, offline credit (`clock.now()`), autosave every `opts.autosave` (10 s) + play-time stat as **session** code
(`game.session`), condition/effect kinds bound. Returns `sim, offlineReport|nil`. `Sim.current()` = that sim.
`Sim.new(content?, { headless?, rand?, now?, autoEquip? (true) })` builds a bare sim (tests, balance; `headless` = private
wallet/layer, no events/save).

## Content files (schemas/*.json; id = file name)
```jsonc
// data/simulator.json
{ "currency": "coins", "currencyName": "Coins", "currencyIcon": "asset:coin", "petSlots": 3, "maxPets": 80,
  "offline": { "rate": 0.25, "capHours": 4, "minSeconds": 120 },
  "rebirth": { "threshold": 60000, "exponent": 0.4, "scale": 1, "bonus": 0.25, "zone": "canyon", "slotsPerRebirth": 1, "maxSlots": 6 },
  "rarities": [ { "id": "common", "name": "Common", "color": "#b8c0cc" }, … ] }        // default: common…mythic
// data/zones/creek.json — first zone (lowest order) is free; others pay unlock.coins once
{ "name": "Crystal Creek", "order": 2, "color": "#bfe6f2", "icon": "asset:zone_creek", "desc": "…",
  "unlock": { "coins": 1200, "rebirths": 0, "condition": {core cond}?, "hint": "…"? },
  "nodes": [ { "id": "crystal", "hp": 40, "reward": 16, "size": 1, "weight": 1, "sprite": "asset:node_crystal", "color": "#d6f6ff" } ] }
// data/tools/<id>.json   { "name", "order", "cost": 600, "power": 12, "speed": 1.5 (auto swings/s, 0 = tap only), "zone"?, "icon" }
// data/backpacks/<id>.json { "name", "order", "cost": 200, "capacity": 60, "zone"?, "icon" }
// data/pets/<id>.json    { "name", "rarity": "epic", "bonus": { "power": 0.5, "coins": 0.25, "capacity"?, "speed"?, "luck"? }, "icon" }
// data/eggs/<id>.json    { "name", "order", "cost": { "coins": 250 }, "zone"?, "icon", "pets": { "bun": 60, "snail": 28, "ladybug": 10, "clover_fox": 2 } }
```
Rules: tools/backpacks are tracks bought **in order** (the newest is auto-equipped); a node's `reward` is carried coin value,
`size` its backpack units; pet bonuses add up (`+0.25` = +25%); egg weights are the odds (any scale). Quests, achievements,
dialog: core kit files (`data/quests/*.json`, …) using the events/conditions below.

## Sim API (`s`)
```luau
-- money / multipliers
s:coins()  s:earn(n)  s:power()  s:speed()  s:capacity()  s:coinMultiplier() (= (1+pets.coins) × rebirth)  s:rebirthMultiplier()  s:petBonus() -> {power, coins, capacity, speed, luck}
-- collecting
local node = s:spawnNode(zoneId?)          -- { def, hp, maxHp, zone } weighted pick
s:hit(node, mult?) -> { damage, broken, value?, units?, full }   -- full bag: { full = true, damage = 0 } (nothing happens)
s:auto(dt, node) -> hit|nil                -- tool auto-swing (speed/s); UI.field does this for you
s.load  s.carried  s:isFull()  s:fill() (0..1)  s:sellValue()  s:sell() -> coins
-- gear tracks: kind = "tools" | "backpacks"
s:next(kind) -> def|nil   s:canBuy(kind, id) -> ok, "owned"|"order"|"zone"|"coins"   s:buy(kind, id)   s:equipGear(kind, id)   s:owns(kind, id)
s:gear(kind) -> { {def, state = "equipped"|"owned"|"next"|"locked", cost, reason} }    s.tool  s.pack  s:toolDef()  s:packDef()
-- zones
s:canUnlock(id) -> ok, "unlocked"|"order"|"rebirths"|"condition"|"coins"   s:unlockZone(id) (pays, travels)   s:travel(id)
s:zoneList() -> { {def, state = "current"|"unlocked"|"available"|"locked", cost, reason} }   s.zone  s:zoneDef(id?)  s:bestZone()
-- pets + eggs (coins only; odds always shown)
s:eggOdds(egg) -> { {pet, name, rarity, chance, percent = "12.5%"} }   s:canHatch(egg) -> ok, "zone"|"storage"|"coins"
s:hatch(egg) -> petId|nil, reason   s:roll(egg, r?) (no cost)   s:givePet(id, n?)   s:release(id)
s:equip(id)  s:unequip(id)  s:equipBest()  s:slots()  s:equippedCount()  s:petCount()  s:petList() (rarest first)  s.pets  s.equipped
s.petScore = function(self, def) … end     -- override ranking used by equipBest
-- rebirth (progression layer "rebirth": gain = floor(scale·(runCoins/threshold)^exponent); mult = 1 + points·bonus)
s:rebirthGain()  s:rebirthNext() (run coins for +1)  s:canRebirth()  s:rebirth() -> gain   -- resets coins, gear, zones, bag; keeps pets/stats
s.runCoins  s.layer (prog prestige layer: points, count)
-- offline (clock.now)
s:incomeRate(taps?) -> coins/s   s:offline(now?) -> {seconds, coins}|nil   s:claimOffline(now?, mult?)   s:touch(now?)
-- stats / leaderboards (local best; ready for a leaderboard service)
s:leaderboard() -> { coins, bestRun, rebirths, nodes, hatched, pets, zones, rarest, playTime }   s.best   s.stats
-- events
s:on(name, fn) -> { disconnect }   -- local listeners ("*" = all); also emitted on core.events
s:serialize(now?)  s:deserialize(t)   -- automatic via core.save section "simulator"
```
**Events** (core.events + `s:on`): `sim_collected` {node, zone, value} · `sim_sold` {coins} · `sim_bought` {kind, item} ·
`zone_unlocked` {zone} · `zone_entered` {zone} · `pet_hatched` {pet, rarity, egg, free?} · `rebirth` {gain, total, count} · `sim_offline` {coins, seconds}.
**Conditions:** `{"zone":"creek"}` `{"pet":"bun","count":2}` `{"gear":"iron_drill"}` `{"rebirths":1}` (+ progression `{"prestige":1,"layer":"rebirth"}`).
**Effects:** `{"pet":"bun"}` (give) · `{"hatch":"creek_egg"}` (free hatch, shown odds) · core `{"earn":"coins","amount":500}`.
Quest example: `{"title":"First Haul","autoStart":true,"steps":[{"id":"s1","text":"Collect 25 pebbles","objectives":[{"id":"o","event":"sim_collected","count":25}]}],"rewards":[{"earn":"coins","amount":40}]}`.

## UI (`Sim.ui`, portrait 720×1280; all optional)
```luau
UI.hud(s, { coinIcon?, bagIcon?, y?, height? (150), background? }) -> { root, refresh() }   -- coins pop, bag bar (amber >80%, red full), zone, bonus
UI.field(s, { area = {x,y,w,h}, count? (6), columns? (3), size? (110), sprite? fn(def, zone), ground? (Sprite2D tinted zone.color),
              shadow? asset, ring? asset (target marker), respawn? (0.6), popups? (true), auto? (true), onBreak?, onFull? })
   -> { slots, reset(), target(i), hitAt(i, mult?) }   -- taps, auto-swing on the target, hp bars, damage numbers, sparkle + "+value", bag-full toast
UI.bar({ {label, onPress, color?, icon?, wide?} }, { y? (1120), height? (120) }) -> { buttons }
UI.shop(s, "tools"|"backpacks")  UI.zones(s)  UI.eggs(s) (odds rows under every egg)  UI.pets(s) (equip/unequip/equip best)
UI.rebirth(s, { onDone? })  UI.daily(streak, { label? fn(reward, i) })  UI.quests()  UI.stats(s)  UI.offline(s, report)
UI.hatchReveal(s, petId, onDone?)  UI.sellFx(s, coins, fromWorld, toWorld?)  UI.sheet(title, function(add, h) add({icon?, title, sub?, color?, badge?, button = {label, onPress, enabled?, color?}, height?}) end)
UI.sfx = { hit, pop, sell, full, buy, hatch, rebirth, unlock, deny }   -- sfx ids (missing ids are ignored)
Sim.format.num(1234567) -> "1.23M"   Sim.format.time(125) -> "2m 05s"   Sim.format.pct(0.25) -> "+25%"
```

## Balance sim
`Sim.balance.run(content, { hours = 2, taps = 4, trip = 6, eggShare = 0.3, stuckMinutes = 6, stallMinutes = 5 })` — greedy player
(taps + auto-swing, sells early when that affords the next target, buys the cheapest next zone/tool/backpack, puts 30% of sales
toward eggs + equips best, rebirths when the next target is > 6 min away) → `{ zones = {{id, t}}, gear, rebirths = {{t, gain}},
firstRebirth, eggs, events, gaps = {max, median, at}, stalls = {{from, to, minutes}}, ok, final }` (seconds). Run it in a test
(see `engine/tests/kits/simulator_test.cpp`). Pebble Pals: creek 8.8 min, canyon 20 min, first rebirth 29 min, peak 53 min,
star hammer 71 min, longest gap between progress events 4m57s.

## How to build a 1–2 hour game
**Content counts:** 4–6 zones (2 nodes each: a common one + a 3× tougher "rare" one at weight 0.35), 6–8 tools, 4–5 backpacks,
3–4 eggs × 4 pets (rarities ~60/28/10/2 %; the last egg holds a mythic ~1%), 6–10 chained quests (one per milestone: first
haul, first sell, first tool, first egg, each zone, first rebirth), a 7-day daily streak, 1 rebirth layer.
**Curves (Pebble Pals, proven by the sim):** zone i node hp ≈ 3·12^i, reward ≈ hp × 0.35–0.5 (deeper zones pay ~10× more per
hit); tool power ≈ 3–4× per step, speed 0 → 3/s; backpack capacity ≈ 4–5× per step; costs: next item ≈ 2–4 min of current
income (`s:incomeRate(4)`), zone i+1 ≈ 1.5× the tool that makes it one/two-shot. Gate the last zone behind 1–2 rebirths.
Rebirth `exponent 0.4`, `bonus 0.25`, `threshold` ≈ the run coins you expect at minute 25–30 ÷ 2^(1/exponent).
**Pacing targets:** first tool < 1 min, zone 2 at 6–10 min, zone 3 at 15–25, first rebirth 25–35, final zone 45–70, last tool
60–90 min, longest gap between progress events < 5 min (`gaps.max`), eggs as a coin sink between purchases.
**Feel:** big tap targets (≥ 120 px), damage numbers + sparkle + "+value" on break, bag bar turns amber/red, SELL is the widest
button, coin burst flying to the HUD on sell, confetti on unlock/rebirth/epic+ pets, toast every quest.

## Do / don't
- Do keep numbers in data; script only layout. Do call `Sim.start` once (shared module guard) and build UI per scene.
- Do show egg odds (`UI.eggs` does) and price eggs in coins only. **Never** sell eggs, pets or luck for Stars (kids platform rule);
  Stars passes may only grant cosmetic or convenience perks (e.g. an extra pet slot), never random rewards.
- Do use `core.events.onScene` in scene scripts (plain `s:on` listeners outlive the scene).
- Don't edit sim fields directly in game code (use the methods; the save shape depends on them).
- Offline earnings need `clock.now()` (headless playtests use a fixed clock, so offline is 0 there).
