-- rpg kit: creature instances — stats, XP curves, leveling, learnsets, evolution, healing.
-- An instance (saved as-is) is a plain table:
--   { uid, id = species, name = nickname?, level, xp, hp, status = nil|"burn"|..., sleep = turns,
--     moves = { { id, pp } }, genes = { hp, atk, def, mag, res, spd } (0..15), held = itemId? }
-- Derived (not saved): mon.stats (recomputed by Creatures.refresh).
local U = require("./util")
local Content = require("./content")
local Curves = require("@kit/progression/curves")

local M = {}
M.MAX_LEVEL = 100
M.MAX_MOVES = 4

-- stat = floor((2*base + gene) * level / 100) + 5;  hp = floor((2*base + gene) * level / 100) + level + 10
function M.statValue(base: number, level: number, gene: number, isHp: boolean): number
	local core = math.floor((2 * base + gene) * level / 100)
	if isHp then return core + level + 10 end
	return core + 5
end

-- XP curves (progression kit curves; total XP to reach a level, 0 at level 1): "fast" 0.8·L³, "medium" L³,
-- "slow" 1.25·L³, or a name from data/rpg.json "xp_curves": { "<name>": [xp at L1, L2, ...] }.
local function cubic(k: number)
	return Curves.new({ kind = "custom", maxLevel = M.MAX_LEVEL, round = false, fn = function(L: number)
		return if L <= 1 then 0 else math.floor(L * L * L * k)
	end })
end
local CURVES = { fast = cubic(0.8), medium = cubic(1), slow = cubic(1.25) }
local customCurves = setmetatable({}, { __mode = "k" }) -- config list -> curve
function M.curve(name: string?)
	local custom = Content.config.xp_curves and Content.config.xp_curves[name or ""]
	if not custom then return CURVES[name or ""] or CURVES.medium end
	local c = customCurves[custom]
	if not c then
		local t = table.clone(custom)
		t[1] = 0
		c = Curves.new({ kind = "table", table = t, round = false })
		customCurves[custom] = c
	end
	return c
end
function M.xpForLevel(curve: string?, level: number): number
	if level <= 1 then return 0 end
	return M.curve(curve):total(level)
end

function M.species(mon)
	return Content.creature(mon.id)
end
function M.name(mon): string
	return mon.name or M.species(mon).name
end

function M.refresh(mon)
	local sp = M.species(mon)
	local st = {}
	for _, s in Content.STATS do
		st[s] = M.statValue(sp.base[s], mon.level, (mon.genes and mon.genes[s]) or 0, s == "hp")
	end
	mon.stats = st
	mon.maxhp = st.hp
	if mon.hp == nil or mon.hp > st.hp then mon.hp = st.hp end
	return st
end

-- moves known at `level`: the last 4 learnset moves at or below it
function M.movesAt(species, level: number)
	local ids = {}
	for _, l in species.learnset do
		if (l.level or 1) <= level and not table.find(ids, l.move) then table.insert(ids, l.move) end
	end
	while #ids > M.MAX_MOVES do table.remove(ids, 1) end
	return ids
end

function M.create(speciesId: string, level: number, rng, opts)
	local sp = Content.creature(speciesId)
	rng = rng or U.defaultRng
	level = math.clamp(math.floor(level), 1, M.MAX_LEVEL)
	local genes = {}
	for _, s in Content.STATS do
		genes[s] = if opts and opts.genes then (opts.genes[s] or 0) else math.floor(rng() * 16)
	end
	local mon = {
		id = speciesId,
		level = level,
		xp = M.xpForLevel(sp.xp_curve, level),
		genes = genes,
		moves = {},
	}
	local ids = (opts and opts.moves) or M.movesAt(sp, level)
	for _, id in ids do
		table.insert(mon.moves, { id = id, pp = Content.move(id).pp })
	end
	M.refresh(mon)
	mon.hp = mon.maxhp
	return mon
end

function M.heal(mon)
	M.refresh(mon)
	mon.hp = mon.maxhp
	mon.status = nil
	mon.sleep = nil
	for _, mv in mon.moves do
		local def = Content.moves[mv.id]
		if def then mv.pp = def.pp end
	end
end

function M.knows(mon, moveId: string): boolean
	for _, mv in mon.moves do
		if mv.id == moveId then return true end
	end
	return false
end

-- learn a move: returns "learned" | "full" | "known". `replace` = slot to overwrite when full.
function M.learn(mon, moveId: string, replace: number?): string
	if M.knows(mon, moveId) then return "known" end
	local def = Content.move(moveId)
	if #mon.moves < M.MAX_MOVES then
		table.insert(mon.moves, { id = moveId, pp = def.pp })
		return "learned"
	end
	if replace and mon.moves[replace] then
		mon.moves[replace] = { id = moveId, pp = def.pp }
		return "learned"
	end
	return "full"
end

-- XP for defeating `foe`: floor(xp_yield * level / 7), ×1.5 for trainer battles
function M.xpYield(foe, trainer: boolean?): number
	local sp = M.species(foe)
	local x = math.floor(sp.xp_yield * foe.level / 7)
	if trainer then x = math.floor(x * 1.5) end
	return math.max(1, x)
end

-- Add XP; returns a list of { level, learned = {moveIds}, pending = {moveIds (moveset full)}, hp gained }
function M.gainXp(mon, amount: number)
	local sp = M.species(mon)
	local out = {}
	mon.xp += math.max(0, math.floor(amount))
	while mon.level < M.MAX_LEVEL and mon.xp >= M.xpForLevel(sp.xp_curve, mon.level + 1) do
		local oldMax = mon.maxhp or M.refresh(mon).hp
		mon.level += 1
		M.refresh(mon)
		if mon.hp > 0 then mon.hp = math.min(mon.maxhp, mon.hp + (mon.maxhp - oldMax)) end
		local step = { level = mon.level, learned = {}, pending = {} }
		for _, l in sp.learnset do
			if (l.level or 1) == mon.level then
				local r = M.learn(mon, l.move)
				if r == "learned" then table.insert(step.learned, l.move)
				elseif r == "full" then table.insert(step.pending, l.move) end
			end
		end
		table.insert(out, step)
	end
	if mon.level >= M.MAX_LEVEL then mon.xp = math.min(mon.xp, M.xpForLevel(sp.xp_curve, M.MAX_LEVEL)) end
	return out
end

-- progress 0..1 to the next level (for XP bars)
function M.xpProgress(mon): number
	local sp = M.species(mon)
	if mon.level >= M.MAX_LEVEL then return 1 end
	local a, b = M.xpForLevel(sp.xp_curve, mon.level), M.xpForLevel(sp.xp_curve, mon.level + 1)
	if b <= a then return 1 end
	return math.clamp((mon.xp - a) / (b - a), 0, 1)
end

-- Evolution rules (creature "evolution": [ ... ]):
--   { "into": "id", "level": 16 }            level reached
--   { "into": "id", "item": "dusk_shard" }   item used on it (trigger.item)
--   { "into": "id", "level": 20, "if": <condition> }   extra condition (flags, map, ...)
-- check(trigger) -> species id or nil. trigger = { item = id? }, cond = function(condition) -> bool
function M.evolutionFor(mon, trigger, cond)
	local sp = M.species(mon)
	trigger = trigger or {}
	for _, e in sp.evolution do
		local ok = true
		if e.level and mon.level < e.level then ok = false end
		if e.item and e.item ~= trigger.item then ok = false end
		if not e.item and trigger.item then ok = false end
		if ok and e["if"] ~= nil and cond and not cond(e["if"]) then ok = false end
		if ok and Content.creatures[e.into] then return e.into end
	end
	return nil
end

function M.evolve(mon, into: string)
	local oldMax = mon.maxhp or 1
	local from = mon.id
	mon.id = into
	M.refresh(mon)
	if mon.hp > 0 then mon.hp = math.min(mon.maxhp, mon.hp + (mon.maxhp - oldMax)) end
	-- learn the new species' moves for the current level (if room)
	local sp = M.species(mon)
	for _, l in sp.learnset do
		if (l.level or 1) == mon.level then M.learn(mon, l.move) end
	end
	return from
end

-- sprite asset for a creature ("front" | "back" | "icon"); falls back front -> any
function M.sprite(speciesOrMon, which: string): string?
	local sp = if type(speciesOrMon) == "table" and speciesOrMon.base then speciesOrMon else Content.creature(speciesOrMon.id or speciesOrMon)
	local s = sp.sprites
	return s[which] or s.front or s.icon or s.back
end

return M
