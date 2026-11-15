--!nonstrict
-- Greedy bot (balance sims, playtests) + DB.sim.run: N seeded runs -> win rate, floors, turns per fight, deck power curve.
local E = require("./effects")
local Battle = require("./battle")
local Run = require("./run")

local Bot = {}

local function B_dex(b) return Battle.stacks(b.player, "dexterity") end

-- score playing hand[i] on target (higher = better); nil = don't
local function scorePlay(b, i, tgt)
	local c = b.hand[i]
	local d = b:def(c)
	local incoming = math.max(0, b:incoming() - b.player.block)
	local s = 0
	local cost = b:costOf(c)
	for _, raw in d.effects do
		local eff = E.parse(raw)
		local ctx = { b = b, src = b.player, tgt = tgt, x = if d.cost == "X" then cost else nil }
		local function n(nx) return E.num(ctx, nx) end
		if eff.op == "if" then
			if E.check(eff.cond, ctx) or eff.cond.lhs == "killed" then eff = eff["then"] else eff = { op = "none" } end
		end
		if eff.op == "damage" then
			local hits = if eff.hits then n(eff.hits) else 1
			local targets = if eff.target == "all" then b:alive() elseif tgt then { tgt } else { b:alive()[1] }
			for _, t in targets do
				if t then
					local per = b:calcDamage(b.player, t, n(eff.n), true)
					local total = per * hits
					local eff_hp = t.hp + t.block
					s += math.min(total, eff_hp)
					if total >= eff_hp then s += 8 + (if t.intent and t.intent.damage then t.intent.damage * (t.intent.hits or 1) else 4) end
				end
			end
		elseif eff.op == "block" then
			local amt = n(eff.n) + B_dex(b)
			s += math.min(amt, incoming) * 1.1 + math.max(0, amt - incoming) * 0.15
		elseif eff.op == "draw" then s += 2.5 * n(eff.n)
		elseif eff.op == "energy" then s += 3 * n(eff.n)
		elseif eff.op == "apply" then
			local v = Run.effectValue(raw)
			if eff.status == "vulnerable" or eff.status == "weak" then v *= 0.8 end
			s += v
		elseif eff.op == "heal" then s += n(eff.n) * 0.6
		elseif eff.op == "lose_hp" then s -= n(eff.n) * (if b.player.hp < 15 then 3 else 0.8)
		else s += 0.5 end
	end
	if d.type == "power" then s += (if b.turn <= 2 then 6 else 2) end
	s -= cost * 0.5
	return s
end

-- play one turn greedily (doesn't end the turn); returns number of cards played
function Bot.playTurn(b, maxPlays)
	local plays = 0
	for _ = 1, maxPlays or 30 do
		if b.state ~= "player" then break end
		local best, bi, bt = 0.3, nil, nil
		local alive = b:alive()
		for i = 1, #b.hand do
			if b:canPlay(i) then
				local d = b:def(b.hand[i])
				if d.target == "enemy" then
					for _, t in alive do
						local s = scorePlay(b, i, t) + (1 - t.hp / t.maxHp) * 0.5 - t.index * 0.01
						if s > best then best, bi, bt = s, i, t end
					end
				else
					local s = scorePlay(b, i, alive[1])
					if s > best then best, bi, bt = s, i, nil end
				end
			end
		end
		if not bi then break end
		b:play(bi, bt)
		plays += 1
	end
	return plays
end

-- fight until it ends; returns "won"|"lost"
function Bot.fight(b, maxTurns)
	for _ = 1, maxTurns or 60 do
		if b.state ~= "player" then break end
		Bot.playTurn(b)
		if b.state == "player" then b:endTurn() end
	end
	if b.state == "player" then b.state = "lost" end
	return b.state
end

-- map choice: prefer rest when hurt, elites when healthy, shops with gold, else fights/events
function Bot.chooseNode(run)
	local best, bestS = nil, -math.huge
	local frac = run.hp / run.maxHp
	for _, id in run:choices() do
		local n = run.map.nodes[id]
		local s = ({ fight = 3, event = 2.5, treasure = 5, boss = 0, shop = if run.gold >= 120 then 4 else 0.5,
			rest = if frac < 0.55 then 6 else 1, elite = if frac > 0.75 and run.floor > 4 then 4 else -2 })[n.type] or 1
		-- look one step ahead
		for _, nx in n.next do local m = run.map.nodes[nx] if m.type == "rest" and frac < 0.6 then s += 1 end end
		s += (string.byte(id, #id) % 3) * 0.01
		if s > bestS then best, bestS = id, s end
	end
	return best
end

function Bot.pickCard(run, ids)
	local best, bs = nil, if #run.deck >= 22 then 4 else 1.5
	for i, id in ids do
		local v = Run.cardValue(run.C, id, false)
		if v > bs then best, bs = i, v end
	end
	return best
end

-- play a whole node/screen step; returns false when the run is over
function Bot.step(run)
	local st = run.state
	if st == "won" or st == "lost" then return false end
	if st == "map" then
		local id = Bot.chooseNode(run)
		if not id then run:lose("stuck") return false end
		run:go(id)
	elseif st == "battle" then
		Bot.fight(run.battle)
		run:afterBattle()
	elseif st == "reward" then
		local rw = run.rewards
		run:takeGold()
		if rw.cards and #rw.cards > 0 then
			local i = Bot.pickCard(run, rw.cards)
			if i then run:takeCard(i) else run:skipCards() end
		end
		if rw.relic or rw.bossRelics then run:takeRelic(1) end
		run:leave()
	elseif st == "rest" then
		if run.hp / run.maxHp < 0.6 then run:rest("heal")
		else
			local bi, bv = nil, -math.huge
			for i, c in run.deck do
				if E.canUpgrade(run.C, c.id, c.up) then
					local v = Run.cardValue(run.C, c.id, true) - Run.cardValue(run.C, c.id, false) + (if run:cardDef(c).rarity == "basic" then 0 else 1)
					if v > bv then bi, bv = i, v end
				end
			end
			if bi then run:rest("upgrade", bi) else run:rest("heal") end
		end
	elseif st == "shop" then
		local s = run.shop
		if run.gold >= s.removePrice then run:buyRemoval() end
		for i, r in s.relics do if run.gold >= r.price then run:buyRelic(i) end end
		for i, c in s.cards do if run.gold >= c.price and Run.cardValue(run.C, c.id, false) > 3 then run:buyCard(i) end end
		run:leave()
	elseif st == "event" then
		local ch = run:eventChoices()
		local pick = nil
		for _, c in ch do if not c.locked then pick = c.index break end end
		-- prefer the last unlocked choice when healthy (usually the greedy option)
		if run.hp / run.maxHp > 0.6 then for _, c in ch do if not c.locked then pick = c.index end end end
		if pick then run:eventChoose(pick) else run:leave() end
	end
	return run.state ~= "won" and run.state ~= "lost"
end

function Bot.playRun(run, maxSteps)
	for _ = 1, maxSteps or 400 do
		if not Bot.step(run) then break end
	end
	return run
end

-- sim({ C, character, seeds = 20 | {list}, startSeed = 1, unlockLevel? }) -> report
function Bot.sim(opts)
	local C = opts.C
	local seeds = opts.seeds or 20
	local list = {}
	if type(seeds) == "table" then list = seeds else for i = 1, seeds do table.insert(list, (opts.startSeed or 1) + i - 1) end end
	local rep = { runs = #list, wins = 0, floors = 0, turns = 0, fights = 0, deaths = {}, power = {}, results = {} }
	local powerByFloor = {}
	for _, seed in list do
		local run = Run.new({ C = C, character = opts.character, seed = seed, unlockLevel = opts.unlockLevel })
		Bot.playRun(run)
		if run.state == "won" then rep.wins += 1 else
			local k = run.stats.killedBy or "?"
			rep.deaths[k] = (rep.deaths[k] or 0) + 1
		end
		rep.floors += run.floor
		for _, t in run.stats.turnsPerFight do rep.turns += t rep.fights += 1 end
		for _, p in run.stats.deckPower do
			local f = p.floor
			powerByFloor[f] = powerByFloor[f] or { sum = 0, n = 0, size = 0 }
			powerByFloor[f].sum += p.power
			powerByFloor[f].size += p.size
			powerByFloor[f].n += 1
		end
		table.insert(rep.results, { seed = seed, won = run.state == "won", floor = run.floor, hp = run.hp, deck = #run.deck, killedBy = run.stats.killedBy })
	end
	rep.winRate = rep.wins / math.max(1, rep.runs)
	rep.avgFloor = rep.floors / math.max(1, rep.runs)
	rep.avgTurns = rep.turns / math.max(1, rep.fights)
	local floors = {}
	for f in powerByFloor do table.insert(floors, f) end
	table.sort(floors)
	for _, f in floors do
		local p = powerByFloor[f]
		table.insert(rep.power, { floor = f, power = p.sum / p.n, size = p.size / p.n, n = p.n })
	end
	return rep
end

-- one-line summary
function Bot.format(rep)
	local d = {}
	for k, v in rep.deaths do table.insert(d, k .. "=" .. v) end
	table.sort(d)
	local curve = {}
	for _, p in rep.power do if p.floor % 3 == 0 or p.floor == 1 then table.insert(curve, p.floor .. ":" .. string.format("%.1f", p.power) .. "/" .. string.format("%.0f", p.size)) end end
	return string.format("runs %d winRate %.0f%% avgFloor %.1f avgTurns/fight %.1f deaths {%s} power[floor:value/deck] %s",
		rep.runs, rep.winRate * 100, rep.avgFloor, rep.avgTurns, table.concat(d, ","), table.concat(curve, " "))
end

return Bot
