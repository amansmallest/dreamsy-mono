--!nonstrict
-- A run: character, deck, hp/gold, relics, act maps, nodes (fight/elite/boss/event/shop/rest/treasure), rewards.
-- Every random choice uses procgen.rng(seed .. ":" .. label) so runs are replayable and independent of UI timing.
local procgen = require("@kit/procgen")
local E = require("./effects")
local Battle = require("./battle")
local Map = require("./map")

local R = {}
R.__index = R

R.DEFAULTS = {
	rarity = {
		fight = { common = 60, uncommon = 37, rare = 3 },
		elite = { common = 50, uncommon = 40, rare = 10 },
		boss = { rare = 100 },
		shop = { common = 55, uncommon = 35, rare = 10 },
	},
	relicRarity = { common = 50, uncommon = 33, rare = 17 },
	gold = { fight = { 10, 20 }, elite = { 25, 35 }, boss = { 95, 105 } },
	cardChoices = 3,
	cardPrice = { common = 50, uncommon = 75, rare = 150 },
	relicPrice = { common = 150, uncommon = 200, rare = 260, shop = 170, boss = 300 },
	removePrice = 75, removeStep = 25,
	shopCards = 5, shopRelics = 2,
	restHeal = 0.3,
	budget = { fight = { 2, 5 }, elite = { 4, 7 } },
	weakFights = 3,
}

local function cfg(C, key)
	local c = C.config or {}
	if c[key] ~= nil then return c[key] end
	return R.DEFAULTS[key]
end
R.cfg = cfg

-- new({ C, character, seed, unlockLevel? (meta level; nil = everything unlocked), sim? (no core events), emit? fn(name, data) })
function R.new(opts)
	local C = opts.C
	local ch = C.characters[opts.character]
	if ch == nil then error("deckbuilder: unknown character '" .. tostring(opts.character) .. "'", 2) end
	local self = setmetatable({
		C = C, charId = ch.id, char = ch, seed = opts.seed or 1, unlockLevel = opts.unlockLevel,
		hp = ch.hp, maxHp = ch.maxHp or ch.hp, gold = ch.gold, deck = {}, relics = {}, relicState = {}, uid = 0,
		actIndex = 0, floor = 0, pos = nil, path = {}, state = "map", battle = nil, rewards = nil, shop = nil, event = nil,
		removals = 0, seenEvents = {}, emitFn = opts.emit, listeners = {},
		stats = { fights = 0, elites = 0, bosses = 0, turns = 0, kills = 0, cardsPlayed = 0, turnsPerFight = {}, deckPower = {}, killedBy = nil },
	}, R)
	for _, id in ch.deck do self:addCard(id) end
	for _, id in ch.relics do self:addRelic(id) end
	self:nextAct()
	return self
end

function R:emit(name, data)
	if self.emitFn then self.emitFn(name, data or {}) end
	for _, fn in self.listeners[name] or {} do fn(data) end
end
function R:on(name, fn) self.listeners[name] = self.listeners[name] or {} table.insert(self.listeners[name], fn) end
function R:rng(label) return procgen.rng(tostring(self.seed) .. ":" .. label) end
function R:act() return self.C.actList[self.actIndex] end

function R:unlocked(def) return self.unlockLevel == nil or (def.unlock or 0) <= self.unlockLevel end

-- ---------- deck / relics ----------
function R:addCard(id, up)
	if self.C.cards[id] == nil then error("deckbuilder: unknown card '" .. tostring(id) .. "'", 2) end
	self.uid += 1
	local c = { id = id, up = up == true, uid = self.uid }
	table.insert(self.deck, c)
	self:emit("card_added", { card = id })
	return c
end
function R:removeCardAt(i)
	local c = table.remove(self.deck, i)
	if c then self:emit("card_removed", { card = c.id }) end
	return c
end
function R:upgradeCardAt(i)
	local c = self.deck[i]
	if c == nil or not E.canUpgrade(self.C, c.id, c.up) then return false end
	c.up = true
	self:emit("card_upgraded", { card = c.id })
	return true
end
function R:cardDef(c) return E.card(self.C, c.id, c.up) end
function R:hasRelic(id) return table.find(self.relics, id) ~= nil end

function R:addRelic(id)
	local r = self.C.relics[id]
	if r == nil then error("deckbuilder: unknown relic '" .. tostring(id) .. "'", 2) end
	table.insert(self.relics, id)
	local mods = r.mods or {}
	if mods.max_hp then self.maxHp += mods.max_hp self.hp += mods.max_hp end
	if mods.gold then self.gold += mods.gold end
	for _, tr in (r.triggers or (if r.on then { { on = r.on, effects = r.effects } } else {})) do
		if tr.on == "pickup" then E.run(tr.effects, { run = self }) end
	end
	if self.battle and self.battle.state == "player" then table.insert(self.battle.relics, id) end
	self:emit("relic_added", { relic = id })
	return true
end

-- ---------- pools ----------
function R:cardPool(rarity)
	local out = {}
	for _, id in self.C.order.cards do
		local c = self.C.cards[id]
		if c.rarity == rarity and c.type ~= "status" and c.type ~= "curse" and c.character ~= "none" and not c.token
			and (c.character == nil or c.character == self.charId) and self:unlocked(c) then table.insert(out, id) end
	end
	return out
end

function R:rollCards(n, kind, rng)
	local weights = cfg(self.C, "rarity")[kind] or cfg(self.C, "rarity").fight
	local picked = {}
	for _ = 1, n * 10 do
		if #picked >= n then break end
		local rar = rng:weighted(weights)
		local pool = {}
		for _, id in self:cardPool(rar) do if not table.find(picked, id) then table.insert(pool, id) end end
		if #pool == 0 then
			for _, r2 in { "common", "uncommon", "rare" } do
				for _, id in self:cardPool(r2) do if not table.find(picked, id) then table.insert(pool, id) end end
			end
		end
		if #pool == 0 then break end
		table.insert(picked, rng:pick(pool))
	end
	return picked
end

function R:relicPool(rarities)
	local out = {}
	for _, id in self.C.order.relics do
		local r = self.C.relics[id]
		if table.find(rarities, r.rarity) and not self:hasRelic(id) and (r.character == nil or r.character == self.charId) and self:unlocked(r) then
			table.insert(out, id)
		end
	end
	return out
end

function R:rollRelic(rng, rarities)
	local w = cfg(self.C, "relicRarity")
	for _ = 1, 8 do
		local rar = rng:weighted(w)
		local pool = self:relicPool(rarities or { rar })
		if #pool > 0 then return rng:pick(pool) end
	end
	local pool = self:relicPool({ "common", "uncommon", "rare" })
	return rng:pick(pool)
end

-- ---------- run-level effect verbs (events, relic pickup) ----------
R.ops = {
	gold = function(r, eff, n) r.gold = math.max(0, r.gold + n) end,
	heal = function(r, eff, n) r.hp = math.min(r.maxHp, r.hp + n) end,
	lose_hp = function(r, eff, n) r.hp = math.max(0, r.hp - n) if r.hp <= 0 then r:lose("event") end end,
	max_hp = function(r, eff, n) r.maxHp += n r.hp = math.max(1, math.min(r.maxHp, r.hp + math.max(0, n))) end,
	relic = function(r, eff)
		local id = eff.relic
		if id == "random" then id = r:rollRelic(r:rng("relic:" .. r.floor .. ":" .. #r.relics)) end
		if id then r:addRelic(id) end
	end,
	card = function(r, eff)
		local id = eff.card
		if id == "random" then
			local rng = r:rng("card:" .. r.floor .. ":" .. #r.deck)
			id = r:rollCards(1, if eff.rarity then "fight" else "fight", rng)[1]
			if eff.rarity then local pool = r:cardPool(eff.rarity) if #pool > 0 then id = rng:pick(pool) end end
		end
		if id then r:addCard(id) end
	end,
	add = function(r, eff, n)
		for _ = 1, n do r:addCard(eff.card) end
	end,
	remove_card = function(r, eff, n)
		for _ = 1, n do
			local i = r:worstCard()
			if i then r:removeCardAt(i) end
		end
	end,
	upgrade_deck = function(r, eff, n)
		local rng = r:rng("upg:" .. r.floor)
		for _ = 1, n do
			local can = {}
			for i, c in r.deck do if E.canUpgrade(r.C, c.id, c.up) then table.insert(can, i) end end
			if #can == 0 then break end
			r:upgradeCardAt(rng:pick(can))
		end
	end,
	upgrade = function(r, eff, n) R.ops.upgrade_deck(r, eff, 1) end,
}

-- worst card: curse > status > basic (lowest value) > anything
function R:worstCard()
	local best, bestScore = nil, math.huge
	for i, c in self.deck do
		local d = self:cardDef(c)
		local s = R.cardValue(self.C, c.id, c.up)
		if d.type == "curse" then s -= 1000 elseif d.type == "status" then s -= 500 elseif d.rarity == "basic" then s -= 50 end
		if s < bestScore then best, bestScore = i, s end
	end
	return best
end

-- heuristic value of a card (bot picks, deck power curve)
local VAL = { damage = 1, block = 0.85, draw = 2.2, energy = 3.5, heal = 0.6, gold = 0.1, discard = -0.5, exhaust = 0.2, upgrade = 2 }
local STATUSVAL = { strength = 4, dexterity = 3.5, weak = 2.2, vulnerable = 2.6, frail = 1.6, poison = 1.3, regen = 1.5, thorns = 1.2, metallicize = 3.2, ritual = 6, artifact = 2 }
function R.effectValue(eff, cost)
	eff = E.parse(eff)
	local function n(nx) if nx == nil then return 1 end if nx.k == "const" then return nx.v elseif nx.k == "X" then return 3 + nx.add end return 5 end
	if eff.op == "if" then return 0.5 * R.effectValue(eff["then"], cost) end
	if eff.op == "damage" then
		local v = n(eff.n) * (if eff.hits then n(eff.hits) else 1)
		if eff.target == "all" then v *= 1.6 elseif eff.target == "self" then v = -v end
		return v
	end
	if eff.op == "apply" then
		local v = (STATUSVAL[eff.status] or 1.5) * n(eff.n)
		if eff.target == "all" then v *= 1.5 end
		return v
	end
	if eff.op == "lose_hp" then return -n(eff.n) * 0.7 end
	return (VAL[eff.op] or 0.5) * n(eff.n)
end
function R.cardValue(C, id, up)
	local d = E.card(C, id, up)
	if d.type == "curse" then return -8 end
	if d.type == "status" then return -4 end
	local v = 0
	for _, e in d.effects do v += R.effectValue(e) end
	local cost = if d.cost == "X" then 3 elseif d.cost < 0 then 1 else d.cost
	v = v - cost * 4 + 4
	if d.exhaust then v -= 1 end
	if d.retain then v += 0.5 end
	if d.type == "power" then v += 2 end
	return v
end
-- deck power: mean card value
function R:deckPower()
	if #self.deck == 0 then return 0 end
	local s = 0
	for _, c in self.deck do s += R.cardValue(self.C, c.id, c.up) end
	return s / #self.deck
end

-- ---------- map flow ----------
function R:nextAct()
	self.actIndex += 1
	local act = self:act()
	if act == nil then return false end
	self.map = Map.generate({ rng = self:rng("map:" .. self.actIndex), rows = act.rows or act.floors or 12, cols = act.cols or 7,
		paths = act.paths or 6, weights = act.weights, rules = act.rules })
	self.pos = nil
	self.state = "map"
	self:emit("act_started", { act = act.id, index = self.actIndex })
	return true
end

function R:choices()
	if self.state ~= "map" then return {} end
	if self.pos == nil then return table.clone(self.map.starts) end
	return table.clone(self.map.nodes[self.pos].next)
end

local function lerpRange(range, t)
	if type(range) == "number" then return range end
	return range[1] + (range[2] - range[1]) * t
end

function R:encounter(kind, row, rng)
	local act = self:act()
	local C = self.C
	local enc = act.encounters or {}
	if kind == "boss" then
		local list = act.bosses
		if list and #list > 0 then return { rng:pick(list) } end
		if enc.boss then local e = rng:pick(enc.boss) return table.clone(e.enemies or e) end
		local pool = {}
		for _, id in C.order.enemies do local e = C.enemies[id] if e.tier == "boss" and (e.act == nil or e.act == act.id or e.act == self.actIndex) then table.insert(pool, id) end end
		return { rng:pick(pool) }
	end
	local key = if kind == "elite" then "elite" elseif row <= cfg(C, "weakFights") and enc.weak then "weak" else "normal"
	local list = enc[key]
	if list and #list > 0 then
		local e = rng:weighted(list, function(x) return if type(x) == "table" and x.weight then x.weight else 1 end)
		return table.clone(e.enemies or e)
	end
	-- generated: procgen.waves.encounter over this act's enemy pool by budget
	local tier = if kind == "elite" then "elite" else "normal"
	local pool = {}
	for _, id in C.order.enemies do
		local e = C.enemies[id]
		if e.tier == tier and (e.act == nil or e.act == act.id or e.act == self.actIndex) then
			table.insert(pool, { id = id, cost = e.cost, weight = e.weight, minLevel = e.minRow, maxLevel = e.maxRow, max = e.max })
		end
	end
	local rows = self.map.rows
	local budgets = act.budget or cfg(C, "budget")
	local b = lerpRange(budgets[kind == "elite" and "elite" or "fight"] or { 2, 5 }, math.clamp((row - 1) / math.max(1, rows - 1), 0, 1))
	local r = procgen.waves.encounter(pool, math.floor(b + 0.5), rng, { level = row, minCount = 1, maxCount = act.maxEnemies or 3 })
	return r.ids
end

function R:go(nodeId)
	if not table.find(self:choices(), nodeId) then return false, "not reachable" end
	self.pos = nodeId
	table.insert(self.path, nodeId)
	self.floor += 1
	return self:enter(self.map.nodes[nodeId])
end

function R:enter(node)
	local label = self.actIndex .. ":" .. node.id
	self.node = node
	local t = node.type
	self:emit("node_entered", { type = t, node = node.id, floor = self.floor })
	if t == "fight" or t == "elite" or t == "boss" then
		local enemies = self:encounter(t, node.row, self:rng("enc:" .. label))
		self:startBattle(enemies, label)
	elseif t == "rest" then
		self.state = "rest"
	elseif t == "shop" then
		self:makeShop(self:rng("shop:" .. label))
		self.state = "shop"
	elseif t == "event" then
		local act = self:act()
		local pool = {}
		local src = act.events or self.C.order.events
		for _, id in src do
			local ev = self.C.events[id]
			if ev and not self.seenEvents[id] and (ev.act == nil or ev.act == act.id or ev.act == self.actIndex) then table.insert(pool, id) end
		end
		if #pool == 0 then
			-- out of events: becomes a fight
			node.type = "fight"
			return self:enter(node)
		end
		local id = self:rng("event:" .. label):pick(pool)
		self.seenEvents[id] = true
		self.event = { id = id, def = self.C.events[id] }
		self.state = "event"
	elseif t == "treasure" then
		local rng = self:rng("treasure:" .. label)
		self.rewards = { kind = "treasure", gold = 0, cards = {}, relic = self:rollRelic(rng), taken = {} }
		self.state = "reward"
	else
		error("deckbuilder: unknown node type '" .. tostring(t) .. "'")
	end
	return true
end

function R:startBattle(enemies, label)
	self.battle = Battle.new({ C = self.C, run = self, seed = tostring(self.seed) .. ":battle:" .. label, deck = self.deck, enemies = enemies,
		player = { hp = self.hp, maxHp = self.maxHp, energy = self.char.energy, draw = self.char.draw, name = self.char.name },
		relics = table.clone(self.relics), relicState = self.relicState })
	self.state = "battle"
	self:emit("battle_started", { enemies = enemies })
	self.battle:start()
	return self.battle
end

function R:onEnemyKilled(e) self.stats.kills += 1 self:emit("enemy_defeated", { enemy = e.enemyId }) end
function R:onCardPlayed(c, d) self.stats.cardsPlayed += 1 self:emit("card_played", { card = c.id, type = d.type }) end

-- call when battle.state is "won" or "lost" -> run.state ("reward" | "lost")
function R:afterBattle()
	local b = self.battle
	if b == nil then return self.state end
	if b.state ~= "won" and b.state ~= "lost" then return self.state end
	self.hp = math.max(0, b.player.hp)
	self.maxHp = b.player.maxHp
	self.stats.turns += b.turn
	table.insert(self.stats.turnsPerFight, b.turn)
	local kind = self.node and self.node.type or "fight"
	if b.state == "lost" then
		local killer = nil
		for _, e in b.enemies do if not e.dead then killer = e.enemyId break end end
		self.battle = nil
		self:lose(killer)
		return self.state
	end
	if kind == "elite" then self.stats.elites += 1 elseif kind == "boss" then self.stats.bosses += 1 else self.stats.fights += 1 end
	self:emit("battle_won", { kind = kind, turns = b.turn, floor = self.floor })
	self.battle = nil
	local rng = self:rng("reward:" .. self.actIndex .. ":" .. (self.pos or "x"))
	local g = cfg(self.C, "gold")[kind] or { 10, 20 }
	local rw = { kind = kind, gold = rng:int(g[1], g[2]), cards = self:rollCards(cfg(self.C, "cardChoices"), kind, rng), taken = {} }
	if kind == "elite" then rw.relic = self:rollRelic(rng) end
	if kind == "boss" then
		local pool = self:relicPool({ "boss" })
		rw.bossRelics = rng:sample(pool, math.min(3, #pool))
		if #rw.bossRelics == 0 then rw.relic = self:rollRelic(rng) end
	end
	self.rewards = rw
	self.state = "reward"
	return self.state
end

-- ---------- rewards ----------
function R:takeGold()
	local rw = self.rewards
	if not rw or rw.taken.gold or (rw.gold or 0) <= 0 then return false end
	rw.taken.gold = true
	self.gold += rw.gold
	self:emit("gold_gained", { amount = rw.gold })
	return true
end
function R:takeCard(i)
	local rw = self.rewards
	if not rw or rw.taken.card or rw.cards[i] == nil then return false end
	rw.taken.card = rw.cards[i]
	self:addCard(rw.cards[i])
	return true
end
function R:skipCards() if self.rewards then self.rewards.taken.card = "skip" end end
function R:takeRelic(i)
	local rw = self.rewards
	if not rw or rw.taken.relic then return false end
	local id = if rw.bossRelics and #rw.bossRelics > 0 then rw.bossRelics[i or 1] else rw.relic
	if not id then return false end
	rw.taken.relic = id
	self:addRelic(id)
	return true
end
-- leave the reward screen: auto-collects gold; after a boss -> next act or won
function R:leave()
	if self.state == "reward" then
		self:takeGold()
		local boss = self.rewards and self.rewards.kind == "boss"
		self.rewards = nil
		if boss then
			if not self:nextAct() then self:win() end
			return true
		end
	end
	self.shop, self.event = nil, nil
	if self.state ~= "won" and self.state ~= "lost" then self.state = "map" end
	table.insert(self.stats.deckPower, { floor = self.floor, power = self:deckPower(), size = #self.deck })
	return true
end

-- ---------- shop ----------
function R:makeShop(rng)
	local prices = cfg(self.C, "cardPrice")
	local rp = cfg(self.C, "relicPrice")
	local s = { cards = {}, relics = {}, removePrice = cfg(self.C, "removePrice") + cfg(self.C, "removeStep") * self.removals, removed = false }
	for _, id in self:rollCards(cfg(self.C, "shopCards"), "shop", rng) do
		local d = self.C.cards[id]
		table.insert(s.cards, { id = id, price = math.floor((prices[d.rarity] or 60) * rng:range(0.9, 1.1)), sold = false })
	end
	for i = 1, cfg(self.C, "shopRelics") do
		local id = self:rollRelic(rng, if i == cfg(self.C, "shopRelics") then { "shop", "common", "uncommon" } else nil)
		if id and not (function() for _, x in s.relics do if x.id == id then return true end end return false end)() then
			local d = self.C.relics[id]
			table.insert(s.relics, { id = id, price = math.floor((rp[d.rarity] or 180) * rng:range(0.95, 1.05)), sold = false })
		end
	end
	self.shop = s
	return s
end
function R:buyCard(i)
	local it = self.shop and self.shop.cards[i]
	if not it or it.sold or self.gold < it.price then return false end
	self.gold -= it.price
	it.sold = true
	self:addCard(it.id)
	return true
end
function R:buyRelic(i)
	local it = self.shop and self.shop.relics[i]
	if not it or it.sold or self.gold < it.price then return false end
	self.gold -= it.price
	it.sold = true
	self:addRelic(it.id)
	return true
end
-- remove a deck card (shop service; deckIndex default = worst card)
function R:buyRemoval(deckIndex)
	local s = self.shop
	if not s or s.removed or self.gold < s.removePrice then return false end
	local i = deckIndex or self:worstCard()
	if not i or not self.deck[i] then return false end
	self.gold -= s.removePrice
	s.removed = true
	self.removals += 1
	self:removeCardAt(i)
	return true
end

-- ---------- rest ----------
-- rest("heal") | rest("upgrade", deckIndex)
function R:rest(action, deckIndex)
	if self.state ~= "rest" then return false end
	if action == "upgrade" then
		if not self:upgradeCardAt(deckIndex or 0) then return false end
	else
		local h = math.floor(self.maxHp * cfg(self.C, "restHeal") + 0.5)
		self.hp = math.min(self.maxHp, self.hp + h)
		self:emit("rested", { heal = h })
	end
	self:leave()
	return true
end

-- ---------- events ----------
function R:eventChoices()
	if not self.event then return {} end
	local out = {}
	for i, ch in self.event.def.choices or {} do
		local ok = ch.condition == nil or E.check(ch.condition, { run = self })
		table.insert(out, { index = i, text = ch.text, locked = not ok, result = ch.result })
	end
	return out
end
function R:eventChoose(i)
	if self.state ~= "event" then return false end
	local ch = self.event.def.choices[i]
	if ch == nil then return false end
	if ch.condition and not E.check(ch.condition, { run = self }) then return false end
	self.lastEventResult = ch.result
	E.run(ch.effects, { run = self })
	self:emit("event_choice", { event = self.event.id, choice = i })
	if ch.fight then
		self.event = nil
		self:startBattle(ch.fight, "event:" .. self.floor)
		return true
	end
	if self.state == "event" then self:leave() end
	return true
end

-- ---------- end ----------
function R:score()
	return self.floor * 5 + self.stats.elites * 15 + self.stats.bosses * 50 + (if self.state == "won" then 100 else 0)
end
function R:win()
	self.state = "won"
	self:emit("run_ended", { won = true, floor = self.floor, score = self:score() })
end
function R:lose(killer)
	self.state = "lost"
	self.stats.killedBy = killer
	self:emit("run_ended", { won = false, floor = self.floor, killedBy = killer, score = self:score() })
end

-- ---------- save ----------
function R:serialize()
	local deck = {}
	for _, c in self.deck do table.insert(deck, { id = c.id, up = c.up }) end
	return { character = self.charId, seed = self.seed, hp = self.hp, maxHp = self.maxHp, gold = self.gold, deck = deck,
		relics = table.clone(self.relics), relicState = table.clone(self.relicState), actIndex = self.actIndex, floor = self.floor,
		pos = self.pos, path = table.clone(self.path), state = self.state, rewards = self.rewards, shop = self.shop,
		event = self.event and self.event.id, removals = self.removals, seenEvents = self.seenEvents, unlockLevel = self.unlockLevel,
		stats = self.stats }
end

function R.restore(C, t, opts)
	opts = opts or {}
	local self = setmetatable({ C = C, charId = t.character, char = C.characters[t.character], seed = t.seed, unlockLevel = t.unlockLevel,
		hp = t.hp, maxHp = t.maxHp, gold = t.gold, deck = {}, relics = {}, relicState = t.relicState or {}, uid = 0,
		actIndex = t.actIndex - 1, floor = t.floor, path = t.path or {}, removals = t.removals or 0, seenEvents = t.seenEvents or {},
		emitFn = opts.emit, listeners = {}, stats = t.stats }, R)
	for _, c in t.deck do self:addCard(c.id, c.up) end
	self.relics = table.clone(t.relics)
	self:nextAct()
	self.pos = t.pos
	self.state = t.state
	self.node = if t.pos then self.map.nodes[t.pos] else nil
	self.rewards, self.shop = t.rewards, t.shop
	if t.event then self.event = { id = t.event, def = C.events[t.event] } end
	if self.state == "battle" and self.node then
		-- a fight in progress restarts from its first turn (same seed => same draws)
		self:startBattle(self:encounter(self.node.type, self.node.row, self:rng("enc:" .. self.actIndex .. ":" .. self.node.id)), self.actIndex .. ":" .. self.node.id)
	end
	return self
end

return R
