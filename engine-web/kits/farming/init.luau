--!nonstrict
-- farming kit: cozy life sim (calendar, crops, animals, shipping, shops, crafting, villagers, festivals, upgrades,
-- collections) on top of core (wallet, bag, dialog, menus, save), progression (upgrade tree, farming level),
-- juice (feedback) and ai (villager paths). See KIT.md.
local core = require("@kit/core")
local Content = require("./content")
local FarmM = require("./farm")

local Farming = { VERSION = "0.1.0" }
Farming.content = Content
Farming.villagers = require("./villagers")
Farming.balance = require("./balance")
Farming.clockText = FarmM.clockText
Farming.key = FarmM.key
Farming.unkey = FarmM.unkey

-- new(C?, opts?) -> farm (pure state object; see farm.luau). C defaults to Content.load() (data files).
function Farming.new(C, opts)
	if C == nil then C = Content.load() elseif not C.normalized then C = Content.normalize(C) end
	return FarmM.new(C, opts)
end

-- start(cfg?) -> farm, loaded: the one-call setup for a game (call once from a session script / shared module).
-- cfg: { core = core.setup options (theme, save = { key, version }, bag = { slots }), content? (raw table; default data files),
--        isSoil? = fn(c, r), upgrades? = defs, newGame? = fn(farm) (first launch: starting items/gold) }
local current = nil
function Farming.start(cfg)
	if current then return current, false end
	cfg = cfg or {}
	local coreCfg = table.clone(cfg.core or {})
	coreCfg.autoload = false
	coreCfg.save = coreCfg.save or { key = "farming", version = 1 }
	core.setup(coreCfg)
	local C = if cfg.content then Content.normalize(cfg.content) else Content.load()
	local farm = FarmM.new(C, { isSoil = cfg.isSoil, upgrades = cfg.upgrades, autosave = cfg.autosave })
	if C.config.bagSlots then core.bag.slotCount = C.config.bagSlots end
	local loaded = core.save.load()
	if not loaded then
		for item, n in C.config.startItems or {} do core.bag:add(item, n) end
		if cfg.newGame then cfg.newGame(farm) end
	end
	current = farm
	return farm, loaded
end
function Farming.current() return current end

-- view (scene integration: tilemap, player, crops, villagers, HUD, menus) — loaded lazily so headless tests skip it
function Farming.bind(farm, opts)
	return require("./view").bind(farm, opts)
end

return Farming
