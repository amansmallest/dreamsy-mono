--!nonstrict
-- progression kit: XP curves, stats, skill/unlock trees, prestige, daily streaks, milestones, difficulty, balance sims.
-- Works standalone; when the game also enables the core kit it binds automatically (xp/level/skill condition +
-- effect kinds, events, save section "progression"). See KIT.md.
local P = require("./shared")
local Curves = require("./curves")
local Prog = { VERSION = "0.1.0" }

Prog.curve = Curves.new
Prog.curves = Curves
Prog.stats = require("./stats")
Prog.skills = require("./skills")
Prog.prestige = require("./prestige")
Prog.daily = require("./daily")
Prog.milestones = require("./milestones")
Prog.difficulty = require("./difficulty")
Prog.balance = require("./balance")

-- register(name, obj): name an object (leveler, tree, prestige layer, daily, milestones) so core effects/conditions
-- can find it and the "progression" save section stores it. Constructors below register automatically when named.
function Prog.register(name: string, obj)
	if P.registry[name] == nil then table.insert(P.order, name) end
	P.registry[name] = obj
	return obj
end
function Prog.get(name: string) return P.registry[name] end

-- constructors that auto-register (name defaults shown)
function Prog.leveler(opts)
	opts = opts or {}
	local lv = Curves.leveler(opts)
	lv:onLevelUp(function(level, gained)
		if P.core then P.core.events.emit("level_up", { track = lv.name, level = level, gained = gained }) end
	end)
	return Prog.register(lv.name, lv)
end
function Prog.tree(opts)
	opts = opts or {}
	local t = Prog.skills.new(opts)
	return Prog.register(t.name, t)
end
function Prog.layer(opts)
	local l = Prog.prestige.new(opts)
	return Prog.register(l.name, l)
end
function Prog.streak(opts)
	local d = Prog.daily.new(opts)
	return Prog.register(d.name, d)
end
function Prog.milestoneSet(list, opts)
	local m = Prog.milestones.new(list, opts)
	return Prog.register(m.name, m)
end

-- override the daily-reward clock (default: engine clock.now()): setClock(fn() -> unix seconds)
function Prog.setClock(fn) P.clock = fn end

-- bind(core): wire into the core kit (done automatically if "core" is enabled)
function Prog.bind(core)
	if P.core == core then return end
	P.core = core
	local C = core.conditions
	C.registerCondition("level", function(c)
		local lv = P.registry[c.track or "player"]
		local L = if lv then lv.level else 0
		return C.compare(L, c, c.level)
	end)
	C.registerCondition("skill", function(c)
		local t = P.registry[c.tree or "skills"]
		return t ~= nil and t:rank(c.skill) >= (c.rank or 1)
	end)
	C.registerCondition("prestige", function(c)
		local l = P.registry[c.layer or "prestige"]
		return C.compare(if l then l.count else 0, c, c.prestige)
	end)
	C.registerCondition("milestone", function(c)
		local m = P.registry[c.set or "milestones"]
		return m ~= nil and m:reached(c.milestone)
	end)
	C.registerEffect("xp", function(e)
		local lv = P.registry[e.track or "player"]
		if not lv then error("xp effect: no leveler \"" .. (e.track or "player") .. "\" (prog.leveler({ name = ... }))", 3) end
		lv:add(e.xp)
	end)
	C.registerEffect("skillPoints", function(e)
		local t = P.registry[e.tree or "skills"]
		if not t then error("skillPoints effect: no tree \"" .. (e.tree or "skills") .. "\"", 3) end
		t:addPoints(e.skillPoints)
	end)
	C.registerEffect("unlockSkill", function(e)
		local t = P.registry[e.tree or "skills"]
		t:unlock(e.unlockSkill, true)
	end)
	core.save.section("progression", {
		serialize = function()
			local out = {}
			for _, name in P.order do out[name] = P.registry[name]:serialize() end
			return out
		end,
		deserialize = function(_, t)
			t = t or {}
			for _, name in P.order do P.registry[name]:deserialize(t[name]) end
		end,
	})
end

do
	local ok, core = pcall(require, "@kit/core")
	if ok and type(core) == "table" and core.conditions then Prog.bind(core) end
end

return Prog
