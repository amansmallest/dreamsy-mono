--!nonstrict
-- Meta-progression between runs: persistent currency (core wallet), meta tree (progression tree "meta",
-- data/meta/*.json), class unlocks (class.unlock = core condition), heat levels (unlocked per class by wins),
-- run history/records, daily seeded run. Saved in the core save section "roguelite" (+ wallet + progression).
local S = require("./state")
local M = {}

M.data = { runs = 0, wins = 0, bestFloor = 0, classes = {}, history = {}, daily = {}, run = nil }
M.tree = nil

local function cls(id)
	local c = M.data.classes[id]
	if not c then c = { runs = 0, wins = 0, heat = -1, bestFloor = 0 } M.data.classes[id] = c end
	return c
end
M.classStats = cls

function M.init()
	local core = S.core
	if core.wallet.defs()[S.config.metaCurrency] == nil then core.wallet.define(S.config.metaCurrency, { name = S.config.metaName, start = 0, max = 999999 }) end
	if core.wallet.defs()[S.config.runCurrency] == nil then core.wallet.define(S.config.runCurrency, { name = "Gold", start = 0, max = 999999 }) end
	if M.tree == nil then
		local defs = S.all("meta")
		M.tree = S.prog.tree({ name = "meta", defs = defs, kind = "meta" })
	end
	core.save.section("roguelite", {
		serialize = function() return M.data end,
		deserialize = function(_, t)
			M.data = { runs = 0, wins = 0, bestFloor = 0, classes = {}, history = {}, daily = {}, run = nil }
			for k, v in t or {} do M.data[k] = v end
		end,
	})
end

function M.currency() return S.core.wallet.get(S.config.metaCurrency) end
function M.mods() return if M.tree then M.tree:mods() else {} end

-- classes() -> { {id, def, unlocked, wins, maxHeat} } (sorted by def.order, id)
function M.classes()
	local list = table.clone(S.all("classes"))
	table.sort(list, function(a, b)
		if (a.order or 99) ~= (b.order or 99) then return (a.order or 99) < (b.order or 99) end
		return a.id < b.id
	end)
	local out = {}
	for _, d in list do
		table.insert(out, { id = d.id, def = d, unlocked = M.unlocked(d.id), wins = cls(d.id).wins, maxHeat = M.maxHeat(d.id) })
	end
	return out
end
function M.unlocked(id)
	local d = S.req("classes", id)
	if d.unlock == nil then return true end
	return S.core.check(d.unlock)
end
-- heat: 0 until the class's first win; then highest heat won + 1 (capped at #config.heat)
function M.maxHeat(id)
	local c = cls(id)
	if c.wins == 0 then return 0 end
	return math.min(#(S.config.heat or {}), c.heat + 1)
end

-- metaReward(summary) -> currency for this run
function M.reward(sum)
	local m = S.config.meta
	local v = sum.floorsCleared * m.perFloor + (sum.bosses or 0) * m.perBoss + sum.kills * m.perKill + (if sum.won then m.win else 0)
	v *= 1 + (sum.heat or 0) * m.heatBonus
	return math.floor(v + 0.5)
end

-- record(summary) -> summary (+ metaEarned, newBest, unlockedHeat). Called by roguelite.finish().
function M.record(sum)
	local d = M.data
	d.runs += 1
	local c = cls(sum.class)
	c.runs += 1
	sum.newBest = sum.floor > d.bestFloor
	d.bestFloor = math.max(d.bestFloor, sum.floor)
	c.bestFloor = math.max(c.bestFloor, sum.floor)
	local beforeHeat = M.maxHeat(sum.class)
	if sum.won then
		d.wins += 1
		c.wins += 1
		c.heat = math.max(c.heat, sum.heat or 0)
	end
	sum.unlockedHeat = if M.maxHeat(sum.class) > beforeHeat then M.maxHeat(sum.class) else nil
	local earned = M.reward(sum)
	sum.metaEarned = earned
	if earned > 0 then S.core.wallet.add(S.config.metaCurrency, earned) end
	if sum.daily then
		local key = tostring(sum.daily)
		local prev = d.daily[key]
		d.daily[key] = { floor = math.max(sum.floor, if prev then prev.floor else 0), won = sum.won or (prev ~= nil and prev.won), played = true }
	end
	table.insert(d.history, 1, { class = sum.class, floor = sum.floor, won = sum.won, heat = sum.heat, kills = sum.kills, daily = sum.daily })
	while #d.history > 10 do table.remove(d.history) end
	d.run = nil
	S.core.flags.set("roguelite_wins", d.wins)
	S.core.flags.set("roguelite_runs", d.runs)
	return sum
end

---------------------------------------------------------------- daily
-- day(now?) -> integer day index (clock.now() wall clock; falls back to 0 without one)
function M.day(now)
	now = now or (if type(clock) == "table" and type(clock.now) == "function" then clock.now() else 0)
	return math.floor(now / 86400)
end
-- dailySeed(now?) -> seed, day: same for every player on a calendar day (UTC)
function M.dailySeed(now)
	local day = M.day(now)
	return S.procgen.RNG.hash and S.procgen.RNG.hash("daily-" .. day) or (day * 7919 + 17) % 2147480000, day
end
-- daily(now?) -> { day, seed, class (fixed per day, from the unlocked classes), played, best }
function M.daily(now)
	local seed, day = M.dailySeed(now)
	local list = {}
	for _, c in M.classes() do if c.unlocked then table.insert(list, c) end end
	local r = S.procgen.rng(seed)
	local pick = list[r:int(1, math.max(1, #list))]
	local rec = M.data.daily[tostring(day)]
	return { day = day, seed = seed, class = pick and pick.id, heat = 0, played = rec ~= nil, best = rec and rec.floor or 0, won = rec and rec.won or false }
end

return M
