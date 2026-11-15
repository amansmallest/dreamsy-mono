--!nonstrict
-- Run: one attempt. Pure state machine (no entities): floors/biomes from data, a branching room path per floor
-- (Hades-style doors), room contents (encounters, rewards, shop stock, events), relics/actives, gold, HP, triggers,
-- summary, serialize/deserialize (mid-run save). Deterministic per seed: every floor/room derives its own rng.
--   state: "choose" (pick a door) → "room" (fight/visit) → "reward" (relic pick pending) → "choose" … → "won" | "dead"
local S = require("./state")
local Relics = require("./relics")
local Run = {}
Run.__index = Run

local function rng(seed, label) return S.procgen.rng(seed):fork(label) end

-- new({ class, seed?, heat? (0), daily?, sim? (true: never touches wallet/save/events), metaMods? })
function Run.new(opts)
	local cls = S.req("classes", opts.class)
	local self = setmetatable({
		seed = opts.seed or 1, classId = cls.id, heat = opts.heat or 0, daily = opts.daily, sim = opts.sim == true,
		floor = 1, step = 0, relics = {}, active = nil, charge = 0, gold = S.config.startGold, state = "choose",
		metaMods = opts.metaMods or {}, counters = {}, plan = nil, room = nil, pending = nil, shield = 0,
		stats = { kills = 0, rooms = 0, elites = 0, bosses = 0, damageTaken = 0, goldEarned = 0, time = 0, relicsTaken = 0 },
	}, Run)
	for _, rid in cls.relics or {} do self:addRelic(rid, true) end
	if cls.active then self:setActive(cls.active) end
	self.hp = self:maxHp()
	self.plan = self:planFloor(self.floor)
	return self
end

---------------------------------------------------------------- floors
-- biome/floor position of an overall floor index -> biome def, floorInBiome, isLastFloorOfBiome, biomeIndex
function Run:where(floor)
	floor = floor or self.floor
	local n = 0
	local biomes = S.sortedBiomes()
	for bi, b in biomes do
		local f = b.floors or 1
		if floor <= n + f then return b, floor - n, floor == n + f, bi end
		n += f
	end
	return nil, 0, false, #biomes + 1
end
function Run:totalFloors()
	local n = 0
	for _, b in S.sortedBiomes() do n += b.floors or 1 end
	return n
end
function Run:biome() return (self:where()) end

local function enemyPool(ids)
	local out = {}
	for _, id in ids or {} do table.insert(out, S.req("enemies", id)) end
	return out
end

-- room contents for a type (deterministic from the room's rng)
function Run:makeRoom(kind, floor, step, r)
	local cfg = S.config
	local biome = (self:where(floor))
	local room = { type = kind, floor = floor, step = step, seed = r:int(1, 2147480000), biome = biome.id }
	local sc = cfg.scaling
	local budget = sc.budgetBase + sc.budgetPerFloor * (floor - 1) + (step - 1) * 0.35
	if kind == "combat" then
		room.enemies = S.procgen.waves.encounter(enemyPool(biome.enemies), math.floor(budget), r, { level = floor, maxCount = 10 }).ids
	elseif kind == "elite" then
		local pool = enemyPool(biome.elites or biome.enemies)
		room.enemies = S.procgen.waves.encounter(pool, math.floor(budget * sc.eliteBudget), r, { level = floor, maxCount = 8 }).ids
		room.elite = true
	elseif kind == "boss" then
		room.enemies = { biome.boss }
		room.boss = biome.boss
	elseif kind == "event" then
		local evs = {}
		for _, e in S.all("events") do
			if (e.biomes == nil or table.find(e.biomes, biome.id)) and (e.minFloor or 1) <= floor then table.insert(evs, e) end
		end
		table.sort(evs, function(a, b) return a.id < b.id end)
		room.event = if #evs > 0 then r:weighted(evs).id else nil
		if room.event == nil then room.type = "treasure" end
	end
	return room
end

-- planFloor(floor) -> { biome, floor, steps = { { choices = {room…} } }, boss = bool }
function Run:planFloor(floor)
	local cfg = S.config
	local biome, inBiome, bossFloor = self:where(floor)
	assert(biome, "planFloor: no biome for floor " .. floor)
	local r = rng(self.seed * 1000 + floor, "floor")
	local steps = biome.steps or 7
	local weights = table.clone(cfg.weights)
	for k, v in biome.weights or {} do weights[k] = v end
	local plan = { biome = biome.id, floor = floor, steps = {}, boss = bossFloor and biome.boss ~= nil }
	local shopSeen = false
	for s = 1, steps do
		local kinds = {}
		if s == 1 then
			kinds = { "combat" }
		elseif s == steps and plan.boss then
			kinds = { "boss" }
		elseif s == steps then
			kinds = { if biome.gate == "combat" then "combat" else "elite" }
		elseif s == steps - 1 and plan.boss then
			kinds = { "rest", "shop" }
			if r:chance(0.5) then table.insert(kinds, "treasure") end
		else
			local n = r:int(cfg.choices[1], cfg.choices[2])
			local w = table.clone(weights)
			if s < cfg.eliteFromStep then w.elite = 0 end
			if shopSeen then w.shop = 0 end
			while #kinds < n do
				local k = r:weighted(w)
				if k == nil then break end
				table.insert(kinds, k)
				if k ~= "combat" then w[k] = 0 end -- distinct non-combat doors
				if k == "combat" then w.combat = w.combat * 0.3 end
			end
			if table.find(kinds, "shop") then shopSeen = true end
		end
		local choices = {}
		for i, k in kinds do table.insert(choices, self:makeRoom(k, floor, s, r:fork(s * 10 + i))) end
		table.insert(plan.steps, { choices = choices })
	end
	return plan
end

---------------------------------------------------------------- stats, hp, relics, actives
-- stats are cached until relics / mods change (run:dirty())
function Run:dirty() self._st = nil self._trig = nil end
function Run:statsNow()
	local st = self._st
	if not st then st = Relics.stats(self) self._st = st end
	return st
end
function Run:maxHp() return self:statsNow().hp end
function Run:synergies() return Relics.synergies(self.relics) end
function Run:hitStatuses() return Relics.hitStatuses(self) end
function Run:relicCount(id) return Relics.owns(self.relics, id) end

local function emit(self, name, data)
	if self.sim then return end
	data = data or {}
	data.run = nil
	S.core.events.emit(name, data)
end
Run._emit = emit

function Run:syncFighter()
	local f = self.fighter
	if f and not f.dead then
		f.maxHp = self:maxHp()
		f.hp = math.min(self.hp, f.maxHp)
	end
end

function Run:heal(n)
	if n <= 0 or self.hp <= 0 then return 0 end
	local st = self:statsNow()
	local before = self.hp
	self.hp = math.min(st.hp, self.hp + n * st.healMult)
	self:syncFighter()
	return self.hp - before
end
function Run:hurt(n)
	self.hp = math.max(0, self.hp - n)
	self.stats.damageTaken += n
	self:syncFighter()
	if self.hp <= 0 then self:die() end
end

function Run:addRelic(id, silent)
	local d = S.req("relics", id)
	local before = self:maxHp()
	local have = false
	for _, r in self.relics do if r.id == id then r.count += 1 have = true end end
	if not have then table.insert(self.relics, { id = id, count = 1 }) end
	self:dirty()
	local gain = self:maxHp() - before
	if gain > 0 and self.hp then self.hp += gain end
	if self.hp then self.hp = math.min(self.hp, self:maxHp()) end
	if not silent then
		self.stats.relicsTaken += 1
		if d.effects then self:apply(d.effects) end
		emit(self, "relic_gained", { relic = id, count = self:relicCount(id) })
	end
	self:syncFighter()
	return d
end

function Run:setActive(id)
	local d = S.req("actives", id)
	self.active = id
	self.charge = d.charge or 3
	return d
end
-- activeReady() -> bool, def
function Run:activeReady()
	if not self.active then return false end
	local d = S.req("actives", self.active)
	return self.charge >= (d.charge or 3), d
end
-- useActive() -> def | nil. Applies its effects, fires "activeUsed", emits `active_used` {active} (the game plays the action).
function Run:useActive()
	local ok, d = self:activeReady()
	if not ok then return nil end
	self.charge = 0
	if d.effects then self:apply(d.effects) end
	self:fire("activeUsed", { active = d.id })
	emit(self, "active_used", { active = d.id, action = d.action })
	return d
end
function Run:addCharge(n)
	if not self.active then return end
	local d = S.req("actives", self.active)
	self.charge = math.min(d.charge or 3, self.charge + n)
end

function Run:addGold(n, raw)
	if n == 0 then return 0 end
	if n > 0 and not raw then n = math.floor(n * self:statsNow().goldMult + 0.5) end
	self.gold = math.max(0, self.gold + n)
	if n > 0 then self.stats.goldEarned += n end
	if not self.sim and S.core.wallet.get then pcall(S.core.wallet.set, S.config.runCurrency, self.gold) end
	return n
end

---------------------------------------------------------------- effects + triggers
-- apply(effects): core effects with ctx.run = self (kit effect kinds: heal, healPct, maxHp, gold, relic, charge, shield, hurt)
function Run:apply(effects)
	if not effects then return end
	if self.sim then
		-- sim: only the run-local kinds (no core side effects)
		for _, e in effects do
			for k in e do
				local fn = S.effectKinds[k]
				if fn then fn(e, { run = self }) break end
			end
		end
		return
	end
	S.core.apply(effects, { run = self })
end

-- fire(event, data): run every matching trigger { on, every?, chance?, condition?, effects }
-- events: kill, eliteKill, bossKill, hit, crit, hurt, roomEnter, roomClear, floorStart, lowHp, activeUsed, relicGained
function Run:fire(event, data)
	local r = self._trigRng or S.procgen.rng(self.seed + 77)
	self._trigRng = r
	local fired = 0
	local trig = self._trig
	if not trig then trig = Relics.triggers(self) self._trig = trig end
	for i, e in trig do
		local t = e.trig
		if t.on == event then
			local key = e.source .. "#" .. i
			self.counters[key] = (self.counters[key] or 0) + 1
			local pass = (t.every == nil or self.counters[key] % t.every == 0) and (t.chance == nil or r:next() < t.chance)
			if pass and t.condition and not self.sim then pass = S.core.check(t.condition, { run = self }) end
			if pass then
				fired += 1
				self:apply(t.effects)
			end
		end
	end
	return fired
end

---------------------------------------------------------------- flow
function Run:currentStep() return self.plan.steps[self.step + 1] end
-- choices() -> rooms offered by the next step (state "choose")
function Run:choices()
	local s = self:currentStep()
	return if s then s.choices else {}
end

-- enter(i) -> room (state "room")
function Run:enter(i)
	assert(self.state == "choose", "run:enter: state is " .. self.state)
	local room = self:choices()[i or 1]
	assert(room, "run:enter: no choice " .. tostring(i))
	self.step += 1
	self.room = room
	self.state = "room"
	self.stats.rooms += 1
	self.roomLowHp = false
	if room.type == "shop" and not room.stock then room.stock = self:shopStock(room) end
	if room.type == "rest" then room.options = { "heal", "maxHp" } end
	self:fire("roomEnter", { type = room.type })
	emit(self, "room_entered", { type = room.type, floor = self.floor, step = self.step })
	return room
end

local function rangeRoll(r, rg) return r:int(rg[1], rg[2]) end

-- clear() -> reward { gold, relics = {choice ids}? , heal? }. Combat rooms: call after the last enemy dies.
-- Shop/event/rest/treasure: call when the player leaves (after buy/choose).
function Run:clear()
	assert(self.state == "room", "run:clear: state is " .. self.state)
	local room = self.room
	local r = rng(room.seed, "reward")
	local cfg = S.config
	local reward = { gold = 0 }
	local scale = 1 + cfg.rewards.goldPerFloor * (self.floor - 1)
	if room.type == "combat" then reward.gold = math.floor(rangeRoll(r, cfg.rewards.combatGold) * scale)
	elseif room.type == "elite" then
		reward.gold = math.floor(rangeRoll(r, cfg.rewards.eliteGold) * scale)
		reward.relics = Relics.roll(r, self, cfg.relicChoices + self:statsNow().relicChoices, cfg.eliteRarity, { luck = self:statsNow().luck })
		self.stats.elites += 1
	elseif room.type == "boss" then
		reward.gold = math.floor(rangeRoll(r, cfg.rewards.bossGold) * scale)
		reward.relics = Relics.roll(r, self, cfg.relicChoices + self:statsNow().relicChoices, cfg.bossRarity, { luck = self:statsNow().luck })
		self.stats.bosses += 1
	elseif room.type == "treasure" then
		reward.relics = Relics.roll(r, self, cfg.relicChoices + self:statsNow().relicChoices, cfg.rarity, { luck = self:statsNow().luck })
	end
	if reward.gold > 0 then reward.gold = self:addGold(reward.gold) end
	if room.type == "combat" or room.type == "elite" or room.type == "boss" then
		self:addCharge(1 + self:statsNow().activeCharge)
		local regen = self:statsNow().regen
		if regen > 0 then self:heal(regen) end
		self:fire("roomClear", { type = room.type })
	end
	emit(self, "room_cleared", { type = room.type, floor = self.floor, step = self.step })
	if room.boss then emit(self, "boss_defeated", { boss = room.boss, floor = self.floor }) end
	if reward.relics and #reward.relics > 0 then
		self.pending = reward.relics
		self.state = "reward"
	else
		self:_advance()
	end
	return reward
end

-- takeRelic(id | index) / skipReward(): resolve the pending relic choice
function Run:takeRelic(which)
	assert(self.state == "reward" and self.pending, "run:takeRelic: no pending reward")
	local id = if type(which) == "number" then self.pending[which] else which
	assert(table.find(self.pending, id), "run:takeRelic: not offered " .. tostring(id))
	self.pending = nil
	self:addRelic(id)
	self:fire("relicGained", { relic = id })
	self:_advance()
	return id
end
function Run:skipReward()
	self.pending = nil
	self:addGold(10, true)
	self:_advance()
end

function Run:_advance()
	if self.state == "dead" then return end
	self.room = nil
	if self.step >= #self.plan.steps then
		if self.floor >= self:totalFloors() then
			self.state = "won"
			emit(self, "run_won", { class = self.classId, heat = self.heat })
			return
		end
		self.floor += 1
		self.step = 0
		self.plan = self:planFloor(self.floor)
		self:fire("floorStart", { floor = self.floor })
		emit(self, "floor_started", { floor = self.floor, biome = self.plan.biome })
	end
	self.state = "choose"
end

---------------------------------------------------------------- shop / rest / event
local function price(self, base)
	local disc = math.clamp(self:statsNow().shopDiscount, 0, 0.9)
	return math.max(1, math.floor(base * (1 - disc) * (1 + 0.1 * (self.floor - 1)) + 0.5))
end
function Run:shopStock(room)
	local cfg = S.config.shop
	local r = rng(room.seed, "shop")
	local out = {}
	for _, id in Relics.roll(r, self, cfg.relics, S.config.rarity, { luck = self:statsNow().luck }) do
		local d = S.req("relics", id)
		table.insert(out, { kind = "relic", id = id, price = price(self, d.price or cfg.prices[d.rarity or "common"] or 60) })
	end
	local acts = {}
	for _, a in S.all("actives") do if a.id ~= self.active and not a.starter then table.insert(acts, a) end end
	table.sort(acts, function(a, b) return a.id < b.id end)
	for i = 1, math.min(cfg.actives, #acts) do
		local a = r:pick(acts)
		table.insert(out, { kind = "active", id = a.id, price = price(self, a.price or cfg.prices.active) })
		table.remove(acts, table.find(acts, a))
	end
	table.insert(out, { kind = "heal", amount = cfg.heal.amount, price = price(self, cfg.heal.price) })
	return out
end
-- buy(i) -> ok, reason ("sold" | "gold")
function Run:buy(i)
	assert(self.room and self.room.type == "shop", "run:buy: not in a shop")
	local it = self.room.stock[i]
	if not it or it.sold then return false, "sold" end
	if self.gold < it.price then return false, "gold" end
	self:addGold(-it.price, true)
	it.sold = true
	if it.kind == "relic" then self:addRelic(it.id) self:fire("relicGained", { relic = it.id })
	elseif it.kind == "active" then self:setActive(it.id)
	elseif it.kind == "heal" then self:heal(math.ceil(self:maxHp() * it.amount)) it.sold = false it.price = math.floor(it.price * 1.5) end
	emit(self, "shop_bought", { kind = it.kind, id = it.id, price = it.price })
	return true
end
-- rest(option) "heal" | "maxHp"
function Run:rest(option)
	assert(self.room and self.room.type == "rest", "run:rest: not at a rest site")
	local cfg = S.config.rest
	if option == "maxHp" then
		self.restBonus = (self.restBonus or 0) + cfg.maxHp
		table.insert(self.metaMods, { stat = "hp", add = cfg.maxHp })
		self:dirty()
		self.hp += cfg.maxHp
		self:syncFighter()
	else
		self:heal(math.ceil(self:maxHp() * cfg.heal))
	end
	return self:clear()
end
-- event: def { title, text, choices = { { text, condition?, cost? {gold, hp}, effects } } }
function Run:eventDef() return self.room and self.room.event and S.req("events", self.room.event) end
function Run:eventChoices()
	local d = self:eventDef()
	local out = {}
	for i, c in d.choices do
		local ok = true
		if c.cost and c.cost.gold and self.gold < c.cost.gold then ok = false end
		if ok and c.condition and not self.sim then ok = S.core.check(c.condition, { run = self }) end
		table.insert(out, { index = i, text = c.text, ok = ok, def = c })
	end
	return out
end
function Run:choose(i)
	local d = self:eventDef()
	local c = d.choices[i]
	assert(c, "run:choose: no choice " .. tostring(i))
	if c.cost then
		if c.cost.gold then self:addGold(-c.cost.gold, true) end
		if c.cost.hp then self:hurt(c.cost.hp) end
	end
	if self.state == "dead" then return nil end
	self:apply(c.effects)
	local reward = self:clear()
	return reward, c
end

---------------------------------------------------------------- combat bookkeeping (called by bindCombat or the sim)
function Run:onKill(enemyId, kind)
	self.stats.kills += 1
	self:fire("kill", { enemy = enemyId })
	if kind == "elite" then self:fire("eliteKill", { enemy = enemyId }) end
	if kind == "boss" then self:fire("bossKill", { enemy = enemyId }) end
	emit(self, "enemy_defeated", { enemy = enemyId })
end

-- enemy scaling for this room: hp/damage multipliers
function Run:enemyScale(room)
	room = room or self.room
	local sc = S.config.scaling
	local st = self:statsNow()
	local hp = (1 + sc.hpPerFloor * (self.floor - 1)) * st.enemyHp
	local dmg = (1 + sc.damagePerFloor * (self.floor - 1)) * st.enemyDamage
	if room and room.elite then hp *= sc.eliteHp dmg *= sc.eliteDamage end
	return hp, dmg
end

---------------------------------------------------------------- end
function Run:die()
	if self.state == "dead" or self.state == "won" then return end
	self.state = "dead"
	self.hp = 0
	emit(self, "run_lost", { class = self.classId, floor = self.floor })
end

-- summary() -> { class, seed, heat, daily, won, floor, floors, biome, rooms, kills, gold, relics, time, minutes, metaEarned? }
function Run:summary()
	local biome = self:where(math.min(self.floor, self:totalFloors()))
	local rel = {}
	for _, r in self.relics do table.insert(rel, { id = r.id, count = r.count }) end
	return {
		class = self.classId, seed = self.seed, heat = self.heat, daily = self.daily, won = self.state == "won",
		floor = self.floor, floors = self:totalFloors(), biome = biome and biome.id, step = self.step, rooms = self.stats.rooms,
		kills = self.stats.kills, elites = self.stats.elites, bosses = self.stats.bosses, gold = self.stats.goldEarned,
		relics = rel, time = self.stats.time, minutes = self.stats.time / 60,
		floorsCleared = self.floor - 1 + (if self.state == "won" then 1 else 0),
	}
end

---------------------------------------------------------------- save
function Run:serialize()
	return {
		v = 1, seed = self.seed, class = self.classId, heat = self.heat, daily = self.daily, floor = self.floor, step = self.step,
		relics = self.relics, active = self.active, charge = self.charge, gold = self.gold, hp = self.hp, state = self.state,
		meta = self.metaMods, counters = self.counters, pending = self.pending, stats = self.stats,
		room = if self.room then { i = table.find(self:choicesAt(self.step), self.room) } else nil,
		stock = if self.room and self.room.stock then self.room.stock else nil, restBonus = self.restBonus,
	}
end
function Run:choicesAt(step) local s = self.plan.steps[step] return if s then s.choices else {} end

function Run.deserialize(t)
	local self = setmetatable({
		seed = t.seed, classId = t.class, heat = t.heat or 0, daily = t.daily, sim = false, floor = t.floor, step = t.step,
		relics = t.relics or {}, active = t.active, charge = t.charge or 0, gold = t.gold or 0, hp = t.hp, state = t.state,
		metaMods = t.meta or {}, counters = t.counters or {}, pending = t.pending, stats = t.stats, shield = 0, restBonus = t.restBonus,
	}, Run)
	self.plan = self:planFloor(self.floor)
	if t.room and t.room.i then
		self.room = self:choicesAt(self.step)[t.room.i]
		if self.room and t.stock then self.room.stock = t.stock end
		if self.room and self.room.type == "rest" then self.room.options = { "heal", "maxHp" } end
	end
	-- a combat room interrupted mid-fight restarts on resume
	return self
end

return Run
