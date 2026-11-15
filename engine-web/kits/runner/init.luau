--!nonstrict
-- runner kit: endless lane runner (segments by difficulty tier + biome, speed ramp, jump/slide/lanes via swipes,
-- coins + magnet/shield/2x, missions, daily challenge, characters, best distance) and obby mode (hand-authored +
-- procgen stages: movers, vanishers, conveyors, spinners, spikes, bounce pads, checkpoints, timer, best ghost).
-- Thin layer over core (content, wallet, save, events, effects) + progression (difficulty, character tree, stats)
-- + procgen (rng). Sims are pure; views draw them. See KIT.md.
local S = require("./state")
local Meta = require("./meta")
local R = { VERSION = "0.1.0" }

R.config = S.config
R.track = require("./track")
R.endless = require("./endless")
R.obby = require("./obby")
R.controls = require("./controls")
R.view = require("./view")
R.meta = Meta

-- setup({ data? (path-keyed files), content? = { segments, missions, characters, stages }, config? (default data/runner.json),
--         core? (core.setup opts if the game hasn't), load? (core.save.load()) })
local didInit = false
function R.setup(cfg)
	cfg = cfg or {}
	local core = S.core
	if cfg.core then core.setup(cfg.core) end
	if cfg.data then core.content.registerFiles(cfg.data) end
	for _, kind in S.KINDS do
		if cfg.content and cfg.content[kind] then core.content.register(kind, cfg.content[kind])
		elseif #core.content.all(kind) == 0 and not cfg.data then core.content.load(kind) end
	end
	local conf = cfg.config
	if conf == nil and type(data) == "table" and type(data.exists) == "function" and data.exists("data/runner.json") then conf = data.read("data/runner.json") end
	if conf == nil and cfg.data then conf = cfg.data["data/runner.json"] end
	for k in S.config do S.config[k] = nil end
	for k, v in S.DEFAULTS do S.config[k] = v end
	S.merge(S.config, conf)
	-- every segment must be passable
	for _, seg in core.content.all("segments") do
		local ok, probs = R.track.validate(seg)
		if not ok then error("runner: segment \"" .. seg.id .. "\" " .. table.concat(probs, "; "), 2) end
	end
	if not didInit then Meta.init() didInit = true end
	if cfg.load then core.save.load() Meta.fillMissions() Meta.ensureDefaultCharacter() end
	return R
end

-- newRun({ seed?, daily? (true: today's seed + modifier) }) -> sim (with the selected character's params)
function R.newRun(opts)
	opts = opts or {}
	local seed, modifier, daily = opts.seed, nil, nil
	if opts.daily then
		daily = Meta.daily(opts.now)
		seed, modifier = daily.seed, daily.modifier
	end
	local sim = R.endless.new({ seed = seed or math.floor(random(1, 2147480000)), params = Meta.params(), modifier = modifier })
	sim.daily = daily
	S.core.events.emit("run_started", { daily = daily ~= nil })
	return sim
end

-- finish(sim) -> summary { distance, coins, score, best, newBest, missions = {completed defs}, daily = rewarded? }
-- Banks coins into the wallet, updates best, mission progress (final), daily challenge, saves.
function R.finish(sim)
	local sum = sim:summary()
	local d = Meta.data
	d.runs += 1
	sum.newBest = sum.distance > d.best
	d.best = math.max(d.best, sum.distance)
	d.bestScore = math.max(d.bestScore, sum.score)
	sum.best = d.best
	S.core.wallet.add(S.config.currency, sum.coins)
	local st = table.clone(sum)
	st.runs = 1
	sum.missions = Meta.progress(st, true)
	if sim.daily then sum.daily = Meta.completeDaily(sum.distance, nil) sum.dailyTarget = sim.daily.target end
	S.core.flags.set("runner_best", d.best)
	S.core.events.emit("run_finished", { distance = sum.distance, coins = sum.coins, best = sum.newBest })
	S.core.save.save()
	return sum
end

R.missions = Meta.missions
R.progress = Meta.progress
R.daily = Meta.daily
R.characters = Meta.characters
R.buyCharacter = Meta.buy
R.selectCharacter = Meta.select
R.params = Meta.params
function R.best() return Meta.data.best end
function R.coins() return S.core.wallet.get(S.config.currency) end

-- stages() -> ordered stage list: hand-authored data/stages/*.json (by `order`) then config.procStages
-- ({ { id, seed, difficulty, platforms } }) generated with obby.generate
function R.stages()
	local list = table.clone(S.all("stages"))
	table.sort(list, function(a, b)
		if (a.order or 99) ~= (b.order or 99) then return (a.order or 99) < (b.order or 99) end
		return a.id < b.id
	end)
	for _, g in S.config.procStages or {} do
		local st = R.obby.generate({ seed = g.seed, difficulty = g.difficulty, platforms = g.platforms, name = g.name })
		st.id = g.id
		st.order = g.order
		table.insert(list, st)
	end
	return list
end
function R.stage(id)
	for _, s in R.stages() do if s.id == id then return s end end
	error("runner: unknown stage \"" .. tostring(id) .. "\"", 2)
end
-- obbyRun(stageId) -> obby sim with the best ghost
function R.obbyRun(id)
	return R.obby.new(R.stage(id), { ghost = Meta.ghost(id) })
end
-- finishStage(id, o) -> isBest (records time, deaths, ghost; saves)
function R.finishStage(id, o)
	local best = Meta.finishStage(id, o.time, o:ghostString(), o.deaths)
	S.core.save.save()
	return best
end
R.stageRecord = Meta.stageRecord
-- unlocked(stageIndex) -> bool: stage i is open when stage i-1 is finished
function R.stageUnlocked(i)
	if i <= 1 then return true end
	local prev = R.stages()[i - 1]
	return prev ~= nil and Meta.stageRecord(prev.id) ~= nil
end

-- balanceJob(opts) -> job; job:step(simSteps = 6000) per tick -> done; job.result = { [tier] = { distances, mean, p10, p50, p90 } }
-- Bot survival distance distribution per difficulty tier (every tier in config.speed, fixed speed for that tier).
function R.balanceJob(opts)
	opts = opts or {}
	local tiers = {}
	for _, t in S.config.speed do if not table.find(tiers, t.params.tier) then table.insert(tiers, t.params.tier) end end
	local job = { result = {}, k = 1, done = false }
	local cur = nil
	function job:step(budget)
		if self.done then return true end
		budget = budget or 6000
		while budget > 0 and not self.done do
			if cur == nil then cur = R.endless.survivalJob({ tier = tiers[self.k], runs = opts.runs or 12, seed = opts.seed or 1, maxDist = opts.maxDist or 2000, skill = opts.skill, params = opts.params }) end
			local chunk = math.min(budget, 1000)
			budget -= chunk
			if cur:step(chunk) then
				self.result[tostring(tiers[self.k])] = cur.result
				cur = nil
				self.k += 1
				if self.k > #tiers then self.done = true end
			end
		end
		return self.done
	end
	return job
end

return R
