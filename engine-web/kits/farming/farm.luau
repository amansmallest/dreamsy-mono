--!nonstrict
-- The farm: one state object for calendar, energy, field, animals, shipping/shops, crafting, villagers,
-- festivals, upgrades and collections. Pure logic (no entities) — the view module draws it.
-- Money and items live in core.wallet / core.bag; upgrades are a progression tree; save = core.save section "farming".
local core = require("@kit/core")
local prog = require("@kit/progression")
local Content = require("./content")
local V = require("./villagers")

local M = {}
local Farm = {}
Farm.__index = Farm
M.Farm = Farm

local function key(c, r) return c .. "," .. r end
M.key = key
local function unkey(k) local c, r = string.match(k, "^(-?%d+),(-?%d+)$") return tonumber(c), tonumber(r) end
M.unkey = unkey

-- deterministic hash rng: h(seed, a, b) -> [0, 1)
local function hash(...)
	local h = 2166136261
	for _, v in { ... } do
		local n = math.floor(v) % 4294967296
		for _ = 1, 4 do
			h = bit32.bxor(h, n % 256)
			h = (h * 16777619) % 4294967296
			n = math.floor(n / 256)
		end
	end
	return (h % 1000003) / 1000003
end
M.hash = hash

-- new(C (Content.normalize / load), opts?) -> farm
-- opts: { isSoil = fn(c, r) -> bool (default true), save = true (register core save section "farming"), autosave = true (save after sleep),
--         upgrades = defs? (else data/upgrades/*.json), rand = fn() -> [0,1)?, name? }
function M.new(C, opts)
	opts = opts or {}
	local cfg = C.config
	core.wallet.define(cfg.currency, { name = cfg.currencyName or "Gold", icon = cfg.currencyIcon, start = cfg.startGold, max = cfg.maxGold or 99999999 })
	Content.registerItems(C)
	local f = setmetatable({ C = C, cfg = cfg, opts = opts, listeners = {} }, Farm)
	f.isSoil = opts.isSoil or function() return true end
	-- upgrades: progression tree (house, coop/barn size, tools, backpack) with stat mods
	local udefs = opts.upgrades
	if udefs == nil then
		if #core.content.all("upgrades") == 0 then core.content.load("upgrades") end
		udefs = core.content.all("upgrades")
	end
	f.upgrades = prog.tree({ name = opts.upgradeTree or "farm_upgrades", defs = udefs })
	f.level = prog.leveler({ name = "farming", curve = cfg.levelCurve or { kind = "quadratic", base = 20, linear = 80, maxLevel = 10 } })
	f:reset()
	if opts.save ~= false then
		core.save.section("farming", {
			serialize = function() return f:serialize() end,
			deserialize = function(_, t) if t then f:deserialize(t) else f:reset() end end,
			reset = function() f:reset() end,
		})
	end
	return f
end

function Farm:reset()
	local cfg = self.cfg
	self.day = 1 self.season = 1 self.year = 1 self.dayCount = 1
	self.minute = cfg.dayStart
	self.weather = "sunny"
	self.forecast = self:rollWeather(2)
	self.energy = self:stat("max_energy")
	self.plots = {} self.objects = {}
	self.animals = {} self.animalSerial = 0
	self.friends = {} -- villager id → { points, talked (day), gifted (day), events = {seen ids} }
	self.bin = {} -- item → count (shipped at sleep)
	self.shipped = {} -- item → total shipped (collection "shipped")
	self.donated = {} -- collection id → { item = true }
	self.rewarded = {} -- collection id → { [threshold] = true }
	self.festivals = {} -- festival id → year attended
	self.income = {} -- dayCount → gold earned that day (shipping)
	self.lastReport = nil
	self.passedOut = false
end

-- ---------------- events ----------------
function Farm:on(name, fn)
	local l = self.listeners[name] or {}
	self.listeners[name] = l
	table.insert(l, fn)
	return { disconnect = function() local i = table.find(l, fn) if i then table.remove(l, i) end end }
end
function Farm:emit(name, d)
	for _, fn in table.clone(self.listeners[name] or {}) do fn(d) end
	for _, fn in table.clone(self.listeners["*"] or {}) do fn(name, d) end
	core.events.emit(name, d or {})
end

-- ---------------- stats (upgrades) ----------------
local BASE = { max_energy = "energy.max", coop_capacity = "coop", barn_capacity = "barn", water_area = 1, sell_mult = 1, quality_chance = 0, speed_bonus = 0, bag_slots = 0 }
function Farm:stat(name)
	local base = BASE[name]
	if base == "energy.max" then base = self.cfg.energy.max
	elseif base == "coop" or base == "barn" then
		local b = self.cfg.animals.buildings[base]
		base = if b then b.capacity else 0
	elseif base == nil then base = 0 end
	local mods = self.upgrades and self.upgrades:mods() or {}
	return prog.stats.apply({ [name] = base }, mods)[name]
end
function Farm:buyUpgrade(id)
	local ok, why = self.upgrades:unlock(id)
	if ok then self:emit("upgrade_bought", { upgrade = id }) end
	return ok, why
end
function Farm:upgradeList() return self.upgrades:list() end

-- ---------------- calendar ----------------
function Farm:seasonDef(i) return self.cfg.seasons[i or self.season] end
function Farm:seasonId() return self:seasonDef().id end
function Farm:weekday(dayCount) local w = self.cfg.weekdays return w[((dayCount or self.dayCount) - 1) % #w + 1] end
function Farm:date() return { day = self.day, season = self:seasonId(), seasonName = self:seasonDef().name, year = self.year, weekday = self:weekday(), dayCount = self.dayCount } end
-- (season, day, year) after n days
function Farm:dateAfter(n)
	local d, s, y = self.day, self.season, self.year
	for _ = 1, n do
		d += 1
		if d > self.cfg.seasons[s].days then d = 1 s += 1 if s > #self.cfg.seasons then s = 1 y += 1 end end
	end
	return d, s, y
end
function Farm:daysLeftInSeason() return self:seasonDef().days - self.day end
function Farm:festivalOn(seasonId, day)
	for _, id in self.C.festivalsOrder do
		local fe = self.C.festivals[id]
		if fe.season == seasonId and fe.day == day then return fe end
	end
	return nil
end
function Farm:festivalToday() return self:festivalOn(self:seasonId(), self.day) end
-- weather for dayCount n: festivals are sunny; season table cfg.weather[season] or default ({ sunny = .7, rain = .3 })
function Farm:rollWeather(n)
	local d, s = self.day, self.season
	if n > self.dayCount then d, s = self:dateAfter(n - self.dayCount) end
	local sid = self.cfg.seasons[s].id
	if self:festivalOn(sid, d) then return "sunny" end
	if self.cfg.weatherFixed and self.cfg.weatherFixed[sid .. "_" .. d] then return self.cfg.weatherFixed[sid .. "_" .. d] end
	local t = self.cfg.weather[sid] or self.cfg.weather.default
	local keys = {}
	local total = 0
	for k, w in t do table.insert(keys, k) total += w end
	table.sort(keys)
	local x = hash(self.cfg.seed, n, 77) * total
	for _, k in keys do
		x -= t[k]
		if x < 0 then return k end
	end
	return keys[#keys] or "sunny"
end
function Farm:isWet() local w = self.weather return w == "rain" or w == "storm" end
-- clock: minutes since midnight → "9:40 AM"
function M.clockText(minute)
	local m = math.floor(minute / 10) * 10
	local h = math.floor(m / 60) % 24
	local mm = m % 60
	local ampm = if h < 12 then "AM" else "PM"
	local h12 = h % 12
	if h12 == 0 then h12 = 12 end
	return string.format("%d:%02d %s", h12, mm, ampm)
end
function Farm:clock() return M.clockText(self.minute) end
-- advance(minutes): passes time; reaching dayEnd makes the farmer pass out (sleep with penalty)
function Farm:advance(minutes)
	if self.minute >= self.cfg.dayEnd then return end
	local before = self.minute
	self.minute = math.min(self.cfg.dayEnd, self.minute + minutes)
	if math.floor(before / 60) ~= math.floor(self.minute / 60) then self:emit("hour", { minute = self.minute }) end
	if self.minute >= self.cfg.dayEnd then self:sleep(true) end
end
-- tick(dt): real seconds → game minutes (cfg.dayLength seconds per day)
function Farm:tick(dt)
	local rate = (self.cfg.dayEnd - self.cfg.dayStart) / self.cfg.dayLength
	self:advance(dt * rate)
end

-- ---------------- energy ----------------
function Farm:maxEnergy() return self:stat("max_energy") end
function Farm:cost(action) return self.cfg.energy.costs[action] or 0 end
function Farm:spendEnergy(action)
	local c = self:cost(action)
	if c <= 0 then return true end
	if self.energy < c then self:emit("too_tired", { action = action }) return false end
	self.energy -= c
	return true
end
function Farm:restoreEnergy(n) self.energy = math.min(self:maxEnergy(), self.energy + n) end

-- ---------------- field ----------------
function Farm:plot(c, r) return self.plots[key(c, r)] end
function Farm:cropDef(id) local d = self.C.crops[id] if not d then error("farming: unknown crop \"" .. tostring(id) .. "\"", 3) end return d end
-- stage index (1-based, #stages + 1 = ready) for a plot
function Farm:stage(p)
	if not p or not p.crop then return 0 end
	local d = self:cropDef(p.crop)
	local acc = 0
	for i, n in d.stages do
		acc += n
		if p.days < acc then return i end
	end
	return #d.stages + 1
end
function Farm:isReady(p) return p ~= nil and p.crop ~= nil and not p.dead and self:stage(p) > #self:cropDef(p.crop).stages end
function Farm:inSeason(cropId, seasonId)
	for _, s in self:cropDef(cropId).seasons do if s == (seasonId or self:seasonId()) then return true end end
	return false
end
-- days a crop planted today needs (with speed fertilizer) / whether it can mature before the season ends
function Farm:canMature(cropId)
	local d = self:cropDef(cropId)
	if not self:inSeason(cropId) then return false end
	-- multi-season crops: count consecutive seasons it grows in
	local left, s = self:daysLeftInSeason(), self.season
	for _ = 1, #self.cfg.seasons - 1 do
		s = s % #self.cfg.seasons + 1
		if self:inSeason(cropId, self.cfg.seasons[s].id) then left += self.cfg.seasons[s].days else break end
	end
	return d.growDays <= left
end

function Farm:till(c, r)
	if self.plots[key(c, r)] or self.objects[key(c, r)] then return false, "occupied" end
	if not self.isSoil(c, r) then return false, "not_soil" end
	if not self:spendEnergy("till") then return false, "tired" end
	local p = { tilled = true, watered = self:isWet(), days = 0 }
	self.plots[key(c, r)] = p
	self:emit("tilled", { col = c, row = r })
	return true
end
function Farm:untill(c, r) self.plots[key(c, r)] = nil self:emit("plot_changed", { col = c, row = r }) end
function Farm:plant(c, r, seedItem)
	local p = self:plot(c, r)
	if not p then return false, "not_tilled" end
	if p.crop then return false, "occupied" end
	local item = core.content.get("items", seedItem)
	local cropId = item and item.data and item.data.seedOf
	if not cropId then return false, "not_seed" end
	if not self:inSeason(cropId) then return false, "out_of_season" end
	if not core.bag:has(seedItem, 1) then return false, "no_seeds" end
	if not self:spendEnergy("plant") then return false, "tired" end
	core.bag:remove(seedItem, 1)
	p.crop = cropId p.days = 0 p.dead = nil p.harvests = 0
	self:emit("planted", { col = c, row = r, crop = cropId })
	return true
end
function Farm:water(c, r)
	local p = self:plot(c, r)
	if not p then return false, "not_tilled" end
	if p.watered then return false, "already" end
	if not self:spendEnergy("water") then return false, "tired" end
	local n = 0
	local area = math.floor(self:stat("water_area"))
	-- water_area 1 = one tile, 3 = a row of 3 (c-1..c+1), 9 = 3×3
	local cells = { { c, r } }
	if area >= 3 then cells = { { c - 1, r }, { c, r }, { c + 1, r } } end
	if area >= 9 then cells = {} for dc = -1, 1 do for dr = -1, 1 do table.insert(cells, { c + dc, r + dr }) end end end
	for _, cr in cells do
		local q = self:plot(cr[1], cr[2])
		if q and not q.watered then q.watered = true n += 1 self:emit("watered", { col = cr[1], row = cr[2] }) end
	end
	return true, n
end
-- fertilize(c, r, item): item def data.fertilizer = { quality = 0..2, speed = 0..1 } (before planting or while growing)
function Farm:fertilize(c, r, itemId)
	local p = self:plot(c, r)
	if not p then return false, "not_tilled" end
	if p.fert then return false, "already" end
	local item = core.content.get("items", itemId)
	local fert = item and item.data and item.data.fertilizer
	if not fert then return false, "not_fertilizer" end
	if not core.bag:has(itemId, 1) then return false, "none" end
	core.bag:remove(itemId, 1)
	p.fert = itemId
	self:emit("fertilized", { col = c, row = r, item = itemId })
	return true
end
local function fertOf(p)
	if not p.fert then return {} end
	local item = core.content.get("items", p.fert)
	return item and item.data and item.data.fertilizer or {}
end
-- quality tier 1..3 for a harvest (deterministic per day/cell)
function Farm:qualityFor(p, c, r)
	local fert = fertOf(p)
	local lvl = self.level and self.level.level or 1
	local chance = (fert.quality or 0) * 0.2 + (lvl - 1) * 0.03 + self:stat("quality_chance")
	local roll = hash(self.cfg.seed, self.dayCount, c * 1000 + r)
	if roll < chance * 0.35 then return 3 end
	if roll < chance then return 2 end
	return 1
end
function Farm:harvest(c, r)
	local p = self:plot(c, r)
	if not p or not p.crop then return false, "empty" end
	if p.dead then self.plots[key(c, r)] = { tilled = true, days = 0, watered = p.watered } self:emit("cleared", { col = c, row = r }) return true, 0 end
	if not self:isReady(p) then return false, "not_ready" end
	if not self:spendEnergy("harvest") then return false, "tired" end
	local d = self:cropDef(p.crop)
	local y = d.yield
	local n = if type(y) == "table" then y[1] + math.floor(hash(self.cfg.seed, self.dayCount, c, r, 5) * (y[2] - y[1] + 1)) else y
	local q = self:qualityFor(p, c, r)
	n += self.cfg.quality.bonus[q] or 0
	local added = core.bag:add(p.crop, n)
	if added < n then
		if added > 0 then core.bag:remove(p.crop, added) end
		return false, "bag_full"
	end
	local cropId = p.crop
	p.harvests = (p.harvests or 0) + 1
	if d.regrow then
		p.days = d.growDays - d.regrow
	else
		p.crop = nil p.days = 0 p.fert = nil
	end
	self.level:add(d.xp or math.max(1, math.floor(d.price / 10)))
	self:emit("harvested", { col = c, row = r, crop = cropId, count = n, quality = q, qualityName = self.cfg.quality.names[q] })
	return true, n, q
end
-- objects on cells (sprinklers, scarecrows, decorations): item def data.sprinkler = { area = 4 | 8 | 24 }
function Farm:place(c, r, itemId)
	if self.objects[key(c, r)] or (self.plots[key(c, r)] and self.plots[key(c, r)].crop) then return false, "occupied" end
	local item = core.content.get("items", itemId)
	if not (item and item.data and item.data.placeable) then return false, "not_placeable" end
	if not core.bag:has(itemId, 1) then return false, "none" end
	core.bag:remove(itemId, 1)
	self.plots[key(c, r)] = nil
	self.objects[key(c, r)] = { item = itemId }
	self:emit("placed", { col = c, row = r, item = itemId })
	return true
end
function Farm:pickUp(c, r)
	local o = self.objects[key(c, r)]
	if not o then return false end
	if core.bag:add(o.item, 1) < 1 then return false, "bag_full" end
	self.objects[key(c, r)] = nil
	self:emit("picked_up", { col = c, row = r, item = o.item })
	return true
end
function Farm:sprinklerCells(c, r, area)
	local out = {}
	if area >= 8 then
		local rad = if area >= 24 then 2 else 1
		for dc = -rad, rad do for dr = -rad, rad do if dc ~= 0 or dr ~= 0 then table.insert(out, { c + dc, r + dr }) end end end
	else
		out = { { c + 1, r }, { c - 1, r }, { c, r + 1 }, { c, r - 1 } }
	end
	return out
end
-- smart(c, r, selected?) -> did, action, info: the single "tap a tile" verb for touch play
--   ready → harvest · dead → clear · empty soil → till · tilled+seed selected → plant · fertilizer selected → fertilize
--   placeable selected → place · dry crop/tilled → water
function Farm:smart(c, r, selected)
	local p = self:plot(c, r)
	local item = selected and core.content.get("items", selected)
	local sdata = item and item.data or {}
	if self.objects[key(c, r)] then
		local ok, why = self:pickUp(c, r) return ok, "pick_up", why
	end
	if p and p.crop and (p.dead or self:isReady(p)) then local ok, n, q = self:harvest(c, r) return ok, "harvest", n, q end
	if not p then
		if sdata.placeable then local ok, why = self:place(c, r, selected) return ok, "place", why end
		local ok, why = self:till(c, r) return ok, "till", why
	end
	if sdata.seedOf and not p.crop then local ok, why = self:plant(c, r, selected) if ok or why ~= "no_seeds" then return ok, "plant", why end end
	if sdata.fertilizer and not p.fert then local ok, why = self:fertilize(c, r, selected) return ok, "fertilize", why end
	if not p.watered then local ok, n = self:water(c, r) return ok, "water", n end
	return false, "none", (if p.crop then "growing" else "tilled")
end

-- ---------------- animals ----------------
function Farm:animalDef(kind) local d = self.C.animals[kind] if not d then error("farming: unknown animal \"" .. tostring(kind) .. "\"", 3) end return d end
function Farm:capacity(building) return math.floor(self:stat(building .. "_capacity")) end
function Farm:animalCount(building)
	local n = 0
	for _, a in self.animals do if self:animalDef(a.kind).building == building then n += 1 end end
	return n
end
function Farm:buyAnimal(kind, name)
	local d = self:animalDef(kind)
	if self:animalCount(d.building) >= self:capacity(d.building) then return false, "full" end
	if not core.wallet.spend(self.cfg.currency, d.price) then return false, "gold" end
	self.animalSerial += 1
	local a = { uid = self.animalSerial, kind = kind, name = name or (d.name .. " " .. self.animalSerial), friendship = 0, age = 0, fed = false, petted = false, ready = nil }
	table.insert(self.animals, a)
	self:emit("animal_bought", { animal = kind, uid = a.uid })
	return true, a
end
function Farm:animal(uid) for _, a in self.animals do if a.uid == uid then return a end end return nil end
function Farm:pet(uid)
	local a = self:animal(uid)
	if not a or a.petted then return false end
	if not self:spendEnergy("pet") then return false, "tired" end
	a.petted = true
	a.friendship = math.min(1000, a.friendship + self.cfg.animals.pet)
	self:emit("animal_petted", { animal = a.kind, uid = uid })
	return true
end
-- feed(uid): consumes def.feed item (if any) from the bag
function Farm:feed(uid)
	local a = self:animal(uid)
	if not a or a.fed then return false, "already" end
	local d = self:animalDef(a.kind)
	if d.feed then
		if not core.bag:has(d.feed, 1) then return false, "no_feed" end
		core.bag:remove(d.feed, 1)
	end
	a.fed = true
	return true
end
function Farm:feedAll() local n = 0 for _, a in self.animals do if self:feed(a.uid) then n += 1 end end return n end
function Farm:collect(uid)
	local a = self:animal(uid)
	if not a or not a.ready then return false end
	if core.bag:add(a.ready, 1) < 1 then return false, "bag_full" end
	local item = a.ready
	a.ready = nil
	self:emit("product_collected", { animal = a.kind, item = item })
	return true, item
end
function Farm:collectAll() local n = 0 for _, a in self.animals do if self:collect(a.uid) then n += 1 end end return n end

-- ---------------- shipping, shops, prices ----------------
function Farm:price(itemId)
	local def = core.content.get("items", itemId)
	local v = (def and def.value) or 0
	return math.floor(v * self:stat("sell_mult") + 0.5)
end
function Farm:ship(itemId, n)
	n = n or core.bag:count(itemId)
	if n <= 0 or self:price(itemId) <= 0 then return 0 end
	if not core.bag:remove(itemId, n) then return 0 end
	self.bin[itemId] = (self.bin[itemId] or 0) + n
	self:emit("item_binned", { item = itemId, count = n })
	return n
end
function Farm:unship(itemId)
	local n = self.bin[itemId] or 0
	if n <= 0 then return 0 end
	local added = core.bag:add(itemId, n)
	self.bin[itemId] = if n - added > 0 then n - added else nil
	return added
end
function Farm:binValue() local t = 0 for id, n in self.bin do t += self:price(id) * n end return t end
-- shop stock today: { {item, price, name, available, reason} } (seasons, condition, open hours, weekday)
function Farm:shopOpen(shopId)
	local s = self.C.shops[shopId]
	if not s then error("farming: unknown shop \"" .. tostring(shopId) .. "\"", 2) end
	if s.closed and table.find(s.closed, string.lower(self:weekday())) then return false, "closed_today" end
	if s.hours and (self.minute < s.hours[1] or self.minute >= s.hours[2]) then return false, "hours" end
	if s.condition and not core.check(s.condition) then return false, "locked" end
	return true
end
function Farm:stock(shopId)
	local s = self.C.shops[shopId]
	local out = {}
	for _, e in s.stock do
		local itemId = e.item
		local crop = nil
		for _, cd in self.C.crops do if cd.seed.id == itemId then crop = cd end end
		local price = e.price or (crop and crop.seed.price) or (function() local d = core.content.get("items", itemId) return d and d.value and d.value * 2 or 0 end)()
		local ok, why = true, nil
		if e.seasons and not table.find(e.seasons, self:seasonId()) then ok, why = false, "season" end
		if ok and crop and e.seasons == nil and not self:inSeason(crop.id) then ok, why = false, "season" end
		if ok and e.condition and not core.check(e.condition) then ok, why = false, "locked" end
		if e.animal then
			local d = self:animalDef(e.animal)
			price = e.price or d.price
		end
		if e.upgrade then
			local c = self.upgrades:cost(e.upgrade)
			price = c[self.cfg.currency] or 0
			local can, w = self.upgrades:canUnlock(e.upgrade)
			if not can and w ~= "cost" then ok, why = false, w end
		end
		if ok or e.showLocked then
			local def = itemId and core.content.get("items", itemId)
			table.insert(out, { item = itemId, animal = e.animal, upgrade = e.upgrade, price = price, available = ok, reason = why,
				name = e.name or (def and def.name) or (e.animal and self:animalDef(e.animal).name) or (e.upgrade and self.upgrades.defs[e.upgrade].name) or itemId })
		end
	end
	return out
end
function Farm:buy(shopId, itemOrRow, n)
	n = n or 1
	local ok, why = self:shopOpen(shopId)
	if not ok then return false, why end
	local row = itemOrRow
	if type(itemOrRow) == "string" then
		row = nil
		for _, r in self:stock(shopId) do if r.item == itemOrRow or r.animal == itemOrRow or r.upgrade == itemOrRow then row = r end end
	end
	if not row then return false, "not_sold" end
	if not row.available then return false, row.reason end
	if row.animal then return self:buyAnimal(row.animal) end
	if row.upgrade then return self:buyUpgrade(row.upgrade) end
	if not core.bag:canAdd(row.item, n) then return false, "bag_full" end
	if not core.wallet.spend(self.cfg.currency, row.price * n) then return false, "gold" end
	core.bag:add(row.item, n)
	self:emit("item_bought", { item = row.item, count = n, shop = shopId })
	return true
end

-- ---------------- crafting ----------------
function Farm:recipeUnlocked(id)
	local r = self.C.recipes[id]
	return r ~= nil and (r.unlock == nil or core.check(r.unlock))
end
function Farm:canCraft(id)
	local r = self.C.recipes[id]
	if not r then return false, "unknown" end
	if not self:recipeUnlocked(id) then return false, "locked" end
	for item, n in r.inputs do if not core.bag:has(item, n) then return false, "missing", item end end
	if r.gold and not core.wallet.has(self.cfg.currency, r.gold) then return false, "gold" end
	if not core.bag:canAdd(r.output, r.count) then return false, "bag_full" end
	return true
end
function Farm:craft(id)
	local ok, why, detail = self:canCraft(id)
	if not ok then return false, why, detail end
	local r = self.C.recipes[id]
	for item, n in r.inputs do core.bag:remove(item, n) end
	if r.gold then core.wallet.spend(self.cfg.currency, r.gold) end
	core.bag:add(r.output, r.count)
	self:emit("item_crafted", { recipe = id, item = r.output, count = r.count })
	return true
end
function Farm:recipes()
	local out = {}
	for _, id in self.C.recipesOrder do
		local ok, why, detail = self:canCraft(id)
		if why ~= "locked" or self.C.recipes[id].showLocked then table.insert(out, { id = id, def = self.C.recipes[id], ok = ok, reason = why, missing = detail }) end
	end
	return out
end

-- ---------------- villagers & friendship ----------------
function Farm:friend(id)
	if not self.C.villagers[id] then error("farming: unknown villager \"" .. tostring(id) .. "\"", 2) end
	local f = self.friends[id]
	if not f then f = { points = 0, events = {} } self.friends[id] = f end
	return f
end
function Farm:hearts(id) return math.min(self.cfg.friendship.maxHearts, math.floor(self:friend(id).points / self.cfg.friendship.perHeart)) end
function Farm:addFriendship(id, n)
	local f = self:friend(id)
	local before = self:hearts(id)
	f.points = math.clamp(f.points + n, 0, self.cfg.friendship.perHeart * self.cfg.friendship.maxHearts)
	local after = self:hearts(id)
	if after > before then self:emit("heart_up", { villager = id, hearts = after }) end
	return after
end
function Farm:isBirthday(id)
	local b = self.C.villagers[id].birthday
	return b ~= nil and b.season == self:seasonId() and b.day == self.day
end
-- talk(id) -> { lines, first (today), heartEvent? }: daily talk gives friendship; lines from def.lines[...]
function Farm:talk(id)
	local def = self.C.villagers[id]
	local f = self:friend(id)
	local first = f.talked ~= self.dayCount
	if first then f.talked = self.dayCount self:addFriendship(id, self.cfg.friendship.talk) end
	local ev = self:pendingHeartEvent(id)
	local h = self:hearts(id)
	local lines = nil
	local L = def.lines or {}
	local keys = { self:seasonId() .. "_" .. self.day, if self:isBirthday(id) then "birthday" else nil, if self:isWet() then "rain" else nil }
	for hh = h, 0, -1 do table.insert(keys, "hearts_" .. hh) end
	table.insert(keys, "default")
	for _, k in keys do
		if k and L[k] then lines = L[k] break end
	end
	lines = lines or { "Hello!" }
	if type(lines) == "string" then lines = { lines } end
	-- rotate through the line pool by day
	local line = lines[(self.dayCount - 1) % #lines + 1]
	self:emit("talked", { villager = id, first = first })
	return { lines = { line }, first = first, heartEvent = ev, speaker = def.name, portrait = def.portrait }
end
-- gift(id, item) -> ok, taste | reason ("already" | "none" | "not_giftable")
function Farm:gift(id, itemId)
	local def = self.C.villagers[id]
	local f = self:friend(id)
	if f.gifted == self.dayCount then return false, "already" end
	local item = core.content.get("items", itemId)
	if not item or item.category == "tool" or item.giftable == false then return false, "not_giftable" end
	if not core.bag:has(itemId, 1) then return false, "none" end
	core.bag:remove(itemId, 1)
	f.gifted = self.dayCount
	local taste = V.taste(def, itemId, item)
	local pts = self.cfg.friendship.gift[taste] or 0
	if self:isBirthday(id) then pts *= self.cfg.friendship.birthday end
	self:addFriendship(id, pts)
	self:emit("gift_given", { villager = id, item = itemId, taste = taste })
	return true, taste
end
function Farm:pendingHeartEvent(id)
	local def = self.C.villagers[id]
	local f = self:friend(id)
	local h = self:hearts(id)
	for _, ev in def.heartEvents do
		local evId = ev.id or (id .. "_" .. ev.hearts)
		if h >= ev.hearts and not table.find(f.events, evId) and (ev.condition == nil or core.check(ev.condition)) then return ev, evId end
	end
	return nil
end
function Farm:markHeartEvent(id, ev)
	local evId = ev.id or (id .. "_" .. ev.hearts)
	local f = self:friend(id)
	if not table.find(f.events, evId) then table.insert(f.events, evId) end
	if ev.effects then core.apply(ev.effects) end
	self:emit("heart_event", { villager = id, event = evId })
end
function Farm:scheduleCtx()
	return { season = self:seasonId(), day = self.day, weekday = self:weekday(), weather = self.weather, festival = self:festivalToday() }
end
-- where(id, minute?) -> { x, y, loc, moving } in world px from config.locations
function Farm:where(id, minute)
	local def = self.C.villagers[id]
	local _, entries = V.pick(def, self:scheduleCtx())
	return V.where(def, entries, minute or self.minute, self.cfg.locations or {}, self.cfg.villagerSpeed)
end

-- ---------------- festivals ----------------
-- attend(): at the festival location during its hours; applies `rewards` once per year; returns festival def
function Farm:festivalActive()
	local fe = self:festivalToday()
	if fe and self.minute >= fe.start and self.minute < fe["end"] then return fe end
	return nil
end
function Farm:attendFestival()
	local fe = self:festivalActive()
	if not fe then return false, "none" end
	if self.festivals[fe.id] == self.year then return false, "already", fe end
	self.festivals[fe.id] = self.year
	if fe.rewards then core.apply(fe.rewards) end
	self:emit("festival_attended", { festival = fe.id })
	return true, fe
end

-- ---------------- collections ----------------
-- collection def: { name, items = {ids}, rewards = { ["3"] = effects, ["all"] = effects }, auto? = "shipped" }
function Farm:collectionProgress(id)
	local col = self.C.collections[id]
	if not col then error("farming: unknown collection \"" .. tostring(id) .. "\"", 2) end
	local have, rows = 0, {}
	local got = self.donated[id] or {}
	for _, item in col.items do
		local done = if col.auto == "shipped" then (self.shipped[item] or 0) > 0 else got[item] == true
		if done then have += 1 end
		table.insert(rows, { item = item, done = done })
	end
	return have, #col.items, rows
end
function Farm:checkCollection(id)
	local col = self.C.collections[id]
	local have, total = self:collectionProgress(id)
	local rw = self.rewarded[id] or {}
	self.rewarded[id] = rw
	for th, eff in col.rewards do
		local need = if th == "all" then total else tonumber(th)
		if need and have >= need and not rw[th] then
			rw[th] = true
			core.apply(eff)
			self:emit("collection_reward", { collection = id, at = th })
		end
	end
end
function Farm:donate(id, itemId)
	local col = self.C.collections[id]
	if not col or col.auto then return false, "not_donatable" end
	if not table.find(col.items, itemId) then return false, "not_wanted" end
	local got = self.donated[id] or {}
	self.donated[id] = got
	if got[itemId] then return false, "already" end
	if not core.bag:remove(itemId, 1) then return false, "none" end
	got[itemId] = true
	self:emit("donated", { collection = id, item = itemId })
	self:checkCollection(id)
	return true
end

-- ---------------- the day cycle ----------------
-- sleep(passedOut?) -> report { day, earned, shipped = {{item,count,value}}, grown, died, products, passedOut, season? }
function Farm:sleep(passedOut)
	local cfg = self.cfg
	local report = { dayCount = self.dayCount, earned = 0, shipped = {}, grown = 0, died = 0, products = 0, passedOut = passedOut == true }
	-- 1. shipping
	local ids = {}
	for id in self.bin do table.insert(ids, id) end
	table.sort(ids)
	for _, id in ids do
		local n = self.bin[id]
		local v = self:price(id) * n
		report.earned += v
		self.shipped[id] = (self.shipped[id] or 0) + n
		table.insert(report.shipped, { item = id, count = n, value = v })
	end
	self.bin = {}
	if report.earned > 0 then core.wallet.add(cfg.currency, report.earned) end
	self.income[self.dayCount] = report.earned
	for id in self.C.collections do if self.C.collections[id].auto == "shipped" then self:checkCollection(id) end end
	if passedOut then
		local fine = math.min(cfg.energy.passOutFineMax, math.floor(core.wallet.get(cfg.currency) * cfg.energy.passOutFine))
		if fine > 0 then core.wallet.add(cfg.currency, -fine) end
		report.fine = fine
	end
	-- 2. crops grow (watered today), sprinklers already applied at day start
	for k, p in self.plots do
		if p.crop and not p.dead then
			if p.watered then
				local speed = (fertOf(p).speed or 0) + self:stat("speed_bonus")
				p.days += 1
				if speed > 0 and hash(cfg.seed, self.dayCount, unkey(k)) < speed then p.days += 1 end
				report.grown += 1
			end
		end
		p.watered = false
	end
	-- 3. animals
	for _, a in self.animals do
		local d = self:animalDef(a.kind)
		a.age += 1
		if not a.fed and d.feed then a.friendship = math.max(0, a.friendship + cfg.animals.unfed) end
		if (a.fed or not d.feed) and a.age >= d.matureDays and d.product and a.ready == nil and a.age % d.productEvery == 0 then
			local large = d.largeProduct and hash(cfg.seed, self.dayCount, a.uid) < a.friendship / 2000
			a.ready = if large then d.largeProduct else d.product
			report.products += 1
		end
		a.fed = false a.petted = false
	end
	-- 4. calendar
	local oldSeason = self.season
	self.day += 1 self.dayCount += 1
	if self.day > self:seasonDef().days then
		self.day = 1
		self.season += 1
		if self.season > #cfg.seasons then self.season = 1 self.year += 1 end
	end
	if self.season ~= oldSeason then
		report.season = self:seasonId()
		for k, p in self.plots do
			if p.crop and not self:inSeason(p.crop) then p.dead = true report.died += 1 end
		end
		self:emit("season_changed", { season = self:seasonId(), year = self.year })
	end
	self.weather = self.forecast or self:rollWeather(self.dayCount)
	self.forecast = self:rollWeather(self.dayCount + 1)
	self.minute = cfg.dayStart
	-- 5. new day: rain waters everything, sprinklers water their cells
	if self:isWet() then for _, p in self.plots do p.watered = true end end
	for k, o in self.objects do
		local item = core.content.get("items", o.item)
		local sp = item and item.data and item.data.sprinkler
		if sp then
			local c, r = unkey(k)
			for _, cr in self:sprinklerCells(c, r, sp.area or 4) do
				local p = self:plot(cr[1], cr[2])
				if p then p.watered = true end
			end
		end
	end
	-- friendship decay for villagers not talked to (above 0 hearts... gentle)
	for id, f in self.friends do
		if f.talked ~= report.dayCount and cfg.friendship.decay > 0 then f.points = math.max(0, f.points - cfg.friendship.decay) end
	end
	-- 6. energy
	local maxE = self:maxEnergy()
	self.energy = if passedOut then math.floor(maxE * cfg.energy.passOutRestore) else maxE
	report.weather = self.weather
	report.festival = self:festivalToday() and self:festivalToday().id
	self.lastReport = report
	self:emit("day_started", report)
	if self.opts.autosave ~= false and self.opts.save ~= false then core.save.save() end
	return report
end

-- income per day list and per-season totals: { days = {n...}, seasons = { {id, total} } }
function Farm:incomeHistory()
	local days, seasons = {}, {}
	for i = 1, self.dayCount - 1 do table.insert(days, self.income[i] or 0) end
	local i, s = 1, 1
	while i <= #days do
		local len = self.cfg.seasons[s].days
		local t = 0
		for j = i, math.min(#days, i + len - 1) do t += days[j] end
		table.insert(seasons, { id = self.cfg.seasons[s].id, total = t })
		i += len
		s = s % #self.cfg.seasons + 1
	end
	return { days = days, seasons = seasons }
end

-- ---------------- save ----------------
local FIELDS = { "day", "season", "year", "dayCount", "minute", "weather", "forecast", "energy", "plots", "objects", "animals", "animalSerial",
	"friends", "bin", "shipped", "donated", "rewarded", "festivals" }
function Farm:serialize()
	local t = {}
	for _, k in FIELDS do t[k] = self[k] end
	-- income as a dense list (save is JSON)
	local inc = {}
	for i = 1, self.dayCount do inc[i] = self.income[i] or 0 end
	t.income = inc
	-- tables with string keys "c,r" are fine; rewarded keys are strings
	return t
end
function Farm:deserialize(t)
	self:reset()
	for _, k in FIELDS do if t[k] ~= nil then self[k] = t[k] end end
	self.income = {}
	for i, v in t.income or {} do self.income[i] = v end
	-- the day starts in the morning after a load (save happens on sleep)
	self.minute = self.cfg.dayStart
end

return M
