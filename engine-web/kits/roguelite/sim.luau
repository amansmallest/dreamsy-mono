--!nonstrict
-- Balance sim: a bot plays seeded runs on the real run logic (same floor plans, encounters, relic stacks,
-- synergies, triggers, shop, events, rest) with an analytic fight model:
--   hero DPS = damage · fireRate · projectiles · (1 + crit·(critMult−1)); room time = Σ enemy hp / DPS + approach;
--   damage taken = Σ enemy dps · time · exposure · (1 − dodge) − armor per hit, ±25 % noise; lifesteal/regen/triggers apply.
-- Enemy dps comes from data: `dps`, else contact.amount / 1.2 s, else projectile.amount / fireEvery.
-- sim.run({ class, heat?, seed, policy? }) -> { won, floor, rooms, minutes, relics, hp }
-- sim.batch({ classes?, heats? ({0}), runs = 50, seed = 1, metaMods? }) -> { [class] = { [heat] = { winRate, avgFloor, avgMinutes, runs } } }
local S = require("./state")
local Run = require("./run")
local M = {}

local function enemyDps(e)
	if e.dps then return e.dps end
	local d = 0
	if e.contact then d += (e.contact.amount or 1) / 1.2 end
	if e.projectile then d += (e.projectile.amount or 1) / ((e.params and e.params.fireEvery) or 1.5) end
	if d == 0 then d = 0.6 end
	return d
end
M.enemyDps = enemyDps

-- fight(run, room, rng) -> seconds, damage taken (applies hp changes + kill triggers)
function M.fight(run, room, rng)
	local cfg = S.config.sim
	local st = run:statsNow()
	local hpM, dmgM = run:enemyScale(room)
	local dps = st.damage * st.fireRate * math.max(1, st.projectiles) * (1 + st.crit * (st.critMult - 1))
	local t, taken = 0, 0
	local alive = {}
	for _, id in room.enemies or {} do
		local e = S.req("enemies", id)
		table.insert(alive, { id = id, hp = e.hp * hpM, dps = enemyDps(e) * dmgM * cfg.enemyDps, armorHits = 1 / 1.2 })
	end
	local steal = 0
	local shield = run.shield
	for _, e in alive do
		local kill = e.hp / dps + cfg.approach
		t += kill
		-- everyone still alive hits while this one dies
		local incoming = 0
		for _, o in alive do if o.hp > 0 then incoming += math.max(0.15, o.dps - st.armor * o.armorHits) end end
		local dmg = incoming * kill * cfg.exposure * (1 - st.dodge) * rng:range(0.75, 1.25)
		if shield > 0 then local a = math.min(shield, dmg) shield -= a dmg -= a end
		taken += dmg
		run:hurt(dmg)
		if run.state == "dead" then return t, taken end
		steal += e.hp * st.lifesteal
		if steal >= 1 then local n = math.floor(steal) steal -= n run:heal(n) end
		e.hp = 0
		run:onKill(e.id, if room.boss then "boss" elseif room.elite then "elite" else nil)
		if run.hp < run:maxHp() * 0.3 and not run.roomLowHp then run.roomLowHp = true run:fire("lowHp", {}) end
	end
	run.hp = math.floor(run.hp + 0.5)
	if run.hp <= 0 then run:die() end
	return t, taken
end

-- default bot policy (override any of these in opts.policy)
M.policy = {
	door = function(run, choices)
		local hpf = run.hp / run:maxHp()
		local best, score = 1, -1e9
		for i, c in choices do
			local s = ({ combat = 3, elite = if hpf > 0.7 then 6 else -5, treasure = 7, shop = if run.gold >= 60 then 6 else 1,
				event = 4, rest = if hpf < 0.55 then 9 else 0, boss = 10 })[c.type] or 0
			if s > score then best, score = i, s end
		end
		return best
	end,
	relic = function(run, ids)
		local order = { boss = 4, rare = 3, uncommon = 2, common = 1 }
		local best, bs = 1, -1
		for i, id in ids do local d = S.req("relics", id) local s = order[d.rarity or "common"] or 0 if s > bs then best, bs = i, s end end
		return best
	end,
	shop = function(run, stock)
		-- buy heal if low, then the best relic affordable
		local out = {}
		for i, it in stock do if it.kind == "heal" and run.hp < run:maxHp() * 0.5 then table.insert(out, i) end end
		for i, it in stock do if it.kind == "relic" then table.insert(out, i) end end
		return out
	end,
	rest = function(run) return if run.hp < run:maxHp() * 0.7 then "heal" else "maxHp" end,
	event = function(run, choices)
		for _, c in choices do if c.ok then return c.index end end
		return 1
	end,
}

function M.run(opts)
	local pol = setmetatable(opts.policy or {}, { __index = M.policy })
	local run = Run.new({ class = opts.class, seed = opts.seed, heat = opts.heat or 0, sim = true, metaMods = opts.metaMods })
	local rng = S.procgen.rng(opts.seed):fork("sim")
	local rt = S.config.roomTime
	local guard = 0
	while run.state ~= "dead" and run.state ~= "won" and guard < 500 do
		guard += 1
		if run.state == "choose" then
			local ch = run:choices()
			run:enter(pol.door(run, ch))
		elseif run.state == "room" then
			local room = run.room
			run.stats.time += rt[room.type] or 10
			if room.type == "combat" or room.type == "elite" or room.type == "boss" then
				local t = M.fight(run, room, rng)
				run.stats.time += t
				if run.state ~= "dead" then run:clear() end
			elseif room.type == "shop" then
				for _, i in pol.shop(run, room.stock) do run:buy(i) end
				run:clear()
			elseif room.type == "rest" then
				run:rest(pol.rest(run))
			elseif room.type == "event" then
				run:choose(pol.event(run, run:eventChoices()))
			else
				run:clear()
			end
		elseif run.state == "reward" then
			run:takeRelic(pol.relic(run, run.pending))
		end
	end
	local sum = run:summary()
	sum.hp = run.hp
	return sum
end

-- job(opts) -> job; job:step(runs = 10) per tick -> done; job.result (same shape as batch). Script callbacks have a
-- 250 ms budget: spread big sims over ticks with a job.
function M.job(opts)
	opts = opts or {}
	local classes = opts.classes
	if not classes then
		classes = {}
		for _, c in S.all("classes") do table.insert(classes, c.id) end
		table.sort(classes)
	end
	local cells = {}
	for _, cls in classes do for _, heat in opts.heats or { 0 } do table.insert(cells, { cls = cls, heat = heat }) end end
	local n = opts.runs or 50
	local job = { result = {}, done = false, ci = 1, i = 0, acc = nil }
	function job:step(budget)
		budget = budget or 10
		while budget > 0 and not self.done do
			local c = cells[self.ci]
			if not c then self.done = true break end
			if not self.acc then self.acc = { wins = 0, floors = 0, mins = 0, hist = {} } self.i = 0 end
			self.i += 1
			local s = M.run({ class = c.cls, heat = c.heat, seed = (opts.seed or 1) * 100000 + self.i, metaMods = opts.metaMods, policy = opts.policy })
			local a = self.acc
			if s.won then a.wins += 1 end
			a.floors += s.floor
			a.mins += s.minutes
			a.hist[tostring(s.floor)] = (a.hist[tostring(s.floor)] or 0) + 1
			budget -= 1
			if self.i >= n then
				self.result[c.cls] = self.result[c.cls] or {}
				self.result[c.cls][tostring(c.heat)] = { winRate = a.wins / n, avgFloor = a.floors / n, avgMinutes = a.mins / n, runs = n, deathsByFloor = a.hist }
				self.acc = nil
				self.ci += 1
			end
		end
		return self.done
	end
	return job
end

-- batch(opts): synchronous job (small sims only)
function M.batch(opts)
	local j = M.job(opts)
	while not j:step(1e9) do end
	return j.result
end

return M
