--!nonstrict
-- Content loading + normalization for the simulator kit.
-- Files: data/simulator.json (config), data/zones|tools|backpacks|pets|eggs/<id>.json (id = file name).
-- load() reads them with the engine data reader (data.list / data.read); normalize(tbl) accepts the same
-- shape as a table { config, zones, tools, backpacks, pets, eggs } (lists or id maps) — tests and generated modules.
local M = {}

M.AREAS = { "zones", "tools", "backpacks", "pets", "eggs" }

M.RARITIES = {
	{ id = "common", name = "Common", color = "#b8c0cc" },
	{ id = "uncommon", name = "Uncommon", color = "#5fd17a" },
	{ id = "rare", name = "Rare", color = "#4aa3ff" },
	{ id = "epic", name = "Epic", color = "#b866ff" },
	{ id = "legendary", name = "Legendary", color = "#ffb020" },
	{ id = "mythic", name = "Mythic", color = "#ff4f7a" },
}

local function toList(defs, area)
	local out = {}
	if defs == nil then return out end
	if #defs > 0 then
		for i, d in defs do
			if type(d.id) ~= "string" then error("simulator: " .. area .. "[" .. i .. "] needs an id", 3) end
			table.insert(out, d)
		end
	else
		for id, d in defs do
			d.id = d.id or id
			table.insert(out, d)
		end
	end
	table.sort(out, function(a, b)
		local oa, ob = a.order or 1e9, b.order or 1e9
		if oa ~= ob then return oa < ob end
		local ca, cb = M.costOf(a), M.costOf(b)
		if ca ~= cb then return ca < cb end
		return a.id < b.id
	end)
	return out
end

-- cost of a def: number | { coins = n } | { amount = n }
function M.costOf(d)
	local c = d.cost
	if c == nil then
		if d.unlock then c = d.unlock.coins end
	end
	if type(c) == "table" then c = c.amount or c.coins end
	return c or 0
end

function M.normalize(raw)
	raw = raw or {}
	local C = { config = table.clone(raw.config or {}) }
	local cfg = C.config
	cfg.currency = cfg.currency or "coins"
	cfg.petSlots = cfg.petSlots or 3
	cfg.maxPets = cfg.maxPets or 60
	cfg.offline = cfg.offline or {}
	cfg.offline.rate = cfg.offline.rate or 0.25
	cfg.offline.capHours = cfg.offline.capHours or 4
	cfg.offline.minSeconds = cfg.offline.minSeconds or 60
	cfg.rebirth = cfg.rebirth or {}
	local rb = cfg.rebirth
	rb.threshold = rb.threshold or 1e5
	rb.exponent = rb.exponent or 0.5
	rb.scale = rb.scale or 1
	rb.bonus = rb.bonus or 0.25
	rb.slotsPerRebirth = rb.slotsPerRebirth or 0
	rb.maxSlots = rb.maxSlots or 6
	cfg.rarities = cfg.rarities or M.RARITIES
	C.rarity = {}
	for i, r in cfg.rarities do
		r.rank = i
		C.rarity[r.id] = r
	end
	for _, area in M.AREAS do
		C[area] = toList(raw[area], area)
		C[area .. "ById"] = {}
		for i, d in C[area] do
			d.index = i
			C[area .. "ById"][d.id] = d
		end
	end
	if #C.zones == 0 then error("simulator: content needs at least one zone (data/zones/*.json)", 2) end
	if #C.tools == 0 then error("simulator: content needs at least one tool (data/tools/*.json)", 2) end
	if #C.backpacks == 0 then error("simulator: content needs at least one backpack (data/backpacks/*.json)", 2) end
	for _, z in C.zones do
		if type(z.nodes) ~= "table" or #z.nodes == 0 then error("simulator: zone " .. z.id .. " needs nodes", 2) end
		for _, n in z.nodes do
			n.weight = n.weight or 1
			n.size = n.size or 1
			if type(n.hp) ~= "number" or type(n.reward) ~= "number" then error("simulator: zone " .. z.id .. " node " .. tostring(n.id) .. " needs hp and reward", 2) end
		end
	end
	for _, p in C.pets do
		if not C.rarity[p.rarity or "common"] then error("simulator: pet " .. p.id .. " has unknown rarity " .. tostring(p.rarity), 2) end
		p.rarity = p.rarity or "common"
		p.bonus = p.bonus or {}
	end
	for _, e in C.eggs do
		if type(e.pets) ~= "table" then error("simulator: egg " .. e.id .. " needs pets { petId = weight }", 2) end
		for pid in e.pets do
			if not C.petsById[pid] then error("simulator: egg " .. e.id .. " lists unknown pet " .. pid, 2) end
		end
	end
	return C
end

-- load(): read the package's data files with the engine data reader.
function M.read()
	if type(data) ~= "table" or type(data.read) ~= "function" then
		error("simulator: this engine has no data reader; pass the content table to Sim.new(content)", 2)
	end
	local raw = {}
	local okCfg, cfg = pcall(data.read, "data/simulator.json")
	raw.config = if okCfg then cfg else {}
	for _, area in M.AREAS do
		local list = {}
		local ok, paths = pcall(data.list, "data/" .. area .. "/")
		if ok and type(paths) == "table" then
			for _, p in paths do
				if string.sub(p, -5) == ".json" then
					local d = data.read(p)
					local id = string.match(p, "([^/]+)%.json$")
					if d.id ~= nil and d.id ~= id then error("simulator: " .. p .. " id must match the file name", 2) end
					d.id = id
					table.insert(list, d)
				end
			end
		end
		raw[area] = list
	end
	return raw
end

function M.load() return M.normalize(M.read()) end

return M
