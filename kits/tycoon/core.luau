--!strict
-- tycoon kit: the pure, deterministic economy simulation. No engine globals (except data.* when content is
-- nil) — runs the same in game scripts, headless tests and the balance simulator. Drive it with t:step(dt) from onTick.
local U = require("./util")
local Content = require("./content")

local T = {}
T.__index = T

local SIGNALS = {
	"purchased", "upgraded", "managerHired", "milestone", "unlocked", "achievement", "prestiged",
	"boostStarted", "boostEnded", "eventSpawned", "eventExpired", "eventClaimed", "produced", "tapped",
	"offline", "changed",
}

export type Opts = { seed: number?, now: number? }

function T.new(content: any?, opts: Opts?): any
	local o = opts or {}
	local c = Content.normalize(content or Content.read())
	local self: any = setmetatable({}, T)
	self.content = c
	self.on = {}
	for _, n in SIGNALS do
		self.on[n] = U.signal()
	end
	-- hooks: optional functions games set to customise the economy
	--   outputMult(genId, mult) -> mult     costMult(genId, mult) -> mult
	--   prestigeGain(layerId, gain) -> gain  tapAmount(amount) -> amount
	self.hooks = {}
	self.rng = U.rng(o.seed or 12345)
	self.t = 0
	self.ach = {}
	self.prestige = {}
	for _, lid in c.layerOrder do
		self.prestige[lid] = { claimed = 0, count = 0 }
	end
	self.allTime = {}
	self.stats = { taps = 0, playTime = 0, purchases = 0, prestiges = 0 }
	self.cur = {}
	for _, id in c.currencyOrder do
		self.cur[id] = 0
		self.allTime[id] = 0
	end
	self.upgrades = {}
	self:_resetRun(nil)
	self.savedAt = o.now
	self.nextEventAt = c.config.events.first_delay
	return self
end

-- reset everything a prestige resets (or initialise a new game when layer == nil)
function T._resetRun(self: any, layer: any)
	local c = self.content
	local resets = if layer then layer.resets else c.currencyOrder
	for _, id in resets do
		self.cur[id] = c.currencies[id].start or 0
	end
	self.earned = {}
	for _, id in c.currencyOrder do
		self.earned[id] = 0
	end
	self.owned, self.progress, self.running, self.unlocked = {}, {}, {}, {}
	if not (layer and layer.keep_managers) then
		self.managers = {}
	end
	for _, gid in c.genOrder do
		self.owned[gid] = 0
		self.progress[gid] = 0
	end
	local keep = {}
	for id in self.upgrades or {} do
		if c.upgrades[id] and c.upgrades[id].permanent then
			keep[id] = true
		end
	end
	self.upgrades = keep
	self.boosts = {}
	self.pendingEvent = nil
	self.runTime = 0
	self._dirty = true
	self:_checkUnlocks(true)
end

-- ---------- currencies ----------
function T.get(self: any, cur: string?): number
	return self.cur[cur or self.content.main] or 0
end

function T._earn(self: any, cur: string, n: number)
	if n <= 0 then
		return
	end
	self.cur[cur] = (self.cur[cur] or 0) + n
	self.earned[cur] = (self.earned[cur] or 0) + n
	self.allTime[cur] = (self.allTime[cur] or 0) + n
end

-- add (or with negative n, remove) currency directly, e.g. store consumables or quest rewards
function T.add(self: any, cur: string, n: number)
	if n >= 0 then
		self:_earn(cur, n)
	else
		self.cur[cur] = math.max(0, (self.cur[cur] or 0) + n)
	end
	self.on.changed:fire()
end

function T.canAfford(self: any, cur: string, amount: number): boolean
	return (self.cur[cur] or 0) >= amount - 1e-9 * amount
end

function T._spend(self: any, cur: string, amount: number): boolean
	if not self:canAfford(cur, amount) then
		return false
	end
	self.cur[cur] = math.max(0, self.cur[cur] - amount)
	return true
end

-- ---------- multipliers ----------
function T._recalc(self: any)
	local c = self.content
	local global = 1
	for id in self.ach do
		local a = c.achievements[id]
		if a and a.reward.mult then
			global *= a.reward.mult
		end
	end
	for _, lid in c.layerOrder do
		local l = c.layers[lid]
		local units = if l.bonus_on == "held" then self.cur[l.currency] or 0 else self.prestige[lid].claimed
		global *= 1 + units * l.bonus
	end
	local out, speed, cost = {}, {}, {}
	for _, gid in c.genOrder do
		out[gid], speed[gid], cost[gid] = 1, 1, 1
	end
	local tap, offH, offR, pres = 1, 0, 0, 1
	local function apply(e)
		local k = e.kind
		if k == "tap" then
			tap *= e.value
		elseif k == "offline_hours" then
			offH += e.value
		elseif k == "offline_rate" then
			offR += e.value
		elseif k == "prestige" then
			pres *= e.value
		else
			local m = if k == "output" then out elseif k == "speed" then speed else cost
			if e.target == "all" then
				for gid in m do
					m[gid] *= e.value
				end
			else
				m[e.target] *= e.value
			end
		end
	end
	for id in self.upgrades do
		for _, e in c.upgrades[id].effects do
			apply(e)
		end
	end
	for gid, g in c.generators do
		local n = self.owned[gid]
		for _, ms in g.milestones do
			if n >= ms.at then
				local k = ms.kind or "output"
				local tgt = ms.target or gid
				local m = if k == "speed" then speed else out
				if tgt == "all" then
					for x in m do
						m[x] *= ms.mult
					end
				else
					m[tgt] *= ms.mult
				end
			end
		end
	end
	for gid in out do
		out[gid] *= global
		if self.hooks.outputMult then
			out[gid] = self.hooks.outputMult(gid, out[gid])
		end
		if self.hooks.costMult then
			cost[gid] = self.hooks.costMult(gid, cost[gid])
		end
	end
	self._m = { out = out, speed = speed, cost = cost, tap = tap, global = global, offlineHours = offH, offlineRate = offR, prestige = pres }
	self._dirty = false
end

function T._mults(self: any)
	if self._dirty then
		self:_recalc()
	end
	return self._m
end

-- recompute multipliers after you change hooks
function T.invalidate(self: any)
	self._dirty = true
end

local function boostMult(self: any, kind: string, gid: string?): number
	local m = 1
	for _, b in self.boosts do
		for _, e in b.effects do
			if e.kind == kind and (e.target == "all" or e.target == gid) then
				m *= e.value
			end
		end
	end
	return m
end

-- total output multiplier of a generator (milestones × upgrades × achievements × prestige × boosts)
function T.outputMult(self: any, gid: string): number
	return self:_mults().out[gid] * boostMult(self, "output", gid)
end

-- effective cycle seconds
function T.cycleTime(self: any, gid: string): number
	return self.content.generators[gid].cycle / (self:_mults().speed[gid] * boostMult(self, "speed", gid))
end

-- payout of one completed cycle
function T.payout(self: any, gid: string): number
	return self.owned[gid] * self.content.generators[gid].output * self:outputMult(gid)
end

function T.isAuto(self: any, gid: string): boolean
	return self.content.generators[gid].auto or self.managers[gid] == true
end

-- per-second output of one generator if it runs continuously
function T.rate(self: any, gid: string): number
	if self.owned[gid] <= 0 then
		return 0
	end
	return self:payout(gid) / self:cycleTime(gid)
end

-- income per second of a currency. opts.manual = fraction of time non-automated generators run (default 0)
function T.income(self: any, cur: string?, opts: any?): number
	cur = cur or self.content.main
	local manual = if opts and opts.manual then opts.manual else 0
	local sum = 0
	for _, gid in self.content.genOrder do
		local g = self.content.generators[gid]
		if g.currency == cur then
			local r = self:rate(gid)
			sum += if self:isAuto(gid) then r else r * manual
		end
	end
	return sum
end

-- ---------- generators ----------
function T.costOf(self: any, gid: string, k: number?): number
	local g = self.content.generators[gid]
	k = k or 1
	if k <= 0 then
		return 0
	end
	local base = g.cost.base * self:_mults().cost[gid] * g.cost.growth ^ self.owned[gid]
	if g.cost.growth == 1 then
		return base * k
	end
	return base * (g.cost.growth ^ k - 1) / (g.cost.growth - 1)
end

function T.maxAffordable(self: any, gid: string): number
	local g = self.content.generators[gid]
	local money = self.cur[g.cost.currency] or 0
	local base = g.cost.base * self:_mults().cost[gid] * g.cost.growth ^ self.owned[gid]
	if money < base then
		return 0
	end
	local k
	if g.cost.growth == 1 then
		k = math.floor(money / base)
	else
		k = math.floor(math.log(money * (g.cost.growth - 1) / base + 1) / math.log(g.cost.growth) + 1e-9)
	end
	while k > 0 and self:costOf(gid, k) > money * (1 + 1e-9) do
		k -= 1
	end
	return k
end

-- owned count of the next milestone (nil when none left)
function T.nextMilestone(self: any, gid: string): number?
	local best = nil
	for _, ms in self.content.generators[gid].milestones do
		if ms.at > self.owned[gid] and (best == nil or ms.at < best) then
			best = ms.at
		end
	end
	return best
end

-- how many a buy mode would buy: 1 | 10 | 100 | "max" | "next" (up to the next milestone)
function T.buyCount(self: any, gid: string, mode: any): number
	if mode == "max" then
		return self:maxAffordable(gid)
	elseif mode == "next" then
		local nm = self:nextMilestone(gid)
		return if nm then nm - self.owned[gid] else 1
	end
	return mode or 1
end

function T.isUnlocked(self: any, gid: string): boolean
	return self.unlocked[gid] == true
end

function T.buy(self: any, gid: string, mode: any?): boolean
	local g = self.content.generators[gid]
	if not g then
		error("tycoon: unknown generator '" .. tostring(gid) .. "'", 2)
	end
	if not self.unlocked[gid] then
		return false
	end
	local n = self:buyCount(gid, mode or 1)
	if n <= 0 then
		return false
	end
	local cost = self:costOf(gid, n)
	if not self:_spend(g.cost.currency, cost) then
		return false
	end
	local before = self.owned[gid]
	self.owned[gid] = before + n
	self.stats.purchases += 1
	self._dirty = true
	self.on.purchased:fire(gid, n, cost)
	for _, ms in g.milestones do
		if before < ms.at and self.owned[gid] >= ms.at then
			self.on.milestone:fire(gid, ms.at, ms.mult)
		end
	end
	self:_checkUnlocks(false)
	self:_checkAchievements()
	self.on.changed:fire()
	return true
end

-- start one production cycle of a non-automated generator (a tap on its row)
function T.run(self: any, gid: string): boolean
	if self.owned[gid] <= 0 or self.running[gid] or self:isAuto(gid) then
		return false
	end
	self.running[gid] = true
	return true
end

-- fraction 0..1 of the current cycle
function T.cycleProgress(self: any, gid: string): number
	if self.owned[gid] <= 0 then
		return 0
	end
	return math.clamp(self.progress[gid] / self:cycleTime(gid), 0, 1)
end

function T.isRunning(self: any, gid: string): boolean
	return self.owned[gid] > 0 and (self:isAuto(gid) or self.running[gid] == true)
end

-- ---------- managers ----------
function T.managerCost(self: any, gid: string): number?
	local m = self.content.generators[gid].manager
	return m and m.cost
end

function T.canHire(self: any, gid: string): boolean
	local m = self.content.generators[gid].manager
	return m ~= nil and not self.managers[gid] and self.owned[gid] > 0 and self:canAfford(m.currency, m.cost)
end

function T.hireManager(self: any, gid: string): boolean
	local m = self.content.generators[gid].manager
	if not m or self.managers[gid] or self.owned[gid] <= 0 then
		return false
	end
	if not self:_spend(m.currency, m.cost) then
		return false
	end
	self.managers[gid] = true
	self.on.managerHired:fire(gid)
	self:_checkAchievements()
	self.on.changed:fire()
	return true
end

-- ---------- upgrades ----------
function T._requiresMet(self: any, r: any): boolean
	for gid, n in r.owned or {} do
		if (self.owned[gid] or 0) < n then
			return false
		end
	end
	for _, uid in r.upgrades or {} do
		if not self.upgrades[uid] then
			return false
		end
	end
	if r.earned and (self.allTime[r.currency or self.content.main] or 0) < r.earned then
		return false
	end
	if r.prestiges and self.stats.prestiges < r.prestiges then
		return false
	end
	return true
end

-- visible in the shop (requirements met, not bought)
function T.upgradeAvailable(self: any, id: string): boolean
	local u = self.content.upgrades[id]
	return u ~= nil and not self.upgrades[id] and self:_requiresMet(u.requires)
end

function T.hasUpgrade(self: any, id: string): boolean
	return self.upgrades[id] == true
end

function T.buyUpgrade(self: any, id: string): boolean
	local u = self.content.upgrades[id]
	if not u then
		error("tycoon: unknown upgrade '" .. tostring(id) .. "'", 2)
	end
	if not self:upgradeAvailable(id) or not self:_spend(u.cost.currency, u.cost.amount) then
		return false
	end
	self.upgrades[id] = true
	self._dirty = true
	self.stats.purchases += 1
	self.on.upgraded:fire(id)
	self:_checkAchievements()
	self.on.changed:fire()
	return true
end

-- upgrades currently purchasable-or-visible, in order
function T.availableUpgrades(self: any): { string }
	local out = {}
	for _, id in self.content.upgradeOrder do
		if self:upgradeAvailable(id) then
			table.insert(out, id)
		end
	end
	return out
end

-- ---------- tapping ----------
function T.tapValue(self: any): number
	local tc = self.content.config.tap
	local amount = (tc.amount + self:income(tc.currency) * tc.rate_fraction) * self:_mults().tap * boostMult(self, "tap", nil)
	if self.hooks.tapAmount then
		amount = self.hooks.tapAmount(amount)
	end
	return amount
end

function T.tap(self: any): number
	local amount = self:tapValue()
	self:_earn(self.content.config.tap.currency, amount)
	self.stats.taps += 1
	self.on.tapped:fire(amount)
	return amount
end

-- ---------- prestige ----------
function T.prestigeTotal(self: any, lid: string?): number
	local c = self.content
	local l = c.layers[lid or c.layerOrder[1]]
	if not l then
		return 0
	end
	return math.floor(l.scale * (self.allTime[l.from] / l.threshold) ^ l.exponent * self:_mults().prestige + 1e-9)
end

-- prestige currency you'd get by resetting now
function T.prestigeGain(self: any, lid: string?): number
	local c = self.content
	lid = lid or c.layerOrder[1]
	if not lid or not c.layers[lid] then
		return 0
	end
	local gain = math.max(0, self:prestigeTotal(lid) - self.prestige[lid].claimed)
	if self.hooks.prestigeGain then
		gain = self.hooks.prestigeGain(lid, gain)
	end
	return gain
end

-- all-time amount of the source currency needed for prestigeGain() to reach `units` (default 1)
function T.prestigeNeeded(self: any, lid: string?, units: number?): number
	local c = self.content
	local l = c.layers[lid or c.layerOrder[1]]
	local target = self.prestige[l.id].claimed + (units or 1)
	return l.threshold * (target / (l.scale * self:_mults().prestige)) ^ (1 / l.exponent)
end

function T.canPrestige(self: any, lid: string?): boolean
	local c = self.content
	lid = lid or c.layerOrder[1]
	local l = c.layers[lid]
	return l ~= nil and self:prestigeGain(lid) >= l.min_gain
end

-- output multiplier the prestige bonus gives now / would give after resetting
function T.prestigeBonus(self: any, lid: string?, extra: number?): number
	local c = self.content
	local l = c.layers[lid or c.layerOrder[1]]
	if not l then
		return 1
	end
	local units = if l.bonus_on == "held" then self.cur[l.currency] or 0 else self.prestige[l.id].claimed
	return 1 + (units + (extra or 0)) * l.bonus
end

function T.doPrestige(self: any, lid: string?): number
	local c = self.content
	lid = lid or c.layerOrder[1]
	local l = c.layers[lid]
	if not l then
		error("tycoon: unknown prestige layer '" .. tostring(lid) .. "'", 2)
	end
	local gain = self:prestigeGain(lid)
	if gain < l.min_gain then
		return 0
	end
	local p = self.prestige[lid]
	p.claimed += gain
	p.count += 1
	self.stats.prestiges += 1
	self:_resetRun(l)
	-- lower layers listed in l.resets_layers lose their progress too
	for _, other in l.resets_layers or {} do
		local op = self.prestige[other]
		if op then
			op.claimed = 0
			self.cur[c.layers[other].currency] = 0
		end
	end
	self:_earn(l.currency, gain)
	self._dirty = true
	self:_checkAchievements()
	self.on.prestiged:fire(lid, gain)
	self.on.changed:fire()
	return gain
end

-- ---------- boosts & events ----------
-- start a timed boost: effects = { {kind="output"|"speed"|"tap", target="all"|genId, value=2} }
function T.boost(self: any, id: string, effects: { any }, seconds: number)
	for _, e in effects do
		e.target = e.target or "all"
	end
	local b = { id = id, effects = effects, left = seconds, duration = seconds }
	table.insert(self.boosts, b)
	self.on.boostStarted:fire(b)
end

function T.activeBoosts(self: any): { any }
	return self.boosts
end

-- the event waiting to be tapped (nil if none): { id, left }
function T.pendingEventInfo(self: any): any
	return self.pendingEvent
end

function T.spawnEvent(self: any, id: string?)
	local c = self.content
	if #c.eventOrder == 0 then
		return
	end
	if not id then
		local total = 0
		for _, eid in c.eventOrder do
			total += c.events[eid].weight
		end
		local r = self.rng:next() * total
		for _, eid in c.eventOrder do
			r -= c.events[eid].weight
			if r <= 0 then
				id = eid
				break
			end
		end
		id = id or c.eventOrder[#c.eventOrder]
	end
	local e = c.events[id :: string]
	self.pendingEvent = { id = id, left = e.lifetime }
	self.on.eventSpawned:fire(id)
end

-- claim the pending event: starts its boost and/or pays `reward.income_seconds` of income
function T.claimEvent(self: any): string?
	local p = self.pendingEvent
	if not p then
		return nil
	end
	self.pendingEvent = nil
	local e = self.content.events[p.id]
	if #e.effects > 0 then
		self:boost(e.id, U.deepCopy(e.effects), e.duration)
	end
	if e.reward and e.reward.income_seconds then
		local cur = e.reward.currency or self.content.main
		self:_earn(cur, self:income(cur) * e.reward.income_seconds + (e.reward.amount or 0))
	end
	self.on.eventClaimed:fire(p.id)
	self.on.changed:fire()
	return p.id
end

-- ---------- unlocks & achievements ----------
function T._checkUnlocks(self: any, silent: boolean)
	local c = self.content
	for _, gid in c.genOrder do
		if not self.unlocked[gid] then
			local u = c.generators[gid].unlock
			local ok = true
			if u.earned and (self.earned[u.currency or c.main] or 0) < u.earned then
				ok = false
			end
			if u.all_time and (self.allTime[u.currency or c.main] or 0) < u.all_time then
				ok = false
			end
			for og, n in u.owned or {} do
				if (self.owned[og] or 0) < n then
					ok = false
				end
			end
			if u.prestiges and self.stats.prestiges < u.prestiges then
				ok = false
			end
			if ok then
				self.unlocked[gid] = true
				if not silent then
					self.on.unlocked:fire(gid)
				end
			end
		end
	end
end

function T.achievementDone(self: any, id: string): boolean
	local a = self.content.achievements[id]
	local w = a.when
	for gid, n in w.owned or {} do
		if (self.owned[gid] or 0) < n then
			return false
		end
	end
	if w.owned_total then
		local s = 0
		for _, n in self.owned do
			s += n
		end
		if s < w.owned_total then
			return false
		end
	end
	if w.earned and (self.allTime[w.currency or self.content.main] or 0) < w.earned then
		return false
	end
	if w.prestiges and self.stats.prestiges < w.prestiges then
		return false
	end
	if w.taps and self.stats.taps < w.taps then
		return false
	end
	if w.upgrades then
		local n = 0
		for _ in self.upgrades do
			n += 1
		end
		if n < w.upgrades then
			return false
		end
	end
	if w.managers then
		local n = 0
		for _ in self.managers do
			n += 1
		end
		if n < w.managers then
			return false
		end
	end
	return true
end

function T._checkAchievements(self: any)
	local c = self.content
	for _, id in c.achievementOrder do
		if not self.ach[id] and self:achievementDone(id) then
			self.ach[id] = true
			local r = c.achievements[id].reward
			if r.amount then
				self:_earn(r.currency or c.main, r.amount)
			end
			self._dirty = true
			self.on.achievement:fire(id)
		end
	end
end

-- ---------- simulation step ----------
function T.step(self: any, dt: number)
	local c = self.content
	self.t += dt
	self.runTime += dt
	self.stats.playTime += dt
	-- boosts
	for i = #self.boosts, 1, -1 do
		local b = self.boosts[i]
		b.left -= dt
		if b.left <= 0 then
			table.remove(self.boosts, i)
			self.on.boostEnded:fire(b)
		end
	end
	-- production
	for _, gid in c.genOrder do
		if self.owned[gid] > 0 then
			local auto = self:isAuto(gid)
			if auto or self.running[gid] then
				local cyc = self:cycleTime(gid)
				local p = self.progress[gid] + dt
				if p >= cyc then
					local n
					if auto then
						n = math.floor(p / cyc)
						p -= n * cyc
					else
						n = 1
						p = 0
						self.running[gid] = false
					end
					local amount = self:payout(gid) * n
					self:_earn(c.generators[gid].currency, amount)
					self.on.produced:fire(gid, amount)
				end
				self.progress[gid] = p
			end
		end
	end
	-- events
	if #c.eventOrder > 0 then
		if self.pendingEvent then
			self.pendingEvent.left -= dt
			if self.pendingEvent.left <= 0 then
				local id = self.pendingEvent.id
				self.pendingEvent = nil
				self.on.eventExpired:fire(id)
			end
		elseif self.t >= self.nextEventAt then
			self:spawnEvent(nil)
			local e = c.events[self.pendingEvent.id]
			self.nextEventAt = self.t + e.lifetime + self.rng:range(e.every[1], e.every[2])
		end
	end
	self:_checkUnlocks(false)
	self:_checkAchievements()
end

-- ---------- offline progress ----------
function T.offlineCap(self: any): number
	return (self.content.config.offline.cap_hours + self:_mults().offlineHours) * 3600
end

-- Credit production for the time since the last save (automated generators only, no boosts),
-- capped at offline.cap_hours and scaled by offline.rate. now = wall-clock seconds (engine clock.now()).
-- Returns { seconds, credited, earned = {[currency]=n} } or nil when nothing to credit.
function T.applyOffline(self: any, now: number?): any
	if now == nil or self.savedAt == nil then
		return nil
	end
	local elapsed = now - self.savedAt
	self.savedAt = now
	local cfg = self.content.config.offline
	if elapsed < cfg.min_seconds then
		return nil
	end
	local credited = math.min(elapsed, self:offlineCap())
	local rate = cfg.rate + self:_mults().offlineRate
	local earned = {}
	local saved = self.boosts
	self.boosts = {}
	for _, gid in self.content.genOrder do
		if self:isAuto(gid) then
			local g = self.content.generators[gid]
			earned[g.currency] = (earned[g.currency] or 0) + self:rate(gid) * credited * rate
		end
	end
	self.boosts = saved
	for cur, n in earned do
		self:_earn(cur, n)
	end
	self:_checkUnlocks(false)
	self:_checkAchievements()
	local report = { seconds = elapsed, credited = credited, earned = earned }
	self.on.offline:fire(report)
	self.on.changed:fire()
	return report
end

-- ---------- save ----------
local function setOf(t: { [string]: boolean }): { string }
	return U.sortedKeys(t)
end
local function fromList(l: { string }?): { [string]: boolean }
	local s = {}
	for _, k in l or {} do
		s[k] = true
	end
	return s
end
local function finiteMap(m: { [string]: number }): { [string]: number }
	local o = {}
	for k, v in m do
		o[k] = U.finite(v)
	end
	return o
end

-- plain JSON-safe table (fits save.set). now = wall-clock seconds for offline progress (optional)
function T.serialize(self: any, now: number?): any
	local boosts = {}
	for _, b in self.boosts do
		table.insert(boosts, { id = b.id, effects = U.deepCopy(b.effects), left = b.left, duration = b.duration })
	end
	return {
		v = 1,
		t = self.t,
		runTime = self.runTime,
		savedAt = now or self.savedAt,
		cur = finiteMap(self.cur),
		earned = finiteMap(self.earned),
		allTime = finiteMap(self.allTime),
		owned = table.clone(self.owned),
		progress = table.clone(self.progress),
		running = setOf(self.running),
		managers = setOf(self.managers),
		upgrades = setOf(self.upgrades),
		unlocked = setOf(self.unlocked),
		ach = setOf(self.ach),
		prestige = U.deepCopy(self.prestige),
		stats = table.clone(self.stats),
		boosts = boosts,
		nextEventAt = self.nextEventAt,
		rng = self.rng.s,
	}
end

-- restore from serialize() output. Unknown ids (content removed since) are dropped.
function T.deserialize(self: any, d: any)
	if type(d) ~= "table" or d.v ~= 1 then
		return false
	end
	local c = self.content
	self.t = d.t or 0
	self.runTime = d.runTime or 0
	self.savedAt = d.savedAt
	for _, id in c.currencyOrder do
		self.cur[id] = (d.cur or {})[id] or 0
		self.earned[id] = (d.earned or {})[id] or 0
		self.allTime[id] = (d.allTime or {})[id] or 0
	end
	for _, gid in c.genOrder do
		self.owned[gid] = (d.owned or {})[gid] or 0
		self.progress[gid] = (d.progress or {})[gid] or 0
	end
	local function filter(s: { [string]: boolean }, map: any)
		local o = {}
		for k in s do
			if map[k] then
				o[k] = true
			end
		end
		return o
	end
	self.running = filter(fromList(d.running), c.generators)
	self.managers = filter(fromList(d.managers), c.generators)
	self.upgrades = filter(fromList(d.upgrades), c.upgrades)
	self.unlocked = filter(fromList(d.unlocked), c.generators)
	self.ach = filter(fromList(d.ach), c.achievements)
	for _, lid in c.layerOrder do
		local p = (d.prestige or {})[lid]
		self.prestige[lid] = { claimed = p and p.claimed or 0, count = p and p.count or 0 }
	end
	for k, v in d.stats or {} do
		self.stats[k] = v
	end
	self.boosts = {}
	for _, b in d.boosts or {} do
		table.insert(self.boosts, b)
	end
	self.nextEventAt = d.nextEventAt or self.t + c.config.events.first_delay
	if d.rng then
		self.rng.s = d.rng
	end
	self.pendingEvent = nil
	self._dirty = true
	self:_checkUnlocks(true)
	return true
end

return T
