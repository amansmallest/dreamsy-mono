-- tower-defense kit: headless balance simulation. A greedy "reference player" builds and upgrades towers;
-- the harness uses it to check every campaign level is winnable (and not trivial) before shipping.
local U = require("@kit/tower-defense/util")
local Content = require("@kit/tower-defense/content")
local Sim = require("@kit/tower-defense/sim")
local Campaign = require("@kit/tower-defense/campaign")
local Run = require("@kit/progression/balance")

local Balance = {}

-- ---------- reference bot ----------
local BotM = {}
BotM.__index = BotM

-- opts: { skill = 0..1 (1 = default; lower = builds fewer towers / upgrades later), think = seconds between decisions }
function Balance.bot(sim, opts)
	opts = opts or {}
	local self = setmetatable({ sim = sim, skill = opts.skill or 1, think = opts.think or 0.5, t = 0, coverCache = {} }, BotM)
	-- does this level send flyers?
	local flyers = false
	for _, w in sim.waveSet.waves do
		for _, g in w.groups or {} do
			if sim.C.enemies[g.enemy].flying then
				flyers = true
			end
		end
	end
	for _, e in (sim.waveSet.endless and sim.waveSet.endless.pool) or {} do
		if sim.C.enemies[e].flying then
			flyers = true
		end
	end
	self.flyers = flyers
	-- enemy mix of the level (weight = count × hp) so the bot values damage types / armor pierce / air sensibly
	local mix, total = {}, 0
	local function add(id, n)
		local d = sim.C.enemies[id]
		mix[id] = (mix[id] or 0) + n * d.hp
		total += n * d.hp
	end
	for _, w in sim.waveSet.waves do
		for _, g in w.groups or {} do
			add(g.enemy, g.count or 1)
		end
	end
	for _, e in (sim.waveSet.endless and sim.waveSet.endless.pool) or {} do
		add(e, 10)
	end
	self.mix = {}
	for id, w in mix do
		table.insert(self.mix, { def = sim.C.enemies[id], w = w / math.max(1, total) })
	end
	return self
end

-- Path length in range of a cell (summed over paths); air = the flyers' straight lines.
function BotM:coverage(c, r, range, air)
	local key = r * 4096 + c .. ":" .. range .. (if air then "a" else "g")
	local v = self.coverCache[key]
	if v == nil then
		v = 0
		for _, id in self.sim.layout.pathIds do
			local p = self.sim.layout.paths[id]
			if air then
				p = p:direct()
			end
			v += p:coverage(c + 0.5, r + 0.5, range, 0.25)
		end
		self.coverCache[key] = v
	end
	return v
end

function BotM:bestCell(def)
	local sim = self.sim
	local best, bestV = nil, 0
	for _, b in sim.layout.build do
		local c, r = b[1], b[2]
		if not sim:towerAtCell(c, r) then
			local v
			if def.aura and (def.damage or 0) <= 0 then
				v = 0
				for _, t in sim.towers do
					if (t.x - c - 0.5) ^ 2 + (t.y - r - 0.5) ^ 2 <= (def.aura.range or 2) ^ 2 and not t.base.aura then
						v += 1
					end
				end
			else
				v = self:value(Content.towerStats(def, { common = 0 }), c, r)
			end
			if v > bestV then
				best, bestV = b, v
			end
		end
	end
	return best, bestV
end

local function isSupport(def)
	return (def.damage or 0) <= 0
end

function BotM:counts()
	local n, air, support = 0, 0, 0
	for _, t in self.sim.towers do
		n += 1
		if t.base.air then
			air += 1
		end
		if isSupport(t.def) then
			support += 1
		end
	end
	return n, air, support
end

-- 0..1+: how well these stats hurt this level's enemy mix (armor, resistances, air/ground).
function BotM:effectiveness(stats, flying)
	local eff = 0
	local dmg = math.max(1, stats.damage or 0)
	for _, m in self.mix do
		local e = m.def
		if flying ~= nil and (e.flying == true) ~= flying then
			continue
		end
		local f = 1
		if e.flying and not stats.air then
			f = 0
		elseif not e.flying and stats.ground == false then
			f = 0
		else
			local kind = stats.damage_type or "physical"
			if not Content.ARMORLESS_TYPES[kind] then
				local armor = math.max(0, (e.armor or 0) - (stats.armor_pierce or 0))
				f = math.max(0.2 * dmg, dmg - armor) / dmg
			end
			f *= 1 - ((e.resist and e.resist[kind]) or 0)
			-- overkill: a 40-damage shot on an 18 hp ant wastes most of it
			f *= math.min(1, (e.hp * 1.3) / math.max(1, dmg * f))
		end
		eff += m.w * f
	end
	return eff
end

-- Value of a stat block at a cell: dps × path coverage (support: buffed dps of neighbours; income: flat).
function BotM:value(stats, c, r, self_t)
	local sim = self.sim
	if (stats.damage or 0) <= 0 then
		local v = 0
		local a = stats.aura
		if a then
			for _, t in sim.towers do
				if t ~= self_t and (t.x - c - 0.5) ^ 2 + (t.y - r - 0.5) ^ 2 <= (a.range or 2) ^ 2 then
					local ts = t.base
					v += Content.dps(ts) * ((a.damage or 0) + (a.rate or 0)) * self:coverage(t.c, t.r, ts.range or 0)
				end
			end
		end
		return v + (stats.income or 0) * 1.5
	end
	local d = Content.dps(stats)
	if stats.slow then
		d += 6 * (1 - (stats.slow.factor or 1))
	end
	local range = stats.range or 0
	return d * (self:effectiveness(stats, false) * self:coverage(c, r, range, false) + self:effectiveness(stats, true) * self:coverage(c, r, range, true))
end

-- All affordable-or-not actions with value per cost.
function BotM:options()
	local sim = self.sim
	local out = {}
	local n, air = self:counts()
	for _, def in sim:availableTowers() do
		local cell = self:bestCell(def)
		if cell then
			local v = self:value(Content.towerStats(def, { common = 0 }), cell[1], cell[2])
			if self.flyers and def.air and air < 2 then
				v *= 3
			end
			if n < 2 then
				v *= 2
			end
			-- players spread across tower types; so does the reference bot
			local same = 0
			for _, t in sim.towers do
				if t.id == def.id then
					same += 1
				end
			end
			v *= 0.88 ^ same
			table.insert(out, { kind = "build", def = def, cell = cell, cost = def.cost, v = v })
		end
	end
	for _, t in sim:towerList() do
		local cur = self:value(t.base, t.c, t.r, t)
		for _, o in sim:upgradeOptions(t) do
			if not o.locked then
				local up = table.clone(t.up)
				if o.kind == "common" then
					up.common = o.tier
				else
					up.branch, up.tier = o.branch, o.tier
				end
				local v = self:value(Content.towerStats(t.def, up), t.c, t.r, t) - cur
				table.insert(out, { kind = "upgrade", t = t, branch = o.branch, cost = o.cost, v = v })
			end
		end
	end
	for _, o in out do
		o.score = o.v / o.cost
	end
	table.sort(out, function(a, b)
		return a.score > b.score
	end)
	return out
end

function BotM:act()
	local sim = self.sim
	for _ = 1, 30 do
		local opts = self:options()
		local best = opts[1]
		if not best or best.v <= 0 then
			return
		end
		-- greedy: the best value-per-cost option we can afford now (a reference player doesn't bank money)
		local pick = nil
		for _, o in opts do
			if sim.money >= o.cost and o.v > 0 then
				pick = o
				break
			end
		end
		if not pick then
			return
		end
		local ok
		if pick.kind == "build" then
			ok = sim:build(pick.def.id, pick.cell[1], pick.cell[2]) ~= nil
		else
			ok = sim:upgrade(pick.t, pick.branch) == true
		end
		if not ok then
			return
		end
	end
end

function BotM:step(dt)
	self.t += dt
	if self.t >= self.think then
		self.t = 0
		self:act()
	end
end

-- Run one level to the end with the bot. Returns Sim:result() + { towers = {"arrow+2a", ...} }.
-- opts: Sim.new options + { maxTime = seconds (default 3600), skill, maxWaves (endless cap) }
function Balance.runLevel(content, levelId, opts)
	opts = opts or {}
	local sim = Sim.new(content, levelId, opts)
	local bot = Balance.bot(sim, opts)
	bot:act()
	sim:startWave()
	local livesByWave = {}
	local leaks = {}
	sim:on("enemyLeaked", function(e)
		leaks[e.id] = (leaks[e.id] or 0) + 1
	end)
	sim:on("waveStarted", function(n)
		if n > 1 then
			livesByWave[n - 1] = sim.lives
		end
	end)
	local maxTime = opts.maxTime or 3600
	local maxWaves = opts.maxWaves or math.huge
	Run.simulate({
		state = sim, dt = Sim.TICK, maxTime = maxTime,
		step = function(s, dt)
			s:tick(dt)
			bot:step(dt)
		end,
		done = function(s)
			return s.state == "won" or s.state == "lost" or s.wave > maxWaves
		end,
	})
	local res = sim:result()
	res.towers = {}
	for _, t in sim:towerList() do
		table.insert(res.towers, t.id .. "+" .. (t.up.common or 0) .. (t.up.branch or "") .. (t.up.tier or ""))
	end
	livesByWave[sim.wave] = sim.lives
	res.livesByWave = livesByWave
	res.leaksByEnemy = leaks
	res.timedOut = sim.time >= maxTime
	res.money = sim.money
	return res
end

-- Whole campaign in order (unlocks carried forward as a player would get them; a lost level still unlocks
-- its rewards so later levels get evaluated). Returns the report harness.ts `balance()` documents.
function Balance.campaign(content, opts)
	opts = opts or {}
	local C = Content.load(content)
	local camp = Campaign.new(C)
	local report = { ok = true, levels = {}, problems = {} }
	for i, cl in C.campaign.levels do
		local res = Balance.runLevel(C, cl.level, camp:simOptions(cl.level, { skill = opts.skill }))
		table.insert(report.levels, {
			level = cl.level, won = res.won, lives = res.lives, maxLives = res.maxLives, stars = res.stars,
			wavesCleared = if res.won then res.waves else math.max(0, res.wave - 1), waves = res.waves,
			leaked = res.leaked, spent = res.spent, towers = res.towers, seconds = math.floor(res.time),
			livesByWave = res.livesByWave, leaksByEnemy = res.leaksByEnemy,
		})
		if not res.won then
			report.ok = false
			table.insert(report.problems, cl.level .. ": reference build LOST at wave " .. res.wave .. "/" .. res.waves)
		elseif res.leaked == 0 and i > 1 then
			table.insert(report.problems, cl.level .. ": reference build leaked nothing (maybe too easy for level " .. i .. ")")
		end
		camp:complete({ level = cl.level, won = true, stars = math.max(1, res.stars), lives = res.lives })
	end
	local e = C.campaign.endless
	if e and opts.endlessWaves and opts.endlessWaves > 0 then
		local res = Balance.runLevel(C, e.level, camp:simOptions(e.level, { endless = true, waves = e.waves, maxWaves = opts.endlessWaves }))
		report.endless = { wavesSurvived = if res.lost then res.wave - 1 else res.wave }
	end
	return report
end

return Balance
