--!nonstrict
-- survival kit: gather / craft / build with day-night, needs, night waves, death/respawn. See KIT.md.
-- Thin layer: core (inventory, events, save, menus, conditions), progression (optional XP), juice (feel),
-- combat (fighters, swings), ai (night threats), procgen (world, waves).
local core = require("@kit/core")
local Survival = { VERSION = "0.1.0" }

Survival.content = require("./content")
Survival.world = require("./world")
Survival.recipes = require("./recipes")
Survival.Sim = require("./sim")
Survival.balance = require("./balance")
Survival.current = nil

-- new(content?, opts?) -> Sim (content defaults to Survival.content.load())
function Survival.new(C, opts)
	C = C or Survival.content.load()
	local s = Survival.Sim.new(C, opts)
	Survival.current = s
	return s
end

local bound = false
-- bind(s): save section "survival" + core condition/effect kinds (call once, before core.save.load()).
--   conditions: {"built":"campfire"} {"nights":3} (survived ≥) {"day":2} (≥) {"found":"ruins"} (a POI of that id found)
--   effects: {"feed":{"hunger":20}} {"heal":10}
function Survival.bind(s)
	Survival.current = s
	if bound then return end
	bound = true
	core.save.section("survival", {
		serialize = function() return if Survival.current then Survival.current:serialize() else nil end,
		deserialize = function(_, t) if Survival.current and t then Survival.current:deserialize(t) end end,
	})
	local C = core.conditions
	C.registerCondition("built", function(c) local s2 = Survival.current return s2 ~= nil and s2:count(c.built) >= (c.count or 1) end)
	C.registerCondition("nights", function(c) local s2 = Survival.current return s2 ~= nil and s2.stats.nightsSurvived >= c.nights end)
	C.registerCondition("day", function(c) local s2 = Survival.current return s2 ~= nil and s2:dayNumber() >= c.day end)
	C.registerCondition("found", function(c)
		local s2 = Survival.current
		if not s2 then return false end
		for _, p in s2.world.pois do if p.id == c.found and p.found then return true end end
		return false
	end)
	C.registerEffect("feed", function(e)
		local s2 = Survival.current
		if not s2 then return end
		for k, v in e.feed do if s2.needs[k] then s2.needs[k] = math.clamp(s2.needs[k] + v, 0, s2.cfg.needs[k].max or 100) end end
	end)
	C.registerEffect("heal", function(e)
		local s2 = Survival.current
		if s2 then s2.needs.health = math.min(s2.cfg.needs.health.max, s2.needs.health + e.heal) end
	end)
end

-- play(s, opts): the runtime (map, player, HUD, hotbar, build mode, crafting, night threats). See view.luau / KIT.md.
function Survival.play(s, opts)
	return require("./view").play(s, opts)
end

return Survival
