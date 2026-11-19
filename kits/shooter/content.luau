--!nonstrict
-- Content: data/shooter.json (config) + data/{ships,weapons,emitters,enemies,stages}/<id>.json (id = file name),
-- read with the engine data reader. normalize(raw) accepts the same shape as a table (tests): { config, ships, weapons, ... }
-- with lists or id maps.
local M = {}
M.AREAS = { "ships", "weapons", "emitters", "enemies", "stages" }

local function byId(defs, area)
	local out, order = {}, {}
	if defs == nil then return out, order end
	if #defs > 0 then
		for i, d in defs do
			if type(d.id) ~= "string" then error("shooter: " .. area .. "[" .. i .. "] needs an id", 3) end
			out[d.id] = d
			table.insert(order, d.id)
		end
	else
		for id, d in defs do
			d.id = d.id or id
			out[d.id] = d
			table.insert(order, d.id)
		end
		table.sort(order, function(a, b)
			local oa, ob = out[a].order or 1e9, out[b].order or 1e9
			if oa ~= ob then return oa < ob end
			return a < b
		end)
	end
	return out, order
end

function M.normalize(raw)
	raw = raw or {}
	local cfg = table.clone(raw.config or {})
	cfg.lives = cfg.lives or 3
	cfg.bombs = cfg.bombs or 2
	cfg.maxBombs = cfg.maxBombs or 5
	cfg.continues = cfg.continues or 2
	cfg.currency = cfg.currency or "credits"
	cfg.autoFire = if cfg.autoFire == nil then true else cfg.autoFire
	cfg.score = cfg.score or {}
	cfg.shop = cfg.shop or {}
	cfg.campaign = cfg.campaign or {}
	local C = { config = cfg }
	for _, area in M.AREAS do
		C[area], C[area .. "Order"] = byId(raw[area], area)
	end
	if #cfg.campaign == 0 then
		for _, id in C.stagesOrder do if C.stages[id].mode ~= "arena" then table.insert(cfg.campaign, id) end end
	end
	cfg.startShip = cfg.startShip or C.shipsOrder[1]
	-- references
	for id, s in C.ships do
		if s.weapon and not C.weapons[s.weapon] then error(`shooter: ship "{id}" uses unknown weapon "{s.weapon}"`, 2) end
	end
	for id, e in C.enemies do
		for _, em in e.emitters or {} do
			if type(em) == "string" and not C.emitters[em] then error(`shooter: enemy "{id}" uses unknown emitter "{em}"`, 2) end
		end
		for _, ph in e.phases or {} do
			for _, st in ph.pattern or {} do
				for _, em in (st.emitters or (if st.emitter then { st.emitter } else {})) do
					if type(em) == "string" and not C.emitters[em] then error(`shooter: boss "{id}" uses unknown emitter "{em}"`, 2) end
				end
				if st.enemy and not C.enemies[st.enemy] then error(`shooter: boss "{id}" summons unknown enemy "{st.enemy}"`, 2) end
			end
		end
	end
	for id, st in C.stages do
		for _, ev in st.events or {} do
			local e = ev.enemy or ev.boss
			if e and not C.enemies[e] then error(`shooter: stage "{id}" spawns unknown enemy "{e}"`, 2) end
		end
		for _, e in (st.waves and st.waves.enemies) or {} do
			if not C.enemies[e] then error(`shooter: stage "{id}" waves use unknown enemy "{e}"`, 2) end
		end
	end
	return C
end

-- read the package files (data.list / data.read)
function M.read()
	local raw = { config = {} }
	if type(data) ~= "table" or type(data.list) ~= "function" then return raw end
	if data.exists("data/shooter.json") then raw.config = data.read("data/shooter.json") end
	for _, area in M.AREAS do
		local defs = {}
		for _, p in data.list("data/" .. area) do
			local id = string.match(p, "^data/" .. area .. "/([%w_%-]+)%.json$")
			if id then
				local d = data.read(p)
				d.id = d.id or id
				defs[d.id] = d
			end
		end
		raw[area] = defs
	end
	return raw
end

local cached = nil
function M.load(raw)
	if raw then cached = M.normalize(raw) return cached end
	if cached == nil then cached = M.normalize(M.read()) end
	return cached
end
function M.clear() cached = nil end

return M
