--!nonstrict
-- Between-run progression: coins (core wallet), best distance/score, missions (data/missions), daily challenge
-- (clock.now day seed + modifier), characters/skins (progression tree "characters" bought with coins; perks = player
-- param mods), obby stage bests + ghosts. Saved in core save section "runner".
local S = require("./state")
local M = {}

local function fresh() return { best = 0, bestScore = 0, runs = 0, totals = {}, missions = {}, done = {}, daily = {}, character = nil, stages = {}, ghosts = {} } end
M.data = fresh()
M.tree = nil

function M.init()
	local core = S.core
	if core.wallet.defs()[S.config.currency] == nil then core.wallet.define(S.config.currency, { name = S.config.currencyName, start = 0, max = 9999999 }) end
	if M.tree == nil then M.tree = S.prog.tree({ name = "characters", defs = S.all("characters"), kind = "characters" }) end
	core.save.section("runner", {
		serialize = function() return M.data end,
		deserialize = function(_, t)
			M.data = fresh()
			for k, v in t or {} do M.data[k] = v end
		end,
	})
	M.fillMissions()
	M.ensureDefaultCharacter()
end

---------------------------------------------------------------- characters
function M.characters()
	local out = {}
	local list = table.clone(S.all("characters"))
	table.sort(list, function(a, b)
		if (a.order or 99) ~= (b.order or 99) then return (a.order or 99) < (b.order or 99) end
		return a.id < b.id
	end)
	for _, d in list do
		table.insert(out, { id = d.id, def = d, owned = M.tree:has(d.id), selected = M.data.character == d.id, cost = M.tree:cost(d.id)[S.config.currency] or 0 })
	end
	return out
end
function M.ensureDefaultCharacter()
	for _, c in M.characters() do
		if c.cost == 0 and not c.owned then M.tree:unlock(c.id, true) end
	end
	if M.data.character == nil or not M.tree.defs[M.data.character] then
		for _, c in M.characters() do if M.tree:has(c.id) then M.data.character = c.id break end end
	end
end
-- buy(id) -> ok, reason ; select(id) -> ok
function M.buy(id)
	local ok, why = M.tree:unlock(id)
	if ok then S.core.save.save() end
	return ok, why
end
function M.select(id)
	if not M.tree:has(id) then return false end
	M.data.character = id
	return true
end
function M.character() return M.data.character and S.get("characters", M.data.character) end

-- params() -> player params with the selected character's mods (progression stats.apply)
function M.params()
	local base = table.clone(S.config.player)
	local ch = M.character()
	if ch and ch.mods then base = S.prog.stats.apply(base, ch.mods) end
	return base
end

---------------------------------------------------------------- missions
-- mission def: { text, stat = "coins"|"distance"|"jumps"|"slides"|"lanes"|"powerups"|"gems"|"runs"|"score",
--               target, scope = "run" (best single run) | "total" (summed), reward = core effects, order? }
local function missionList()
	local list = table.clone(S.all("missions"))
	table.sort(list, function(a, b)
		if (a.order or 999) ~= (b.order or 999) then return (a.order or 999) < (b.order or 999) end
		return a.id < b.id
	end)
	return list
end
function M.fillMissions()
	local d = M.data
	for i = #d.missions, 1, -1 do if d.done[d.missions[i].id] or not S.get("missions", d.missions[i].id) then table.remove(d.missions, i) end end
	for _, m in missionList() do
		if #d.missions >= S.config.missionSlots then break end
		local active = false
		for _, a in d.missions do if a.id == m.id then active = true end end
		if not active and not d.done[m.id] then table.insert(d.missions, { id = m.id, progress = 0 }) end
	end
end
-- missions() -> { {id, def, progress, target, done} } (active slots)
function M.missions()
	local out = {}
	for _, a in M.data.missions do
		local def = S.req("missions", a.id)
		table.insert(out, { id = a.id, def = def, text = def.text, progress = math.min(a.progress, def.target), target = def.target, done = a.progress >= def.target })
	end
	return out
end
-- progress(runStats, final?) -> completed list (live: newly reached this call; final: every mission completed + rewarded now). Call live (final = false: only "run"-scoped progress, toasts)
-- and once at the end of the run (final = true: totals added, rewards applied, slots refilled).
function M.progress(st, final)
	local d = M.data
	local newly = {}
	for _, a in d.missions do
		local def = S.req("missions", a.id)
		local v = st[def.stat] or 0
		local wasDone = a.progress >= def.target
		if def.scope == "total" then
			if final then a.progress += v end
			local live = a.progress + (if final then 0 else v)
			if not wasDone and live >= def.target and (final or not a.flag) then a.flag = true table.insert(newly, def) end
		else
			if v > a.progress then a.progress = v end
			if not wasDone and a.progress >= def.target then table.insert(newly, def) end
		end
	end
	if final then
		newly = {}
		for _, a in table.clone(d.missions) do
			local def = S.req("missions", a.id)
			if a.progress >= def.target then
				table.insert(newly, def)
				d.done[a.id] = true
				if def.reward then S.core.apply(def.reward) end
				S.core.events.emit("mission_completed", { mission = a.id })
			end
		end
		M.fillMissions()
	end
	return newly
end

---------------------------------------------------------------- daily challenge
function M.day(now)
	now = now or (if type(clock) == "table" and type(clock.now) == "function" then clock.now() else 0)
	return math.floor(now / 86400)
end
-- daily(now?) -> { day, seed, modifier, target (m), done }
function M.daily(now)
	local day = M.day(now)
	local seed = S.procgen.RNG.hash("runner-daily-" .. day)
	local r = S.procgen.rng(seed)
	local mods = S.config.dailyModifiers
	local cfg = S.config.daily
	local target = math.floor((cfg.base + r:int(0, cfg.spread) + (cfg.perDay or 0) * 0) / 50 + 0.5) * 50
	local rec = M.data.daily[tostring(day)]
	return { day = day, seed = seed, modifier = if #mods > 0 then mods[r:int(1, #mods)] else nil, target = target, done = rec ~= nil and rec.done == true, best = rec and rec.best or 0 }
end
-- completeDaily(distance, now?) -> rewarded (bool)
function M.completeDaily(dist, now)
	local dl = M.daily(now)
	local key = tostring(dl.day)
	local rec = M.data.daily[key] or { best = 0 }
	rec.best = math.max(rec.best, dist)
	local rewarded = false
	if dist >= dl.target and not rec.done then
		rec.done = true
		rewarded = true
		S.core.apply(S.config.daily.reward)
		S.core.events.emit("daily_completed", { day = dl.day })
	end
	M.data.daily = { [key] = rec } -- keep only today
	return rewarded
end

---------------------------------------------------------------- obby records
-- stageRecord(id) -> { best (s), deaths, ghost? }
function M.stageRecord(id) return M.data.stages[id] end
-- finishStage(id, time, ghost, deaths) -> isBest
function M.finishStage(id, t, ghost, deaths)
	local rec = M.data.stages[id]
	local isBest = rec == nil or t < rec.best
	if isBest then
		M.data.stages[id] = { best = math.floor(t * 100 + 0.5) / 100, deaths = deaths }
		M.data.ghosts[id] = ghost
	end
	S.core.events.emit("stage_completed", { stage = id, time = t, best = isBest })
	return isBest
end
function M.ghost(id) return M.data.ghosts[id] end
function M.stagesDone()
	local n = 0
	for _ in M.data.stages do n += 1 end
	return n
end

return M
