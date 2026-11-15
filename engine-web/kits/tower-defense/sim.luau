-- tower-defense kit: the deterministic level simulation. Pure Luau (no engine globals): runs the same in a
-- game, in tests and in the headless balance sim. Positions are in tile units (see path.luau).
local U = require("@kit/tower-defense/util")
local Content = require("@kit/tower-defense/content")

local Sim = {}
local SimM = {}
SimM.__index = SimM

Sim.TICK = 1 / 30

-- opts: { towers = {id}|set (unlocked; default all), lockedBranches = {"tower.branch"} (blocked branches),
--         endless = bool, waves = wave set id (default: the level's), seed = n, autoWaves = bool (default true: next wave auto-starts `between` s after
--         the previous finished spawning and is cleared), hooks = { damage = fn(sim, tower, enemy, dmg, type) -> dmg,
--         bounty = fn(sim, enemy, n) -> n, canBuild = fn(sim, towerId, c, r) -> bool } }
function Sim.new(content, levelId, opts)
	local C = Content.load(content)
	opts = opts or {}
	local level = C.levels[levelId]
	if not level then
		error("tower-defense: unknown level '" .. tostring(levelId) .. "'", 2)
	end
	local lay = Content.layout(C, levelId)
	local self = setmetatable({}, SimM)
	self.C = C
	self.level = level
	self.levelId = levelId
	self.layout = lay
	self.waveSet = C.waves[opts.waves or level.waves]
	if not self.waveSet then
		error("tower-defense: unknown wave set '" .. tostring(opts.waves) .. "'", 2)
	end
	self.endless = opts.endless == true
	self.waveCount = if self.endless then math.huge else #self.waveSet.waves
	self.money = level.money
	self.lives = level.lives
	self.maxLives = level.lives
	self.wave = 0 -- waves started
	self.state = "build" -- build | running | won | lost
	self.speed = 1
	self.time = 0
	self.acc = 0
	self.enemies = {}
	self.towers = {}
	self.towerAt = {}
	self.buildable = {}
	for _, b in lay.build do
		self.buildable[b[2] * 4096 + b[1]] = true
	end
	self.pending = {} -- spawn entries of started waves { t, enemy, path, hpMult, wave }
	self.waveAlive = {}
	self.waveSpawning = {}
	self.waveBonus = {}
	self.countdown = nil
	self.autoWaves = opts.autoWaves ~= false
	self.rng = U.rng(opts.seed or 1)
	self.uid = 0
	self.stats = { kills = 0, leaked = 0, spent = 0, earned = 0, damage = 0 }
	self.hooks = opts.hooks or {}
	self.events = U.events()
	self.unlockedTowers = if opts.towers then (if #opts.towers > 0 then U.set(opts.towers) else opts.towers) else nil
	self.lockedBranches = U.set(opts.lockedBranches)
	return self
end

function SimM:on(name, fn)
	return self.events.on(name, fn)
end
local function emit(self, name, ...)
	self.events.emit(name, ...)
end

-- ---------- economy ----------

function SimM:addMoney(n, why)
	n = math.floor(n + 0.5)
	if n == 0 then
		return
	end
	self.money += n
	if n > 0 then
		self.stats.earned += n
	end
	emit(self, "moneyChanged", self.money, n, why)
end

function SimM:towerUnlocked(id)
	return self.C.towers[id] ~= nil and (self.unlockedTowers == nil or self.unlockedTowers[id] == true)
end

function SimM:availableTowers()
	local list = {}
	for id, t in self.C.towers do
		if self:towerUnlocked(id) then
			table.insert(list, t)
		end
	end
	table.sort(list, function(a, b)
		if a.cost == b.cost then
			return a.id < b.id
		end
		return a.cost < b.cost
	end)
	return list
end

-- ---------- building ----------

local function cellKey(c, r)
	return r * 4096 + c
end

function SimM:isBuildable(c, r)
	return self.buildable[cellKey(c, r)] == true
end

function SimM:towerAtCell(c, r)
	return self.towerAt[cellKey(c, r)]
end

-- Can `towerId` be built at (c, r)? Returns ok, reason ("locked" | "tile" | "occupied" | "money" | "over").
function SimM:canBuild(towerId, c, r)
	if self.state == "won" or self.state == "lost" then
		return false, "over"
	end
	if not self:towerUnlocked(towerId) then
		return false, "locked"
	end
	if not self:isBuildable(c, r) then
		return false, "tile"
	end
	if self.towerAt[cellKey(c, r)] then
		return false, "occupied"
	end
	if self.hooks.canBuild and not self.hooks.canBuild(self, towerId, c, r) then
		return false, "tile"
	end
	if self.money < self.C.towers[towerId].cost then
		return false, "money"
	end
	return true
end

local function refreshStats(self, t)
	t.base = Content.towerStats(t.def, t.up)
	emit(self, "towerChanged", t)
end

function SimM:build(towerId, c, r)
	local ok, why = self:canBuild(towerId, c, r)
	if not ok then
		return nil, why
	end
	local def = self.C.towers[towerId]
	self.uid += 1
	local t = {
		uid = self.uid, id = towerId, def = def, c = c, r = r, x = c + 0.5, y = r + 0.5,
		up = { common = 0 }, spent = def.cost, cooldown = 0, targeting = def.targeting, kills = 0, damage = 0,
		builtWave = self.wave,
	}
	t.base = Content.towerStats(def, t.up)
	self.money -= def.cost
	self.stats.spent += def.cost
	self.towers[t.uid] = t
	self.towerAt[cellKey(c, r)] = t
	emit(self, "moneyChanged", self.money, -def.cost, "build")
	emit(self, "towerBuilt", t)
	return t
end

-- Upgrade choices with lock + affordability flags.
function SimM:upgradeOptions(t)
	local out = Content.upgradeChoices(t.def, t.up)
	for _, o in out do
		o.locked = o.kind == "branch" and self.lockedBranches[t.id .. "." .. o.branch] == true
		o.affordable = self.money >= o.cost
	end
	return out
end

-- Buy the next upgrade: `branch` picks the branch once common tiers are done (nil = the only choice).
function SimM:upgrade(t, branch)
	if self.state == "won" or self.state == "lost" then
		return false, "over"
	end
	local opts = self:upgradeOptions(t)
	local pick = nil
	for _, o in opts do
		if o.kind == "common" or o.branch == branch or (branch == nil and #opts == 1) then
			pick = o
			break
		end
	end
	if not pick then
		return false, if #opts == 0 then "max" else "choose"
	end
	if pick.locked then
		return false, "locked"
	end
	if self.money < pick.cost then
		return false, "money"
	end
	self.money -= pick.cost
	self.stats.spent += pick.cost
	t.spent += pick.cost
	if pick.kind == "common" then
		t.up.common = pick.tier
	else
		t.up.branch = pick.branch
		t.up.tier = pick.tier
	end
	refreshStats(self, t)
	emit(self, "moneyChanged", self.money, -pick.cost, "upgrade")
	emit(self, "towerUpgraded", t, pick)
	return true
end

function SimM:sellValue(t)
	return math.floor(t.spent * (self.level.sell_ratio or 0.7))
end

function SimM:sell(t)
	if not self.towers[t.uid] then
		return 0
	end
	local v = self:sellValue(t)
	self.towers[t.uid] = nil
	self.towerAt[cellKey(t.c, t.r)] = nil
	self:addMoney(v, "sell")
	emit(self, "towerSold", t, v)
	return v
end

function SimM:setTargeting(t, mode)
	t.targeting = mode
	emit(self, "towerChanged", t)
end

function SimM:cycleTargeting(t)
	local modes = Content.TARGETING
	local i = table.find(modes, t.targeting) or 0
	self:setTargeting(t, modes[i % #modes + 1])
	return t.targeting
end

function SimM:setSpeed(s)
	self.speed = math.clamp(s, 0, 3)
	emit(self, "speedChanged", self.speed)
end

-- ---------- waves ----------

function SimM:canStartWave()
	if self.state == "won" or self.state == "lost" then
		return false
	end
	if self.wave >= self.waveCount then
		return false
	end
	return self.waveSpawning[self.wave] ~= true
end

-- Start the next wave now. Calling early (during the countdown, or while the previous wave is still alive)
-- pays early_bonus × seconds saved. Interest is paid at every wave start after the first.
function SimM:startWave()
	if not self:canStartWave() then
		return false
	end
	local n = self.wave + 1
	local sched, bonus = Content.waveSchedule(self.C, self.waveSet, n, self.layout.pathIds, self.endless)
	if not sched then
		return false
	end
	if self.wave > 0 then
		local saved = if self.countdown then self.countdown else self.level.between
		local early = math.floor((self.level.early_bonus or 0) * saved)
		if early > 0 then
			self:addMoney(early, "early")
		end
		local it = self.level.interest
		if it and (it.rate or 0) > 0 then
			local interest = math.min(it.cap or math.huge, math.floor(self.money * it.rate))
			if interest > 0 then
				self:addMoney(interest, "interest")
			end
		end
	end
	self.countdown = nil
	self.wave = n
	self.state = "running"
	self.waveAlive[n] = 0
	self.waveSpawning[n] = #sched > 0
	self.waveBonus[n] = bonus
	for _, s in sched do
		table.insert(self.pending, { t = self.time + s.t, enemy = s.enemy, path = s.path, hpMult = s.hpMult, wave = n })
	end
	table.sort(self.pending, function(a, b)
		return a.t < b.t
	end)
	-- income towers pay at wave start
	for _, t in self:towerList() do
		if (t.base.income or 0) > 0 then
			self:addMoney(t.base.income, "income")
			emit(self, "income", t, t.base.income)
		end
	end
	emit(self, "waveStarted", n, sched)
	return true
end

-- ---------- enemies ----------

function SimM:spawnEnemy(enemyId, pathId, opts)
	opts = opts or {}
	local def = self.C.enemies[enemyId]
	local path = opts.pathObj or self.layout.paths[pathId] or self.layout.paths[self.layout.pathIds[1]]
	if def.flying and not opts.pathObj then
		path = path:direct()
	end
	self.uid += 1
	local hp = math.max(1, math.floor(def.hp * (opts.hpMult or 1) + 0.5))
	local e = {
		uid = self.uid, id = enemyId, def = def, hp = hp, maxHp = hp, dist = opts.dist or 0, path = path,
		flying = def.flying, boss = def.boss, wave = opts.wave or self.wave, slow = 1, slowT = 0, dots = {},
		healT = 0, alive = true, hpMult = opts.hpMult or 1,
	}
	e.x, e.y = path:at(e.dist)
	self.enemies[e.uid] = e
	self.waveAlive[e.wave] = (self.waveAlive[e.wave] or 0) + 1
	emit(self, "enemySpawned", e)
	if e.boss then
		emit(self, "bossSpawned", e)
	end
	return e
end

local function waveDone(self, w)
	self.waveAlive[w] -= 1
	if self.waveAlive[w] <= 0 and not self.waveSpawning[w] then
		local b = self.waveBonus[w] or 0
		if b > 0 then
			self:addMoney(b, "wave")
		end
		emit(self, "waveCleared", w, b)
	end
end

local function kill(self, e, tower)
	e.alive = false
	self.enemies[e.uid] = nil
	local bounty = e.def.bounty
	if self.hooks.bounty then
		bounty = self.hooks.bounty(self, e, bounty)
	end
	self.stats.kills += 1
	if tower then
		tower.kills += 1
	end
	self:addMoney(bounty, "bounty")
	emit(self, "enemyKilled", e, bounty, tower)
	local sp = e.def.split
	if sp then
		for i = 1, sp.count or 2 do
			self:spawnEnemy(sp.into, nil, {
				dist = math.max(0, e.dist - 0.25 * (i - 1)),
				wave = e.wave,
				hpMult = e.hpMult,
				pathObj = e.path,
			})
		end
	end
	waveDone(self, e.wave)
end

-- Apply damage of `kind` to e (armor + resistances + hooks). Returns damage dealt.
function SimM:damage(e, amount, kind, tower, opts)
	if not e.alive then
		return 0
	end
	local d = amount
	if not Content.ARMORLESS_TYPES[kind] and not (opts and opts.ignoreArmor) then
		local armor = math.max(0, (e.def.armor or 0) - ((tower and tower.stats and tower.stats.armor_pierce) or 0))
		d = math.max(d * 0.2, d - armor)
	end
	if kind ~= "true" then
		d *= 1 - (e.def.resist[kind] or 0)
	end
	local bonus = tower and tower.stats and tower.stats.bonus
	if bonus then
		if e.boss and bonus.boss then
			d *= bonus.boss
		end
		if e.flying and bonus.air then
			d *= bonus.air
		end
	end
	if self.hooks.damage then
		d = self.hooks.damage(self, tower, e, d, kind) or d
	end
	d = math.max(0, d)
	e.hp -= d
	self.stats.damage += d
	if tower then
		tower.damage += d
	end
	emit(self, "enemyDamaged", e, d, kind, tower)
	if e.hp <= 0 then
		kill(self, e, tower)
	end
	return d
end

-- ---------- targeting ----------

local function inRange(t, e, range)
	return (e.x - t.x) ^ 2 + (e.y - t.y) ^ 2 <= range * range
end

local function canHit(stats, e)
	if e.flying then
		return stats.air == true
	end
	return stats.ground ~= false
end

-- The enemy tower `t` would shoot now under its targeting mode (or nil).
function SimM:pickTarget(t, stats)
	stats = stats or t.stats or t.base
	local best, bestScore = nil, -math.huge
	local mode = t.targeting
	for _, e in self.enemies do
		if canHit(stats, e) and inRange(t, e, stats.range) then
			local score
			if mode == "last" then
				score = -(e.dist / e.path.length)
			elseif mode == "strong" then
				score = e.hp
			elseif mode == "close" then
				score = -((e.x - t.x) ^ 2 + (e.y - t.y) ^ 2)
			else -- first: closest to the exit
				score = -(e.path.length - e.dist)
			end
			if score > bestScore or (score == bestScore and best and e.uid < best.uid) then
				best, bestScore = e, score
			end
		end
	end
	return best
end

-- ---------- tower effects ----------

-- Support auras: each stat takes the best aura in range (auras don't stack with each other).
local function computeStats(self)
	local list = self:towerList()
	for _, t in list do
		local s = table.clone(t.base)
		local dmg, rate, range = 0, 0, 0
		for _, o in list do
			local a = o.base.aura
			if o ~= t and a and (o.x - t.x) ^ 2 + (o.y - t.y) ^ 2 <= (a.range or 2) ^ 2 then
				dmg = math.max(dmg, a.damage or 0)
				rate = math.max(rate, a.rate or 0)
				range = math.max(range, a.range_bonus or 0)
			end
		end
		s.damage = (s.damage or 0) * (1 + dmg)
		s.rate = (s.rate or 0) * (1 + rate)
		s.range = (s.range or 0) * (1 + range)
		s.buffed = dmg > 0 or rate > 0 or range > 0
		t.stats = s
	end
end

local function fire(self, t, target)
	local s = t.stats
	local kind = s.damage_type
	emit(self, "shot", t, target)
	local x, y = target.x, target.y
	self:damage(target, s.damage, kind, t)
	if s.slow and target.alive and not target.def.immune.slow then
		local f = s.slow.factor or 0.5
		if f <= target.slow or target.slowT <= 0 then
			target.slow = f
			target.slowT = s.slow.duration or 1
		elseif f == target.slow then
			target.slowT = math.max(target.slowT, s.slow.duration or 1)
		end
	end
	if s.dot and target.alive and not target.def.immune.dot then
		target.dots[t.uid] = { dps = s.dot.dps, t = s.dot.duration or 3, kind = s.dot.type or kind, tower = t }
	end
	if s.splash then
		local r = s.splash.radius or 1
		local fall = s.splash.falloff or 0.5
		emit(self, "splash", t, x, y, r)
		for _, e in self.enemies do
			if e ~= target and canHit(s, e) then
				local d2 = (e.x - x) ^ 2 + (e.y - y) ^ 2
				if d2 <= r * r then
					local k = 1 - fall * math.sqrt(d2) / r
					self:damage(e, s.damage * k, kind, t)
					if s.slow and e.alive and not e.def.immune.slow and (s.slow.factor or 0.5) <= e.slow then
						e.slow = s.slow.factor or 0.5
						e.slowT = s.slow.duration or 1
					end
				end
			end
		end
	end
	if s.chain then
		local hit = { [target.uid] = true }
		local lx, ly = x, y
		local dmg = s.damage
		for _ = 1, s.chain.count or 2 do
			dmg *= s.chain.falloff or 0.7
			local best, bd = nil, math.huge
			for _, e in self.enemies do
				if not hit[e.uid] and canHit(s, e) then
					local d2 = (e.x - lx) ^ 2 + (e.y - ly) ^ 2
					if d2 <= (s.chain.range or 1.5) ^ 2 and (d2 < bd or (d2 == bd and best and e.uid < best.uid)) then
						best, bd = e, d2
					end
				end
			end
			if not best then
				break
			end
			hit[best.uid] = true
			emit(self, "chain", t, lx, ly, best)
			lx, ly = best.x, best.y
			self:damage(best, dmg, kind, t)
		end
	end
end

-- ---------- tick ----------

function SimM:towerList()
	local list = {}
	for _, t in self.towers do
		table.insert(list, t)
	end
	table.sort(list, function(a, b)
		return a.uid < b.uid
	end)
	return list
end

function SimM:enemyList()
	local list = {}
	for _, e in self.enemies do
		table.insert(list, e)
	end
	table.sort(list, function(a, b)
		return a.uid < b.uid
	end)
	return list
end

function SimM:tick(dt)
	if self.state == "won" or self.state == "lost" then
		return
	end
	self.time += dt
	-- spawns
	while #self.pending > 0 and self.pending[1].t <= self.time do
		local s = table.remove(self.pending, 1)
		self:spawnEnemy(s.enemy, s.path, { hpMult = s.hpMult, wave = s.wave })
		local more = false
		for _, p in self.pending do
			if p.wave == s.wave then
				more = true
				break
			end
		end
		if not more then
			self.waveSpawning[s.wave] = false
			emit(self, "waveSpawned", s.wave)
		end
	end
	-- enemies: status, abilities, movement
	for _, e in self:enemyList() do
		if not e.alive then
			continue
		end
		for key, d in e.dots do
			d.t -= dt
			self:damage(e, d.dps * dt, d.kind, d.tower, { ignoreArmor = true })
			if d.t <= 0 then
				e.dots[key] = nil
			end
			if not e.alive then
				break
			end
		end
		if not e.alive then
			continue
		end
		if e.def.regen > 0 then
			e.hp = math.min(e.maxHp, e.hp + e.def.regen * dt)
		end
		local h = e.def.heal
		if h then
			e.healT += dt
			if e.healT >= (h.interval or 2) then
				e.healT = 0
				local healed = {}
				for _, o in self.enemies do
					if o ~= e and o.hp < o.maxHp and (o.x - e.x) ^ 2 + (o.y - e.y) ^ 2 <= (h.radius or 1.5) ^ 2 then
						o.hp = math.min(o.maxHp, o.hp + (h.amount or 10) * o.hpMult)
						table.insert(healed, o)
					end
				end
				emit(self, "heal", e, healed)
			end
		end
		if e.slowT > 0 then
			e.slowT -= dt
			if e.slowT <= 0 then
				e.slow = 1
			end
		end
		e.dist += e.def.speed * e.slow * dt
		e.x, e.y = e.path:at(e.dist)
		if e.dist >= e.path.length then
			e.alive = false
			self.enemies[e.uid] = nil
			self.lives = math.max(0, self.lives - e.def.lives)
			self.stats.leaked += 1
			emit(self, "enemyLeaked", e, e.def.lives)
			emit(self, "livesChanged", self.lives, -e.def.lives)
			waveDone(self, e.wave)
			if self.lives <= 0 then
				self.state = "lost"
				emit(self, "levelLost", self:result())
				return
			end
		end
	end
	-- towers
	computeStats(self)
	for _, t in self:towerList() do
		local s = t.stats
		if (s.damage or 0) <= 0 or (s.rate or 0) <= 0 then
			continue
		end
		t.cooldown -= dt
		if t.cooldown <= 0 then
			local target = self:pickTarget(t, s)
			if target then
				fire(self, t, target)
				t.cooldown += 1 / s.rate
			else
				t.cooldown = 0
			end
		end
	end
	-- wave flow
	local spawning = #self.pending > 0
	local alive = next(self.enemies) ~= nil
	if not spawning and not alive then
		if self.wave >= self.waveCount then
			self.state = "won"
			emit(self, "levelWon", self:result())
			return
		end
		if self.wave > 0 then
			self.state = "build"
		end
	end
	if self.autoWaves and self.wave > 0 and not spawning and self.wave < self.waveCount then
		if not alive then
			if self.countdown == nil then
				self.countdown = self.level.between
				emit(self, "countdown", self.countdown)
			end
			self.countdown -= dt
			if self.countdown <= 0 then
				self.countdown = 0
				self:startWave()
			end
		end
	end
end

-- Advance by real seconds `dt`; runs fixed 30 Hz ticks × speed. Returns ticks run.
function SimM:step(dt)
	dt = math.min(dt, 1) -- a long hitch never fast-forwards more than 1 s
	self.acc += dt * self.speed
	local n = 0
	local cap = math.max(12, math.ceil(dt * self.speed / Sim.TICK) + 1)
	while self.acc >= Sim.TICK - 1e-9 and n < cap do
		self.acc -= Sim.TICK
		self:tick(Sim.TICK)
		n += 1
	end
	if n >= cap then
		self.acc = 0
	end
	return n
end

-- ---------- results + snapshots ----------

function SimM:stars()
	if self.state == "lost" then
		return 0
	end
	local st = (self.C.campaign and self.C.campaign.stars) or { two = 0.5, three = 0.9 }
	local f = self.lives / self.maxLives
	if f >= (st.three or 0.9) then
		return 3
	elseif f >= (st.two or 0.5) then
		return 2
	end
	return 1
end

function SimM:result()
	return {
		level = self.levelId, won = self.state == "won", lost = self.state == "lost", lives = self.lives,
		maxLives = self.maxLives, stars = if self.state == "won" then self:stars() else 0, wave = self.wave,
		waves = self.waveCount, kills = self.stats.kills, leaked = self.stats.leaked, spent = self.stats.spent,
		time = self.time, endless = self.endless,
	}
end

-- Between waves (no enemies alive or pending): a plain table you can save.set() and Sim.restore() later.
function SimM:snapshot()
	if next(self.enemies) ~= nil or #self.pending > 0 then
		return nil
	end
	local towers = {}
	for _, t in self:towerList() do
		table.insert(towers, {
			id = t.id, c = t.c, r = t.r, common = t.up.common, branch = t.up.branch, tier = t.up.tier,
			targeting = t.targeting, spent = t.spent,
		})
	end
	return {
		level = self.levelId, wave = self.wave, money = self.money, lives = self.lives, endless = self.endless,
		towers = towers,
	}
end

function Sim.restore(content, snap, opts)
	opts = table.clone(opts or {})
	opts.endless = snap.endless
	local s = Sim.new(content, snap.level, opts)
	s.money, s.lives, s.wave = snap.money, snap.lives, snap.wave
	for _, ts in snap.towers do
		local def = s.C.towers[ts.id]
		if def then
			s.money += def.cost -- build() charges it
			local t = s:build(ts.id, ts.c, ts.r)
			if t then
				t.up = { common = ts.common or 0, branch = ts.branch, tier = ts.tier }
				t.spent = ts.spent or t.spent
				t.targeting = ts.targeting or t.targeting
				t.base = Content.towerStats(def, t.up)
			end
		end
	end
	s.money = snap.money
	if s.wave > 0 then
		s.state = "build"
		s.countdown = s.level.between
	end
	return s
end

return Sim
