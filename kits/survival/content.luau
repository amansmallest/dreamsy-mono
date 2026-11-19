--!nonstrict
-- survival content: load + normalize.
-- Files: data/survival.json (config incl. ordered "biomes"), data/nodes|recipes|structures|nights|pois|enemies/<id>.json
-- (id = file name), items in data/items/<id>.json (core kit). load() uses the engine data reader through core.content;
-- normalize(raw) takes the same shape as a table (tests): { config, nodes, recipes, structures, nights, pois, enemies, items }.
local core = require("@kit/core")
local M = {}

M.AREAS = { "nodes", "recipes", "structures", "nights", "pois", "enemies" }

local function toList(defs, area)
	local out = {}
	if defs == nil then return out end
	if #defs > 0 then
		for i, d in defs do
			if d.id == nil and area == "nights" then d.id = "night_" .. tostring(d.night or i) end
			if type(d.id) ~= "string" then error("survival: " .. area .. "[" .. i .. "] needs an id", 3) end
			table.insert(out, d)
		end
	else
		local keys = {}
		for k in defs do table.insert(keys, k) end
		table.sort(keys)
		for _, k in keys do
			local d = defs[k]
			d.id = d.id or k
			table.insert(out, d)
		end
	end
	return out
end

local DEFAULT_BIOMES = {
	{ id = "water", name = "Water", char = "~", maxE = 0.3, walkable = false, temp = 14 },
	{ id = "meadow", name = "Meadow", char = "g", temp = 20, nodes = { tree = 0.05, rock = 0.02 } },
}

local function num(v, d) return if type(v) == "number" then v else d end

function M.normalize(raw)
	raw = raw or {}
	local cfg = table.clone(raw.config or {})
	local C = { config = cfg }
	cfg.world = table.clone(cfg.world or {})
	local w = cfg.world
	w.w, w.h = num(w.w, 40), num(w.h, 40)
	w.tile = num(w.tile, 48)
	w.seed = w.seed or 1
	w.scale = num(w.scale, 0.08)
	w.island = w.island
	w.reach = num(w.reach, 1.6) -- interaction reach in cells (from the player's cell centre)
	cfg.biomes = cfg.biomes or DEFAULT_BIOMES
	C.biomeByChar, C.biomeById = {}, {}
	for i, b in cfg.biomes do
		b.id = b.id or b.name or ("biome" .. i)
		b.name = b.name or b.id
		if b.walkable == nil then b.walkable = true end
		b.temp = num(b.temp, 20)
		b.nodes = b.nodes or {}
		C.biomeByChar[b.char] = b
		C.biomeById[b.id] = b
	end
	cfg.day = table.clone(cfg.day or {})
	local d = cfg.day
	d.length = num(d.length, 300) -- seconds per full day
	d.night = num(d.night, 0.35) -- fraction of the day that is night (at the end of each day)
	d.start = num(d.start, 0.05) -- time-of-day the game starts at (0 = dawn)
	d.nightTemp = num(d.nightTemp, -10)
	cfg.needs = cfg.needs or {}
	local function need(name, def)
		local n = table.clone(cfg.needs[name] or {})
		for k, v in def do if n[k] == nil then n[k] = v end end
		cfg.needs[name] = n
	end
	-- rates are per minute of game time
	need("hunger", { max = 100, start = 100, decay = 2, damage = 6, low = 25 })
	need("thirst", { max = 100, start = 100, decay = 3, damage = 8, low = 25 })
	need("health", { max = 100, start = 100, regen = 6, regenAbove = 50 })
	need("temperature", { min = 8, max = 32, start = 20, follow = 0.25, damage = 5 })
	cfg.death = cfg.death or {}
	local de = cfg.death
	de.drop = de.drop or "half" -- "all" | "half" | "none": inventory left in a stash where you fell
	de.keepTools = if de.keepTools == nil then true else de.keepTools
	de.respawn = de.respawn or "bed" -- "bed" (nearest bed structure, else start) | "start"
	de.restore = de.restore or { health = 60, hunger = 60, thirst = 60 }
	cfg.player = cfg.player or {}
	cfg.player.speed = num(cfg.player.speed, 170) -- px/s
	cfg.player.swing = num(cfg.player.swing, 0.45) -- seconds per gather/attack hit
	cfg.player.damage = num(cfg.player.damage, 1)
	cfg.start = cfg.start or {}
	cfg.milestones = cfg.milestones or {}
	cfg.nightGrowth = num(cfg.nightGrowth, 1.3)

	for _, area in M.AREAS do
		C[area] = toList(raw[area], area)
		local by = {}
		for _, def in C[area] do by[def.id] = def end
		C[area .. "ById"] = by
	end
	for _, n in C.nodes do
		n.hp = num(n.hp, 3)
		n.tier = num(n.tier, 0)
		n.drops = n.drops or {}
		n.respawn = num(n.respawn, 180)
		if n.solid == nil then n.solid = true end
	end
	for _, r in C.recipes do
		r.needs = r.needs or {}
		r.count = num(r.count, 1)
		r.gives = r.gives or r.id
		r.time = num(r.time, 1)
	end
	for _, s in C.structures do
		s.kind = s.kind or "wall"
		s.hp = num(s.hp, 20)
		if s.solid == nil then s.solid = (s.kind == "wall") end
		s.radius = num(s.radius, if s.kind == "station" or s.kind == "fire" then 3 else 0)
	end
	table.sort(C.nights, function(a, b) return num(a.night, 0) < num(b.night, 0) end)
	for i, n in C.nights do n.night = num(n.night, i) n.budget = num(n.budget, 3) n.duration = num(n.duration, 0) end
	for _, p in C.pois do p.count = num(p.count, 1) p.minDist = num(p.minDist, 6) end
	for _, e in C.enemies do e.cost = num(e.cost, 1) end

	-- items: core content (register given tables; otherwise whatever core already loaded)
	if raw.items then core.content.register("items", raw.items) end
	C.items = {}
	for _, it in core.content.all("items") do C.items[it.id] = it end
	return C
end

-- load(): read the game's files (data/survival.json + areas + data/items) via the engine data reader
function M.load()
	local raw = {}
	if type(data) == "table" and data.exists and data.exists("data/survival.json") then raw.config = data.read("data/survival.json") end
	for _, area in M.AREAS do
		core.content.load(area)
		raw[area] = core.content.all(area)
	end
	if #core.content.all("items") == 0 then core.content.load("items") end
	return M.normalize(raw)
end

-- item helpers
function M.itemData(C, id)
	local it = C.items[id] or core.content.get("items", id)
	return if it then (it.data or {}) else {}
end

return M
