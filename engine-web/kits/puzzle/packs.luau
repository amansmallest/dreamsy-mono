--!nonstrict
-- Level packs: authored levels (data/levels/*.txt|json, inline tables) and generated runs with a difficulty curve
-- (progression difficulty tiers → mechanic.generate params; solvable + par from the solver). Lazy: a 300-level pack
-- only generates the levels that are opened.
local B = require("./board")
local Mech = require("./mechanics")
local prog = require("@kit/progression")
local M = {}
local packs, order = {}, {}

local Pack = {}
Pack.__index = Pack

local function readFile(path)
	if type(data) ~= "table" or type(data.read) ~= "function" then error("puzzle: data.read unavailable; pass level tables inline", 3) end
	return data.read(path)
end

-- expand { generate = { count, seed, params?, curve = { {at = 0..1, params}, ... } } } into lazy entries
local function expand(def)
	local out = {}
	for _, e in def.levels or {} do
		if type(e) == "table" and e.generate then
			local g = e.generate
			local n = g.count or 10
			local curve = prog.difficulty.new({ tiers = g.curve or { { at = 0, params = {} } } })
			for j = 1, n do
				local x = if n > 1 then (j - 1) / (n - 1) else 0
				local params = table.clone(g.params or {})
				for k, v in curve:at(x) do params[k] = v end
				params.seed = (g.seed or 1) * 1000 + j
				table.insert(out, { gen = params, x = x })
			end
		else
			table.insert(out, e)
		end
	end
	return out
end

-- define(id, { name, mechanic, levels = { path | table | {generate=…} }, unlock? (condition), gate? ("sequential"|"open"),
--              icon?, color?, description?, hintPenalty? })
function M.define(id: string, def)
	if not def.mechanic then error("puzzle pack '" .. id .. "' needs a mechanic", 2) end
	local p = setmetatable({ id = id, def = def, name = def.name or id, mechanic = def.mechanic, entries = expand(def), cache = {},
		unlock = def.unlock, gate = def.gate or "sequential" }, Pack)
	if not packs[id] then table.insert(order, id) end
	packs[id] = p
	return p
end

-- load(dir = "data/packs"): every *.json there is a pack (id = file name); sorted by `order` then id
function M.load(dir: string?)
	dir = dir or "data/packs"
	local list = {}
	for _, path in data.list(dir) do
		local id = string.match(path, "([%w_%-]+)%.json$")
		if id then table.insert(list, { id = id, def = data.read(path) }) end
	end
	table.sort(list, function(a, b) return (a.def.order or 0) < (b.def.order or 0) or ((a.def.order or 0) == (b.def.order or 0) and a.id < b.id) end)
	for _, e in list do M.define(e.id, e.def) end
	return M.list()
end

function M.get(id: string) return packs[id] end
function M.list() local out = {} for _, id in order do table.insert(out, packs[id]) end return out end
function M.clear() packs, order = {}, {} end

function Pack:count(): number return #self.entries end
function Pack:mech() return Mech.get(self.mechanic) end

-- normalise one authored entry into a level table
function M.resolve(mech, e)
	local lv
	if type(e) == "string" then
		local raw = readFile(e)
		if type(raw) == "string" then lv = mech.parse(raw) lv.source = e
		else lv = raw lv.source = e end
	else
		lv = B.copy(e)
	end
	if lv.text and mech.parse then
		local p = mech.parse(lv.text)
		for k, v in p do if lv[k] == nil then lv[k] = v end end
	end
	return lv
end

-- par for authored levels without one: solver solution length (stochastic mechanics: the move limit)
function M.ensurePar(mech, lv)
	if lv.par and (lv.stars or not mech.calibrate) then return lv.par end
	if mech.calibrate then mech.calibrate(lv) return lv.par end
	if lv.par then return lv.par end
	local sol = mech.solve(mech.load(lv), {}, { level = lv })
	lv.par = if sol and sol.moves then #sol.moves else nil
	return lv.par
end

-- level(i) -> level table (cached): { ..., mechanic, pack, index, par }
function Pack:level(i: number)
	if self.cache[i] then return self.cache[i] end
	local e = self.entries[i]
	if e == nil then return nil end
	local mech = self:mech()
	local lv
	if type(e) == "table" and e.gen then
		lv = mech.generate(e.gen)
		if not lv then error("puzzle pack '" .. self.id .. "': could not generate level " .. i, 2) end
		lv.generated = true
		lv.curveX = e.x
	else
		lv = M.resolve(mech, e)
	end
	lv.mechanic, lv.pack, lv.index = self.mechanic, self.id, i
	M.ensurePar(mech, lv)
	self.cache[i] = lv
	return lv
end

-- generate a standalone run: generateRun(mechanic, { count, seed, params?, curve }) -> pack (unnamed, not listed)
function M.generateRun(mechanic: string, gen)
	return setmetatable({ id = "_run", name = "run", mechanic = mechanic, entries = expand({ levels = { { generate = gen } } }), cache = {}, gate = "open" }, Pack)
end

return M
