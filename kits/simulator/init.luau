--!nonstrict
-- simulator kit: Roblox-style collect/upgrade simulators (tap/auto collect → backpack → sell → upgrade tools/backpacks →
-- unlock zones → hatch pets from in-game-coin eggs → rebirth). Built on core (wallet, events, quests, save, menus),
-- progression (rebirth = prestige layer, daily streaks) and juice (feel). See KIT.md.
local Core = require("@kit/core")
local Prog = require("@kit/progression")
local Sim = require("./sim")

local K = { VERSION = "0.1.0" }
K.content = require("./content")
K.format = require("./format")
K.balance = require("./balance")
K.ui = require("./ui")
K.new = Sim.new
K.Sim = Sim.Sim

local bound = false
local function bind()
	if bound then return end
	bound = true
	local C = Core.conditions
	local function cur() return Sim.current end
	-- {"zone":"meadow"}: zone unlocked
	C.registerCondition("zone", function(c) local s = cur() return s ~= nil and s.zones[c.zone] == true end)
	-- {"pet":"bunny","count":2}: owns ≥ count
	C.registerCondition("pet", function(c) local s = cur() return s ~= nil and (s.pets[c.pet] or 0) >= (c.count or 1) end)
	-- {"gear":"steel_pick"}: owns that tool/backpack
	C.registerCondition("gear", function(c) local s = cur() return s ~= nil and (s.tools[c.gear] == true or s.packs[c.gear] == true) end)
	-- {"rebirths": 2} (or use progression's {"prestige":2,"layer":"rebirth"})
	C.registerCondition("rebirths", function(c) local s = cur() return C.compare(if s then s.layer.count else 0, c, c.rebirths) end)
	-- effects: {"pet":"bunny"} give a pet (quest reward), {"hatch":"egg_id"} free hatch (rolls shown odds)
	C.registerEffect("pet", function(e) local s = cur() if s then s:givePet(e.pet, e.count) end end)
	C.registerEffect("hatch", function(e)
		local s = cur()
		if not s then return end
		local pid = s:roll(e.hatch)
		s:givePet(pid)
		s:emit("pet_hatched", { pet = pid, rarity = s.C.petsById[pid].rarity, egg = e.hatch, free = true })
	end)
end

-- start(opts?) -> sim, offlineReport
-- One call from a session script (or a shared module's init): builds the sim from data files (or opts.content),
-- wires core content/save, loads the save, credits offline earnings, starts autosave + play-time stats.
-- opts: { content?, core? (core.setup config: currencies/theme/save…), rand?, autosave? (10 s), autoload? (true), daily? (streak opts) }
function K.start(opts)
	opts = opts or {}
	bind()
	local cfg = opts.core or {}
	cfg.save = cfg.save or { key = "simulator", version = 1 }
	local autoload = opts.autoload ~= false
	local s = Sim.new(opts.content, { rand = opts.rand, now = opts.now })
	local daily = nil
	if opts.daily then
		daily = Prog.streak(opts.daily)
		s.daily = daily
	end
	Core.setup({ data = cfg.data, items = cfg.items, quests = cfg.quests, dialog = cfg.dialog, achievements = cfg.achievements,
		currencies = cfg.currencies, theme = cfg.theme, save = cfg.save })
	local offline = nil
	if autoload and Core.save.load() then
		offline = s:claimOffline()
	end
	s:touch()
	Core.quests.evaluate()
	local function timers()
		every(opts.autosave or 10, function() s:touch() s:leaderboard() Core.save.save() end)
		onTick(function(dt) if not Core.pause.isPaused() then s:addPlayTime(dt) end end)
	end
	-- session code: autosave + play time survive loadScene / restart even when started from a scene script
	if type(game) == "table" and game.session then game.session(timers) else timers() end
	return s, offline
end

K.bind = bind
function K.current() return Sim.current end

return K
