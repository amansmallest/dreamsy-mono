--!nonstrict
-- Headless pacing simulation: a greedy player on a private (headless) sim.
-- run(content, opts) -> report
-- opts: { hours? (2), taps? (4 taps/s while active), trip? (6 s walk to the sell stand and back), eggShare? (0.3: share of
--         spare coins spent on eggs), stallMinutes? (5), rebirthWhen? ("stuck" | "always"), maxRebirths? (99), stuckMinutes? (6) }
-- report: { zones = { {id, t} }, gear = { {kind, id, t} }, firstRebirth, rebirths = { {t, gain} }, eggs, events = { {t, kind, id} },
--           gaps = { max, median, at }, stalls = { {from, to, minutes} }, ok, final = { coins, zone, tool, pack, pets, mult } }
local Sim = require("./sim")
local Content = require("./content")

local M = {}

-- expected seconds / value / units per node in the sim's current zone (weighted average over node kinds)
local function zoneRates(s, hitsPerSec)
	local z = s:zoneDef()
	local W, t, v, u = 0, 0, 0, 0
	local p = s:power()
	for _, n in z.nodes do
		W += n.weight
		t += n.weight * math.ceil(n.hp / p - 1e-9) / hitsPerSec
		v += n.weight * n.reward
		u += n.weight * n.size
	end
	return t / W, v / W, u / W
end

function M.run(content, opts)
	opts = opts or {}
	local C = if content.zonesById then content else Content.normalize(content)
	local s = Sim.new(C, { headless = true, rand = function() return 0.5 end })
	local maxT = (opts.hours or 2) * 3600
	local taps = opts.taps or 4
	local trip = opts.trip or 6
	local eggShare = opts.eggShare or 0.3
	local stuckLimit = (opts.stuckMinutes or 6) * 60
	local stallLimit = (opts.stallMinutes or 5) * 60
	local rng = 12345
	s.rand = function() rng = (rng * 1103515245 + 12345) % 2147483648 return rng / 2147483648 end

	local t = 0
	local eggBudget = 0
	local rep = { zones = { { id = C.zones[1].id, t = 0 } }, gear = {}, rebirths = {}, eggs = 0, events = {}, stalls = {} }
	local function event(kind, id) table.insert(rep.events, { t = t, kind = kind, id = id }) end

	-- cheapest next progress target: next zone / next tool / next backpack
	local function target()
		local best, bestCost, kind = nil, math.huge, nil
		for _, z in s:zoneList() do
			if z.state == "available" or (z.state == "locked" and z.reason == "coins") then
				if z.cost < bestCost then best, bestCost, kind = z.def.id, z.cost, "zone" end
				break
			end
		end
		for _, k in { "tools", "backpacks" } do
			local d = s:next(k)
			if d then
				local ok, why = s:canBuy(k, d.id)
				if (ok or why == "coins") and Content.costOf(d) < bestCost then best, bestCost, kind = d.id, Content.costOf(d), k end
			end
		end
		return kind, best, bestCost
	end

	local function shop()
		local bought = true
		while bought do
			bought = false
			local kind, id, cost = target()
			if kind and s:coins() >= cost then
				if kind == "zone" then
					s:unlockZone(id)
					table.insert(rep.zones, { id = id, t = t })
				else
					s:buy(kind, id)
					table.insert(rep.gear, { kind = kind, id = id, t = t })
				end
				event(kind, id)
				bought = true
			end
		end
		-- eggs: a share of every sale goes to an egg budget; hatch the best unlocked egg the budget covers
		local bestEgg = nil
		for _, e in C.eggs do
			if (not e.zone or s.zones[e.zone]) and Content.costOf(e) <= eggBudget then bestEgg = e end
		end
		if bestEgg then
			local n = 0
			while n < 20 and s:canHatch(bestEgg.id) and Content.costOf(bestEgg) <= eggBudget do
				eggBudget -= Content.costOf(bestEgg)
				s:hatch(bestEgg.id)
				rep.eggs += 1
				n += 1
			end
			event("egg", bestEgg.id)
		end
		s:travel(s:bestZone())
	end

	local lastProgress = 0
	while t < maxT do
		local hits = taps + s:speed()
		local nodeT, nodeV, nodeU = zoneRates(s, hits)
		local mult = s:coinMultiplier()
		local kind, _, cost = target()
		-- nodes until full, or until a sell would afford the next target (sell early)
		local room = s:capacity() - s.load
		local nFull = math.max(1, math.ceil(room / nodeU))
		local n = nFull
		if kind then
			local need = cost - s:coins() - s:sellValue()
			if need <= 0 then n = 0 else n = math.min(nFull, math.max(1, math.ceil(need / (nodeV * mult)))) end
		end
		if n > 0 then
			local units = math.min(room, n * nodeU)
			s.load += units
			s.carried += nodeV * (units / nodeU)
			s.stats.nodes += n
			t += n * nodeT
		end
		t += trip
		local sold = s:sell()
		eggBudget = math.min(eggBudget + sold * eggShare, s:coins())
		local before = #rep.events
		shop()
		if #rep.events > before then
			local real = false
			for i = before + 1, #rep.events do if rep.events[i].kind ~= "egg" then real = true end end
			if real then lastProgress = t end
		end
		-- rebirth: when stuck (next target too far) or everything is bought
		local k2, _, cost2 = target()
		local stuck = k2 == nil
		if k2 then
			local rate = s:incomeRate(taps)
			stuck = rate <= 0 or (cost2 - s:coins()) / rate > stuckLimit
		end
		if (stuck or opts.rebirthWhen == "always") and s:canRebirth() and #rep.rebirths < (opts.maxRebirths or 99) then
			local g = s:rebirth()
			table.insert(rep.rebirths, { t = t, gain = g })
			rep.firstRebirth = rep.firstRebirth or t
			event("rebirth", tostring(g))
			lastProgress = t
		elseif stuck and not s:canRebirth() and t - lastProgress > maxT then
			break
		end
	end

	-- gaps between progress events (zones, gear, rebirths; eggs don't count)
	local times = { 0 }
	for _, e in rep.events do if e.kind ~= "egg" then table.insert(times, e.t) end end
	table.insert(times, math.min(t, maxT))
	local gaps = {}
	local maxGap, at = 0, 0
	for i = 2, #times do
		local g = times[i] - times[i - 1]
		table.insert(gaps, g)
		if g > maxGap then maxGap, at = g, times[i - 1] end
		if g > stallLimit then table.insert(rep.stalls, { from = times[i - 1], to = times[i], minutes = g / 60 }) end
	end
	table.sort(gaps)
	rep.gaps = { max = maxGap, median = gaps[math.max(1, math.floor(#gaps / 2))] or 0, at = at }
	rep.ok = #rep.stalls == 0 and #rep.zones == #C.zones and rep.firstRebirth ~= nil
	rep.final = { t = t, coins = s:coins(), zone = s.zone, tool = s.tool, pack = s.pack, pets = s:petCount(), mult = s:coinMultiplier(), rebirths = s.layer.count }
	return rep
end

-- format(seconds) "12m 05s"
function M.fmt(sec: number): string
	sec = math.floor(sec + 0.5)
	if sec >= 3600 then return string.format("%dh %02dm", sec // 3600, (sec % 3600) // 60) end
	return string.format("%dm %02ds", sec // 60, sec % 60)
end

return M
