-- rpg kit: events games can connect to (rpg.events.<name>:connect(fn)) and override points (rpg.hooks).
-- Every event is also emitted on the core event bus as "rpg.<name>" with named fields (FIELDS), so core
-- quests/achievements can count rpg facts: { "event": "rpg.trainerDefeated", "match": { "trainer": "vela" } }.
local U = require("./util")
local CoreEvents = require("@kit/core/events")

local E = {}
local NAMES = {
	"flagSet", -- (name, value)
	"varSet", -- (name, value)
	"moneyChanged", -- (money, delta)
	"itemObtained", -- (itemId, count)
	"itemUsed", -- (itemId, target creature?)
	"creatureObtained", -- (mon, where: "party"|"box")
	"creatureCaught", -- (mon)
	"creatureSeen", -- (speciesId)
	"levelUp", -- (mon, level)
	"evolved", -- (mon, fromSpecies, toSpecies)
	"questUpdated", -- (questId, state, stepId)
	"questCompleted", -- (questId)
	"battleStarted", -- (battle)
	"battleEnded", -- (battle, result: "win"|"lose"|"run"|"caught")
	"trainerDefeated", -- (trainerId)
	"mapEntered", -- (mapId, spawnId)
	"stepped", -- (x, y, mapId)
	"interacted", -- (kind: "npc"|"sign"|"item"|"object", def)
	"dialogStarted", -- (dialogId)
	"dialogEnded", -- (dialogId)
	"shopOpened", -- (shopId)
	"saved", -- ()
	"loaded", -- ()
	"newGame", -- ()
	"custom", -- (name, args): the "emit" dialog effect
}
-- core-bus field names per event (positional args -> data table)
local FIELDS = {
	flagSet = { "flag", "value" }, varSet = { "var", "value" }, moneyChanged = { "money", "delta" },
	itemObtained = { "item", "count" }, itemUsed = { "item", "mon" }, creatureObtained = { "mon", "where" },
	creatureCaught = { "mon" }, creatureSeen = { "creature" }, levelUp = { "mon", "level" }, evolved = { "mon", "from", "to" },
	questUpdated = { "quest", "state", "step" }, questCompleted = { "quest" }, battleStarted = { "battle" },
	battleEnded = { "battle", "result" }, trainerDefeated = { "trainer" }, mapEntered = { "map", "spawn" },
	stepped = { "x", "y", "map" }, interacted = { "kind", "def" }, dialogStarted = { "dialog" }, dialogEnded = { "dialog" },
	shopOpened = { "shop" }, custom = { "name", "args" },
}
for _, n in NAMES do
	local sig = U.signal(n)
	local fields = FIELDS[n] or {}
	local fire = sig.fire
	sig.fire = function(self, ...)
		fire(self, ...)
		local d = {}
		for i, f in fields do d[f] = select(i, ...) end
		if type(d.mon) == "table" then d.creature = d.mon.id end -- species id, for core `match`
		CoreEvents.emit("rpg." .. n, d)
	end
	E[n] = sig
end
E.NAMES = NAMES

-- Override points. Each is optional; return nil to fall back to the kit's default.
E.hooks = {
	-- moveEffect[id](ctx) for move effects { "type": "custom", "id": "<id>" }; ctx has battle, user, target, move, damage, emit(event), rng
	moveEffect = {},
	-- effect[name](args, ctx) for dialog/script effects { "<name>": args } the kit doesn't know
	effect = {},
	-- condition[name](args) -> boolean for conditions { "<name>": args } the kit doesn't know
	condition = {},
	-- objective[type](objective, quest) -> current progress number for custom quest objectives
	objective = {},
	-- encounter(mapId, tag, x, y) -> { creature, level } | false (no battle) | nil (default roll)
	encounter = nil,
	-- catchChance(p, ctx) -> new probability 0..1
	catchChance = nil,
	-- damage(dmg, ctx) -> new damage
	damage = nil,
	-- ai[name](battle, side) -> action, for trainers/creatures with "ai": "<name>"
	ai = {},
	-- interact(kind, def) -> true to handle it yourself
	interact = nil,
	-- statusEffects[name] = { name, onTurnEnd(battler, battle) -> events?, canAct(battler, battle) -> bool, text }
	status = {},
	-- startBattle(opts) -> true to replace the kit's battle screen entirely
	startBattle = nil,
}

return E
