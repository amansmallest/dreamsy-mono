--!nonstrict
-- Pacing helper: a greedy bot plays the real farm rules headless (no entities) and reports the income curve.
-- Farming.balance.run(C?, opts?) -> report
--   opts: { days? (one full year of cfg.seasons, or cfg.balance.days), field = { w = 12, h = 10 } (soil rect),
--           buy = { "upgrade:<id>" | "animal:<kind>" | "item:<id>" ... } (priority list; bought when affordable after a seed reserve),
--           saveRate? (0: share of gold held back toward the next purchase), energyUse? (0.9 of max per day), log? (print per day) }
--   report: { days = { {day, season, gold, earned, plots, crop} }, seasons = { {id, total, perDay} }, purchases = { {what, day} },
--             finalGold, totalEarned, playMinutes, firstHarvestDay, bestCrop = { [season] = crop } }
local core = require("@kit/core")
local Content = require("./content")
local Farm = require("./farm")

local M = {}

local function cropScore(f, crop, daysLeft)
	local c = f.C.crops[crop]
	local avg = if type(c.yield) == "table" then (c.yield[1] + c.yield[2]) / 2 else c.yield
	if c.growDays > daysLeft then return -1 end
	local harvests = 1
	if c.regrow then harvests += math.floor((daysLeft - c.growDays) / c.regrow) end
	local value = f:price(crop) * avg * harvests - c.seed.price
	return value / math.max(1, daysLeft), value
end

-- bestCrop(farm, gold, prices?) -> crop id: best value/day among in-season crops whose seeds are owned or for sale (prices: seed → price)
function M.bestCrop(f, gold, prices)
	local best, bestScore = nil, 0
	local left = f:daysLeftInSeason() + 1
	for _, id in f.C.cropsOrder do
		local c = f.C.crops[id]
		local owned = core.bag:count(c.seed.id) > 0
		local price = if prices then prices[c.seed.id] else c.seed.price
		if f:inSeason(id) and (owned or (price and price <= gold)) then
			local s = cropScore(f, id, left)
			if s > bestScore then best, bestScore = id, s end
		end
	end
	return best
end

function M.run(C, opts)
	opts = opts or {}
	C = C or Content.load()
	local cfg = C.config
	local fw, fh = (opts.field and opts.field.w) or 12, (opts.field and opts.field.h) or 10
	local f = Farm.new(C, { save = false, autosave = false, isSoil = function(c, r) return c >= 0 and r >= 0 and c < fw and r < fh end, upgrades = opts.upgrades })
	core.bag.slotCount = math.max(core.bag.slotCount or 0, 60)
	for item, n in cfg.startItems or {} do core.bag:add(item, n) end
	local days = opts.days or (cfg.balance and cfg.balance.days)
	if not days then days = 0 for _, s in cfg.seasons do days += s.days end end
	local buy = table.clone(opts.buy or (cfg.balance and cfg.balance.buy) or {})
	local purchases = {}
	local rep = { days = {}, seasons = {}, purchases = purchases, bestCrop = {} }
	local cur = cfg.currency
	local shopFor = nil
	for _, sid in C.shopsOrder do shopFor = shopFor or sid end
	local function gold() return core.wallet.get(cur) end
	-- what the shops sell today (available rows only)
	local prices = {}
	local function restock()
		prices = {}
		for _, sid in C.shopsOrder do
			for _, row in f:stock(sid) do if row.item and row.available and prices[row.item] == nil then prices[row.item] = row.price end end
		end
	end
	local function stockPrice(item) return prices[item] end
	for d = 1, days do
		f.minute = cfg.dayStart + 30
		restock()
		-- morning chores: harvest, collect, feed, pet
		for k, p in f.plots do
			if p.crop and (p.dead or f:isReady(p)) then
				local c, r = Farm.unkey(k)
				local ok = f:harvest(c, r)
				if ok and rep.firstHarvestDay == nil and not p.dead then rep.firstHarvestDay = d end
			end
		end
		f:collectAll()
		for _, a in f.animals do f:feed(a.uid) f:pet(a.uid) end
		-- ship everything sellable (keep seeds/feed/fertilizer/materials)
		for _, row in core.bag:list() do
			local cat = row.def and row.def.category
			if cat == "crop" or cat == "product" or cat == "artisan" then f:ship(row.id, row.count) end
		end
		-- purchases in priority order
		while #buy > 0 do
			local what = buy[1]
			local kind, id = string.match(what, "^(%a+):(.+)$")
			local ok = false
			if kind == "upgrade" then
				ok = f.upgrades:canUnlock(id) and f:buyUpgrade(id)
				if not ok then local _, why = f.upgrades:canUnlock(id) if why == "max" then ok = true end end
			elseif kind == "animal" then
				local price = f:animalDef(id).price
				if gold() >= price then ok = f:buyAnimal(id) end
			elseif kind == "item" then
				local price = stockPrice(id) or math.huge
				if gold() >= price * 2 then
					core.wallet.spend(cur, price) core.bag:add(id, 1) ok = true
				end
			end
			if ok then table.insert(purchases, { what = what, day = d }) table.remove(buy, 1) else break end
		end
		-- place sprinklers / fertilizer the bot owns
		for _, row in core.bag:list() do
			if row.def and row.def.data and row.def.data.placeable then
				for n = 1, row.count do
					-- place in a grid pattern every 3 cells
					for r = 1, fh - 2, 3 do for c = 1, fw - 2, 3 do
						if not f.objects[Farm.key(c, r)] and core.bag:has(row.id, 1) then
							f.plots[Farm.key(c, r)] = nil
							f:place(c, r, row.id)
						end
					end end
				end
			end
		end
		-- plant: choose best crop, till + plant as many plots as energy allows (keep energy for watering)
		-- save toward the next purchase: keep min(its price, saveRate · gold) out of the seed budget
		local hold = 0
		if #buy > 0 then
			local kind, id = string.match(buy[1], "^(%a+):(.+)$")
			local price = if kind == "upgrade" then (f.upgrades:cost(id)[cur] or 0) elseif kind == "animal" then f:animalDef(id).price else (stockPrice(id) or 0)
			hold = math.min(price, gold() * (opts.saveRate or 0))
		end
		local function spendable() return gold() - hold end
		local function ownsSeeds()
			for _, oid in C.cropsOrder do if core.bag:has(C.crops[oid].seed.id, 1) and f:canMature(oid) then return true end end
			return false
		end
		local crop = M.bestCrop(f, spendable(), prices)
		local plotsUsed = 0
		for _, p in f.plots do if p.crop then plotsUsed += 1 end end
		if crop then
			rep.bestCrop[f:seasonId()] = rep.bestCrop[f:seasonId()] or crop
			local seed = C.crops[crop].seed.id
			local seedPrice = stockPrice(C.crops[crop].seed.id) or math.huge
			local keep = f:maxEnergy() * (1 - (opts.energyUse or 0.9))
			local waterCost = f:cost("water")
			local dry = 0
			for _, q in f.plots do if q.crop and not q.watered then dry += waterCost end end
			for r = 0, fh - 1 do
				for c = 0, fw - 1 do
					local k = Farm.key(c, r)
					if f.objects[k] then continue end
					local p = f.plots[k]
					local need = (if p and p.watered then 0 else waterCost) + (if p then 0 else f:cost("till")) + f:cost("plant")
					if (p == nil or p.crop == nil) and f.energy - keep - dry >= need and (core.bag:has(seed, 1) or spendable() >= seedPrice or ownsSeeds()) then
						-- use seeds already owned first (starting packets, gifts, festival prizes)
						local useSeed = seed
						for _, oid in C.cropsOrder do
							local od = C.crops[oid]
							if core.bag:has(od.seed.id, 1) and f:canMature(oid) then useSeed = od.seed.id break end
						end
						if useSeed ~= seed then
							if p == nil then f:till(c, r) end
							if f:plant(c, r, useSeed) and not f.plots[k].watered then dry += waterCost end
							continue
						end
						if not core.bag:has(seed, 1) then
							if not core.wallet.spend(cur, seedPrice) then continue end
							core.bag:add(seed, 1)
						end
						if p == nil then f:till(c, r) end
						if f:plant(c, r, seed) and not f.plots[k].watered then dry += waterCost end
					end
				end
			end
		end
		-- water everything dry
		for k, p in f.plots do
			if p.crop and not p.watered then local c, r = Farm.unkey(k) f:water(c, r) end
		end
		plotsUsed = 0
		for _, p in f.plots do if p.crop then plotsUsed += 1 end end
		local sid = f:seasonId()
		local report = f:sleep(false)
		table.insert(rep.days, { day = d, season = sid, gold = gold(), earned = report.earned, plots = plotsUsed, crop = crop })
		if opts.log then print(string.format("day %d %s gold %d earned %d plots %d %s", d, sid, gold(), report.earned, plotsUsed, tostring(crop))) end
	end
	local hist = f:incomeHistory()
	rep.seasons = {}
	for _, s in hist.seasons do
		local len = 0
		for _, sd in cfg.seasons do if sd.id == s.id then len = sd.days end end
		table.insert(rep.seasons, { id = s.id, total = s.total, perDay = math.floor(s.total / math.max(1, len)) })
	end
	rep.finalGold = gold()
	local t = 0
	for _, e in rep.days do t += e.earned end
	rep.totalEarned = t
	rep.playMinutes = days * cfg.dayLength / 60
	rep.farm = f
	return rep
end

return M
