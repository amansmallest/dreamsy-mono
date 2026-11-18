--!nonstrict
-- Content loading for the deckbuilder kit.
-- Files (id = file name): data/cards, data/enemies, data/relics, data/characters, data/events, data/acts (*.json)
-- + optional data/deckbuilder.json (config: statuses, rewards, shop, map, meta).
-- load() uses the engine data reader; normalize(tbl) takes the same shape as a table (tests / custom loaders):
-- { cards, enemies, relics, characters, events, acts (lists or id maps), config }.
local M = {}
M.AREAS = { "cards", "enemies", "relics", "characters", "events", "acts" }

local function toMap(defs, area)
	local out, order = {}, {}
	if defs == nil then return out, order end
	if #defs > 0 then
		for i, d in defs do
			if type(d.id) ~= "string" then error("deckbuilder: " .. area .. "[" .. i .. "] needs an id", 3) end
			out[d.id] = d
			table.insert(order, d.id)
		end
	else
		for id, d in defs do
			d.id = d.id or id
			out[d.id] = d
			table.insert(order, d.id)
		end
		table.sort(order)
	end
	return out, order
end

local function readDir(area)
	local out = {}
	if type(data) ~= "table" or type(data.list) ~= "function" then return out end
	local ok, paths = pcall(data.list, "data/" .. area)
	if not ok or type(paths) ~= "table" then return out end
	for _, p in paths do
		if string.sub(p, -5) == ".json" then
			local d = data.read(p)
			if type(d) == "table" then
				d.id = d.id or string.match(p, "([^/]+)%.json$")
				table.insert(out, d)
			end
		end
	end
	return out
end

function M.normalize(raw)
	raw = raw or {}
	local C = { config = raw.config or {}, order = {} }
	for _, area in M.AREAS do
		C[area], C.order[area] = toMap(raw[area], area)
	end
	-- defaults
	for id, c in C.cards do
		c.name = c.name or id
		c.type = c.type or "skill"
		c.rarity = c.rarity or "common"
		if c.cost == nil then c.cost = if c.type == "status" or c.type == "curse" then -1 else 1 end
		c.effects = c.effects or {}
		if c.target == nil then
			c.target = "none"
			for _, e in c.effects do
				if type(e) == "string" and (string.match(e, "^damage") or string.match(e, "^apply")) and not string.find(e, " all") and not string.find(e, " self") and not string.find(e, " random") then c.target = "enemy" end
			end
		end
	end
	for id, e in C.enemies do
		e.name = e.name or id
		e.tier = e.tier or "normal"
		e.moves = e.moves or {}
		e.cost = e.cost or (if e.tier == "elite" then 4 else 1)
		e.weight = e.weight or 1
	end
	for id, r in C.relics do r.name = r.name or id r.rarity = r.rarity or "common" end
	for id, ch in C.characters do
		ch.name = ch.name or id
		ch.hp = ch.hp or 70
		ch.energy = ch.energy or 3
		ch.draw = ch.draw or 5
		ch.gold = ch.gold or 99
		ch.deck = ch.deck or {}
		ch.relics = ch.relics or {}
	end
	-- acts sorted by `order`
	local acts = {}
	for id, a in C.acts do table.insert(acts, a) end
	table.sort(acts, function(a, b)
		if (a.order or 1e9) ~= (b.order or 1e9) then return (a.order or 1e9) < (b.order or 1e9) end
		return a.id < b.id
	end)
	C.actList = acts
	-- validate refs
	local problems = {}
	local function chk(kind, id, where)
		if C[kind][id] == nil then table.insert(problems, where .. ": unknown " .. kind .. " '" .. tostring(id) .. "'") end
	end
	for id, ch in C.characters do
		for _, c in ch.deck do chk("cards", c, "characters/" .. id .. " deck") end
		for _, r in ch.relics do chk("relics", r, "characters/" .. id .. " relics") end
	end
	for id, e in C.enemies do
		local p = e.pattern
		if p then
			for _, m in p.moves or {} do if e.moves[m] == nil then table.insert(problems, "enemies/" .. id .. ": pattern move '" .. m .. "' missing") end end
			for m in p.weights or {} do if e.moves[m] == nil then table.insert(problems, "enemies/" .. id .. ": weights move '" .. m .. "' missing") end end
		end
	end
	for id, a in C.acts do
		for kind, list in a.encounters or {} do
			for _, enc in list do
				for _, eid in (enc.enemies or enc) do chk("enemies", eid, "acts/" .. id .. " encounters." .. kind) end
			end
		end
		for _, b in a.bosses or {} do chk("enemies", b, "acts/" .. id .. " bosses") end
		for _, ev in a.events or {} do chk("events", ev, "acts/" .. id .. " events") end
	end
	C.problems = problems
	if #problems > 0 and C.config.strict ~= false then error("deckbuilder content: " .. table.concat(problems, "; "), 2) end
	return C
end

-- load(): read every data file. Returns the normalized content table.
function M.load()
	local raw = {}
	for _, area in M.AREAS do raw[area] = readDir(area) end
	if type(data) == "table" and type(data.exists) == "function" and data.exists("data/deckbuilder.json") then
		raw.config = data.read("data/deckbuilder.json")
	end
	return M.normalize(raw)
end

return M
