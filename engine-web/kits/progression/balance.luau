--!nonstrict
-- Balance helpers: headless simulations for "how long until X?" (run in tests/harness playtests).
local Curves = require("./curves")
local M = {}

-- timeToLevel(curve, xpPerSecond | fn(level) -> xp/s, maxLevel?) -> { {level, seconds, total} }  (seconds to reach that level)
function M.timeToLevel(curve, rate, maxLevel: number?)
	local c = Curves.new(curve)
	local out, total = {}, 0
	for L = 2, math.min(maxLevel or c.maxLevel, c.maxLevel) do
		local r = if type(rate) == "function" then rate(L - 1) else rate
		local s = c:toNext(L - 1) / math.max(r, 1e-9)
		total += s
		table.insert(out, { level = L, seconds = s, total = total })
	end
	return out
end

-- idle({ income = fn(owned: {[id]: n}, t) -> per second, items = { { id, cost = n | fn(owned n) -> cost } },
--        dt? (1), maxTime? (36000), start? (0) }) -> buy-asap timeline { {id, n, time, cost} }, endTime
-- Greedy: always buys the cheapest affordable item. Good for tycoon generators, TD tower economies, upgrade shops.
function M.idle(opts)
	local owned, money, t = {}, opts.start or 0, 0
	local dt, maxT = opts.dt or 1, opts.maxTime or 36000
	local timeline = {}
	local function costOf(it)
		local n = owned[it.id] or 0
		if type(it.cost) == "function" then return it.cost(n) end
		if it.growth then return it.cost * it.growth ^ n end
		return it.cost
	end
	local function remaining()
		for _, it in opts.items do if (it.max == nil or (owned[it.id] or 0) < it.max) then return true end end
		return false
	end
	while t < maxT and remaining() do
		local best, bestCost = nil, math.huge
		for _, it in opts.items do
			if it.max == nil or (owned[it.id] or 0) < it.max then
				local c = costOf(it)
				if c < bestCost then best, bestCost = it, c end
			end
		end
		while money < bestCost and t < maxT do
			money += opts.income(owned, t) * dt
			t += dt
		end
		if money < bestCost then break end
		money -= bestCost
		owned[best.id] = (owned[best.id] or 0) + 1
		table.insert(timeline, { id = best.id, n = owned[best.id], time = t, cost = bestCost })
	end
	return timeline, t
end

-- simulate({ state, step = fn(state, dt, t), done = fn(state, t) -> boolean, dt? (1), maxTime? (36000) }) -> time, state
function M.simulate(opts)
	local s, t, dt, maxT = opts.state or {}, 0, opts.dt or 1, opts.maxTime or 36000
	while t < maxT and not opts.done(s, t) do
		opts.step(s, dt, t)
		t += dt
	end
	return t, s
end

-- format(seconds) -> "1h 02m", "3m 05s", "12s"
function M.format(s: number): string
	s = math.floor(s)
	if s >= 3600 then return string.format("%dh %02dm", s // 3600, (s % 3600) // 60) end
	if s >= 60 then return string.format("%dm %02ds", s // 60, s % 60) end
	return s .. "s"
end
return M
