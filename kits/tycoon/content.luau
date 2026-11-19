--!strict
-- tycoon kit: content loading (C.read: the game's data files via the engine data reader) + normalization/validation.
-- Raw content = { config = data/tycoon.json, generators = {[id]=…}, upgrades = {[id]=…}, achievements = {[id]=…}, events = {[id]=…} }
-- normalize fills defaults, checks references, returns a new table with sorted id lists (genOrder, upgradeOrder, …).
local C = {}
local G: any = _G

local function err(msg: string)
	error("tycoon content: " .. msg, 3)
end

local function orderedIds(map: { [string]: any }): { string }
	local ids = {}
	for id in map do
		table.insert(ids, id)
	end
	table.sort(ids, function(a, b)
		local oa, ob = map[a].order or 1e9, map[b].order or 1e9
		if oa ~= ob then
			return oa < ob
		end
		return a < b
	end)
	return ids
end

local function effects(list: any, where: string): { any }
	if list == nil then
		return {}
	end
	if list.kind ~= nil then
		list = { list }
	end
	for i, e in list do
		if type(e.kind) ~= "string" then
			err(where .. " effect " .. i .. " needs a kind")
		end
		if type(e.value) ~= "number" then
			err(where .. " effect " .. i .. " needs a numeric value")
		end
		e.target = e.target or "all"
	end
	return list
end

C.AREAS = { "generators", "upgrades", "achievements", "events" }

-- C.read(root = "data") → raw content from <root>/tycoon.json + <root>/{generators,upgrades,achievements,events}/*.json
-- (id = file name). Uses the engine's data.list / data.read.
function C.read(root: string?): any
	local D = G.data
	if type(D) ~= "table" or type(D.list) ~= "function" or type(D.read) ~= "function" then
		err("no data reader: pass a content table to Tycoon.new(content)")
	end
	local dir = root or "data"
	local raw: any = { config = if D.exists(dir .. "/tycoon.json") then D.read(dir .. "/tycoon.json") else {} }
	for _, area in C.AREAS do
		local m = {}
		for _, p in D.list(dir .. "/" .. area) do
			if string.sub(p, -5) == ".json" then
				local def = D.read(p)
				local id = string.match(p, "([^/]+)%.json$") :: string
				if def.id ~= nil and def.id ~= id then
					err(p .. ': id "' .. tostring(def.id) .. '" must match the file name')
				end
				m[id] = def
			end
		end
		raw[area] = m
	end
	return raw
end

C.EFFECT_KINDS = { output = true, speed = true, cost = true, tap = true, offline_hours = true, offline_rate = true, prestige = true }

function C.normalize(raw: any): any
	if type(raw) ~= "table" then
		err("expected a content table (or call Tycoon.new() to read data/*.json)")
	end
	if raw._normalized then
		return raw
	end
	local cfg = table.clone(raw.config or {})
	local c: any = {
		_normalized = true,
		config = cfg,
		generators = {},
		upgrades = {},
		achievements = {},
		events = {},
	}
	-- currencies
	cfg.currencies = cfg.currencies or { { id = "coins", name = "Coins" } }
	if #cfg.currencies == 0 then
		err("config.currencies is empty")
	end
	c.currencies = {}
	c.currencyOrder = {}
	for _, cur in cfg.currencies do
		if type(cur.id) ~= "string" then
			err("every currency needs an id")
		end
		c.currencies[cur.id] = cur
		table.insert(c.currencyOrder, cur.id)
	end
	c.main = cfg.main or cfg.currencies[1].id
	cfg.tap = cfg.tap or {}
	cfg.tap.currency = cfg.tap.currency or c.main
	cfg.tap.amount = cfg.tap.amount or 1
	cfg.tap.rate_fraction = cfg.tap.rate_fraction or 0
	cfg.offline = cfg.offline or {}
	cfg.offline.cap_hours = cfg.offline.cap_hours or 2
	cfg.offline.rate = cfg.offline.rate or 0.5
	cfg.offline.min_seconds = cfg.offline.min_seconds or 60
	cfg.milestones = cfg.milestones or { { at = 25, mult = 2 }, { at = 50, mult = 2 }, { at = 100, mult = 2 }, { at = 200, mult = 2 }, { at = 300, mult = 2 }, { at = 400, mult = 2 } }
	cfg.prestige = cfg.prestige or {}
	cfg.events = cfg.events or {}
	cfg.events.first_delay = cfg.events.first_delay or 90

	-- prestige layers
	c.layers = {}
	c.layerOrder = {}
	c.prestigeCurrency = {}
	for _, l in cfg.prestige do
		if type(l.id) ~= "string" then
			err("every prestige layer needs an id")
		end
		if not c.currencies[l.currency] then
			err("prestige layer " .. l.id .. ": currency '" .. tostring(l.currency) .. "' is not in config.currencies")
		end
		l.from = l.from or c.main
		l.threshold = l.threshold or 1e6
		l.exponent = l.exponent or 0.5
		l.scale = l.scale or 1
		l.bonus = l.bonus or 0.02
		l.bonus_on = l.bonus_on or "earned"
		l.min_gain = l.min_gain or 1
		l.keep_managers = l.keep_managers == true
		c.layers[l.id] = l
		c.prestigeCurrency[l.currency] = l.id
		table.insert(c.layerOrder, l.id)
	end
	-- currencies that a prestige resets by default: everything that isn't a prestige currency
	for _, l in cfg.prestige do
		if l.resets == nil then
			local r = {}
			for _, id in c.currencyOrder do
				if not c.prestigeCurrency[id] then
					table.insert(r, id)
				end
			end
			l.resets = r
		end
	end

	-- generators
	for id, g in raw.generators or {} do
		g = table.clone(g)
		g.id = id
		g.name = g.name or id
		g.currency = g.currency or c.main
		if not c.currencies[g.currency] then
			err("generator " .. id .. ": unknown currency " .. tostring(g.currency))
		end
		if type(g.cost) ~= "table" or type(g.cost.base) ~= "number" then
			err("generator " .. id .. " needs cost = { base = <number>, growth = <number> }")
		end
		g.cost = table.clone(g.cost)
		g.cost.currency = g.cost.currency or c.main
		g.cost.growth = g.cost.growth or 1.1
		if g.cost.growth < 1 then
			err("generator " .. id .. ": cost.growth must be ≥ 1")
		end
		if type(g.output) ~= "number" then
			err("generator " .. id .. " needs output (per cycle per unit owned)")
		end
		g.cycle = g.cycle or 1
		if g.cycle <= 0 then
			err("generator " .. id .. ": cycle must be > 0")
		end
		if g.auto == nil then
			g.auto = g.manager == nil
		end
		if g.manager then
			g.manager = table.clone(g.manager)
			g.manager.currency = g.manager.currency or c.main
			if type(g.manager.cost) ~= "number" then
				err("generator " .. id .. ": manager.cost must be a number")
			end
		end
		g.milestones = g.milestones or cfg.milestones
		g.unlock = g.unlock or {}
		c.generators[id] = g
	end
	c.genOrder = orderedIds(c.generators)
	if #c.genOrder == 0 then
		err("no generators (data/generators/*.json)")
	end

	-- upgrades
	for id, u in raw.upgrades or {} do
		u = table.clone(u)
		u.id = id
		u.name = u.name or id
		if type(u.cost) ~= "table" or type(u.cost.amount) ~= "number" then
			err("upgrade " .. id .. " needs cost = { amount = <number>, currency = ? }")
		end
		u.cost = table.clone(u.cost)
		u.cost.currency = u.cost.currency or c.main
		if not c.currencies[u.cost.currency] then
			err("upgrade " .. id .. ": unknown cost currency " .. tostring(u.cost.currency))
		end
		u.effects = effects(u.effects or u.effect, "upgrade " .. id)
		for _, e in u.effects do
			if not C.EFFECT_KINDS[e.kind] then
				err("upgrade " .. id .. ": unknown effect kind '" .. e.kind .. "'")
			end
			if e.target ~= "all" and not c.generators[e.target] then
				err("upgrade " .. id .. ": effect target '" .. e.target .. "' is not a generator")
			end
		end
		u.requires = u.requires or {}
		u.permanent = u.permanent == true or c.prestigeCurrency[u.cost.currency] ~= nil
		c.upgrades[id] = u
	end
	c.upgradeOrder = orderedIds(c.upgrades)

	for id, a in raw.achievements or {} do
		a = table.clone(a)
		a.id = id
		a.name = a.name or id
		a.when = a.when or {}
		a.reward = a.reward or {}
		c.achievements[id] = a
	end
	c.achievementOrder = orderedIds(c.achievements)

	for id, e in raw.events or {} do
		e = table.clone(e)
		e.id = id
		e.name = e.name or id
		e.duration = e.duration or 30
		e.lifetime = e.lifetime or 12
		e.every = e.every or { 120, 240 }
		e.weight = e.weight or 1
		e.effects = effects(e.effects or e.effect, "event " .. id)
		c.events[id] = e
	end
	c.eventOrder = orderedIds(c.events)

	-- reference checks
	local function checkGenRefs(map: any, where: string)
		for gid in map or {} do
			if not c.generators[gid] then
				err(where .. ": unknown generator '" .. gid .. "'")
			end
		end
	end
	for id, g in c.generators do
		checkGenRefs(g.unlock.owned, "generator " .. id .. " unlock.owned")
	end
	for id, u in c.upgrades do
		checkGenRefs(u.requires.owned, "upgrade " .. id .. " requires.owned")
		for _, uid in u.requires.upgrades or {} do
			if not c.upgrades[uid] then
				err("upgrade " .. id .. " requires unknown upgrade '" .. uid .. "'")
			end
		end
	end
	for id, a in c.achievements do
		checkGenRefs(a.when.owned, "achievement " .. id .. " when.owned")
	end
	return c
end

return C
