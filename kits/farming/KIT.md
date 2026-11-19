# farming kit

Cozy life sim: a calendar (days, seasons, weekdays, weather, festivals), energy, tile farming on a TileMap2D (till →
plant → water → grow stages → harvest, regrow, fertilizer, sprinklers, season withering), animals with products, a
shipping bin paid at night, shops, crafting, villagers who walk schedules over a location graph, gifts + friendship
hearts + heart-event dialogs, collections/museum, house/farm upgrades, save every morning, and a pacing bot that plays
the real rules to chart the income curve. Thin layer: money/items = `core.wallet`/`core.bag`, dialogs = `core.dialog`,
menus = `core.menus`, upgrades = a `progression` tree, farming level = a `progression` leveler, paths = `ai.graphPath`,
feedback = `juice`. Requires core, progression, juice, ai (enabled automatically). Example: `games/examples/kit-farming`.

## Setup
```toml
kits = ["farming"]
[physics]
layers = ["player", "world"]
```
```luau
local Farming = require("@kit/farming")
local farm, loaded = Farming.start({ core = { save = { key = "myfarm", version = 1 }, theme = { primary = "#4f8a5b", font = "rounded" } } })
local view = Farming.bind(farm, { map = entity("map"), player = entity("player"), solid = "TfWB", wake = vec2(216, 464),
  pens = { coop = { x = 672, y = 528, w = 192, h = 96 } } })
```
`start` = `core.setup` + load content from `data/` + `Farming.new` + `core.save.load()` (first launch: `config.startItems`,
`cfg.newGame(farm)`). Call it once from the scene script or a session script; it returns the same farm on later calls
(`Farming.current()`). `bind` draws one scene; call it in each scene script that shows the farm/town.

## Scene contract (bind)
- `map`: TileMap2D. Tiles tagged `soil` (tileset `"tags": ["soil"]`) are tillable; tilled/watered cells are drawn with tileset
  chars `tiles = { tilled = "t", watered = "w" }` (define both). Untilled cells restore their original char.
- `player`: dynamic Body2D (`gravity_scale = 0`, `lock_rotation`, circle ~30 px, `mask = "world"`) with a Sprite2D child. Joystick
  moves (`input.axis`); **tap a tile** → walks there (A* if `solid = "chars"` given, else straight) → `farm:smart(c, r, selected)`.
- Props (any 2D entity, tap → walk → act) by tag: `farm_bed` (sleep confirm), `farm_bin` (ship menu), `farm_shop` (shop id = the
  entity's `name`), `farm_craft`, `farm_coop`/`farm_barn` (feed all + collect all), `farm_museum` (collections), `farm_festival` (attend).
- Villagers are spawned by the kit (Sprite2D `sprite`, name tag); tap → talk (daily +friendship, heart events) → "Give <selected>?".
- Animals are spawned inside `opts.pens[building]` rects; tap → collect product + pet + feed.
- HUD (top): date, clock, weather, gold (rolls up), energy bar; hotbar row at y = 136 (Hand + 4 stacks + Bag) and a Menu button
  (Bag, Crafting, Friends, Collections, Calendar). Evening tint from 18:00. Keep rows 0–4 of the world (≈ 240 px) as scenery under the HUD.
- `bind` opts: `map, player` (required), `soilTag = "soil"`, `tiles`, `solid?`, `speed = 240`, `reach = 1.6` (tiles), `wake` (Vec2),
  `pens`, `theme = { panel, text, accent }`, `hud/hotbar/menuButton/nightTint = true`, `anims?` (player has walk/idle),
  `onInteract(e, tag) -> handled`, `onDay(report)`.
- view: `view.refresh()` (redraw field) · `view.select(itemId|nil)` · `view.selected()` · `view.openMenu()` · `view.sleep()` (fade + sleep) ·
  `view.interact(e, tag)` · `view.refreshHotbar()` · `view.refreshAnimals()` · `view.hud` · `view.stop()`.
- End of day (bed or passing out at `dayEnd`): fade → `farm:sleep()` → player to `wake` → summary modal (shipped items, earned roll-up,
  weather, festival, withered crops) → autosave.

## Farm API (pure state; `Farming.new(content?, opts?)` for tests/sims)
`Farming.new(C?, { isSoil = fn(c, r), save = true, autosave = true, upgrades = defs?, upgradeTree = "farm_upgrades" })` — C = raw table
`{ config, crops, animals, villagers, festivals, recipes, shops, collections }` (lists or id maps) or nil (= data files).
```luau
-- calendar / time
farm.day farm.season (index) farm.year farm.dayCount farm.minute farm.weather farm.forecast
farm:date() -> {day, season, seasonName, year, weekday, dayCount}   farm:seasonId()   farm:weekday()   farm:clock() -> "9:40 AM"
farm:tick(dt) (real s; dayLength s per day)   farm:advance(minutes) (reaching dayEnd = pass out)   farm:daysLeftInSeason()
farm:festivalToday()  farm:festivalOn(season, day)  farm:festivalActive()  farm:attendFestival() -> ok, def   farm:isWet()
farm:sleep(passedOut?) -> report {earned, shipped={{item,count,value}}, grown, died, products, passedOut, fine?, season?, weather, festival}
-- energy (stat max_energy)
farm.energy  farm:maxEnergy()  farm:cost(action)  farm:spendEnergy(action) -> bool  farm:restoreEnergy(n)
-- field (cells = TileMap cols/rows)
farm:till(c, r) farm:plant(c, r, seedItem) farm:water(c, r) -> ok, n  farm:fertilize(c, r, item) farm:harvest(c, r) -> ok, count, quality
farm:place(c, r, item) farm:pickUp(c, r) farm:untill(c, r)   farm:smart(c, r, selected?) -> ok, action, info   -- the one tap verb
farm:plot(c, r) -> {tilled, watered, crop?, days, dead?, fert?}  farm:stage(p) farm:isReady(p) farm:inSeason(crop, season?) farm:canMature(crop)
-- animals
farm:buyAnimal(kind, name?) -> ok, a|reason("full"|"gold")  farm:feed(uid) farm:feedAll() farm:pet(uid) farm:collect(uid) farm:collectAll()
farm.animals = { {uid, kind, name, friendship 0..1000, age, fed, petted, ready = productId?} }  farm:capacity(building) farm:animalCount(building)
-- money
farm:price(item) (value × sell_mult)  farm:ship(item, n?) farm:unship(item) farm:binValue()
farm:shopOpen(shop) -> ok, reason("closed_today"|"hours"|"locked")  farm:stock(shop) -> { {item|animal|upgrade, name, price, available, reason} }
farm:buy(shop, itemOrAnimalOrUpgrade, n?) -> ok, reason("gold"|"bag_full"|"season"|"locked"|...)
-- crafting
farm:recipes() -> { {id, def, ok, reason, missing} }  farm:canCraft(id) farm:craft(id)  farm:recipeUnlocked(id)
-- villagers
farm:talk(id) -> {lines, first, heartEvent?, speaker, portrait}  farm:gift(id, item) -> ok, taste("love"|"like"|"neutral"|"dislike"|"hate") | reason
farm:hearts(id) farm:friend(id) -> {points, talked, gifted, events}  farm:addFriendship(id, n)  farm:isBirthday(id)
farm:pendingHeartEvent(id) -> ev, evId   farm:markHeartEvent(id, ev)   farm:where(id, minute?) -> {x, y, loc, moving}
-- upgrades (progression tree "farm_upgrades", data/upgrades/*.json) + stats
farm:buyUpgrade(id) farm:upgradeList() farm.upgrades (prog tree) farm:stat(name)    farm.level (prog leveler "farming": XP per harvest)
-- collections
farm:donate(col, item) farm:collectionProgress(col) -> have, total, rows   farm:checkCollection(col)
-- history / events
farm:incomeHistory() -> { days = {gold/day}, seasons = { {id, total} } }   farm:on(name, fn) -> {disconnect}
```
Stats (upgrade `mods`, `prog.stats.apply`): `max_energy` (config energy.max), `coop_capacity`/`barn_capacity`/`<building>_capacity`
(config.animals.buildings), `water_area` (1 = tile, 3 = row of 3, 9 = 3×3), `sell_mult` (1), `quality_chance`, `speed_bonus`.
Events (farm:on and core events, so quests/achievements can count them): `tilled planted watered fertilized harvested{crop,count,quality}
placed picked_up cleared item_binned item_bought item_crafted animal_bought animal_petted product_collected talked{villager,first}
gift_given{villager,item,taste} heart_up{villager,hearts} heart_event festival_attended donated collection_reward upgrade_bought
too_tired hour season_changed day_started(report)`.

## Rules
- Growth: a crop advances 1 day per night **if watered that day** (rain/storm days water every plot at dawn; sprinklers water their cells
  at dawn). Stage = cumulative `stages`; ready after the last. Regrow crops go back to `growDays - regrow`. A season change withers crops
  whose `seasons` don't include the new one (harvest = clear). Speed fertilizer: chance per night of +1 day.
- Quality (1..3: normal/Silver/Gold) from fertilizer quality, farming level and `quality_chance` → `config.quality.bonus` extra items.
- Shipping: bin contents are paid at sleep (`income[dayCount]`); `shipped` totals feed `"auto": "shipped"` collections.
- Friendship: talk +20 once/day, gift once/day (love 80, like 45, neutral 20, dislike −20, hate −40; ×8 on birthdays), 250 points per
  heart (max 10), −2/night when not talked to. Heart events fire on the next talk once `hearts ≥ ev.hearts` (core dialog `ev.dialog`).
- Weather: deterministic per day from `config.seed` + `weather[season]` weights; `weatherFixed["spring_1"]`; festivals are always sunny;
  `farm.forecast` = tomorrow.
- Schedules: entries `[minute, location]`; villagers walk from the previous entry's location along `config.locations` links
  (`ai.graphPath`) at `villagerSpeed` px/min; `hidden` locations = indoors (invisible). Priority: `<season>_<day>` > weather > weekday >
  season > default; festivals override `[start, end]` → festival location.
- Passing out at `dayEnd`: −`passOutFine` (10%, ≤ 1000) gold, wake with half energy. Save happens every morning (after sleep).

## Content files (schemas/)
- `data/farming.json` (`config.json`): `startGold, startItems, bagSlots, seasons [{id, name, days}], weekdays, dayStart (360), dayEnd (1560),
  dayLength (s), weather, weatherFixed, energy {max, costs {till, water, plant, harvest, pet}}, friendship, animals {pet, unfed, buildings},
  quality, villagerSpeed, locations {id: {x, y, links, hidden?}}, art {sprout, growing, dead}, levelCurve, balance {days, buy}`.
- `data/crops/<id>.json` (`crop.json`): `{ "name": "Radish", "seasons": ["spring"], "stages": [1,1,1], "regrow"?: 2, "yield": 1 | [1,3],
  "price": 40, "icon": "asset:radish", "sprites"?: [...], "seed": { "price": 15, "icon": "asset:radish_seeds" } }` → items `radish` + `radish_seeds`.
- `data/animals/<id>.json`: `{ "name", "building": "coop", "price", "feed": "hay", "matureDays", "productEvery", "product": "egg",
  "productPrice", "productIcon", "largeProduct"?, ..., "sprite" }` (large product chance = friendship/2000).
- `data/villagers/<id>.json`: `{ "name", "sprite", "portrait", "home", "birthday": {"season","day"}, "loves"/"likes"/"dislikes"/"hates":
  ["item" | "category:crop"], "schedule": {"default": [[360,"store_in"],[1080,"square"]], "rain": [...], "wed": [...]},
  "lines": {"default": [...], "hearts_2": [...], "rain": [...], "birthday": [...]}, "heartEvents": [{"hearts": 2, "dialog": "juniper_h2"}] }`.
- `data/festivals/<id>.json`: `{ "name", "season", "day", "start": 540, "end": 900, "location": "square", "dialog"?, "rewards": [effects] }`.
- `data/recipes/<id>.json`: `{ "name", "icon", "inputs": {"stone": 6}, "output"? (= id), "count"?, "unlock"?: cond, "value"?, "category"?,
  "data": {"placeable": true, "sprinkler": {"area": 4|8|24}} | {"fertilizer": {"quality": 1, "speed": 0.5}} }`.
- `data/shops/<id>.json`: `{ "name", "hours": [540, 1200], "closed": ["wed"], "stock": [ {"item": "radish_seeds"} (seed price from crop;
  seeds auto-hidden out of season), {"item": "hay", "price": 10}, {"animal": "hen"}, {"upgrade": "big_coop"}, {"item": "x", "condition": {...}, "showLocked": true} ] }`.
- `data/upgrades/<id>.json`: progression skill defs — `{ "name", "cost": {"gold": 2500}, "requires"?, "mods": [{"stat": "coop_capacity", "add": 4}], "effects"? }`.
- `data/collections/<id>.json`: `{ "name", "items": [...], "auto"?: "shipped", "rewards": {"3": [effects], "all": [effects]} }`.
- Plus core: `data/items/*.json` (materials/feed with icons), `data/dialog/*.json` (heart events, festivals), `data/quests`, `data/achievements`.

## Pacing — `Farming.balance.run(C?, opts?)`
A greedy bot plays the real rules: harvest → collect/feed/pet → ship everything → buy `config.balance.buy` in order → place sprinklers →
plant owned seeds, then the best value/day crop the shops sell today, as far as energy allows → water → sleep.
`opts = { days?, field = {w, h}, buy?, saveRate = 0, energyUse = 0.9, log? }` → `{ days = {{day, season, gold, earned, plots, crop}},
seasons = {{id, total, perDay}}, purchases = {{what, day}}, firstHarvestDay, totalEarned, finalGold, playMinutes, bestCrop }`.
Example (Mossbell, 1 × 20-day spring, 4 min/day): income per 5 days 630 → 660 → 1125 → 5075, copper can day 5, hens day 17–18,
comfy bed day 20, first harvest day 4, ≈ 80 min of play. Bots don't socialize or chase festivals, so real players earn a bit less but
unlock more (quests, collection rewards).

## How to build a 1–2 h farming game
- **Time**: `dayLength` 180–300 s; 1 season of 20–28 days ≈ 1–2 h, or 2 short seasons of 12–14 days. Pass-out penalty keeps nights honest.
- **Crops**: 8–12 per season — 2–3 fast cheap (3–4 days), 3–4 mid (5–7), 1–2 regrow, 1 "jackpot" (10–13 days, unlocked mid-season).
  Margin ≈ (price × yield − seed) / days should rise from ~8 g/day (starter) to ~25 g/day (late). Give 10–15 starter seeds.
- **Economy**: 4–6 upgrades from ~1 day of income (can) to ~5 days (barn); 2 animals (cheap daily product, pricier every-2-days product);
  2–4 artisan recipes (jam/cheese ≈ 3–4× inputs). Energy: ~100–150, till 2 / water 1 → ~40–60 plots/day before upgrades.
- **People**: 4–6 villagers × (6–10 lines + 2 heart events at 2/4 hearts + birthday + rain lines + schedule with 4–6 stops + weekday
  variant); 1 festival per ~10 days with a reward that unlocks content (new seeds/recipe).
- **Goals**: 3–6 core quests (first harvest, meet X, ship N, gifts), a collection with rewards at thresholds (unlocks the jackpot crop),
  a shipping log, 3–5 achievements; a season wrap-up message.
- Check with `Farming.balance.run` that first harvest ≤ day 4, the first upgrade lands in the first third, and the last 5 days earn
  ≥ 3× the first 5.

## Do / don't
- Do keep all numbers in data; reference items by id; give every crop/seed/product an `icon` (hotbar + bag grid show it).
- Do define tileset chars for tilled/watered soil and tag tillable tiles `soil`; keep buildings as solid tiles + Sprite2D art on top.
- Do put tappable props in the scene with the `farm_*` tags; give shops the entity `name` of their shop id.
- Don't move the player's velocity yourself while bound (the view owns it); use `view.select` / `farm:*` calls instead.
- Don't save Vec2/entities in custom state; the farm saves itself (core save section "farming").
