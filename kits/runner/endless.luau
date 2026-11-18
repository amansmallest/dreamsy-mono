--!nonstrict
-- Endless lane runner simulation (pure, deterministic; no entities). The view module draws it.
-- sim = endless.new({ seed, tier? (fixed difficulty), params? (player params, e.g. from runner.params()), modifier? (daily) })
-- sim:step(dt, action?)   action = "left" | "right" | "jump" | "slide" | nil
-- state: dist, speed, tier, lane (target, 1..lanes), x (float lane position), air (s left in jump), slide (s left), alive,
--        coins, score, power = { magnet, shield, double } (s left), objects = { {id, d, lane, kind, taken?} }, stats, events (this step)
local S = require("./state")
local Track = require("./track")
local M = {}
local Sim = {}
Sim.__index = Sim
M.Sim = Sim

function M.new(opts)
	opts = opts or {}
	local p = table.clone(S.config.player)
	for k, v in opts.params or {} do p[k] = v end
	local mod = opts.modifier and opts.modifier.params or {}
	local lanes = S.config.lanes
	local self = setmetatable({
		p = p, mod = mod, lanes = lanes, seq = Track.sequencer({ seed = opts.seed, tier = opts.tier, segments = opts.segments }),
		diff = Track.difficulty(), tierFixed = opts.tier,
		dist = 0, speed = 0, tier = 0, lane = math.ceil(lanes / 2), x = math.ceil(lanes / 2), air = 0, slide = 0, alive = true,
		lives = p.lives, coins = 0, score = 0, time = 0, power = { magnet = 0, shield = 0, double = 0 },
		objects = {}, nextId = 0, genD = 12, events = {}, hitCooldown = 0,
		stats = { jumps = 0, slides = 0, lanes = 0, powerups = 0, coins = 0, gems = 0, nearMiss = 0, distance = 0 },
	}, Sim)
	self:fill()
	return self
end

function Sim:speedAt(d)
	local sp
	if self.tierFixed then
		-- fixed tier: speed of the first difficulty tier with that tier number
		for _, t in S.config.speed do if t.params.tier == self.tierFixed then sp = t.params.speed end end
		sp = sp or S.config.speed[#S.config.speed].params.speed
	else
		sp = self.diff:at(d).speed
	end
	return sp * (self.mod.speedMult or 1)
end

-- generate segments until genD covers dist + viewAhead
function Sim:fill()
	local rl = S.config.rowLength
	while self.genD < self.dist + S.config.viewAhead do
		local seg, tier = self.seq:next(self.genD)
		for i, row in seg.rows do
			local d = self.genD + (i - 1) * rl
			for l = 1, #row do
				local c = string.sub(row, l, l)
				local kind = Track.KIND[c]
				if kind and not (self.mod.noPowerups and (kind == "magnet" or kind == "shield" or kind == "double")) then
					self.nextId += 1
					table.insert(self.objects, { id = self.nextId, d = d, lane = l, kind = kind, seg = seg.id, tier = tier })
				end
			end
		end
		self.genD += (#seg.rows + S.config.gapRows) * rl
	end
end

function Sim:emit(name, data)
	data = data or {}
	data.name = name
	table.insert(self.events, data)
end

function Sim:act(action)
	if not self.alive or action == nil then return end
	if action == "left" and self.lane > 1 then self.lane -= 1 self.stats.lanes += 1 self:emit("lane", { dir = -1 })
	elseif action == "right" and self.lane < self.lanes then self.lane += 1 self.stats.lanes += 1 self:emit("lane", { dir = 1 })
	elseif action == "jump" and self.air <= 0 then
		self.air = self.p.jumpTime
		self.slide = 0
		self.stats.jumps += 1
		self:emit("jump")
	elseif action == "slide" and self.slide <= 0 then
		self.slide = self.p.slideTime
		self.air = 0 -- fast-fall
		self.stats.slides += 1
		self:emit("slide")
	end
end

-- current lane cell (the lane the player body occupies)
function Sim:cell() return math.floor(self.x + 0.5) end
-- jump height 0..1 (parabola) for views
function Sim:height()
	if self.air <= 0 then return 0 end
	local t = 1 - self.air / self.p.jumpTime
	return 4 * t * (1 - t)
end

local function collect(self, o)
	o.taken = true
	if o.kind == "coin" or o.kind == "gem" then
		local v = (if o.kind == "gem" then 10 else 1) * self.p.coinValue * (if self.power.double > 0 then 2 else 1) * (self.mod.coinMult or 1)
		self.coins += v
		self.stats.coins += v
		if o.kind == "gem" then self.stats.gems += 1 end
		self:emit("coin", { value = v, lane = o.lane, kind = o.kind })
	else
		local t = ({ magnet = self.p.magnetTime, shield = self.p.shieldTime, double = self.p.doubleTime })[o.kind]
		self.power[o.kind] = t
		self.stats.powerups += 1
		self:emit("powerup", { kind = o.kind })
	end
end

function Sim:hit(o)
	if self.hitCooldown > 0 then return end
	if self.power.shield > 0 then
		self.power.shield = 0
		self.hitCooldown = 0.5
		o.taken = true
		self:emit("shieldBreak", { kind = o.kind })
		return
	end
	self.lives -= 1
	self.hitCooldown = 1
	self:emit("hit", { kind = o.kind, lane = o.lane })
	if self.lives <= 0 then
		self.alive = false
		self.stats.distance = self.dist
		self:emit("dead", { kind = o.kind })
	end
end

function Sim:step(dt, action)
	self.events = {}
	if not self.alive then return self.events end
	self:act(action)
	self.time += dt
	self.speed = self:speedAt(self.dist)
	self.tier = if self.tierFixed then self.tierFixed else math.floor(self.diff:at(self.dist).tier + 1e-6)
	local prev = self.dist
	self.dist += self.speed * dt
	-- lane slide
	local dx = self.lane - self.x
	local mv = dt / math.max(0.01, self.p.laneTime)
	if math.abs(dx) <= mv then self.x = self.lane else self.x += mv * math.sign(dx) end
	self.air = math.max(0, self.air - dt)
	self.slide = math.max(0, self.slide - dt)
	self.hitCooldown = math.max(0, self.hitCooldown - dt)
	for k, v in self.power do self.power[k] = math.max(0, v - dt) if v > 0 and self.power[k] == 0 then self:emit("powerupEnd", { kind = k }) end end
	local cell = self:cell()
	local hw = S.config.hitWindow
	local magnet = self.power.magnet > 0
	for _, o in self.objects do
		if not o.taken then
			local isObs = Track.OBSTACLE[o.kind]
			if isObs then
				-- overlapping this step?
				if o.d + hw >= prev and o.d - hw <= self.dist and o.lane == cell then
					local avoided = (o.kind == "low" and self.air > 0) or (o.kind == "high" and self.slide > 0)
					if not avoided then self:hit(o) if not self.alive then break end end
				end
			elseif o.d <= self.dist + 0.5 and o.d >= prev - 0.5 and o.lane == cell then
				collect(self, o)
			elseif magnet and (o.kind == "coin" or o.kind == "gem") and o.d >= self.dist and o.d <= self.dist + self.p.magnetRange then
				collect(self, o)
			end
		end
	end
	-- drop passed objects
	local keep = {}
	for _, o in self.objects do if o.d > self.dist - 6 and not (o.taken and o.d < self.dist) then table.insert(keep, o) end end
	self.objects = keep
	self:fill()
	self.score = math.floor(self.dist * self.p.scorePerMetre) + self.stats.coins * self.p.scorePerCoin
	self.stats.distance = self.dist
	return self.events
end

-- summary() for missions / best / UIs
function Sim:summary()
	return { distance = math.floor(self.dist), coins = self.stats.coins, score = self.score, time = self.time, jumps = self.stats.jumps,
		slides = self.stats.slides, lanes = self.stats.lanes, powerups = self.stats.powerups, gems = self.stats.gems, tier = self.tier }
end

------------------------------------------------------------------ bot (balance sims, demos, tests)
-- botAction(sim, state, skill) -> action. skill = { reaction = 0.25 (s look-ahead slack), miss = 0.02 (chance to ignore a threat), rng }
function M.botAction(sim, bot, skill)
	skill = skill or {}
	bot.cool = (bot.cool or 0) - (1 / 60)
	if bot.cool > 0 then return nil end
	local rng = skill.rng
	-- look further ahead than the reaction window: lane plans need time, jumps/slides fire late
	local look = sim.speed * ((skill.reaction or 0.25) + 0.35) + 4
	local cell = sim.lane
	local function threatIn(lane, from, to)
		local best = nil
		for _, o in sim.objects do
			if not o.taken and Track.OBSTACLE[o.kind] and o.lane == lane and o.d >= from and o.d <= to then
				if best == nil or o.d < best.d then best = o end
			end
		end
		return best
	end
	local t = threatIn(cell, sim.dist - 0.2, sim.dist + look)
	if t == nil then
		-- drift toward coins when the lane ahead is clear
		return nil
	end
	-- each threat is noticed or missed once (miss chance per obstacle)
	bot.missed = bot.missed or {}
	if bot.missed[t.id] == nil then bot.missed[t.id] = rng ~= nil and rng:next() < (skill.miss or 0.02) end
	if bot.missed[t.id] then return nil end
	local timeTo = (t.d - sim.dist) / math.max(1, sim.speed)
	if t.kind == "low" then
		if sim.air <= 0 and timeTo < sim.p.jumpTime * 0.45 then bot.cool = 0.1 return "jump" end
		return nil
	elseif t.kind == "high" then
		if sim.slide <= 0 and timeTo < sim.p.slideTime * 0.45 then bot.cool = 0.1 return "slide" end
		return nil
	end
	-- block: head for the lane whose first block is farthest, stepping through lanes that are clear right now
	local first = {}
	for l = 1, sim.lanes do first[l] = 1e9 end
	for _, o in sim.objects do
		if not o.taken and o.kind == "block" and o.d >= sim.dist - 1 and o.d < first[o.lane] then first[o.lane] = o.d end
	end
	-- feasible target lanes: clear past this threat, and every lane crossed on the way stays clear while crossing it
	local stepT = sim.p.laneTime + 0.05
	local want, wd = nil, -1
	for l = 1, sim.lanes do
		if l ~= cell and first[l] > t.d + 0.6 then
			local ok = true
			local dir = if l > cell then 1 else -1
			local k = 0
			for m = cell + dir, l - dir, dir do
				k += 1
				if first[m] <= sim.dist + sim.speed * stepT * (k + 1) + 0.8 then ok = false end
			end
			if ok and (first[l] > wd + 0.5 or (math.abs(first[l] - wd) <= 0.5 and want and math.abs(l - cell) < math.abs(want - cell))) then want, wd = l, first[l] end
		end
	end
	local bestDir = nil
	if want then bestDir = if want > cell then 1 else -1
	elseif t.d - sim.dist < 1.5 then
		-- desperate: dodge to the adjacent lane with the farthest block
		local bd = -1
		for _, dir in { -1, 1 } do
			local l = cell + dir
			if l >= 1 and l <= sim.lanes and first[l] > bd then bd, bestDir = first[l], dir end
		end
	end
	if bestDir then bot.cool = 0.05 return if bestDir < 0 then "left" else "right" end
	return nil
end

-- survivalJob(opts) -> job; job:step(maxSimSteps) -> done; job.result (when done). Spreads bot runs over ticks
-- (each script callback has a 250 ms budget). opts = { tier?, runs = 20, seed = 1, maxDist = 3000, skill = {reaction, miss}, params? }
function M.survivalJob(opts)
	opts = opts or {}
	local job = { distances = {}, i = 0, sim = nil, done = false }
	local n = opts.runs or 20
	local maxD = opts.maxDist or 3000
	local function startNext()
		job.i += 1
		local seed = (opts.seed or 1) * 1000 + job.i
		job.sim = M.new({ seed = seed, tier = opts.tier, params = opts.params })
		job.bot = {}
		job.skill = { reaction = (opts.skill and opts.skill.reaction) or 0.25, miss = (opts.skill and opts.skill.miss) or 0.02, rng = S.procgen.rng(seed):fork("bot") }
	end
	function job:step(budget)
		if self.done then return true end
		budget = budget or 5000
		local dt = 1 / 60
		while budget > 0 do
			if self.sim == nil then startNext() end
			local sim = self.sim
			sim:step(dt, M.botAction(sim, self.bot, self.skill))
			budget -= 1
			if not sim.alive or sim.dist >= maxD then
				table.insert(self.distances, math.floor(sim.dist))
				self.sim = nil
				if #self.distances >= n then
					self.done = true
					self.result = M.stats(self.distances, maxD)
					return true
				end
			end
		end
		return false
	end
	return job
end

function M.stats(out, maxD)
	local sorted = table.clone(out)
	table.sort(sorted)
	local sum = 0
	for _, d in out do sum += d end
	local function pct(p) return sorted[math.clamp(math.floor(#sorted * p + 0.5), 1, #sorted)] end
	return { distances = out, mean = sum / math.max(1, #out), p10 = pct(0.1), p50 = pct(0.5), p90 = pct(0.9), maxed = #sorted > 0 and sorted[#sorted] >= (maxD or 3000) }
end

-- survival(opts) -> { distances, mean, p10, p50, p90, maxed } synchronously (small runs only; use survivalJob for big sims)
function M.survival(opts)
	local job = M.survivalJob(opts)
	while not job:step(1e9) do end
	return job.result
end

return M
