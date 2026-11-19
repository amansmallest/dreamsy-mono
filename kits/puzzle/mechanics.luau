--!nonstrict
-- Mechanic registry. Built-ins load lazily; games add their own with register(mech).
local M = {}
local BUILTIN = { push = "./push", sliding = "./sliding", lights = "./lights", flow = "./flow", match3 = "./match3", nonogram = "./nonogram" }
local reg = {}

function M.register(mech)
	if type(mech) ~= "table" or type(mech.id) ~= "string" then error("puzzle.mechanics.register(mech): mech.id required", 2) end
	for _, f in { "load", "apply", "isWon", "render" } do
		if type(mech[f]) ~= "function" then error("puzzle mechanic '" .. mech.id .. "' needs a " .. f .. "() function", 2) end
	end
	mech.solve = mech.solve or function() return nil end
	reg[mech.id] = mech
	return mech
end

function M.get(id: string)
	if reg[id] then return reg[id] end
	local b = BUILTIN[id]
	if b == "./push" then reg[id] = require("./push")
	elseif b == "./sliding" then reg[id] = require("./sliding")
	elseif b == "./lights" then reg[id] = require("./lights")
	elseif b == "./flow" then reg[id] = require("./flow")
	elseif b == "./match3" then reg[id] = require("./match3")
	elseif b == "./nonogram" then reg[id] = require("./nonogram") end
	return reg[id]
end

function M.ids()
	local out = {}
	for k in BUILTIN do table.insert(out, k) end
	for k in reg do if not BUILTIN[k] then table.insert(out, k) end end
	table.sort(out)
	return out
end

return M
