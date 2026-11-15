-- Enemy encounters / waves by point budget.
local RNG = require("./rng")
local W = {}

--[[ enemies: list of { id, cost = 1, weight = 1, minLevel = 0, maxLevel = inf, tags?, max? (per encounter) }
   encounter(enemies, budget, rng|seed, { level = 1, tags = {..}? (any match), minCount = 1, maxCount = 12 })
   -> { ids = {id...}, cost = spent } (spends as much of the budget as fits; deterministic per seed) ]]
function W.encounter(enemies: { any }, budget: number, rngOrSeed: any?, opts: any?): any
	opts = opts or {}
	local rng = RNG.from(rngOrSeed)
	local level = opts.level or 1
	local pool = {}
	for _, e in enemies do
		local okTag = opts.tags == nil
		if opts.tags then
			for _, t in e.tags or {} do if table.find(opts.tags, t) then okTag = true end end
		end
		if okTag and level >= (e.minLevel or 0) and level <= (e.maxLevel or math.huge) then table.insert(pool, e) end
	end
	local ids, spent, per = {}, 0, {}
	local maxCount = opts.maxCount or 12
	while #ids < maxCount do
		local fit = {}
		for _, e in pool do
			if (e.cost or 1) <= budget - spent and (e.max == nil or (per[e.id] or 0) < e.max) then table.insert(fit, e) end
		end
		if #fit == 0 then break end
		local e = rng:weighted(fit)
		table.insert(ids, e.id)
		per[e.id] = (per[e.id] or 0) + 1
		spent += e.cost or 1
	end
	if #ids < (opts.minCount or 1) and #pool > 0 then
		-- always at least the cheapest enemy
		local cheapest = pool[1]
		for _, e in pool do if (e.cost or 1) < (cheapest.cost or 1) then cheapest = e end end
		table.insert(ids, cheapest.id)
		spent += cheapest.cost or 1
	end
	return { ids = ids, cost = spent }
end

--[[ waves(enemies, { count = 10, budget = 6, growth = 1.35 (x per wave) | add = 0, boss = { id, every = 5 }?,
                     seed|rng, gap = 2 (seconds between spawns), rest = 5 })
   -> { { wave = i, budget, ids = {...}, spawnTimes = {...} } } ]]
function W.waves(enemies: { any }, opts: any?): { any }
	opts = opts or {}
	local rng = RNG.from(opts.rng or opts.seed)
	local out = {}
	local budget = opts.budget or 6
	for i = 1, opts.count or 10 do
		local b = math.floor(budget)
		local enc = W.encounter(enemies, b, rng, { level = i, tags = opts.tags, maxCount = opts.maxCount or 40 })
		if opts.boss and i % (opts.boss.every or 5) == 0 then table.insert(enc.ids, opts.boss.id) end
		local times = {}
		for k = 1, #enc.ids do times[k] = (k - 1) * (opts.gap or 1) end
		table.insert(out, { wave = i, budget = b, cost = enc.cost, ids = enc.ids, spawnTimes = times })
		budget = budget * (opts.growth or 1.35) + (opts.add or 0)
	end
	return out
end

return W
