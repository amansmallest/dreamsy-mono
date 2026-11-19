-- rpg kit: save / continue. The whole game state goes under one save key (engine save API: save.get/set,
-- persisted per game, 64KB max). It is also registered as the core save section "rpg", so a game that
-- uses core.save.save()/load() for its own systems saves the rpg state with them.
local U = require("./util")
local State = require("./state")
local Events = require("./events")
local CoreSave = require("@kit/core/save")

local SV = {}
SV.KEY = "rpg"

-- strip derived fields (stats are recomputed on load)
local function packMon(m)
	local out = {}
	for k, v in m do
		if k ~= "stats" and k ~= "maxhp" then out[k] = U.deepcopy(v) end
	end
	return out
end

function SV.snapshot()
	local d = State.get()
	local out = {}
	for k, v in d do
		if k == "party" or k == "box" then
			local list = {}
			for i, m in v do list[i] = packMon(m) end
			out[k] = list
		else
			out[k] = U.deepcopy(v)
		end
	end
	out.playtime = math.floor(d.playtime or 0)
	return out
end

function SV.write(): boolean
	local ok, err = pcall(save.set, SV.KEY, SV.snapshot()) -- fails when the save is over the size limit
	if not ok then
		print("[rpg] save failed: " .. tostring(err))
		return false
	end
	Events.saved:fire()
	return true
end

function SV.read()
	return save.get(SV.KEY, nil)
end

function SV.exists(): boolean
	local d = SV.read()
	return type(d) == "table" and d.player ~= nil
end

-- install a saved state table (as written by SV.snapshot)
function SV.apply(d): boolean
	if type(d) ~= "table" or not d.player then return false end
	-- JSON turns empty lists into {} and keeps maps as maps; normalize the shapes we rely on
	for _, k in { "party", "box" } do
		local list = {}
		for _, m in d[k] or {} do table.insert(list, m) end
		d[k] = list
	end
	for _, k in { "party", "box" } do
		for _, m in d[k] do
			local moves = {}
			for _, mv in m.moves or {} do table.insert(moves, mv) end
			m.moves = moves
		end
	end
	State.restore(d) -- also recomputes derived stats
	Events.loaded:fire()
	return true
end

function SV.load(): boolean
	return SV.apply(SV.read())
end

function SV.delete()
	save.remove(SV.KEY)
end

CoreSave.section("rpg", {
	serialize = function() return SV.snapshot() end,
	deserialize = function(_, t) if not SV.apply(t) then State.reset() end end,
	reset = function() State.reset() end,
})

return SV
