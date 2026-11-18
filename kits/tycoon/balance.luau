--!strict
-- tycoon kit: headless balance simulator for the harness. Plays the game with a greedy "optimal-ish"
-- player for N simulated hours and reports pacing: unlock times, time to first prestige, purchase gaps.
--   local B = require("@kit/tycoon/balance")
--   local report = B.simulate(nil, { hours = 2 })   -- nil content = the game's data/*.json
local Core = require("./core")

local B = {}

local function median(xs: { number }): number
	if #xs == 0 then
		return 0
	end
	local s = table.clone(xs)
	table.sort(s)
	return s[math.floor((#s + 1) / 2)]
end

local function pct(xs: { number }, p: number): number
	if #xs == 0 then
		return 0
	end
	local s = table.clone(xs)
	table.sort(s)
	return s[math.clamp(math.ceil(#s * p), 1, #s)]
end

-- opts: hours (2), dt (1 s), manual (0.5: share of time a non-automated generator runs — the player taps it),
--       tapEvery (3 s: how often the bot restarts idle manual generators), tapsPerSecond (2 during the first
--       minute only), prestigeRatio (2: reset when the prestige bonus would grow ×2), stallSeconds (180),
--       claimEvents (true), seed
function B.runner(content: any, opts: any?): any
	local o = opts or {}
	local hours = o.hours or 2
	local dt = o.dt or 1
	local manual = o.manual or 0.5
	local tapEvery = o.tapEvery or 3
	local ratio = o.prestigeRatio or 2
	local stallSeconds = o.stallSeconds or 180
	local t = Core.new(content, { seed = o.seed or 7 })
	local c = t.content
	local main = c.main

	local unlocks, firstBuy, prestiges, buys = {}, {}, {}, {}
	local boughtUpg, gensEver = {}, {}
	local allGensAt, allUpgradesAt = nil, nil
	local nUpg = #c.upgradeOrder
	t.on.unlocked:connect(function(gid)
		if unlocks[gid] == nil then
			unlocks[gid] = t.stats.playTime
		end
	end)
	for _, gid in c.genOrder do
		if t:isUnlocked(gid) then
			unlocks[gid] = 0
		end
	end

	local function income(): number
		return t:income(main, { manual = manual })
	end
	-- Δincome of a hypothetical change (apply → measure → revert)
	local function delta(apply: () -> (), revert: () -> ()): number
		local before = income()
		apply()
		t:invalidate()
		local after = income()
		revert()
		t:invalidate()
		return after - before
	end

	local function candidates(): { any }
		local out = {}
		local inc = math.max(income(), 1e-9)
		for _, gid in c.genOrder do
			local g = c.generators[gid]
			if t:isUnlocked(gid) and g.cost.currency == main then
				local n = 1
				local nm = t:nextMilestone(gid)
				-- buy up to a close milestone in one go (players do)
				if nm and nm - t.owned[gid] <= 10 and t:canAfford(main, t:costOf(gid, nm - t.owned[gid])) then
					n = nm - t.owned[gid]
				else
					n = math.max(1, t:maxAffordable(gid) // 2) -- bulk-buy like a real player
				end
				local cost = t:costOf(gid, n)
				local d = delta(function()
					t.owned[gid] += n
				end, function()
					t.owned[gid] -= n
				end)
				if t.owned[gid] == 0 then
					d = math.max(d, inc * 0.25) -- new tiers open content: value them
				end
				table.insert(out, { kind = "gen", id = gid, n = n, cost = cost, cur = main, d = d })
			end
			if g.manager and not t.managers[gid] and t.owned[gid] > 0 and g.manager.currency == main then
				local d = delta(function()
					t.managers[gid] = true
				end, function()
					t.managers[gid] = nil
				end)
				table.insert(out, { kind = "mgr", id = gid, cost = g.manager.cost, cur = main, d = math.max(d, inc * 0.02) })
			end
		end
		for _, uid in t:availableUpgrades() do
			local u = c.upgrades[uid]
			if u.cost.currency == main then
				local d = delta(function()
					t.upgrades[uid] = true
				end, function()
					t.upgrades[uid] = nil
				end)
				table.insert(out, { kind = "upg", id = uid, cost = u.cost.amount, cur = main, d = math.max(d, inc * 0.05) })
			end
		end
		return out
	end

	local function pick(): any
		local money = t:get(main)
		local inc = math.max(income(), 1e-9)
		local best, bestScore = nil, math.huge
		for _, cand in candidates() do
			if cand.d > 0 then
				local score = cand.cost / cand.d + math.max(0, cand.cost - money) / inc
				if score < bestScore then
					best, bestScore = cand, score
				end
			end
		end
		return best
	end

	local function record(kind: string, id: string)
		table.insert(buys, t.stats.playTime)
		if kind == "gen" and not firstBuy[id] then
			firstBuy[id] = t.stats.playTime
			gensEver[id] = true
			local all = true
			for _, gid in c.genOrder do
				if not gensEver[gid] then
					all = false
				end
			end
			if all and not allGensAt then
				allGensAt = t.stats.playTime
			end
		elseif kind == "upg" and not boughtUpg[id] then
			boughtUpg[id] = true
			local n = 0
			for _ in boughtUpg do
				n += 1
			end
			if n == nUpg and not allUpgradesAt then
				allUpgradesAt = t.stats.playTime
			end
		end
	end

	local function buyPermanent()
		-- spend prestige currencies on permanent upgrades, cheapest first
		for _, uid in t:availableUpgrades() do
			local u = c.upgrades[uid]
			if u.cost.currency ~= main and t:buyUpgrade(uid) then
				record("upg", uid)
			end
		end
	end

	local samples = {}
	local nextSample = 0
	local target = nil
	local lastEval = -1e9
	local lastTap = -1e9
	local endT = hours * 3600
	local function tick()
		-- active player: taps early, restarts manual generators, claims events
		if t.runTime < 60 then
			for _ = 1, math.floor((o.tapsPerSecond or 2) * dt) do
				t:tap()
			end
		end
		if t.stats.playTime - lastTap >= tapEvery then
			lastTap = t.stats.playTime
			for _, gid in c.genOrder do
				t:run(gid)
			end
		end
		if t:pendingEventInfo() and o.claimEvents ~= false then
			t:claimEvent()
		end
		-- buy loop
		for _ = 1, 40 do
			if target == nil or t.stats.playTime - lastEval >= 10 then
				target = pick()
				lastEval = t.stats.playTime
			end
			if target == nil or not t:canAfford(target.cur, target.cost) then
				break
			end
			local ok = false
			if target.kind == "gen" then
				ok = t:buy(target.id, target.n)
			elseif target.kind == "mgr" then
				ok = t:hireManager(target.id)
			else
				ok = t:buyUpgrade(target.id)
			end
			if ok then
				record(target.kind, target.id)
			end
			target = nil
		end
		buyPermanent()
		-- prestige
		for _, lid in c.layerOrder do
			if t:canPrestige(lid) then
				local gain = t:prestigeGain(lid)
				local grows = t:prestigeBonus(lid, gain) / t:prestigeBonus(lid) >= ratio
				local stuck = #buys > 0 and t.stats.playTime - buys[#buys] > stallSeconds
				if grows or stuck then
					t:doPrestige(lid)
					table.insert(prestiges, { t = t.stats.playTime, layer = lid, gain = gain })
					target = nil
					buyPermanent()
				end
			end
		end
		if t.stats.playTime >= nextSample then
			table.insert(samples, { t = t.stats.playTime, income = income(), allTime = t.allTime[main] })
			nextSample += o.sampleEvery or 300
		end
		t:step(dt)
	end

	local function report(): any

	-- purchase gaps (ignore the first minute of tapping)
	local gaps, stalls = {}, {}
	local maxGap, maxAt = 0, 0
	for i = 2, #buys do
		local g = buys[i] - buys[i - 1]
		table.insert(gaps, g)
		if g > maxGap then
			maxGap, maxAt = g, buys[i - 1]
		end
		if g > stallSeconds then
			table.insert(stalls, { at = buys[i - 1], wait = g })
		end
	end
	if #buys > 0 and endT - buys[#buys] > stallSeconds then
		table.insert(stalls, { at = buys[#buys], wait = endT - buys[#buys] })
		maxGap = math.max(maxGap, endT - buys[#buys])
	end
	local owned = table.clone(t.owned)
	local cur = {}
	for k, v in t.cur do
		cur[k] = v
	end
	return {
		hours = hours,
		firstPrestige = if prestiges[1] then prestiges[1].t else nil,
		prestiges = prestiges,
		unlocks = unlocks,
		firstBuy = firstBuy,
		allGeneratorsAt = allGensAt,
		allUpgradesAt = allUpgradesAt,
		purchases = #buys,
		gaps = { median = median(gaps), p90 = pct(gaps, 0.9), max = maxGap, maxAt = maxAt },
		stalls = stalls,
		smooth = #stalls == 0,
		samples = samples,
		final = { cur = cur, income = income(), owned = owned, achievements = #(function()
			local l = {}
			for id in t.ach do
				table.insert(l, id)
			end
			return l
		end)() },
	}
end

	-- advance the simulation by up to `seconds` of play time; returns true when finished
	local function advance(seconds: number): boolean
		local stop = math.min(endT, t.stats.playTime + seconds)
		while t.stats.playTime < stop do
			tick()
		end
		return t.stats.playTime >= endT
	end
	return { advance = advance, report = report, state = t }
end

-- run the whole simulation at once (fine for short runs; the per-call script budget is 250 ms,
-- so for hours of simulated play use B.runner and advance it across ticks — harness.ts does this)
function B.simulate(content: any, opts: any?): any
	local r = B.runner(content, opts)
	r.advance(math.huge)
	return r.report()
end

return B
