--!nonstrict
-- deckbuilder kit: card battler with runs. See KIT.md.
local Core = require("@kit/core")
local prog = require("@kit/progression")
local Content = require("./content")
local E = require("./effects")
local Battle = require("./battle")
local Run = require("./run")
local Map = require("./map")
local Bot = require("./bot")

local DB = { VERSION = "0.1.0" }
DB.Content, DB.effects, DB.Battle, DB.Run, DB.Map, DB.bot = Content, E, Battle, Run, Map, Bot
DB.C = nil
DB.current = nil

-- setup({ content? (table: tests / generated), save? (true: core save section "deckbuilder"), metaKey? ("deckbuilder_meta"),
--         metaCurve? (progression curve spec), events? (true: run facts -> core.emit) }) -> C
function DB.setup(opts)
	opts = opts or {}
	DB.C = if opts.content then Content.normalize(opts.content) else Content.load()
	DB.opts = opts
	DB.meta.key = opts.metaKey or "deckbuilder_meta"
	DB.meta.curve = prog.curve(opts.metaCurve or (DB.C.config.meta and DB.C.config.meta.curve) or { kind = "quadratic", base = 20, linear = 80, maxLevel = 30 })
	if opts.save ~= false and not DB._section then
		DB._section = true
		Core.save.section("deckbuilder", {
			serialize = function() return if DB.current then DB.current:serialize() else nil end,
			deserialize = function(_, t) DB.current = if t then Run.restore(DB.C, t, { emit = DB._emit }) else nil end,
			reset = function() DB.current = nil end,
		})
	end
	return DB.C
end

function DB.content() return DB.C or DB.setup() end
function DB._emit(name, data)
	if DB.opts and DB.opts.events == false then return end
	Core.emit(name, data)
	if name == "run_ended" then DB.meta.record(DB.current) end
end

-- newRun({ character, seed?, locked? (true: respect meta unlocks) }) -> run (DB.current)
function DB.newRun(o)
	local C = DB.content()
	o = o or {}
	local seed = o.seed or math.floor(random(1, 1e9))
	local character = o.character or C.order.characters[1]
	DB.current = Run.new({ C = C, character = character, seed = seed, emit = DB._emit,
		unlockLevel = if o.locked then DB.meta.level() else nil })
	return DB.current
end

function DB.defineStatus(name, def)
	local C = DB.content()
	C.config.statuses = C.config.statuses or {}
	C.config.statuses[name] = def
end

-- card helpers
function DB.card(id, up) return E.card(DB.content(), id, up) end
function DB.cardValue(id, up) return Run.cardValue(DB.content(), id, up) end

-- balance: DB.sim({ character?, seeds = 20 }) -> report (winRate, avgFloor, avgTurns, power curve, deaths)
function DB.sim(o)
	o = o or {}
	local C = o.C or DB.content()
	return Bot.sim({ C = C, character = o.character or C.order.characters[1], seeds = o.seeds, startSeed = o.startSeed, unlockLevel = o.unlockLevel })
end

-- ---------- meta progression (persistent across runs; engine save key, not a core slot) ----------
DB.meta = { key = "deckbuilder_meta" }
function DB.meta.get()
	local m = save.get(DB.meta.key, nil) or {}
	m.xp = m.xp or 0
	m.runs = m.runs or 0
	m.wins = m.wins or 0
	m.best = m.best or {}
	return m
end
function DB.meta.level()
	local c = DB.meta.curve or prog.curve({ kind = "quadratic", base = 20, linear = 80, maxLevel = 30 })
	return c:levelAt(DB.meta.get().xp)
end
function DB.meta.record(run)
	if run == nil then return end
	local m = DB.meta.get()
	local before = DB.meta.level()
	m.xp += run:score()
	m.runs += 1
	if run.state == "won" then m.wins += 1 end
	m.best[run.charId] = math.max(m.best[run.charId] or 0, run.floor)
	save.set(DB.meta.key, m)
	local after = DB.meta.level()
	if after > before then Core.emit("meta_level", { level = after }) end
	return m
end
function DB.meta.unlocked(def) return (def.unlock or 0) <= DB.meta.level() end
-- what the next meta level unlocks: { cards, relics, characters }
function DB.meta.unlocksAt(level)
	local C = DB.content()
	local out = { cards = {}, relics = {}, characters = {} }
	for _, area in { "cards", "relics", "characters" } do
		for _, id in C.order[area] do if (C[area][id].unlock or 0) == level then table.insert(out[area], id) end end
	end
	return out
end

-- lazily load the UI (needs a scene)
setmetatable(DB, { __index = function(t, k)
	if k == "ui" then local ui = require("./ui") ui.DB = t rawset(t, "ui", ui) return ui end
	return nil
end })

return DB
