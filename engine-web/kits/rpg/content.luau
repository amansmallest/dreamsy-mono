-- rpg kit: content registry. Everything game-specific lives in the package's data/ files:
--   data/rpg.json            game config (start map, money, party, xp, ui)
--   data/types.json          type names + effectiveness chart
--   data/creatures/<id>.json  data/moves/<id>.json  data/items/<id>.json  data/trainers/<id>.json
--   data/dialog/<id>.json    data/quests/<id>.json   data/maps/<id>.json   data/shops/<id>.json
-- Files are read with the engine's data reader (data.list / data.read). Tests and tools can pass a
-- path-keyed table instead: rpg.setup({ data = { ["data/creatures/x.json"] = {...}, ... } }).
-- Tile collision/tags come from the engine tile maps (map:tileDef), not from here.
local U = require("./util")
local Formula = require("@kit/combat/formula")

local C = {}

local KINDS = { "creatures", "moves", "items", "dialog", "quests", "maps", "trainers", "shops" }
C.KINDS = KINDS

C.STATS = { "hp", "atk", "def", "mag", "res", "spd" }
C.STAT_NAMES = { hp = "HP", atk = "Attack", def = "Defense", mag = "Magic", res = "Resist", spd = "Speed", acc = "Accuracy", eva = "Evasion" }

local function reset()
	for _, k in KINDS do C[k] = {} end
	C.types = {}
	C.chart = {}
	C.typeChart = Formula.typeChart(C.chart)
	C.config = {}
	C.issues = {}
	C.files = {}
end
reset()

local function issue(msg: string)
	table.insert(C.issues, msg)
end

local function stem(path: string): string
	return (string.match(path, "([^/]+)%.json$")) or path
end

-- Normalizers: fill defaults so the rest of the kit can trust the shape.
local function normCreature(id, c)
	c.id = id
	c.name = c.name or id
	if type(c.types) ~= "table" then c.types = { c.type or "normal" } end
	c.type = nil
	c.base = c.base or {}
	for _, s in C.STATS do c.base[s] = c.base[s] or 40 end
	c.learnset = c.learnset or {}
	table.sort(c.learnset, function(a, b) return (a.level or 1) < (b.level or 1) end)
	c.catch_rate = c.catch_rate or 120
	c.xp_yield = c.xp_yield or 60
	c.xp_curve = c.xp_curve or "medium"
	if type(c.evolution) == "table" and c.evolution.into then c.evolution = { c.evolution } end
	c.evolution = c.evolution or {}
	c.sprites = c.sprites or {}
	return c
end
local function normMove(id, m)
	m.id = id
	m.name = m.name or id
	m.type = m.type or "normal"
	m.category = m.category or (if (m.power or 0) > 0 then "physical" else "status")
	m.power = m.power or 0
	m.pp = m.pp or 20
	m.priority = m.priority or 0
	m.effects = m.effects or {}
	m.target = m.target or (if m.category == "status" then "enemy" else "enemy")
	return m
end
local function normItem(id, it)
	it.id = id
	it.name = it.name or id
	it.kind = it.kind or "misc"
	it.price = it.price or 0
	it.sell = it.sell or math.floor(it.price / 2)
	it.description = it.description or ""
	return it
end
local function normQuest(id, q)
	q.id = id
	q.name = q.name or id
	q.steps = q.steps or {}
	for i, s in q.steps do
		s.id = s.id or ("step_" .. i)
		s.objectives = s.objectives or {}
	end
	q.rewards = q.rewards or {}
	return q
end
local function normMap(id, m)
	m.id = id
	m.name = m.name or id
	m.npcs = m.npcs or {}
	m.signs = m.signs or {}
	m.items = m.items or {}
	m.warps = m.warps or {}
	m.triggers = m.triggers or {}
	m.spawns = m.spawns or {}
	m.encounters = m.encounters or {}
	m.tile_size = m.tile_size or 16
	if not m.layers then
		m.layers = { { data = m.data or m.level, tileset = m.tileset } }
	end
	return m
end
local function normTrainer(id, t)
	t.id = id
	t.name = t.name or id
	t.party = t.party or {}
	t.ai = t.ai or "smart"
	t.items = t.items or {}
	return t
end

local NORM = { creatures = normCreature, moves = normMove, items = normItem, quests = normQuest, maps = normMap, trainers = normTrainer }

function C.add(kind: string, id: string, def)
	assert(C[kind] ~= nil and kind ~= "types", "rpg.content.add: unknown kind " .. tostring(kind))
	def = U.deepcopy(def)
	local norm = NORM[kind]
	if norm then def = norm(id, def) elseif type(def) == "table" then def.id = def.id or id end
	C[kind][id] = def
	return def
end

function C.setTypes(t)
	t = t or {}
	C.types = U.deepcopy(t.types or {})
	C.chart = U.deepcopy(t.chart or {})
	C.typeChart = Formula.typeChart(C.chart)
	for id, td in C.types do td.id = id td.name = td.name or id end
end

-- files: { ["data/creatures/x.json"] = table, ... } or nil (engine data API)
function C.load(files)
	reset()
	local paths = {}
	local read
	if files then
		for p in files do table.insert(paths, p) end
		read = function(p) return files[p] end
	else
		for _, k in KINDS do
			for _, p in data.list("data/" .. k) do table.insert(paths, p) end
		end
		for _, p in { "data/rpg.json", "data/types.json" } do
			if data.exists(p) then table.insert(paths, p) end
		end
		read = data.read
	end
	table.sort(paths)
	C.files = paths
	C.fromData = files == nil
	for _, p in paths do
		if p == "data/rpg.json" then
			C.config = U.deepcopy(read(p) or {})
		elseif p == "data/types.json" then
			C.setTypes(read(p))
		else
			local kind = string.match(p, "^data/([%w_]+)/[^/]+%.json$")
			if kind and C[kind] ~= nil and kind ~= "types" then
				local v = read(p)
				if type(v) == "table" then C.add(kind, stem(p), v) end
			end
		end
	end
	C.validate()
	return C
end

-- Cross-reference checks; problems go to C.issues (rpg.setup prints them).
function C.validate()
	C.issues = {}
	local function typeOk(t, where)
		if next(C.types) ~= nil and not C.types[t] and t ~= "normal" then issue(where .. ": unknown type \"" .. tostring(t) .. "\"") end
	end
	for id, c in C.creatures do
		for _, t in c.types do typeOk(t, "creature " .. id) end
		for _, l in c.learnset do
			if not C.moves[l.move] then issue("creature " .. id .. ": learnset move \"" .. tostring(l.move) .. "\" does not exist") end
		end
		for _, e in c.evolution do
			if not C.creatures[e.into] then issue("creature " .. id .. ": evolves into unknown creature \"" .. tostring(e.into) .. "\"") end
		end
	end
	for id, m in C.moves do typeOk(m.type, "move " .. id) end
	for id, t in C.trainers do
		for _, p in t.party do
			if not C.creatures[p.creature] then issue("trainer " .. id .. ": unknown creature \"" .. tostring(p.creature) .. "\"") end
		end
	end
	for id, s in C.shops do
		for _, e in s.items or {} do
			local iid = if type(e) == "table" then e.item else e
			if not C.items[iid] then issue("shop " .. id .. ": unknown item \"" .. tostring(iid) .. "\"") end
		end
	end
	for id, m in C.maps do
		for _, w in m.warps do
			if not C.maps[w.to] then issue("map " .. id .. ": warp to unknown map \"" .. tostring(w.to) .. "\"")
			elseif w.spawn and not C.maps[w.to].spawns[w.spawn] then issue("map " .. id .. ": warp to " .. w.to .. " uses unknown spawn \"" .. w.spawn .. "\"") end
		end
		for tag, z in m.encounters do
			for _, e in z.table or {} do
				if not C.creatures[e.creature] then issue("map " .. id .. ": encounter zone \"" .. tag .. "\" has unknown creature \"" .. tostring(e.creature) .. "\"") end
			end
		end
		for _, n in m.npcs do
			if n.dialog and not C.dialog[n.dialog] then issue("map " .. id .. ": npc " .. tostring(n.id) .. " uses unknown dialog \"" .. n.dialog .. "\"") end
			if n.trainer and not C.trainers[n.trainer] then issue("map " .. id .. ": npc " .. tostring(n.id) .. " uses unknown trainer \"" .. n.trainer .. "\"") end
		end
		if C.fromData then
			for _, l in m.layers do
				if l.tileset and not data.exists(l.tileset) then issue("map " .. id .. ": tileset " .. l.tileset .. " does not exist") end
			end
		end
	end
	for id, d in C.dialog do
		local nodes = d.nodes
		if nodes then
			local function chk(target, where)
				if target and target ~= "end" and not nodes[target] then issue("dialog " .. id .. ": " .. where .. " goes to unknown node \"" .. target .. "\"") end
			end
			for nid, n in nodes do
				chk(n.next, nid .. ".next")
				for _, b in n.branches or {} do chk(b.goto, nid .. ".branches") end
				for _, ch in n.choices or {} do chk(ch.goto, nid .. ".choices") end
			end
		end
	end
	return C.issues
end

function C.creature(id: string)
	local c = C.creatures[id]
	if not c then error("rpg: unknown creature \"" .. tostring(id) .. "\" (add data/creatures/" .. tostring(id) .. ".json)", 2) end
	return c
end
function C.move(id: string)
	local m = C.moves[id]
	if not m then error("rpg: unknown move \"" .. tostring(id) .. "\" (add data/moves/" .. tostring(id) .. ".json)", 2) end
	return m
end
function C.item(id: string)
	local it = C.items[id]
	if not it then error("rpg: unknown item \"" .. tostring(id) .. "\" (add data/items/" .. tostring(id) .. ".json)", 2) end
	return it
end
function C.typeColor(t: string): string
	local td = C.types[t]
	return (td and td.color) or "#9a9a9a"
end
function C.typeName(t: string): string
	local td = C.types[t]
	return (td and td.name) or t
end

-- multiplier of an attacking type against a list of defending types
function C.effectiveness(atk: string, defTypes: { string }): number
	return C.typeChart.mult(atk, defTypes)
end

return C
