--!nonstrict
-- Headless balance bot: plays a generated world greedily toward config.milestones and reports when each is reached.
-- Travel = Manhattan cells × tile / speed × pathFactor; gather = hits × swing; craft = recipe.time. Needs, nights,
-- temperature and deaths run through the real Sim:tick. Use from tests / harness to keep a 1–2 h game on pace.
local core = require("@kit/core")
local Content = require("./content")
local Sim = require("./sim")
local Recipes = require("./recipes")
local B = {}

function B.fmt(s)
	s = math.floor(s + 0.5)
	if s >= 3600 then return string.format("%dh %02dm", s // 3600, (s % 3600) // 60) end
	return string.format("%dm %02ds", s // 60, s % 60)
end

-- run(C, opts) opts: { seed?, maxTime? (7200), pathFactor? (1.4), milestones? (config.milestones) }
-- milestone: { id, item? (own one), structure? (built), recipe? (crafted once), night? (survived n nights) }
-- -> { ok, milestones = { {id, t, label} }, missing = {ids}, deaths, nights, time, log = {string}, stuck? }
function B.run(C, opts)
	opts = opts or {}
	local bag = core.inventory.new({ id = "survival_balance_bag", slots = 60, strict = false })
	bag.saved = false
	bag:clear()
	local s = Sim.new(C, { seed = opts.seed, bag = bag, quiet = true })
	local cfg = C.config
	local tile, speed, swing = cfg.world.tile, cfg.player.speed, cfg.player.swing
	local pf = opts.pathFactor or 1.4
	local maxTime = opts.maxTime or 7200
	local t0 = s.time
	local log = {}
	local crafted = {}
	local function now() return s.time - t0 end
	local function spend(sec)
		while sec > 0 and now() < maxTime do
			local d = math.min(1, sec)
			s:tick(d)
			sec -= d
		end
	end
	local function walkTo(x, y)
		local d = math.abs(x - s.player.x) + math.abs(y - s.player.y)
		spend(d * tile / speed * pf)
		s:setPlayer(x, y)
	end
	local tree = Recipes.analyze(C)
	local want -- forward
	local depthGuard = 0

	local function toolRecipeFor(kind, tier)
		local best = nil
		for _, r in C.recipes do
			local t = Content.itemData(C, r.gives).tool
			if t and t.kind == kind and (t.tier or 1) >= tier and tree.recipeDepth[r.id] then
				if best == nil or (Content.itemData(C, best.gives).tool.tier or 1) > (t.tier or 1) then best = r end
			end
		end
		return best
	end
	local function nearestNode(item)
		local best, bd = nil, math.huge
		for _, n in s.world.nodes do
			if n.hp > 0 then
				local def = C.nodesById[n.id]
				for _, dr in def.drops do
					if dr.item == item and (dr.chance == nil or dr.chance >= 0.5) then
						local d = math.abs(n.x - s.player.x) + math.abs(n.y - s.player.y)
						if d < bd then best, bd = n, d end
					end
				end
			end
		end
		return best
	end
	local function ensureStation(sid)
		if s:count(sid) > 0 then
			for _, st in s.structures do if st.id == sid then walkTo(st.x, st.y) return true end end
		end
		local item = s:placerItem(sid)
		if not item or not want(item, 1) then return false end
		local b = s:base()
		local px, py = s.player.x, s.player.y
		for r = 1, 4 do
			for dy = -r, r do
				for dx = -r, r do
					local tx, ty = b.x + dx, b.y + dy
					local sx, sy = tx - (if dx > 0 then 1 elseif dx < 0 then -1 else 0), ty - (if dy > 0 then 1 elseif dy < 0 then -1 else 0)
					s:setPlayer(sx, sy)
					if s:passable(sx, sy) and s:canPlace(sid, tx, ty) then
						walkTo(sx, sy)
						if s:place(sid, tx, ty) then
							table.insert(log, B.fmt(now()) .. " built " .. sid)
							return true
						end
					end
				end
			end
		end
		s:setPlayer(px, py)
		return false
	end
	local function eatDrink()
		for _, need in { "hunger", "thirst" } do
			if s.needs[need] < 45 then
				-- best edible in the bag for this need
				local best, bv = nil, 0
				for _, st in bag:list() do
					local f = Content.itemData(C, st.id).food
					if f and (f[need] or 0) > bv then best, bv = st.id, f[need] end
				end
				if best then s:consume(best)
				else
					-- gather the cheapest raw food for this need
					local bestItem, bestV = nil, 0
					for id in tree.obtainable do
						local f = Content.itemData(C, id).food
						if f and (f[need] or 0) > bestV and #Recipes.producers(C, id) == 0 then bestItem, bestV = id, f[need] end
					end
					if bestItem and want(bestItem, 2) then s:consume(bestItem) end
				end
			end
		end
	end
	function want(item, n)
		depthGuard += 1
		if depthGuard > 400 then return false end
		local guard = 0
		while bag:count(item) < n and now() < maxTime do
			guard += 1
			if guard > 60 then return false end
			local prod = Recipes.producers(C, item)[1]
			if prod and tree.recipeDepth[prod.id] then
				for it, c in prod.needs do if not want(it, c) then return false end end
				if prod.station and not ensureStation(prod.station) then return false end
				spend(prod.time)
				if not s:craft(prod.id) then return false end
				if not crafted[prod.id] then crafted[prod.id] = now() table.insert(log, B.fmt(now()) .. " crafted " .. prod.id) end
			else
				local node = nearestNode(item)
				if not node then
					-- wait for a depleted node of this kind to respawn
					local soonest = nil
					for _, n in s.depleted do
						for _, dr in C.nodesById[n.id].drops do if dr.item == item and n.respawnAt then soonest = math.min(soonest or math.huge, n.respawnAt) end end
					end
					if not soonest then return false end
					spend(math.max(1, soonest - s.time + 0.1))
					continue
				end
				local def = C.nodesById[node.id]
				if def.tool then
					local _, td = s:bestTool(def.tool)
					if (td == nil and def.tier > 0) or (td and (td.tier or 1) < def.tier) then
						local tr = toolRecipeFor(def.tool, def.tier)
						if not tr or not want(tr.gives, 1) then return false end
					end
				end
				walkTo(node.x, node.y)
				local hits = s:hitsFor(node.id)
				spend(hits * swing)
				s:gather(node.x, node.y)
				eatDrink()
			end
		end
		return bag:count(item) >= n
	end

	local results, missing = {}, {}
	for _, m in opts.milestones or cfg.milestones do
		depthGuard = 0
		local ok = false
		if m.item then ok = want(m.item, m.count or 1)
		elseif m.structure then ok = ensureStation(m.structure)
		elseif m.recipe then
			local r = C.recipesById[m.recipe]
			ok = r ~= nil and want(r.gives, bag:count(r.gives) + r.count)
		elseif m.night then
			while s.stats.nightsSurvived < m.night and now() < maxTime do spend(10) eatDrink() end
			ok = s.stats.nightsSurvived >= m.night
		end
		eatDrink()
		if ok and now() <= maxTime then
			table.insert(results, { id = m.id, t = now(), label = m.label or m.id })
			table.insert(log, B.fmt(now()) .. " MILESTONE " .. m.id)
		else
			table.insert(missing, m.id)
		end
	end
	local out = { ok = #missing == 0, milestones = results, missing = missing, deaths = s.stats.deaths, nights = s.stats.nightsSurvived,
		time = now(), log = log, gathered = s.stats.gathered, crafted = s.stats.crafted }
	bag:clear()
	return out
end

return B
