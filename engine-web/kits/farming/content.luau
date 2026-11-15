--!nonstrict
-- farming content: data/farming.json (config) + data/<kind>/<id>.json for crops, animals, villagers, festivals,
-- recipes, shops, collections (core content registry; id = file name). Upgrades are progression-tree defs in
-- data/upgrades/*.json (read by the progression kit). load() uses the engine data reader; normalize(raw) takes the
-- same shape as a table { config, crops, animals, ... } (lists or id maps) for tests.
local core = require("@kit/core")
local M = {}

M.KINDS = { "crops", "animals", "villagers", "festivals", "recipes", "shops", "collections" }

M.DEFAULTS = {
	currency = "gold",
	startGold = 500,
	seasons = { { id = "spring", name = "Spring", days = 28 }, { id = "summer", name = "Summer", days = 28 },
		{ id = "fall", name = "Fall", days = 28 }, { id = "winter", name = "Winter", days = 28 } },
	weekdays = { "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun" },
	dayStart = 360, dayEnd = 1560, -- minutes after midnight (6:00 → 2:00 next morning)
	dayLength = 600, -- real seconds per in-game day
	weather = { default = { sunny = 0.75, rain = 0.25 } },
	energy = { max = 100, costs = { till = 2, water = 1, plant = 0, harvest = 0, fertilize = 0, pet = 0, place = 0 }, passOutRestore = 0.5, passOutFine = 0.1, passOutFineMax = 1000 },
	friendship = { perHeart = 250, maxHearts = 10, talk = 20, gift = { love = 80, like = 45, neutral = 20, dislike = -20, hate = -40 }, birthday = 8, decay = 2 },
	animals = { pet = 15, unfed = -20, buildings = { coop = { capacity = 4 }, barn = { capacity = 4 } } },
	quality = { names = { "", "Silver", "Gold" }, bonus = { 0, 1, 2 } }, -- extra items per quality tier
	shipping = { payAt = "sleep" },
	villagerSpeed = 3, -- px per game minute
	seed = 1,
}

local function merge(base, over)
	local out = table.clone(base)
	for k, v in over or {} do
		if type(v) == "table" and type(out[k]) == "table" and #v == 0 and next(v) ~= nil then out[k] = merge(out[k], v) else out[k] = v end
	end
	return out
end

local function toMap(defs, kind)
	local map, order = {}, {}
	if defs == nil then return map, order end
	if #defs > 0 then
		for i, d in defs do
			if type(d.id) ~= "string" then error("farming: " .. kind .. "[" .. i .. "] needs an id", 3) end
			map[d.id] = d
			table.insert(order, d.id)
		end
	else
		for id, d in defs do d.id = d.id or id map[d.id] = d table.insert(order, d.id) end
		table.sort(order)
	end
	return map, order
end

-- normalize(raw) -> C: { config, crops = {id → def}, cropOrder = {ids}, ... same for every kind }
function M.normalize(raw)
	raw = raw or {}
	if raw.normalized then return raw end
	local C = { normalized = true, config = merge(M.DEFAULTS, raw.config or {}) }
	for _, kind in M.KINDS do
		local map, order = toMap(raw[kind], kind)
		C[kind] = map
		C[kind .. "Order"] = order
	end
	local cfg = C.config
	cfg.seasonIndex = {}
	for i, s in cfg.seasons do cfg.seasonIndex[s.id] = i end
	for id, c in C.crops do
		c.name = c.name or id
		c.stages = c.stages or { 1, 1, 1 }
		local total = 0
		for _, d in c.stages do total += d end
		c.growDays = total
		c.seasons = c.seasons or { cfg.seasons[1].id }
		c.yield = c.yield or 1
		c.price = c.price or 10
		c.seed = c.seed or {}
		c.seed.id = c.seed.id or (id .. "_seeds")
		c.seed.price = c.seed.price or math.floor(c.price / 2)
		c.seed.name = c.seed.name or (c.name .. " Seeds")
	end
	for id, a in C.animals do
		a.name = a.name or id
		a.building = a.building or "coop"
		a.productEvery = a.productEvery or 1
		a.matureDays = a.matureDays or 0
		a.price = a.price or 400
	end
	for id, v in C.villagers do
		v.name = v.name or id
		v.loves = v.loves or {} v.likes = v.likes or {} v.dislikes = v.dislikes or {} v.hates = v.hates or {}
		v.schedule = v.schedule or { default = { { cfg.dayStart, v.home or "home" } } }
		v.heartEvents = v.heartEvents or {}
	end
	for id, r in C.recipes do r.output = r.output or id r.count = r.count or 1 r.inputs = r.inputs or {} end
	for id, s in C.shops do s.name = s.name or id s.stock = s.stock or {} end
	for id, col in C.collections do col.name = col.name or id col.items = col.items or {} col.rewards = col.rewards or {} end
	for id, f in C.festivals do f.name = f.name or id f.start = f.start or 540 f["end"] = f["end"] or 840 end
	return C
end

-- load(): read data/farming.json + data/<kind>/*.json via core content (engine data reader)
function M.load()
	local raw = {}
	if type(data) == "table" and type(data.exists) == "function" and data.exists("data/farming.json") then raw.config = data.read("data/farming.json") end
	for _, kind in M.KINDS do
		if #core.content.all(kind) == 0 then core.content.load(kind) end
		raw[kind] = core.content.all(kind)
		if #raw[kind] == 0 then raw[kind] = nil end
	end
	return M.normalize(raw)
end

-- registerItems(C): crops, seeds, animal products and recipe outputs become core items (so core.bag stacks them).
-- Existing data/items/*.json defs win (add icons/descriptions there).
function M.registerItems(C)
	local function put(id, def)
		if core.content.get("items", id) == nil then def.id = id core.content.register("items", def) end
	end
	for id, c in C.crops do
		put(id, { name = c.name, icon = c.icon, category = "crop", value = c.price, stack = 999, data = { crop = id } })
		put(c.seed.id, { name = c.seed.name, icon = c.seed.icon or c.icon, category = "seeds", value = math.floor(c.seed.price / 2), stack = 999, data = { seedOf = id } })
	end
	for id, a in C.animals do
		if a.product then put(a.product, { name = a.productName or a.product, icon = a.productIcon, category = "product", value = a.productPrice or 50, stack = 999 }) end
		if a.largeProduct then put(a.largeProduct, { name = a.largeProductName or a.largeProduct, icon = a.largeProductIcon, category = "product", value = a.largeProductPrice or 90, stack = 999 }) end
	end
	for id, r in C.recipes do
		put(r.output, { name = r.name or r.output, icon = r.icon, category = r.category or "crafted", value = r.value or 0, stack = 999, data = r.data })
		for item in r.inputs do put(item, { name = item, category = "material", value = 1, stack = 999 }) end
	end
end

return M
