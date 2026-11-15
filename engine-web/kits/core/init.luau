--!nonstrict
-- core kit: foundation systems every genre kit and game reuses. See KIT.md.
local S = require("./shared")
local Core = { VERSION = "0.1.0" }

Core.events = require("./events")
Core.fsm = require("./fsm")
Core.content = require("./content")
Core.flags = require("./flags")
Core.wallet = require("./wallet")
Core.inventory = require("./inventory")
Core.conditions = require("./conditions")
Core.quests = require("./quests")
Core.achievements = require("./achievements")
Core.dialog = require("./dialog")
Core.pause = require("./pause")
Core.timers = require("./timers")
Core.menus = require("./menus")
Core.save = require("./save")
Core.ui = Core.menus
Core.bag = Core.inventory.new({ id = "bag" })

for k, v in Core do S[k] = v end

-- global event fan-out to quests + achievements
Core.events.on("*", function(name, data)
	Core.quests._onEvent(name, data)
	Core.achievements._onEvent(name, data)
end)

-- save sections for all core state
local function mod(m) return { serialize = function() return m.serialize() end, deserialize = function(_, t) m.deserialize(t) end, reset = function() if m.resetAll then m.resetAll() elseif m.reset then m.reset() else m.deserialize(nil) end end } end
Core.save.section("flags", mod(Core.flags))
Core.save.section("wallet", mod(Core.wallet))
Core.save.section("quests", mod(Core.quests))
Core.save.section("achievements", mod(Core.achievements))
Core.save.section("dialog", mod(Core.dialog))
Core.save.section("inventories", {
	serialize = function()
		local out = {}
		for id, inv in Core.inventory.byId do if inv.saved ~= false then out[id] = inv:serialize() end end
		return out
	end,
	deserialize = function(_, t)
		t = t or {}
		for id, inv in Core.inventory.byId do if inv.saved ~= false then inv:deserialize(t[id]) end end
	end,
})

-- emit(name, data?): shorthand for core.events.emit — use for game facts quests/achievements count
-- ("enemy_defeated" {enemy = "slime"}, "level_completed" {level = 3}, "talked" {npc = "owl"}).
function Core.emit(name: string, data: any?) Core.events.emit(name, data or {}) end
function Core.check(cond, ctx) return Core.conditions.check(cond, ctx) end
function Core.apply(effects, ctx) Core.conditions.apply(effects, ctx) end

-- setup(config): one call to wire content + options. All keys optional.
-- { data? (path-keyed files { ["data/items/apple.json"] = {...} }), items?, quests?, dialog?, achievements? (tables: list or id map; else data/<kind>/*.json via the engine loader),
--   currencies? = { gold = { name, icon, start, max } }, bag? = { slots, categorySlots },
--   theme? = {...}, save? = { key, version, migrate }, autoload? (load save now), autosave? = seconds }
function Core.setup(cfg)
	cfg = cfg or {}
	if cfg.data then Core.content.registerFiles(cfg.data) end
	for _, kind in { "items", "quests", "dialog", "achievements" } do
		if cfg[kind] then Core.content.register(kind, cfg[kind]) elseif not cfg.data then Core.content.load(kind) end
	end
	for id, d in cfg.currencies or {} do Core.wallet.define(id, d) end
	if cfg.bag then
		Core.bag.slotCount = cfg.bag.slots
		Core.bag.categorySlots = cfg.bag.categorySlots or {}
		if cfg.bag.strict ~= nil then Core.bag.strict = cfg.bag.strict end
	end
	if cfg.theme then Core.menus.theme(cfg.theme) end
	if cfg.save then Core.save.configure(cfg.save) end
	local loaded = false
	if cfg.autoload then loaded = Core.save.load() end
	if cfg.autosave and type(every) == "function" then every(cfg.autosave, function() Core.save.save() end) end
	Core.quests.evaluate()
	return loaded
end

-- newGame(): reset every section to its starting state (wallet starts, empty bag, no quests)
function Core.newGame()
	Core.save.reset()
	Core.quests.evaluate()
end

return Core
