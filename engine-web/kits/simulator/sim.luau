--!nonstrict
-- Simulator economy: a pure, deterministic state object (no entities). The game's scene script is UI + feel.
-- Coins live in core.wallet (so quests/dialog can `earn`/`spend` them), rebirth is a progression prestige layer,
-- events go to core.events (quests/achievements count them). `headless = true` uses a private wallet/layer and no
-- events (balance sims, tests).
local Core = require("@kit/core")
local Prog = require("@kit/progression")
local Content = require("./content")

local M = {}
local S = {}
S.__index = S

local BONUS_KEYS = { "power", "coins", "capacity", "speed", "luck" }

local function privateWallet()
	local bal = {}
	return {
		get = function(c) return bal[c] or 0 end,
		add = function(c, n) local b = bal[c] or 0 bal[c] = math.max(0, b + n) return bal[c] - b end,
		set = function(c, n) bal[c] = math.max(0, n) end,
		spend = function(c, n) if (bal[c] or 0) < n then return false end bal[c] -= n return true end,
		has = function(c, n) return (bal[c] or 0) >= n end,
	}
end

-- new(content, opts?) — content: Content.normalize'd table, a raw table, or nil (= read data files)
-- opts: { headless?, rand? () -> [0,1), now? () -> unix seconds, autoEquip? (true), name? ("simulator") }
function M.new(content, opts)
	opts = opts or {}
	local C = if content == nil then Content.load() elseif content.zonesById then content else Content.normalize(content)
	local cfg = C.config
	local s = setmetatable({
		C = C, cfg = cfg, cur = cfg.currency, headless = opts.headless == true,
		rand = opts.rand or math.random, nowFn = opts.now, autoEquipPets = opts.autoEquip ~= false,
		listeners = {},
	}, S)
	if s.headless then
		s.wallet = privateWallet()
		s.layer = Prog.prestige.new({ name = "rebirth", threshold = cfg.rebirth.threshold, exponent = cfg.rebirth.exponent,
			scale = cfg.rebirth.scale, bonusPer = cfg.rebirth.bonus })
	else
		s.wallet = Core.wallet
		Core.wallet.define(s.cur, { name = cfg.currencyName or "Coins", icon = cfg.currencyIcon, start = 0, max = 1e300 })
		s.layer = Prog.get("rebirth") or Prog.layer({ name = "rebirth", threshold = cfg.rebirth.threshold, exponent = cfg.rebirth.exponent,
			scale = cfg.rebirth.scale, bonusPer = cfg.rebirth.bonus })
	end
	s:_resetRun(true)
	s.pets = {} -- petId -> count owned
	s.equipped = {} -- petId -> count equipped
	s.stats = { coins = 0, bestRun = 0, nodes = 0, hatched = 0, sold = 0, rebirths = 0, playTime = 0, rarest = 0 }
	s.best = {}
	s.lastSeen = nil
	if not s.headless then
		M.current = s
		Core.save.section(opts.name or "simulator", {
			serialize = function() return s:serialize() end,
			deserialize = function(_, t) s:deserialize(t) end,
			reset = function() s:deserialize(nil) end,
		})
	end
	return s
end

function S:_resetRun(first)
	local C = self.C
	self.zones = { [C.zones[1].id] = true }
	self.zone = C.zones[1].id
	self.tools = { [C.tools[1].id] = true }
	self.tool = C.tools[1].id
	self.packs = { [C.backpacks[1].id] = true }
	self.pack = C.backpacks[1].id
	self.load = 0
	self.carried = 0
	self.runCoins = 0
	if not first then self.wallet.set(self.cur, 0) end
end

function S:now(): number
	if self.nowFn then return self.nowFn() end
	if type(clock) == "table" and type(clock.now) == "function" then return clock.now() end
	return time()
end

-- events: core.events when bound (quests/achievements), plus s:on(name, fn) local listeners (UI)
function S:emit(name, d)
	for _, fn in self.listeners[name] or {} do fn(d) end
	for _, fn in self.listeners["*"] or {} do fn(name, d) end
	if not self.headless then Core.events.emit(name, d) end
end
function S:on(name, fn)
	self.listeners[name] = self.listeners[name] or {}
	table.insert(self.listeners[name], fn)
	local list = self.listeners[name]
	return { disconnect = function() local i = table.find(list, fn) if i then table.remove(list, i) end end }
end

-- ---------- money ----------
function S:coins(): number return self.wallet.get(self.cur) end
function S:earn(n: number) self.wallet.add(self.cur, n) end

-- ---------- stats from gear + pets + rebirth ----------
function S:toolDef() return self.C.toolsById[self.tool] end
function S:packDef() return self.C.backpacksById[self.pack] end
function S:zoneDef(id: string?) return self.C.zonesById[id or self.zone] end
function S:petBonus()
	local b = {}
	for _, k in BONUS_KEYS do b[k] = 0 end
	for pid, n in self.equipped do
		local d = self.C.petsById[pid]
		if d then for k, v in d.bonus do b[k] = (b[k] or 0) + v * n end end
	end
	return b
end
function S:power(): number return self:toolDef().power * (1 + self:petBonus().power) end
function S:speed(): number return (self:toolDef().speed or 0) * (1 + self:petBonus().speed) end
function S:capacity(): number return math.floor(self:packDef().capacity * (1 + self:petBonus().capacity)) end
function S:rebirthMultiplier(): number return self.layer:multiplier() end
function S:coinMultiplier(): number return (1 + self:petBonus().coins) * self.layer:multiplier() end
function S:isFull(): boolean return self.load >= self:capacity() end
function S:fill(): number return math.min(1, self.load / math.max(1, self:capacity())) end

-- ---------- collecting ----------
-- spawnNode(zoneId?) -> node { def, hp, maxHp, zone } (weighted pick from the zone's nodes)
function S:spawnNode(zoneId: string?)
	local z = self:zoneDef(zoneId)
	local total = 0
	for _, n in z.nodes do total += n.weight end
	local r = self.rand() * total
	local pick = z.nodes[#z.nodes]
	for _, n in z.nodes do
		r -= n.weight
		if r < 0 then pick = n break end
	end
	return { def = pick, hp = pick.hp, maxHp = pick.hp, zone = z.id }
end

-- hit(node, mult?) -> { damage, broken, value, units, full }  (full = bag already full: nothing happens)
function S:hit(node, mult: number?)
	if self:isFull() then return { damage = 0, broken = false, full = true } end
	if node.hp <= 0 then return { damage = 0, broken = true } end
	local dmg = self:power() * (mult or 1)
	node.hp -= dmg
	local res = { damage = dmg, broken = false }
	if node.hp <= 0 then
		node.hp = 0
		res.broken = true
		local d = node.def
		local cap = self:capacity()
		local units = math.min(d.size, cap - self.load)
		local value = d.reward * units / d.size
		self.load += units
		self.carried += value
		self.stats.nodes += 1
		res.units, res.value = units, value
		res.full = self.load >= cap
		self:emit("sim_collected", { node = d.id, zone = node.zone, value = value })
	end
	return res
end

-- auto(dt, node) -> hit result | nil: the equipped tool's auto-swing (speed hits/s) on `node`
function S:auto(dt: number, node)
	local sp = self:speed()
	if sp <= 0 or node == nil then return nil end
	self._autoT = (self._autoT or 0) + dt * sp
	if self._autoT < 1 then return nil end
	self._autoT -= 1
	return self:hit(node)
end

-- sellValue() -> coins a sell would pay now;  sell() -> coins paid
function S:sellValue(): number return math.floor(self.carried * self:coinMultiplier() + 1e-9) end
function S:sell(): number
	local coins = self:sellValue()
	if coins <= 0 and self.load <= 0 then return 0 end
	self.wallet.add(self.cur, coins)
	self.runCoins += coins
	self.stats.coins += coins
	self.stats.sold += 1
	self.stats.bestRun = math.max(self.stats.bestRun, self.runCoins)
	self.load, self.carried = 0, 0
	self:emit("sim_sold", { coins = coins })
	return coins
end

-- ---------- gear tracks (tools / backpacks) ----------
local TRACK = { tools = { owned = "tools", eq = "tool", byId = "toolsById" }, backpacks = { owned = "packs", eq = "pack", byId = "backpacksById" } }
local function track(kind)
	local t = TRACK[kind]
	if not t then error("simulator: gear kind must be \"tools\" or \"backpacks\" (got " .. tostring(kind) .. ")", 3) end
	return t
end
function S:owns(kind: string, id: string): boolean return self[track(kind).owned][id] == true end
-- next(kind) -> def of the next unowned item in order (nil = all owned)
function S:next(kind: string)
	for _, d in self.C[kind] do
		if not self[track(kind).owned][d.id] then return d end
	end
	return nil
end
-- canBuy(kind, id) -> ok, reason ("owned" | "order" | "zone" | "coins")
function S:canBuy(kind: string, id: string)
	local t = track(kind)
	local d = self.C[t.byId][id]
	if not d then error("simulator: unknown " .. kind .. " id " .. tostring(id), 2) end
	if self[t.owned][id] then return false, "owned" end
	local prev = self.C[kind][d.index - 1]
	if prev and not self[t.owned][prev.id] then return false, "order" end
	if d.zone and not self.zones[d.zone] then return false, "zone" end
	if self:coins() < Content.costOf(d) then return false, "coins" end
	return true, nil
end
function S:buy(kind: string, id: string): boolean
	local ok = self:canBuy(kind, id)
	if not ok then return false end
	local t = track(kind)
	local d = self.C[t.byId][id]
	self.wallet.spend(self.cur, Content.costOf(d))
	self[t.owned][id] = true
	self[t.eq] = id -- newest is always the best in its track
	self:emit("sim_bought", { kind = kind, item = id })
	return true
end
function S:equipGear(kind: string, id: string): boolean
	local t = track(kind)
	if not self[t.owned][id] then return false end
	self[t.eq] = id
	return true
end
-- gear(kind) -> { {def, state = "equipped"|"owned"|"next"|"locked", cost, reason} } for shop UIs
function S:gear(kind: string)
	local t = track(kind)
	local out = {}
	for _, d in self.C[kind] do
		local st
		if self[t.eq] == d.id then st = "equipped"
		elseif self[t.owned][d.id] then st = "owned"
		else
			local ok, why = self:canBuy(kind, d.id)
			st = if ok or why == "coins" then "next" else "locked"
			table.insert(out, { def = d, state = st, cost = Content.costOf(d), reason = why })
			continue
		end
		table.insert(out, { def = d, state = st, cost = Content.costOf(d) })
	end
	return out
end

-- ---------- zones ----------
-- canUnlock(id) -> ok, reason ("unlocked" | "order" | "rebirths" | "condition" | "coins")
function S:canUnlock(id: string)
	local z = self.C.zonesById[id]
	if not z then error("simulator: unknown zone " .. tostring(id), 2) end
	if self.zones[id] then return false, "unlocked" end
	local prev = self.C.zones[z.index - 1]
	if prev and not self.zones[prev.id] then return false, "order" end
	local u = z.unlock or {}
	if (u.rebirths or 0) > self.layer.count then return false, "rebirths" end
	if u.condition and not self.headless and not Core.check(u.condition) then return false, "condition" end
	if self:coins() < (u.coins or 0) then return false, "coins" end
	return true, nil
end
function S:unlockZone(id: string): boolean
	if not self:canUnlock(id) then return false end
	local u = self.C.zonesById[id].unlock or {}
	self.wallet.spend(self.cur, u.coins or 0)
	self.zones[id] = true
	self.zone = id
	self:emit("zone_unlocked", { zone = id })
	return true
end
function S:travel(id: string): boolean
	if not self.zones[id] then return false end
	self.zone = id
	self:emit("zone_entered", { zone = id })
	return true
end
function S:zoneList()
	local out = {}
	for _, z in self.C.zones do
		local ok, why = self:canUnlock(z.id)
		local st = if self.zone == z.id then "current" elseif self.zones[z.id] then "unlocked" elseif ok then "available" else "locked"
		table.insert(out, { def = z, state = st, cost = (z.unlock or {}).coins or 0, reason = why })
	end
	return out
end
function S:bestZone() -- highest unlocked
	local best = self.C.zones[1].id
	for _, z in self.C.zones do if self.zones[z.id] then best = z.id end end
	return best
end

-- ---------- pets + eggs ----------
-- eggOdds(eggId) -> { {pet, name, rarity, chance (0..1), percent "12.5%"} } sorted common → rare. Show these in the UI.
function S:eggOdds(eggId: string)
	local e = self.C.eggsById[eggId]
	if not e then error("simulator: unknown egg " .. tostring(eggId), 2) end
	local total = 0
	for _, w in e.pets do total += w end
	local out = {}
	for pid, w in e.pets do
		local p = self.C.petsById[pid]
		local ch = w / total
		local pct = ch * 100
		local txt = if pct >= 10 then string.format("%.0f%%", pct) elseif pct >= 1 then string.format("%.1f%%", pct) else string.format("%.2f%%", pct)
		table.insert(out, { pet = pid, name = p.name or pid, rarity = p.rarity, chance = ch, percent = txt })
	end
	table.sort(out, function(a, b) if a.chance ~= b.chance then return a.chance > b.chance end return a.pet < b.pet end)
	return out
end
function S:canHatch(eggId: string)
	local e = self.C.eggsById[eggId]
	if e.zone and not self.zones[e.zone] then return false, "zone" end
	if self:petCount() >= self.cfg.maxPets then return false, "storage" end
	if self:coins() < Content.costOf(e) then return false, "coins" end
	return true, nil
end
-- roll(eggId, r?) -> petId (no cost; r in [0,1) default self.rand())
function S:roll(eggId: string, r: number?): string
	local odds = self:eggOdds(eggId)
	r = r or self.rand()
	for _, o in odds do
		r -= o.chance
		if r < 0 then return o.pet end
	end
	return odds[#odds].pet
end
-- hatch(eggId) -> petId | nil, reason   (pays the egg's in-game coin cost; never real money)
function S:hatch(eggId: string)
	local ok, why = self:canHatch(eggId)
	if not ok then return nil, why end
	local e = self.C.eggsById[eggId]
	self.wallet.spend(self.cur, Content.costOf(e))
	local pid = self:roll(eggId)
	self:givePet(pid)
	local rar = self.C.rarity[self.C.petsById[pid].rarity]
	self.stats.hatched += 1
	self.stats.rarest = math.max(self.stats.rarest, rar.rank)
	self:emit("pet_hatched", { pet = pid, rarity = rar.id, egg = eggId })
	return pid, nil
end
function S:givePet(pid: string, n: number?)
	if not self.C.petsById[pid] then error("simulator: unknown pet " .. tostring(pid), 2) end
	self.pets[pid] = (self.pets[pid] or 0) + (n or 1)
	if self.autoEquipPets then self:equipBest() end
end
function S:petCount(): number local n = 0 for _, c in self.pets do n += c end return n end
function S:slots(): number
	local rb = self.cfg.rebirth
	return math.min(rb.maxSlots, self.cfg.petSlots + math.floor(self.layer.count * rb.slotsPerRebirth))
end
function S:equippedCount(): number local n = 0 for _, c in self.equipped do n += c end return n end
-- petScore(def): ranking used by equipBest (override: s.petScore = function(self, def) ... end)
function S:petScore(def): number
	local b = def.bonus
	return (b.power or 0) + (b.coins or 0) + (b.capacity or 0) * 0.5 + (b.speed or 0) * 0.5 + (b.luck or 0) * 0.25
end
function S:equip(pid: string): boolean
	if (self.pets[pid] or 0) <= (self.equipped[pid] or 0) or self:equippedCount() >= self:slots() then return false end
	self.equipped[pid] = (self.equipped[pid] or 0) + 1
	return true
end
function S:unequip(pid: string): boolean
	if (self.equipped[pid] or 0) <= 0 then return false end
	self.equipped[pid] -= 1
	if self.equipped[pid] == 0 then self.equipped[pid] = nil end
	return true
end
function S:equipBest()
	local list = {}
	for pid, n in self.pets do for _ = 1, n do table.insert(list, pid) end end
	table.sort(list, function(a, b)
		local sa, sb = self:petScore(self.C.petsById[a]), self:petScore(self.C.petsById[b])
		if sa ~= sb then return sa > sb end
		return a < b
	end)
	self.equipped = {}
	for i = 1, math.min(#list, self:slots()) do self.equipped[list[i]] = (self.equipped[list[i]] or 0) + 1 end
end
-- release(pid) -> bool: remove one copy (unequips if needed)
function S:release(pid: string): boolean
	if (self.pets[pid] or 0) <= 0 then return false end
	self.pets[pid] -= 1
	if (self.equipped[pid] or 0) > self.pets[pid] then self:unequip(pid) end
	if self.pets[pid] == 0 then self.pets[pid] = nil end
	return true
end
-- petList() -> { {def, count, equipped, rarity} } sorted rarest first
function S:petList()
	local out = {}
	for pid, n in self.pets do
		local d = self.C.petsById[pid]
		table.insert(out, { def = d, count = n, equipped = self.equipped[pid] or 0, rarity = self.C.rarity[d.rarity] })
	end
	table.sort(out, function(a, b) if a.rarity.rank ~= b.rarity.rank then return a.rarity.rank > b.rarity.rank end return a.def.id < b.def.id end)
	return out
end

-- ---------- rebirth (progression prestige layer "rebirth") ----------
function S:rebirthGain(): number return self.layer:pending(self.runCoins) end
function S:rebirthNext(): number return self.layer:nextAt(self.runCoins) end -- run coins needed for one more
function S:canRebirth(): boolean
	local need = self.cfg.rebirth.zone
	if need and not self.zones[need] then return false end
	return self:rebirthGain() >= 1
end
-- rebirth() -> gain (0 = not allowed). Resets coins, gear, zones, bag; keeps pets, stats, rebirth points.
function S:rebirth(): number
	if not self:canRebirth() then return 0 end
	local g = self.layer:prestige(self.runCoins, function() end)
	if g > 0 then
		self:_resetRun(false)
		self.stats.rebirths = self.layer.count
		if self.autoEquipPets then self:equipBest() end
		self:emit("rebirth", { gain = g, total = self.layer.points, count = self.layer.count })
	end
	return g
end

-- ---------- offline earnings (clock.now) ----------
-- incomeRate(tapsPerSec?) -> coins/s from auto-swing (+ taps) in the current zone, selling as it fills (ignores trips)
function S:incomeRate(taps: number?): number
	local hitsPerSec = self:speed() + (taps or 0)
	if hitsPerSec <= 0 then return 0 end
	local z = self:zoneDef()
	local W, t, v = 0, 0, 0
	local p = self:power()
	for _, n in z.nodes do
		W += n.weight
		t += n.weight * math.ceil(n.hp / p - 1e-9) / hitsPerSec
		v += n.weight * n.reward
	end
	return (v / W) / (t / W) * self:coinMultiplier()
end
-- offline(now?) -> { seconds, coins } (not applied) | nil when too short / no auto tool
function S:offline(now: number?)
	if self.lastSeen == nil then return nil end
	now = now or self:now()
	local o = self.cfg.offline
	local secs = math.min(now - self.lastSeen, o.capHours * 3600)
	if secs < o.minSeconds then return nil end
	local coins = math.floor(self:incomeRate(0) * secs * o.rate)
	if coins <= 0 then return nil end
	return { seconds = secs, coins = coins }
end
-- claimOffline(now?, mult?) -> report | nil (credits coins; mult e.g. 2 for a watched-daily bonus — never paid)
function S:claimOffline(now: number?, mult: number?)
	local r = self:offline(now)
	self.lastSeen = now or self:now()
	if not r then return nil end
	r.coins = math.floor(r.coins * (mult or 1))
	self.wallet.add(self.cur, r.coins)
	self.runCoins += r.coins
	self.stats.coins += r.coins
	self:emit("sim_offline", { coins = r.coins, seconds = r.seconds })
	return r
end
function S:touch(now: number?) self.lastSeen = now or self:now() end

-- ---------- stats / leaderboards (local best) ----------
function S:addPlayTime(dt: number) self.stats.playTime += dt end
-- leaderboard() -> flat numeric stats ready for a future leaderboard service; also updates local bests
function S:leaderboard()
	local st = self.stats
	local row = { coins = st.coins, bestRun = st.bestRun, rebirths = self.layer.count, nodes = st.nodes, hatched = st.hatched,
		pets = self:petCount(), zones = 0, rarest = st.rarest, playTime = math.floor(st.playTime) }
	for _ in self.zones do row.zones += 1 end
	for k, v in row do self.best[k] = math.max(self.best[k] or 0, v) end
	return row
end

-- ---------- save ----------
function S:serialize(now: number?)
	local function keys(set) local out = {} for k in set do table.insert(out, k) end table.sort(out) return out end
	return {
		v = 1, coins = self:coins(), zones = keys(self.zones), zone = self.zone, tools = keys(self.tools), tool = self.tool,
		packs = keys(self.packs), pack = self.pack, load = self.load, carried = self.carried, run = self.runCoins,
		pets = table.clone(self.pets), eq = table.clone(self.equipped), stats = table.clone(self.stats), best = table.clone(self.best),
		layer = if self.headless then self.layer:serialize() else nil, seen = now or self:now(),
	}
end
function S:deserialize(t)
	self:_resetRun(true)
	self.pets, self.equipped, self.best = {}, {}, {}
	self.stats = { coins = 0, bestRun = 0, nodes = 0, hatched = 0, sold = 0, rebirths = 0, playTime = 0, rarest = 0 }
	self.lastSeen = nil
	if t == nil then self.wallet.set(self.cur, 0) return end
	local C = self.C
	local function set(list, byId) local out = {} for _, id in list or {} do if byId[id] then out[id] = true end end return out end
	self.zones = set(t.zones, C.zonesById)
	self.zones[C.zones[1].id] = true
	self.tools = set(t.tools, C.toolsById)
	self.tools[C.tools[1].id] = true
	self.packs = set(t.packs, C.backpacksById)
	self.packs[C.backpacks[1].id] = true
	self.zone = if self.zones[t.zone] then t.zone else C.zones[1].id
	self.tool = if self.tools[t.tool] then t.tool else C.tools[1].id
	self.pack = if self.packs[t.pack] then t.pack else C.backpacks[1].id
	self.load, self.carried, self.runCoins = t.load or 0, t.carried or 0, t.run or 0
	for pid, n in t.pets or {} do if C.petsById[pid] then self.pets[pid] = n end end
	for pid, n in t.eq or {} do if self.pets[pid] then self.equipped[pid] = math.min(n, self.pets[pid]) end end
	for k, v in t.stats or {} do self.stats[k] = v end
	self.best = t.best or {}
	if t.layer then self.layer:deserialize(t.layer) end
	if t.coins and self.headless then self.wallet.set(self.cur, t.coins) end
	self.lastSeen = t.seen
end

M.Sim = S
return M
