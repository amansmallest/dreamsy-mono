--!nonstrict
-- One fight: piles (draw/hand/discard/exhaust), energy, player + enemy turns, statuses, intents, relic triggers.
-- Headless and deterministic per seed (procgen.rng forks: "shuffle", "ai", "fx"). The UI listens via b:on(event, fn).
local procgen = require("@kit/procgen")
local combat = require("@kit/combat")
local E = require("./effects")

local B = {}
B.__index = B

B.HAND_MAX = 10
B.WEAK = 0.75
B.VULNERABLE = 1.5
B.FRAIL = 0.75

-- status defs: debuff (artifact blocks it), decay (−1 at owner's turn end), turnStart/turnEnd = effect lists ($stacks)
B.STATUS = {
	weak = { debuff = true, decay = true, text = "Deals 25% less attack damage." },
	vulnerable = { debuff = true, decay = true, text = "Takes 50% more attack damage." },
	frail = { debuff = true, decay = true, text = "Gains 25% less Block." },
	poison = { debuff = true, text = "Loses HP at turn start, then −1." },
	strength = { text = "+1 attack damage per stack." },
	dexterity = { text = "+1 Block per stack." },
	regen = { text = "Heals at turn end, then −1." },
	thorns = { text = "Attackers take damage." },
	metallicize = { text = "Gain Block at turn end." },
	ritual = { text = "Gain Strength at turn end." },
	artifact = { text = "Negates the next debuff." },
}

local zero = function() return 0 end

local function st(u, name) return (u and u.statuses[name]) or 0 end
B.stacks = st

-- new(opts) opts: { C (content), seed, deck = { {id, up?} }, enemies = { enemyId }, player = { hp, maxHp, energy, draw, name? },
--   relics = { id }, relicState = {} (shared counters), run? (hp/gold/relics synced), statuses? (extra defs) }
function B.new(opts)
	local C = opts.C
	local rng = procgen.rng(opts.seed or 1)
	local b = setmetatable({
		C = C, run = opts.run, seed = opts.seed or 1,
		rng = rng, shuffleRng = rng:fork("shuffle"), aiRng = rng:fork("ai"), fxRng = rng:fork("fx"),
		drawPile = {}, hand = {}, discard = {}, exhausted = {}, powers = {},
		energy = 0, turn = 0, state = "setup", log = {}, listeners = {},
		cardsPlayedTurn = 0, attacksPlayedTurn = 0, cardsPlayed = 0, uid = 0,
		relics = opts.relics or {}, relicState = opts.relicState or {},
		statusDefs = {},
	}, B)
	for k, v in B.STATUS do b.statusDefs[k] = v end
	for k, v in (C.config and C.config.statuses) or {} do b.statusDefs[k] = v end
	for k, v in opts.statuses or {} do b.statusDefs[k] = v end
	local p = opts.player or {}
	b.player = { id = "player", side = "player", name = p.name or "You", hp = p.hp or 70, maxHp = p.maxHp or p.hp or 70, block = 0, statuses = {} }
	-- relic mods
	local mods = { max_energy = 0, draw = 0 }
	for _, rid in b.relics do
		local r = C.relics[rid]
		for k, v in (r and r.mods) or {} do mods[k] = (mods[k] or 0) + v end
	end
	b.maxEnergy = (p.energy or 3) + mods.max_energy
	b.drawCount = (p.draw or 5) + mods.draw
	for _, c in opts.deck or {} do
		b.uid += 1
		table.insert(b.drawPile, { id = c.id, up = c.up == true, uid = b.uid, deckUid = c.uid })
	end
	b.shuffleRng:shuffle(b.drawPile)
	-- innate on top (end of list = top)
	local innate, rest = {}, {}
	for _, c in b.drawPile do if b:def(c).innate then table.insert(innate, c) else table.insert(rest, c) end end
	for _, c in innate do table.insert(rest, c) end
	b.drawPile = rest
	b.enemies = {}
	for i, eid in opts.enemies or {} do b:spawnEnemy(eid) end
	return b
end

function B:def(card) return E.card(self.C, card.id, card.up) end
function B:on(name, fn) self.listeners[name] = self.listeners[name] or {} table.insert(self.listeners[name], fn) end
function B:emit(name, data)
	for _, fn in self.listeners[name] or {} do fn(data) end
	for _, fn in self.listeners["*"] or {} do fn(name, data) end
end

function B:spawnEnemy(eid)
	local d = self.C.enemies[eid]
	if d == nil then error("deckbuilder: unknown enemy '" .. tostring(eid) .. "'", 2) end
	local hp = d.hp or 10
	if type(hp) == "table" then hp = self.aiRng:int(hp[1], hp[2] or hp[1]) end
	local e = { id = "e" .. (#self.enemies + 1), enemyId = eid, def = d, side = "enemy", name = d.name, hp = hp, maxHp = hp, block = 0,
		statuses = {}, history = {}, intent = nil, dead = false, index = #self.enemies + 1 }
	table.insert(self.enemies, e)
	return e
end

function B:alive()
	local out = {}
	for _, e in self.enemies do if not e.dead then table.insert(out, e) end end
	return out
end

-- ---------- relics ----------
local function triggersOf(r)
	if r.triggers then return r.triggers end
	if r.on then return { { on = r.on, effects = r.effects, every = r.every, first = r.first, condition = r.condition, card = r.card } } end
	return {}
end
function B:fireRelics(event, extra)
	for _, rid in self.relics do
		local r = self.C.relics[rid]
		if r then
			for ti, tr in triggersOf(r) do
				if tr.on == event and (tr.card == nil or (extra and extra.cardType == tr.card)) and (not tr.first or self.turn == 1) then
					local fire = true
					if tr.every then
						local key = rid .. "#" .. ti
						self.relicState[key] = (self.relicState[key] or 0) + 1
						fire = self.relicState[key] % tr.every == 0
					end
					local ctx = { b = self, run = self.run, src = self.player, tgt = extra and extra.target, relic = rid }
					if fire and tr.condition then fire = E.check(tr.condition, ctx) end
					if fire then
						self:emit("relic", { relic = rid, event = event })
						E.run(tr.effects, ctx)
					end
				end
			end
		end
	end
end

-- ---------- primitives ----------
function B:calcDamage(src, tgt, base, isAttack)
	local str = if isAttack and src then st(src, "strength") else 0
	local mult = 1
	if isAttack and src and st(src, "weak") > 0 then mult *= B.WEAK end
	if isAttack and tgt and st(tgt, "vulnerable") > 0 then mult *= B.VULNERABLE end
	local amount = combat.formula.damage({ style = "subtract", attack = base + str, power = 1, defense = 1, typeMult = mult,
		variance = 0, crit = false, min = 0, rand = zero })
	return amount
end

function B:checkEnd()
	if self.state == "won" or self.state == "lost" then return true end
	if self.player.hp <= 0 then
		self.state = "lost"
		self:emit("lost", {})
		return true
	end
	if #self:alive() == 0 then
		self.state = "won"
		self:fireRelics("battle_end")
		self:emit("won", {})
		return true
	end
	return false
end

-- hp loss after block (amount already computed)
function B:hurt(src, tgt, amount, opts)
	if tgt.dead or amount <= 0 then
		if not tgt.dead then self:emit("damage", { src = src, tgt = tgt, amount = 0, blocked = 0 }) end
		return 0
	end
	local blocked = 0
	if not (opts and opts.ignoreBlock) then
		blocked = math.min(tgt.block, amount)
		tgt.block -= blocked
	end
	local lost = math.min(tgt.hp, amount - blocked)
	tgt.hp -= lost
	self:emit("damage", { src = src, tgt = tgt, amount = lost, blocked = blocked, attack = opts and opts.attack })
	if tgt == self.player and lost > 0 and not self._inHpLost then
		self._inHpLost = true
		self:fireRelics("hp_lost")
		self._inHpLost = false
	end
	if tgt.hp <= 0 and tgt.side == "enemy" and not tgt.dead then
		tgt.dead = true
		self:emit("enemy_killed", { enemy = tgt })
		if self.run and self.run.onEnemyKilled then self.run:onEnemyKilled(tgt) end
		self:fireRelics("enemy_killed", { target = tgt })
	end
	return lost
end

function B:attack(src, tgt, base, ctx)
	local isAttack = not (ctx and ctx.relic)
	local amount = self:calcDamage(src, tgt, base, isAttack)
	local lost = self:hurt(src, tgt, amount, { attack = true })
	if tgt.dead then ctx.killed = true end
	local th = st(tgt, "thorns")
	if th > 0 and src and src ~= tgt and not src.dead and isAttack then self:hurt(tgt, src, th, {}) end
	return lost
end

function B:gainBlock(u, n, fromCard)
	if fromCard then
		n += st(u, "dexterity")
		if st(u, "frail") > 0 then n = math.floor(n * B.FRAIL) end
	end
	n = math.max(0, n)
	u.block += n
	self:emit("block", { unit = u, amount = n })
	return n
end

function B:applyStatus(u, name, n, src)
	if u.dead or n == 0 then return false end
	local def = self.statusDefs[name]
	if def == nil then error("deckbuilder: unknown status '" .. tostring(name) .. "' (define it in data/deckbuilder.json statuses)", 2) end
	if def.debuff and n > 0 and st(u, "artifact") > 0 then
		u.statuses.artifact -= 1
		if u.statuses.artifact <= 0 then u.statuses.artifact = nil end
		self:emit("status", { unit = u, status = "artifact", amount = -1, negated = name })
		return false
	end
	local v = (u.statuses[name] or 0) + n
	if v == 0 or (v < 0 and name ~= "strength" and name ~= "dexterity") then u.statuses[name] = nil else u.statuses[name] = v end
	self:emit("status", { unit = u, status = name, amount = n })
	return true
end

function B:heal(u, n)
	local h = math.min(n, u.maxHp - u.hp)
	if h > 0 then u.hp += h self:emit("heal", { unit = u, amount = h }) end
	return h
end

function B:newCard(id, up)
	if self.C.cards[id] == nil then error("deckbuilder: unknown card '" .. tostring(id) .. "'", 2) end
	self.uid += 1
	return { id = id, up = up == true, uid = self.uid }
end

function B:reshuffle()
	if #self.discard == 0 then return false end
	for _, c in self.discard do table.insert(self.drawPile, c) end
	self.discard = {}
	self.shuffleRng:shuffle(self.drawPile)
	self:emit("shuffle", {})
	self:fireRelics("shuffle")
	return true
end

function B:draw(n)
	local drawn = 0
	for _ = 1, n do
		if #self.drawPile == 0 and not self:reshuffle() then break end
		local c = table.remove(self.drawPile)
		if #self.hand >= B.HAND_MAX then table.insert(self.discard, c) else table.insert(self.hand, c) drawn += 1 end
	end
	if drawn > 0 then self:emit("draw", { n = drawn }) end
	return drawn
end

local function resolve(b, ctx, spec)
	local src = ctx.src or b.player
	local hostile = if src.side == "player" then b:alive() else { b.player }
	if spec == "self" then return { src } end
	if spec == "all" then return hostile end
	if spec == "allies" then return if src.side == "player" then { b.player } else b:alive() end
	if spec == "random" then
		local t = b.fxRng:pick(hostile)
		return if t then { t } else {}
	end
	-- target
	local t = ctx.tgt
	if t and not t.dead and t.side ~= src.side then return { t } end
	if t and not t.dead and src.side == "player" and t == b.player then return { t } end
	if src.side == "player" then
		local r = b.fxRng:pick(hostile)
		return if r then { r } else {}
	end
	return hostile
end
B.resolve = resolve

-- battle verbs for the effect language
B.ops = {
	damage = function(b, eff, n, ctx)
		local hits = if eff.hits then E.num(ctx, eff.hits) else 1
		for _ = 1, hits do
			for _, t in resolve(b, ctx, eff.target or "target") do
				if not t.dead then b:attack(ctx.src or b.player, t, n, ctx) end
			end
			if b:checkEnd() then return end
		end
	end,
	block = function(b, eff, n, ctx)
		for _, u in resolve(b, ctx, if eff.target == "allies" then "allies" else "self") do b:gainBlock(u, n, true) end
	end,
	draw = function(b, eff, n) b:draw(n) end,
	energy = function(b, eff, n) b.energy += n b:emit("energy", { energy = b.energy }) end,
	heal = function(b, eff, n, ctx)
		for _, u in resolve(b, ctx, if eff.target == "allies" then "allies" else "self") do b:heal(u, n) end
	end,
	lose_hp = function(b, eff, n, ctx)
		for _, u in resolve(b, ctx, eff.target or "self") do b:hurt(nil, u, n, { ignoreBlock = true }) end
		b:checkEnd()
	end,
	max_hp = function(b, eff, n, ctx)
		local u = ctx.src or b.player
		u.maxHp += n
		u.hp += n
		if b.run and u == b.player then b.run.maxHp += n end
	end,
	apply = function(b, eff, n, ctx)
		for _, u in resolve(b, ctx, eff.target or "target") do b:applyStatus(u, eff.status, n, ctx.src) end
	end,
	remove = function(b, eff, n, ctx)
		for _, u in resolve(b, ctx, eff.target or "self") do
			if u.statuses[eff.status] then u.statuses[eff.status] = nil b:emit("status", { unit = u, status = eff.status, amount = 0 }) end
		end
	end,
	double = function(b, eff, n, ctx)
		for _, u in resolve(b, ctx, eff.target or "target") do
			local v = st(u, eff.status)
			if v ~= 0 then b:applyStatus(u, eff.status, v, ctx.src) end
		end
	end,
	discard = function(b, eff, n, ctx)
		for _ = 1, n do
			if #b.hand == 0 then break end
			local c = table.remove(b.hand, b.fxRng:int(1, #b.hand))
			table.insert(b.discard, c)
			b:emit("discard", { card = c })
		end
	end,
	exhaust = function(b, eff, n, ctx)
		for _ = 1, n do
			if #b.hand == 0 then break end
			local c = table.remove(b.hand, b.fxRng:int(1, #b.hand))
			table.insert(b.exhausted, c)
			b:emit("exhaust", { card = c })
		end
	end,
	add = function(b, eff, n, ctx)
		for _ = 1, n do
			local c = b:newCard(eff.card)
			if eff.pile == "hand" then
				if #b.hand < B.HAND_MAX then table.insert(b.hand, c) else table.insert(b.discard, c) end
			elseif eff.pile == "draw" then table.insert(b.drawPile, b.fxRng:int(1, #b.drawPile + 1), c)
			elseif eff.pile == "deck" then
				table.insert(b.discard, c)
				if b.run then b.run:addCard(eff.card) end
			else table.insert(b.discard, c) end
		end
		b:emit("add", { card = eff.card, pile = eff.pile, n = n })
	end,
	upgrade = function(b, eff, n, ctx)
		local can = {}
		for _, c in b.hand do if E.canUpgrade(b.C, c.id, c.up) then table.insert(can, c) end end
		if eff.which == "hand" then for _, c in can do c.up = true end
		elseif #can > 0 then b.fxRng:pick(can).up = true end
		b:emit("upgrade", {})
	end,
	gold = function(b, eff, n, ctx)
		if b.run then b.run.gold += n end
		b.goldGained = (b.goldGained or 0) + n
	end,
}

-- ---------- statuses on turn boundaries ----------
local function statusPhase(b, u, phase)
	if u.dead then return end
	-- built-ins
	if phase == "start" then
		local p = st(u, "poison")
		if p > 0 then
			b:hurt(nil, u, p, { ignoreBlock = true, poison = true })
			if not u.dead and u.hp > 0 then b:applyStatus(u, "poison", -1) end
		end
	else
		local m = st(u, "metallicize")
		if m > 0 then b:gainBlock(u, m, false) end
		local r = st(u, "regen")
		if r > 0 then b:heal(u, r) b:applyStatus(u, "regen", -1) end
		local rit = st(u, "ritual")
		if rit > 0 and (u.side == "player" or #u.history > 0) then b:applyStatus(u, "strength", rit) end
	end
	-- custom statuses
	local names = {}
	for name in u.statuses do table.insert(names, name) end
	table.sort(names)
	for _, name in names do
		local def = b.statusDefs[name]
		local fx = def and (if phase == "start" then def.turnStart else def.turnEnd)
		if fx and st(u, name) ~= 0 then
			E.run(fx, { b = b, run = b.run, src = u, tgt = nil, stacks = st(u, name) })
			if b:checkEnd() then return end
		end
	end
	if phase == "end" then
		for _, name in names do
			local def = b.statusDefs[name]
			if def and def.decay and u.statuses[name] then b:applyStatus(u, name, -1) end
		end
	end
end

-- ---------- intents ----------
local function inferKind(move)
	if move.intent then return move.intent end
	local atk, def, buff, debuff = false, false, false, false
	for _, s in move.effects or {} do
		local e = E.parse(s)
		if e.op == "damage" then atk = true
		elseif e.op == "block" then def = true
		elseif e.op == "apply" then if e.target == "self" or e.target == "allies" then buff = true else debuff = true end
		elseif e.op == "add" then debuff = true
		elseif e.op == "heal" then buff = true end
	end
	if atk and def then return "attack_defend" elseif atk and debuff then return "attack_debuff" elseif atk and buff then return "attack_buff"
	elseif atk then return "attack" elseif def then return "defend" elseif debuff then return "debuff" elseif buff then return "buff" end
	return "unknown"
end
B.inferKind = inferKind

function B:chooseMove(e)
	local d = e.def
	local p = d.pattern or {}
	local turnIdx = #e.history + 1
	local moveIds = {}
	for id in d.moves do table.insert(moveIds, id) end
	table.sort(moveIds)
	local pick
	if d.first and turnIdx == 1 then pick = d.first end
	local function runPattern(pt, idx)
		local kind = pt.kind or (if pt.moves then "cycle" elseif pt.weights then "random" else "random")
		if kind == "cycle" then
			local list = pt.moves or moveIds
			return list[((idx - 1) % #list) + 1]
		elseif kind == "sequence" then
			local list = pt.moves or {}
			if idx <= #list then return list[idx] end
			if pt["then"] then return runPattern(pt["then"], idx - #list) end
			return list[#list]
		else
			local weights = pt.weights
			if weights == nil then weights = {} for _, id in moveIds do weights[id] = 1 end end
			local nr = pt.noRepeat or 2
			for _ = 1, 12 do
				local m = self.aiRng:weighted(weights)
				local run = 0
				for i = #e.history, math.max(1, #e.history - nr + 1), -1 do if e.history[i] == m then run += 1 else break end end
				if run < nr then return m end
			end
			return self.aiRng:weighted(weights)
		end
	end
	pick = pick or runPattern(p, if d.first then turnIdx - 1 else turnIdx)
	local move = d.moves[pick]
	if move == nil then error("deckbuilder: enemy '" .. e.enemyId .. "' has no move '" .. tostring(pick) .. "'", 2) end
	e.intent = { move = pick, kind = inferKind(move), name = move.name or pick }
	self:refreshIntent(e)
	self:emit("intent", { enemy = e })
	return e.intent
end

-- intent damage preview (per hit, after strength/weak/vulnerable) + hits
function B:refreshIntent(e)
	local it = e.intent
	if not it then return end
	local move = e.def.moves[it.move]
	it.damage, it.hits = nil, nil
	for _, s in move.effects or {} do
		local eff = E.parse(s)
		if eff.op == "damage" and it.damage == nil then
			local ctx = { b = self, src = e, tgt = self.player }
			it.damage = self:calcDamage(e, self.player, E.num(ctx, eff.n), true)
			it.hits = if eff.hits then E.num(ctx, eff.hits) else 1
		end
	end
end
function B:refreshIntents() for _, e in self:alive() do self:refreshIntent(e) end end

-- total incoming damage this enemy turn (for bots / UI)
function B:incoming()
	local t = 0
	for _, e in self:alive() do if e.intent and e.intent.damage then t += e.intent.damage * (e.intent.hits or 1) end end
	return t
end

-- ---------- flow ----------
function B:start()
	self.state = "player"
	for _, e in self.enemies do
		if e.def.start then E.run(e.def.start, { b = self, run = self.run, src = e, tgt = self.player }) end
	end
	self:fireRelics("battle_start")
	for _, e in self:alive() do self:chooseMove(e) end
	self:emit("battle_start", {})
	self:startTurn()
	return self
end

function B:startTurn()
	if self:checkEnd() then return end
	self.turn += 1
	self.state = "player"
	if self.turn > 1 then self.player.block = 0 end -- battle_start block survives turn 1
	self.cardsPlayedTurn, self.attacksPlayedTurn = 0, 0
	statusPhase(self, self.player, "start")
	if self:checkEnd() then return end
	self.energy = self.maxEnergy + (self.bonusEnergy or 0)
	self.bonusEnergy = 0
	self:draw(self.drawCount)
	self:fireRelics("turn_start")
	self:refreshIntents()
	self:emit("turn_start", { turn = self.turn })
	self:checkEnd()
end

-- cost of a card in hand right now (X → current energy)
function B:costOf(card)
	local d = self:def(card)
	if d.cost == "X" then return self.energy, true end
	return card.cost or d.cost, false
end

function B:canPlay(i)
	if self.state ~= "player" then return false, "not your turn" end
	local c = self.hand[i]
	if c == nil then return false, "no card" end
	local d = self:def(c)
	if d.unplayable or d.cost == -1 or d.type == "curse" or (d.type == "status" and not d.playable) then return false, "unplayable" end
	local cost = self:costOf(c)
	if cost > self.energy then return false, "energy" end
	if d.condition and not E.check(d.condition, { b = self, run = self.run, src = self.player }) then return false, "condition" end
	return true
end

-- play(handIndex, target? (enemy index or unit)) -> ok, reason
function B:play(i, target)
	local ok, why = self:canPlay(i)
	if not ok then return false, why end
	local c = self.hand[i]
	local d = self:def(c)
	local tgt = target
	if type(target) == "number" then tgt = self.enemies[target] end
	if d.target == "enemy" and (tgt == nil or tgt.dead) then tgt = self:alive()[1] end
	local cost, isX = self:costOf(c)
	self.energy -= cost
	table.remove(self.hand, i)
	self.cardsPlayedTurn += 1
	self.cardsPlayed += 1
	if d.type == "attack" then self.attacksPlayedTurn += 1 end
	self:emit("card_played", { card = c, def = d, target = tgt })
	local ctx = { b = self, run = self.run, src = self.player, tgt = tgt, x = if isX then cost else nil, card = c }
	E.run(d.effects, ctx)
	if d.type == "power" then table.insert(self.powers, c)
	elseif d.exhaust then table.insert(self.exhausted, c) self:emit("exhaust", { card = c })
	else table.insert(self.discard, c) end
	if self.state == "player" then
		self:fireRelics("card_played", { cardType = d.type, target = tgt })
		if self.state == "player" then self:fireRelics(d.type .. "_played", { target = tgt }) end
	end
	if self.run and self.run.onCardPlayed then self.run:onCardPlayed(c, d) end
	self:refreshIntents()
	self:checkEnd()
	return true
end

function B:endTurn()
	if self.state ~= "player" then return false end
	self:fireRelics("turn_end")
	if self:checkEnd() then return true end
	-- hand: retain stays, ethereal exhausts, rest discarded
	local keep = {}
	for _, c in self.hand do
		local d = self:def(c)
		if d.retain then table.insert(keep, c)
		elseif d.ethereal then table.insert(self.exhausted, c)
		else table.insert(self.discard, c) end
	end
	self.hand = keep
	statusPhase(self, self.player, "end")
	if self:checkEnd() then return true end
	self.state = "enemy"
	self:emit("enemy_turn", {})
	for _, e in self.enemies do
		if not e.dead then
			e.block = 0
			statusPhase(self, e, "start")
			if self:checkEnd() then return true end
			if not e.dead then
				local move = e.def.moves[e.intent.move]
				self:emit("enemy_move", { enemy = e, move = e.intent.move, intent = e.intent })
				E.run(move.effects, { b = self, run = self.run, src = e, tgt = self.player })
				table.insert(e.history, e.intent.move)
				if self:checkEnd() then return true end
				statusPhase(self, e, "end")
				if self:checkEnd() then return true end
			end
		end
	end
	for _, e in self:alive() do self:chooseMove(e) end
	self:startTurn()
	return true
end

-- deterministic snapshot for tests: pile ids in order
function B:piles()
	local function ids(list) local o = {} for _, c in list do table.insert(o, c.id .. (if c.up then "+" else "")) end return o end
	return { draw = ids(self.drawPile), hand = ids(self.hand), discard = ids(self.discard), exhaust = ids(self.exhausted) }
end

return B
