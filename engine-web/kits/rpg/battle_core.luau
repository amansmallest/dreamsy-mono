-- rpg kit: the turn-based battle engine (pure logic, no entities/UI; deterministic given `rng`).
--   local b = Battle.new({ kind = "wild"|"trainer", player = { party = {...} }, enemy = { party = {...},
--                          name = "Ranger Ivy", ai = "smart", items = { tonic = 1 } }, rng = fn, bag = adapter })
--   local events = b:submit({ kind = "move", slot = 1 })    -- or switch/item/run
--   b.over, b.result ("win"|"lose"|"run"|"caught"), b.needSwitch (player must send a replacement)
-- Every event is { t = kind, text = "message"?, side = 1|2, ... } — the UI plays them in order.
local U = require("./util")
local Content = require("./content")
local Creatures = require("./creatures")
local Events = require("./events")

local B = {}
B.__index = B

-- Messages (override any with data/rpg.json "text": { "<key>": "..." }).
B.TEXT = {
	wild_appears = "A wild {foe} appears!",
	trainer_challenges = "{trainer} wants to battle!",
	trainer_sends = "{trainer} sends out {foe}!",
	go = "Go, {mon}!",
	come_back = "{mon}, come back!",
	used = "{user} used {move}!",
	missed = "{user}'s attack missed!",
	strong = "A strong hit!",
	weak = "A weak hit...",
	immune = "It had no effect on {target}.",
	crit = "A critical strike!",
	fainted = "{mon} fainted!",
	xp = "{mon} gained {xp} XP!",
	level = "{mon} grew to level {level}!",
	learned = "{mon} learned {move}!",
	learn_full = "{mon} wants to learn {move}, but already knows 4 moves.",
	win_trainer = "You defeated {trainer}!",
	money = "You got ${money} for winning!",
	lose = "You have no creatures left to fight...",
	run_ok = "You escaped!",
	run_fail = "No escape!",
	run_trainer = "You can't run from a trainer battle!",
	catch_trainer = "You can't catch another trainer's creature!",
	threw = "You threw a {item}!",
	caught = "Caught! {foe} joins your team.",
	broke_free = "Oh no! It broke free!",
	item_used = "{user} used a {item}.",
	healed = "{mon} recovered {amount} HP.",
	cured = "{mon} was cured.",
	revived = "{mon} was revived!",
	no_effect_item = "It won't have any effect.",
	stat_up = "{mon}'s {stat} rose!",
	stat_up2 = "{mon}'s {stat} rose sharply!",
	stat_down = "{mon}'s {stat} fell!",
	stat_down2 = "{mon}'s {stat} harshly fell!",
	stat_max = "{mon}'s {stat} won't go any higher!",
	stat_min = "{mon}'s {stat} won't go any lower!",
	nothing = "But nothing happened.",
	drain = "{target} had its energy drained!",
	recoil = "{mon} is hurt by recoil!",
	no_pp = "{mon} has no energy left and flails!",
	confused_hurt = "{mon} hurt itself in its confusion!",
	dazed = "{mon} is dazed and can't move!",
	held_heal = "{mon} restored a little HP with its {item}.",
	-- status: apply / blocked / end-of-turn / can't act / ends
	burn = "{mon} was burned!",
	burn_tick = "{mon} is hurt by its burn!",
	poison = "{mon} was poisoned!",
	poison_tick = "{mon} is hurt by poison!",
	sleep = "{mon} fell asleep!",
	sleep_act = "{mon} is fast asleep.",
	sleep_end = "{mon} woke up!",
	stun = "{mon} is stunned! It may be unable to move.",
	stun_act = "{mon} is stunned and can't move!",
	freeze = "{mon} was frozen solid!",
	freeze_act = "{mon} is frozen solid!",
	freeze_end = "{mon} thawed out!",
	confuse = "{mon} became confused!",
	confuse_end = "{mon} snapped out of its confusion!",
	already = "{mon} is already affected.",
}
local function T(key: string, vars): string
	local over = Content.config.text
	return U.format((over and over[key]) or B.TEXT[key] or key, vars)
end
B.T = T

B.STATUS = { "burn", "poison", "sleep", "stun", "freeze" }
B.STATUS_LABEL = { burn = "BRN", poison = "PSN", sleep = "SLP", stun = "STN", freeze = "FRZ" }
B.STRUGGLE = { id = "struggle", name = "Flail", type = "none", category = "physical", power = 40, pp = 1, priority = 0, effects = { { type = "recoil", percent = 25 } } }
local CONFUSION_HIT = { id = "confusion", name = "Confusion", type = "none", category = "physical", power = 40, pp = 1, priority = 0, effects = {} }

-- ---------------------------------------------------------------- math (exported for tests / balancing tools)

function B.stageMult(stage: number): number
	if stage >= 0 then return (2 + stage) / 2 end
	return 2 / (2 - stage)
end
function B.accMult(stage: number): number
	if stage >= 0 then return (3 + stage) / 3 end
	return 3 / (3 - stage)
end

local function hasType(mon, t: string): boolean
	return table.find(Creatures.species(mon).types, t) ~= nil
end

-- held item boosts: item "held": { "type": "<type>", "mult": 1.2 }
local function heldMult(mon, move): number
	if not mon.held then return 1 end
	local it = Content.items[mon.held]
	local h = it and it.held
	if h and h.type == move.type then return h.mult or 1.2 end
	return 1
end

-- Damage for `move` from attacker to defender.
-- opts: { rng, crit = bool?, roll = 0.85..1?, atkStage, defStage }  -> damage, effectiveness, crit
function B.damage(attacker, defender, move, opts)
	opts = opts or {}
	local rng = opts.rng or U.defaultRng
	if move.category == "status" or (move.power or 0) <= 0 then return 0, 1, false end
	local physical = move.category ~= "magic"
	local aStat, dStat = if physical then "atk" else "mag", if physical then "def" else "res"
	local crit = opts.crit
	if crit == nil then
		local cs = move.crit_stage or 0
		local chance = if cs <= 0 then 1 / 16 elseif cs == 1 then 1 / 8 else 1 / 2
		crit = rng() < chance
	end
	local as, ds = opts.atkStage or 0, opts.defStage or 0
	if crit then as, ds = math.max(0, as), math.min(0, ds) end
	local A = attacker.stats[aStat] * B.stageMult(as)
	local D = math.max(1, defender.stats[dStat] * B.stageMult(ds))
	local L = attacker.level
	local base = math.floor(math.floor(math.floor(2 * L / 5 + 2) * move.power * A / D) / 50) + 2
	local stab = if move.type ~= "none" and hasType(attacker, move.type) then 1.5 else 1
	local eff = if move.type == "none" then 1 else Content.effectiveness(move.type, Creatures.species(defender).types)
	local roll = opts.roll or ((85 + math.floor(rng() * 16)) / 100)
	local burn = if physical and attacker.status == "burn" then 0.5 else 1
	local dmg = math.floor(base * stab * eff * (if crit then 1.5 else 1) * roll * burn * heldMult(attacker, move))
	if eff > 0 and dmg < 1 then dmg = 1 end
	if eff == 0 then dmg = 0 end
	local hook = Events.hooks.damage
	if hook then
		local d2 = hook(dmg, { attacker = attacker, defender = defender, move = move, effectiveness = eff, crit = crit })
		if type(d2) == "number" then dmg = math.max(0, math.floor(d2)) end
	end
	return dmg, eff, crit
end

-- Catch probability for a capture item of `power` (1 = basic) against `mon`:
--   p = (3·maxHP − 2·HP) / (3·maxHP) × catch_rate/255 × power × status bonus (sleep/freeze 2, other 1.5)
function B.catchChance(mon, power: number?): number
	local sp = Creatures.species(mon)
	local hpF = (3 * mon.maxhp - 2 * mon.hp) / (3 * mon.maxhp)
	local st = if mon.status == "sleep" or mon.status == "freeze" then 2 elseif mon.status then 1.5 else 1
	local p = hpF * (sp.catch_rate / 255) * (power or 1) * st
	local hook = Events.hooks.catchChance
	if hook then
		local p2 = hook(p, { mon = mon, power = power })
		if type(p2) == "number" then p = p2 end
	end
	return math.clamp(p, 0, 1)
end

-- Escape chance (wild): faster always escapes, else 0.25 + 0.5·(yours/theirs) + 0.25 per failed attempt
function B.runChance(mySpd: number, foeSpd: number, attempts: number): number
	if mySpd >= foeSpd then return 1 end
	return math.clamp(0.25 + 0.5 * (mySpd / math.max(1, foeSpd)) + 0.25 * attempts, 0, 1)
end

-- ---------------------------------------------------------------- construction

local function newBattler()
	return { stages = { atk = 0, def = 0, mag = 0, res = 0, spd = 0, acc = 0, eva = 0 }, confuse = 0, dazed = false, fainted = false }
end

local function newSide(index: number, def)
	def = def or {}
	local s = {
		index = index,
		name = def.name,
		party = def.party or {},
		active = 1,
		ai = def.ai or (if index == 2 then "random" else nil),
		items = U.deepcopy(def.items or {}),
		b = newBattler(),
	}
	for i, m in s.party do
		if m.hp > 0 then s.active = i break end
	end
	for _, m in s.party do if not m.stats then Creatures.refresh(m) end end
	return s
end

function B.new(opts)
	local self = setmetatable({}, B)
	self.kind = opts.kind or "wild"
	self.rng = opts.rng or U.defaultRng
	self.bag = opts.bag
	self.trainer = opts.trainer
	self.sides = { newSide(1, opts.player), newSide(2, opts.enemy) }
	self.sides[2].name = self.sides[2].name or (self.trainer and self.trainer.name)
	self.turn = 0
	self.over = false
	self.result = nil
	self.runAttempts = 0
	self.needSwitch = false
	self.canRun = self.kind == "wild" and opts.canRun ~= false
	self.canCatch = self.kind == "wild" and opts.canCatch ~= false
	self.participants = { [self.sides[1].active] = true }
	self.leveled = {}
	self.pendingLearn = {}
	self.moneyWon = 0
	self.caught = nil
	self.events = {}
	return self
end

function B:active(side: number)
	local s = self.sides[side]
	return s.party[s.active]
end

-- display name: "Sproutle" (yours), "Wild Sproutle", "Foe Sproutle"
function B:monName(side: number, mon): string
	mon = mon or self:active(side)
	local n = Creatures.name(mon)
	if side == 2 then
		local pre = Content.config.text and Content.config.text[if self.kind == "wild" then "wild_prefix" else "foe_prefix"]
		return (pre or (if self.kind == "wild" then "Wild " else "Foe ")) .. n
	end
	return n
end

function B:emit(ev)
	table.insert(self.events, ev)
	return ev
end
function B:say(key: string, vars, extra)
	local ev = extra or {}
	ev.t = ev.t or "text"
	ev.text = T(key, vars)
	return self:emit(ev)
end

-- opening messages (call once before the first submit; the UI shows them)
function B:intro()
	self.events = {}
	local foe = self:monName(2)
	if self.kind == "trainer" then
		self:say("trainer_challenges", { trainer = self.sides[2].name })
		self:say("trainer_sends", { trainer = self.sides[2].name, foe = Creatures.name(self:active(2)) }, { t = "send", side = 2 })
	else
		self:say("wild_appears", { foe = Creatures.name(self:active(2)) }, { t = "send", side = 2 })
	end
	self:say("go", { mon = self:monName(1) }, { t = "send", side = 1 })
	Events.battleStarted:fire(self)
	return self.events
end

-- ---------------------------------------------------------------- helpers

function B:speed(side: number): number
	local mon = self:active(side)
	local s = self.sides[side]
	local v = mon.stats.spd * B.stageMult(s.b.stages.spd)
	if mon.status == "stun" then v *= 0.5 end
	return v
end

function B:aliveCount(side: number): number
	local n = 0
	for _, m in self.sides[side].party do if m.hp > 0 then n += 1 end end
	return n
end

function B:usableMoves(side: number)
	local out = {}
	for i, mv in self:active(side).moves do
		if mv.pp > 0 then table.insert(out, i) end
	end
	return out
end

local function moveDef(id)
	return Content.moves[id] or B.STRUGGLE
end

-- ---------------------------------------------------------------- status

local function statusDef(name)
	return Events.hooks.status[name]
end

function B:applyStatus(side: number, status: string, src)
	local s = self.sides[side]
	local mon = self:active(side)
	if mon.hp <= 0 then return false end
	if status == "confuse" then
		if s.b.confuse > 0 then return false end
		s.b.confuse = U.randInt(self.rng, 2, 4)
		self:say("confuse", { mon = self:monName(side) }, { t = "status", side = side, status = "confuse" })
		return true
	end
	if status == "daze" then
		s.b.dazed = true
		return true
	end
	if mon.status then return false end
	for _, t in Creatures.species(mon).types do
		local td = Content.types[t]
		if td and td.immune_status and table.find(td.immune_status, status) then return false end
	end
	mon.status = status
	if status == "sleep" then mon.sleep = U.randInt(self.rng, 1, 3) end
	local custom = statusDef(status)
	local key = if custom and custom.text then nil else status
	local ev = { t = "status", side = side, status = status }
	if key then self:say(key, { mon = self:monName(side) }, ev) else ev.text = U.format(custom.text, { mon = self:monName(side) }) self:emit(ev) end
	return true
end

-- returns true if the active creature on `side` may act this turn (emits the reason when not)
function B:canAct(side: number): boolean
	local s = self.sides[side]
	local mon = self:active(side)
	local name = self:monName(side)
	if s.b.dazed then
		s.b.dazed = false
		self:say("dazed", { mon = name })
		return false
	end
	local st = mon.status
	if st == "sleep" then
		mon.sleep = (mon.sleep or 1) - 1
		if mon.sleep <= 0 then
			mon.status, mon.sleep = nil, nil
			self:say("sleep_end", { mon = name }, { t = "cure", side = side })
		else
			self:say("sleep_act", { mon = name }, { t = "status_act", side = side, status = "sleep" })
			return false
		end
	elseif st == "freeze" then
		if self.rng() < 0.2 then
			mon.status = nil
			self:say("freeze_end", { mon = name }, { t = "cure", side = side })
		else
			self:say("freeze_act", { mon = name }, { t = "status_act", side = side, status = "freeze" })
			return false
		end
	elseif st == "stun" then
		if self.rng() < 0.25 then
			self:say("stun_act", { mon = name }, { t = "status_act", side = side, status = "stun" })
			return false
		end
	elseif st then
		local custom = statusDef(st)
		if custom and custom.canAct then
			local ok, msg = custom.canAct(mon, self, side)
			if not ok then
				self:emit({ t = "status_act", side = side, status = st, text = msg and U.format(msg, { mon = name }) or nil })
				return false
			end
		end
	end
	if s.b.confuse > 0 then
		s.b.confuse -= 1
		if s.b.confuse == 0 then
			self:say("confuse_end", { mon = name })
		elseif self.rng() < 1 / 3 then
			local dmg = B.damage(mon, mon, CONFUSION_HIT, { rng = self.rng, crit = false, atkStage = s.b.stages.atk, defStage = s.b.stages.def })
			self:say("confused_hurt", { mon = name })
			self:hurt(side, dmg, 1, false)
			return false
		end
	end
	return true
end

function B:hurt(side: number, amount: number, eff: number?, crit: boolean?)
	local mon = self:active(side)
	local before = mon.hp
	mon.hp = math.max(0, mon.hp - amount)
	self:emit({ t = "damage", side = side, amount = before - mon.hp, hp = mon.hp, maxhp = mon.maxhp, eff = eff or 1, crit = crit })
end

function B:heal(side: number, amount: number)
	local mon = self:active(side)
	local before = mon.hp
	mon.hp = math.min(mon.maxhp, mon.hp + math.max(0, math.floor(amount)))
	if mon.hp > before then self:emit({ t = "heal", side = side, amount = mon.hp - before, hp = mon.hp, maxhp = mon.maxhp }) end
	return mon.hp - before
end

function B:changeStage(side: number, stat: string, stages: number)
	local s = self.sides[side]
	local cur = s.b.stages[stat]
	if cur == nil then return end
	local name, label = self:monName(side), (Content.STAT_NAMES[stat] or stat)
	local nxt = math.clamp(cur + stages, -6, 6)
	if nxt == cur then
		self:say(if stages > 0 then "stat_max" else "stat_min", { mon = name, stat = label })
		return
	end
	s.b.stages[stat] = nxt
	local key = if stages > 0 then (if stages >= 2 then "stat_up2" else "stat_up") else (if stages <= -2 then "stat_down2" else "stat_down")
	self:say(key, { mon = name, stat = label }, { t = "stat", side = side, stat = stat, stages = stages })
end

-- ---------------------------------------------------------------- actions

function B:useMove(side: number, slot: number)
	local s = self.sides[side]
	local foeSide = 3 - side
	local mon = self:active(side)
	local mv = mon.moves[slot]
	local def
	if mv and mv.pp > 0 then
		def = moveDef(mv.id)
	else
		def = B.STRUGGLE
		if #self:usableMoves(side) == 0 then self:say("no_pp", { mon = self:monName(side) }) end
	end
	if not self:canAct(side) then return end
	if mon.hp <= 0 then return end
	if mv and def ~= B.STRUGGLE then mv.pp -= 1 end
	self:say("used", { user = self:monName(side), move = def.name }, { t = "move", side = side, move = def.id, moveType = def.type, category = def.category })

	local targetSide = if def.target == "self" then side else foeSide
	local target = self:active(targetSide)
	if targetSide ~= side and target.hp <= 0 then
		self:say("nothing")
		return
	end
	-- accuracy
	if targetSide ~= side and def.accuracy ~= nil and def.accuracy ~= true then
		local stage = math.clamp(s.b.stages.acc - self.sides[targetSide].b.stages.eva, -6, 6)
		local p = (def.accuracy / 100) * B.accMult(stage)
		if self.rng() >= p then
			self:say("missed", { user = self:monName(side) }, { t = "miss", side = side })
			return
		end
	end
	-- damage
	local dealt = 0
	local didSomething = false
	if def.category ~= "status" and (def.power or 0) > 0 then
		local hits = 1
		if type(def.hits) == "number" then hits = def.hits
		elseif type(def.hits) == "table" then hits = U.randInt(self.rng, def.hits[1], def.hits[2]) end
		local eff = 1
		for h = 1, hits do
			if target.hp <= 0 then break end
			local dmg, e, crit = B.damage(mon, target, def, {
				rng = self.rng,
				atkStage = s.b.stages[if def.category == "magic" then "mag" else "atk"],
				defStage = self.sides[targetSide].b.stages[if def.category == "magic" then "res" else "def"],
			})
			eff = e
			if e == 0 then break end
			self:hurt(targetSide, dmg, e, crit)
			dealt += dmg
			if crit then self:say("crit") end
		end
		if eff == 0 then
			self:say("immune", { target = self:monName(targetSide) })
			return
		elseif eff > 1 then self:say("strong", nil, { t = "eff", eff = eff })
		elseif eff < 1 then self:say("weak", nil, { t = "eff", eff = eff }) end
		didSomething = true
	end
	-- effects
	for _, e in def.effects do
		local chance = e.chance or 100
		if chance >= 100 or self.rng() * 100 < chance then
			if self:applyMoveEffect(side, targetSide, def, e, dealt) then didSomething = true end
		end
	end
	if not didSomething and def.category == "status" then self:say("nothing") end
end

function B:applyMoveEffect(side: number, targetSide: number, move, e, dealt: number): boolean
	local typ = e.type
	local who = function(default: string): number
		local t = e.target or default
		if t == "self" then return side end
		return 3 - side
	end
	if typ == "status" then
		local ts = who("enemy")
		if self:active(ts).hp <= 0 then return false end
		local ok = self:applyStatus(ts, e.status, side)
		if not ok and move.category == "status" then self:say("already", { mon = self:monName(ts) }) return true end
		return ok
	elseif typ == "stat" then
		local ts = who(if (e.stages or 0) > 0 then "self" else "enemy")
		if self:active(ts).hp <= 0 then return false end
		self:changeStage(ts, e.stat, e.stages or 1)
		return true
	elseif typ == "heal" then
		local ts = who("self")
		local mon = self:active(ts)
		local n = self:heal(ts, mon.maxhp * (e.percent or 50) / 100)
		if n > 0 then self:say("healed", { mon = self:monName(ts), amount = n }) end
		return n > 0
	elseif typ == "drain" then
		if dealt <= 0 then return false end
		local n = self:heal(side, math.max(1, dealt * (e.percent or 50) / 100))
		if n > 0 then self:say("drain", { target = self:monName(3 - side) }) end
		return true
	elseif typ == "recoil" then
		if dealt <= 0 then return false end
		self:say("recoil", { mon = self:monName(side) })
		self:hurt(side, math.max(1, math.floor(dealt * (e.percent or 25) / 100)))
		return true
	elseif typ == "cure" then
		local ts = who("self")
		local mon = self:active(ts)
		if mon.status then
			mon.status, mon.sleep = nil, nil
			self:say("cured", { mon = self:monName(ts) }, { t = "cure", side = ts })
			return true
		end
		return false
	elseif typ == "daze" then
		-- target skips its action this turn if it hasn't acted yet (only meaningful when faster)
		local ts = who("enemy")
		if self.acted and not self.acted[ts] then self.sides[ts].b.dazed = true end
		return true
	elseif typ == "custom" then
		local fn = Events.hooks.moveEffect[e.id or ""]
		if not fn then
			print("[rpg] move " .. move.id .. ": no hooks.moveEffect[\"" .. tostring(e.id) .. "\"]")
			return false
		end
		local r = fn({
			battle = self, side = side, targetSide = targetSide, user = self:active(side), target = self:active(targetSide),
			move = move, effect = e, damage = dealt, rng = self.rng,
			emit = function(ev) return self:emit(ev) end,
			say = function(text) return self:emit({ t = "text", text = text }) end,
		})
		return r ~= false
	end
	return false
end

-- item from the player's bag (side 1) or a trainer's items (side 2). target = party slot.
function B:useItem(side: number, itemId: string, targetSlot: number?): boolean
	local s = self.sides[side]
	local it = Content.items[itemId]
	if not it then return false end
	local user = if side == 1 then (Content.config.player_name or "You") else (s.name or "Foe")
	local mon = s.party[targetSlot or s.active]
	if not mon then return false end
	local name = if (targetSlot or s.active) == s.active then self:monName(side, mon) else Creatures.name(mon)
	local function consume()
		if side == 1 then
			if self.bag then self.bag.take(itemId) end
		else
			s.items[itemId] = (s.items[itemId] or 1) - 1
		end
		Events.itemUsed:fire(itemId, mon)
	end
	if it.kind == "capture" then
		return self:throwCapture(itemId, it)
	end
	local effective = false
	if it.revive then
		if mon.hp <= 0 then effective = true end
	elseif mon.hp > 0 then
		if (it.heal or it.heal_percent) and mon.hp < mon.maxhp then effective = true end
		if it.cure and mon.status and (it.cure == true or table.find(it.cure, mon.status)) then effective = true end
		if it.boost and (targetSlot or s.active) == s.active then effective = true end
	end
	if not effective then
		if side == 1 then self:say("no_effect_item") end
		return false
	end
	consume()
	self:say("item_used", { user = user, item = it.name }, { t = "item", side = side, item = itemId })
	if it.revive then
		mon.hp = math.max(1, math.floor(mon.maxhp * it.revive / 100))
		mon.status = nil
		self:say("revived", { mon = name }, { t = "revive", side = side, slot = targetSlot })
		return true
	end
	local isActive = (targetSlot or s.active) == s.active
	if it.heal or it.heal_percent then
		local amt = (it.heal or 0) + mon.maxhp * (it.heal_percent or 0) / 100
		local before = mon.hp
		if isActive then self:heal(side, amt) else mon.hp = math.min(mon.maxhp, mon.hp + math.floor(amt)) end
		if mon.hp > before then self:say("healed", { mon = name, amount = mon.hp - before }) end
	end
	if it.cure and mon.status and (it.cure == true or table.find(it.cure, mon.status)) then
		mon.status, mon.sleep = nil, nil
		self:say("cured", { mon = name }, { t = "cure", side = side })
	end
	if it.boost and isActive then self:changeStage(side, it.boost.stat, it.boost.stages or 1) end
	return true
end

function B:throwCapture(itemId: string, it)
	if not self.canCatch then
		self:say("catch_trainer")
		return false
	end
	if self.bag then self.bag.take(itemId) end
	Events.itemUsed:fire(itemId, nil)
	local foe = self:active(2)
	self:say("threw", { item = it.name }, { t = "throw", item = itemId })
	local p = B.catchChance(foe, it.power or 1)
	local q = p ^ (1 / 3)
	local shakes = 0
	for _ = 1, 3 do
		if p >= 1 or self.rng() < q then shakes += 1 else break end
	end
	if shakes == 3 then
		self:say("caught", { foe = Creatures.name(foe) }, { t = "catch", shakes = 3, success = true })
		self.caught = foe
		self:finish("caught")
	else
		self:say("broke_free", nil, { t = "catch", shakes = shakes, success = false })
	end
	return true
end

function B:switchTo(side: number, slot: number, forced: boolean?)
	local s = self.sides[side]
	if not forced and s.party[s.active] and s.party[s.active].hp > 0 and side == 1 then
		self:say("come_back", { mon = self:monName(side) }, { t = "recall", side = side })
	end
	s.active = slot
	s.b = newBattler()
	if side == 1 then
		self.participants[slot] = true
		self:say("go", { mon = self:monName(1) }, { t = "send", side = 1, slot = slot })
	else
		self:say("trainer_sends", { trainer = s.name or "Foe", foe = Creatures.name(self:active(2)) }, { t = "send", side = 2, slot = slot })
		self.participants = { [self.sides[1].active] = true }
	end
end

function B:tryRun()
	if not self.canRun then
		self:say("run_trainer")
		return
	end
	local p = B.runChance(self:speed(1), self:speed(2), self.runAttempts)
	self.runAttempts += 1
	if self.rng() < p then
		self:say("run_ok", nil, { t = "run", success = true })
		self:finish("run")
	else
		self:say("run_fail", nil, { t = "run", success = false })
	end
end

-- ---------------------------------------------------------------- AI

-- expected value of a move for the AI (higher = better)
function B:scoreMove(side: number, slot: number): number
	local mon = self:active(side)
	local foe = self:active(3 - side)
	local mv = mon.moves[slot]
	local def = moveDef(mv.id)
	local acc = if def.accuracy == nil or def.accuracy == true then 1 else def.accuracy / 100
	if def.category ~= "status" and def.power > 0 then
		local eff = Content.effectiveness(def.type, Creatures.species(foe).types)
		local stab = if hasType(mon, def.type) then 1.5 else 1
		local physical = def.category ~= "magic"
		local ratio = mon.stats[if physical then "atk" else "mag"] / math.max(1, foe.stats[if physical then "def" else "res"])
		local hits = if type(def.hits) == "number" then def.hits elseif type(def.hits) == "table" then (def.hits[1] + def.hits[2]) / 2 else 1
		local score = def.power * hits * eff * stab * ratio * acc
		-- finishing blow bonus
		local est = (math.floor(2 * mon.level / 5 + 2) * def.power * ratio / 50 + 2) * eff * stab * hits
		if est >= foe.hp then score *= 1.5 end
		return score
	end
	local score = 0
	for _, e in def.effects do
		if e.type == "status" then
			local tgt = if e.target == "self" then mon else foe
			if not tgt.status and e.status ~= "confuse" then score += 70 * acc
			elseif e.status == "confuse" and self.sides[3 - side].b.confuse == 0 then score += 45 * acc end
		elseif e.type == "stat" then
			local ts = if (e.target or (if (e.stages or 0) > 0 then "self" else "enemy")) == "self" then side else 3 - side
			local cur = self.sides[ts].b.stages[e.stat] or 0
			if (e.stages or 0) > 0 and cur < 2 then score += 35
			elseif (e.stages or 0) < 0 and cur > -2 then score += 30 * acc end
		elseif e.type == "heal" then
			if mon.hp < mon.maxhp * 0.5 then score += 90 else score += 5 end
		else
			score += 20
		end
	end
	return score
end

function B:aiAction(side: number)
	local s = self.sides[side]
	local name = s.ai or "random"
	local custom = Events.hooks.ai[name]
	if custom then
		local a = custom(self, side)
		if a then return a end
	end
	local mon = self:active(side)
	-- smart trainers heal when low
	if name == "smart" and mon.hp < mon.maxhp * 0.25 then
		for id, n in s.items do
			local it = Content.items[id]
			if n > 0 and it and (it.heal or it.heal_percent) and self.rng() < 0.6 then
				return { kind = "item", item = id }
			end
		end
	end
	local usable = self:usableMoves(side)
	if #usable == 0 then return { kind = "move", slot = 0 } end
	if name == "random" then
		return { kind = "move", slot = usable[1 + math.floor(self.rng() * #usable)] }
	end
	-- smart: best score, 10% chance to pick the runner-up
	local scored = {}
	for _, i in usable do table.insert(scored, { slot = i, score = self:scoreMove(side, i) }) end
	table.sort(scored, function(a, b)
		if a.score ~= b.score then return a.score > b.score end
		return a.slot < b.slot
	end)
	local pick = scored[1]
	if #scored > 1 and scored[2].score > 0 and self.rng() < 0.1 then pick = scored[2] end
	return { kind = "move", slot = pick.slot }
end

-- next creature a trainer sends (smart: best type matchup)
function B:aiNext(side: number): number?
	local s = self.sides[side]
	local best, bestScore = nil, -math.huge
	local foe = self:active(3 - side)
	for i, m in s.party do
		if m.hp > 0 then
			local score = -i * 0.01
			if s.ai == "smart" and foe then
				for _, mv in m.moves do
					local d = Content.moves[mv.id]
					if d and d.power > 0 then score = math.max(score, Content.effectiveness(d.type, Creatures.species(foe).types) - i * 0.01) end
				end
			end
			if best == nil or score > bestScore then best, bestScore = i, score end
		end
	end
	return best
end

-- ---------------------------------------------------------------- turn resolution

function B:finish(result: string)
	if self.over then return end
	self.over = true
	self.result = result
	self:emit({ t = "end", result = result })
end

function B:awardXp(foe)
	local list = {}
	for slot in self.participants do
		local m = self.sides[1].party[slot]
		if m and m.hp > 0 then table.insert(list, slot) end
	end
	table.sort(list)
	if #list == 0 then return end
	local total = Creatures.xpYield(foe, self.kind == "trainer")
	local share = math.max(1, math.floor(total / #list))
	for _, slot in list do
		local m = self.sides[1].party[slot]
		if m.level < Creatures.MAX_LEVEL then
			self:say("xp", { mon = Creatures.name(m), xp = share }, { t = "xp", slot = slot, amount = share })
			local steps = Creatures.gainXp(m, share)
			for _, st in steps do
				self.leveled[m] = true
				self:say("level", { mon = Creatures.name(m), level = st.level }, { t = "level", slot = slot, level = st.level })
				Events.levelUp:fire(m, st.level)
				for _, mv in st.learned do self:say("learned", { mon = Creatures.name(m), move = moveDef(mv).name }, { t = "learn", slot = slot, move = mv }) end
				for _, mv in st.pending do
					self:say("learn_full", { mon = Creatures.name(m), move = moveDef(mv).name }, { t = "learn_full", slot = slot, move = mv })
					table.insert(self.pendingLearn, { mon = m, move = mv })
				end
			end
			if #steps == 0 then self:emit({ t = "xp_bar", slot = slot }) end
		end
	end
end

function B:checkFaints()
	if self.over then return end
	-- enemy first (so XP lands before a double knockout ends the battle)
	local foeS = self.sides[2]
	local foe = self:active(2)
	if foe.hp <= 0 and not foeS.b.fainted then
		foeS.b.fainted = true
		self:say("fainted", { mon = self:monName(2) }, { t = "faint", side = 2 })
		self:awardXp(foe)
	end
	local me = self:active(1)
	local myS = self.sides[1]
	if me.hp <= 0 and not myS.b.fainted then
		myS.b.fainted = true
		self:say("fainted", { mon = self:monName(1) }, { t = "faint", side = 1 })
	end
	if foeS.b.fainted then
		local nxt = if self.kind == "trainer" then self:aiNext(2) else nil
		if nxt then
			if not myS.b.fainted then self:switchTo(2, nxt, true) else self.pendingEnemySwitch = nxt end
		else
			if self.kind == "trainer" then
				self:say("win_trainer", { trainer = foeS.name or "the trainer" })
				local t = self.trainer or {}
				local maxL = 1
				for _, m in foeS.party do maxL = math.max(maxL, m.level) end
				self.moneyWon = t.reward or (maxL * (t.reward_per_level or 40))
				if self.moneyWon > 0 then self:say("money", { money = self.moneyWon }, { t = "money", amount = self.moneyWon }) end
			end
			self:finish("win")
			return
		end
	end
	if myS.b.fainted then
		if self:aliveCount(1) == 0 then
			self:say("lose", nil, { t = "lose" })
			self:finish("lose")
		else
			self.needSwitch = true
		end
	end
end

function B:endOfTurn()
	for side = 1, 2 do
		if self.over then return end
		local mon = self:active(side)
		if mon.hp > 0 then
			local name = self:monName(side)
			if mon.status == "burn" then
				self:say("burn_tick", { mon = name }, { t = "status_tick", side = side, status = "burn" })
				self:hurt(side, math.max(1, math.floor(mon.maxhp / 16)))
			elseif mon.status == "poison" then
				self:say("poison_tick", { mon = name }, { t = "status_tick", side = side, status = "poison" })
				self:hurt(side, math.max(1, math.floor(mon.maxhp / 8)))
			elseif mon.status then
				local custom = statusDef(mon.status)
				if custom and custom.onTurnEnd then custom.onTurnEnd(mon, self, side) end
			end
			if mon.hp > 0 and mon.held then
				local it = Content.items[mon.held]
				if it and it.held and it.held.heal_percent and mon.hp < mon.maxhp then
					self:heal(side, math.max(1, mon.maxhp * it.held.heal_percent / 100))
					self:say("held_heal", { mon = name, item = it.name })
				end
			end
		end
	end
	self:checkFaints()
end

local RANK = { run = 7, switch = 6, item = 5, catch = 5 }

-- Validates and resolves a full turn. action: { kind = "move", slot } | { kind = "switch", slot } |
-- { kind = "item", item, target? } | { kind = "run" }. Returns the turn's events.
function B:submit(action)
	assert(not self.over, "battle is over")
	self.events = {}
	if self.needSwitch then
		assert(action.kind == "switch", "a replacement must be chosen (kind = \"switch\")")
		local m = self.sides[1].party[action.slot]
		assert(m and m.hp > 0, "can't switch to that creature")
		self.needSwitch = false
		self:switchTo(1, action.slot, true)
		if self.pendingEnemySwitch then
			self:switchTo(2, self.pendingEnemySwitch, true)
			self.pendingEnemySwitch = nil
		end
		return self.events
	end
	if action.kind == "switch" then
		local m = self.sides[1].party[action.slot]
		assert(m and m.hp > 0 and action.slot ~= self.sides[1].active, "can't switch to that creature")
	end
	self.turn += 1
	local acts = { { side = 1, a = action }, { side = 2, a = self:aiAction(2) } }
	local function prio(x)
		local r = RANK[x.a.kind]
		if r then return r * 100 - x.side end
		local mon = self:active(x.side)
		local mv = mon.moves[x.a.slot or 0]
		return (if mv then moveDef(mv.id).priority else 0)
	end
	local p1, p2 = prio(acts[1]), prio(acts[2])
	if p2 > p1 or (p1 == p2 and (self:speed(2) > self:speed(1) or (self:speed(2) == self:speed(1) and self.rng() < 0.5))) then
		acts[1], acts[2] = acts[2], acts[1]
	end
	for _, x in acts do x.mon = self:active(x.side) end
	self.acted = {}
	for _, x in acts do
		if self.over or self.needSwitch then break end
		local a = x.a
		if self:active(x.side) == x.mon and x.mon.hp > 0 then
			if a.kind == "move" then self:useMove(x.side, a.slot)
			elseif a.kind == "switch" then self:switchTo(x.side, a.slot)
			elseif a.kind == "item" then self:useItem(x.side, a.item, a.target)
			elseif a.kind == "run" then self:tryRun()
			end
			self.acted[x.side] = true
			self:checkFaints()
		end
	end
	self.acted = nil
	if not self.over and not self.needSwitch then self:endOfTurn() end
	return self.events
end

-- party creatures that leveled this battle and now meet a level evolution: { { mon, into } }
function B:evolutions(cond)
	local out = {}
	for _, m in self.sides[1].party do
		if self.leveled[m] and m.hp > 0 then
			local into = Creatures.evolutionFor(m, nil, cond)
			if into then table.insert(out, { mon = m, into = into }) end
		end
	end
	return out
end

return B
