--!nonstrict
-- The deckbuilder effect language: compact strings, parsed once and cached.
--   damage N [xH] [target|all|random|self]   block N [self|allies]   draw N   energy N   heal N [self|allies]
--   lose_hp N [self|target|all]   gold N   max_hp N   apply STATUS N [target|all|random|self]   remove STATUS [who]
--   double STATUS [who]   discard N   exhaust N   add CARD [hand|draw|discard] [N]   upgrade hand|random
--   relic ID|random   card ID|random [rarity]   remove_card [N]   upgrade_deck [N]   (run-level)
--   if COND then EFFECT          COND: [not] LHS [op RHS]  LHS = killed | self.S | target.S | hand | energy | hp | gold | turn |
--                                 block | draw | discard | exhaust | X | cards_played;  RHS = number | N% (of max: hp)
-- Numbers: 6 | X | X+1 | X-1 | $block | $hand | $target.poison | $self.strength | $stacks (status effects) [*k]
local E = {}

local cache = {}

local function parseNum(tok)
	if tok == nil then return nil end
	local n = tonumber(tok)
	if n then return { k = "const", v = n } end
	if tok == "X" then return { k = "X", add = 0 } end
	local sgn, d = string.match(tok, "^X([%+%-])(%d+)$")
	if sgn then return { k = "X", add = (if sgn == "-" then -1 else 1) * tonumber(d) } end
	local v, mul = string.match(tok, "^%$([%w_%.]+)%*?([%d%.]*)$")
	if v then return { k = "var", name = v, mul = tonumber(mul) or 1 } end
	return nil
end
E.parseNum = parseNum

local function isNum(tok) return parseNum(tok) ~= nil end
local TARGETS = { target = true, all = true, random = true, self = true, allies = true }
local PILES = { hand = true, draw = true, discard = true, deck = true }

local OPS = { "<=", ">=", "==", "~=", "!=", "<", ">" }
local function parseCond(s)
	s = string.gsub(string.gsub(s, "^%s+", ""), "%s+$", "")
	local neg = false
	if string.sub(s, 1, 4) == "not " then neg = true s = string.sub(s, 5) end
	for _, op in OPS do
		local i = string.find(s, op, 1, true)
		if i then
			local lhs = string.gsub(string.sub(s, 1, i - 1), "%s+", "")
			local rhs = string.gsub(string.sub(s, i + #op), "%s+", "")
			local pct = string.match(rhs, "^([%d%.]+)%%$")
			return { neg = neg, lhs = lhs, op = if op == "!=" then "~=" else op, rhs = if pct then tonumber(pct) / 100 else parseNum(rhs), pct = pct ~= nil }
		end
	end
	return { neg = neg, lhs = string.gsub(s, "%s+", ""), op = ">", rhs = { k = "const", v = 0 } }
end
E.parseCond = parseCond

function E.parse(str)
	if type(str) ~= "string" then return str end
	local c = cache[str]
	if c then return c end
	local s = string.gsub(string.gsub(str, "^%s+", ""), "%s+$", "")
	local eff
	if string.sub(s, 1, 3) == "if " then
		local a, b = string.find(s, " then ", 1, true)
		if not a then error("deckbuilder effect '" .. str .. "': 'if' needs 'then'", 2) end
		eff = { op = "if", cond = parseCond(string.sub(s, 4, a - 1)), ["then"] = E.parse(string.sub(s, b + 1)) }
	else
		local t = string.split(s, " ")
		local toks = {}
		for _, x in t do if x ~= "" then table.insert(toks, x) end end
		local op = toks[1]
		eff = { op = op, src = str }
		local rest = {}
		for i = 2, #toks do table.insert(rest, toks[i]) end
		local function takeTarget()
			for i = #rest, 1, -1 do if TARGETS[rest[i]] then eff.target = rest[i] table.remove(rest, i) return end end
		end
		if op == "damage" then
			takeTarget()
			eff.n = parseNum(rest[1])
			if rest[2] then
				local h = string.match(rest[2], "^x(.+)$")
				eff.hits = parseNum(h or "")
				if not eff.hits then error("deckbuilder effect '" .. str .. "': hits must be xN / xX", 2) end
			end
		elseif op == "block" or op == "draw" or op == "energy" or op == "heal" or op == "lose_hp" or op == "gold" or op == "max_hp"
			or op == "discard" or op == "exhaust" or op == "remove_card" or op == "upgrade_deck" then
			takeTarget()
			eff.n = parseNum(rest[1] or "1")
		elseif op == "apply" then
			takeTarget()
			eff.status = rest[1]
			eff.n = parseNum(rest[2] or "1")
		elseif op == "remove" or op == "double" then
			takeTarget()
			eff.status = rest[1]
		elseif op == "add" then
			eff.card = rest[1]
			eff.pile = "discard"
			eff.n = { k = "const", v = 1 }
			for i = 2, #rest do
				if PILES[rest[i]] then eff.pile = rest[i] elseif isNum(rest[i]) then eff.n = parseNum(rest[i]) end
			end
		elseif op == "upgrade" then
			eff.which = rest[1] or "random"
		elseif op == "relic" then
			eff.relic = rest[1] or "random"
		elseif op == "card" then
			eff.card = rest[1] or "random"
			eff.rarity = rest[2]
		else
			error("deckbuilder effect '" .. str .. "': unknown verb '" .. tostring(op) .. "' (damage block draw energy heal lose_hp gold max_hp apply remove double discard exhaust add upgrade relic card remove_card upgrade_deck if)", 2)
		end
		if (op ~= "add" and op ~= "upgrade" and op ~= "relic" and op ~= "card" and op ~= "remove" and op ~= "double") and eff.n == nil then
			error("deckbuilder effect '" .. str .. "': bad number", 2)
		end
	end
	cache[str] = eff
	return eff
end

-- ---------- values ----------
-- ctx: { b = battle?, run = run?, src = unit?, tgt = unit?, x = number?, stacks = number?, killed = bool, card = inst? }
local function unitVal(ctx, u, name)
	if u == nil then return 0 end
	if name == "hp" then return u.hp elseif name == "maxhp" or name == "max_hp" then return u.maxHp
	elseif name == "block" then return u.block or 0 end
	return (u.statuses and u.statuses[name]) or 0
end

function E.value(ctx, name)
	local who, field = string.match(name, "^(%a+)%.([%w_]+)$")
	if who == "self" then return unitVal(ctx, ctx.src, field) elseif who == "target" then return unitVal(ctx, ctx.tgt, field) end
	local b = ctx.b
	if name == "X" then return ctx.x or 0 end
	if name == "stacks" then return ctx.stacks or 0 end
	if b then
		if name == "hand" then return #b.hand elseif name == "draw" then return #b.drawPile elseif name == "discard" then return #b.discard
		elseif name == "exhaust" then return #b.exhausted elseif name == "energy" then return b.energy elseif name == "turn" then return b.turn
		elseif name == "cards_played" then return b.cardsPlayedTurn elseif name == "attacks_played" then return b.attacksPlayedTurn end
	end
	if name == "gold" then return if ctx.run then ctx.run.gold else 0 end
	if name == "hp" or name == "block" or name == "maxhp" then
		local u = ctx.src or (if ctx.run then ctx.run else nil)
		if u then return if name == "hp" then u.hp elseif name == "maxhp" then u.maxHp else (u.block or 0) end
		return 0
	end
	return unitVal(ctx, ctx.src, name)
end

function E.num(ctx, nx)
	if nx == nil then return 0 end
	if nx.k == "const" then return nx.v end
	if nx.k == "X" then return math.max(0, (ctx.x or 0) + nx.add) end
	return math.floor(E.value(ctx, nx.name) * nx.mul)
end

function E.check(cond, ctx)
	if type(cond) == "string" then cond = parseCond(cond) end
	local l
	if cond.lhs == "killed" then l = if ctx.killed then 1 else 0
	else l = E.value(ctx, cond.lhs) end
	local r
	if cond.pct then
		local who = string.match(cond.lhs, "^(%a+)%.") or "self"
		local u = if who == "target" then ctx.tgt else (ctx.src or ctx.run)
		r = (if u then u.maxHp or 1 else 1) * cond.rhs
	else r = E.num(ctx, cond.rhs) end
	local ok
	local op = cond.op
	if op == "<" then ok = l < r elseif op == "<=" then ok = l <= r elseif op == ">" then ok = l > r elseif op == ">=" then ok = l >= r
	elseif op == "==" then ok = l == r else ok = l ~= r end
	if cond.neg then ok = not ok end
	return ok
end

-- ---------- execution ----------
-- run(effects, ctx): effects = list of strings (or one string). Battle verbs need ctx.b, run verbs ctx.run.
function E.run(effects, ctx)
	if effects == nil then return end
	if type(effects) == "string" then effects = { effects } end
	for _, raw in effects do
		local eff = E.parse(raw)
		E.exec(eff, ctx)
		if ctx.b and ctx.b.state ~= "player" and ctx.b.state ~= "enemy" and ctx.b.state ~= "setup" then return end
	end
end

function E.exec(eff, ctx)
	local op = eff.op
	if op == "if" then
		if E.check(eff.cond, ctx) then E.exec(eff["then"], ctx) end
		return
	end
	local b, run = ctx.b, ctx.run
	local n = if eff.n then E.num(ctx, eff.n) else 0
	if b then
		local h = b.ops[op]
		if h then return h(b, eff, n, ctx) end
	end
	if run then
		local h = run.ops[op]
		if h then return h(run, eff, n, ctx) end
	end
	-- outside a battle, battle-only verbs do nothing (relic pickup / events stay safe)
end

-- ---------- card defs + text ----------
local function cap(s) return string.upper(string.sub(s, 1, 1)) .. string.sub(s, 2) end
local function numText(nx)
	if nx == nil then return "?" end
	if nx.k == "const" then return tostring(nx.v) end
	if nx.k == "X" then return if nx.add == 0 then "X" elseif nx.add > 0 then "X+" .. nx.add else "X" .. nx.add end
	return "[" .. string.gsub(nx.name, "^target%.", "target ") .. "]"
end
local function plural(nx, one, many) return if nx and nx.k == "const" and nx.v == 1 then one else many end

function E.describe(eff, C)
	eff = E.parse(eff)
	local op = eff.op
	local t = eff.target
	if op == "if" then
		local c = eff.cond
		local cs
		if c.lhs == "killed" then cs = if c.neg then "this did not kill" else "this kills"
		elseif c.pct and (c.lhs == "target.hp" or c.lhs == "hp" or c.lhs == "self.hp") then
			cs = (if c.lhs == "target.hp" then "the target is " else "you are ") .. (if c.op == "<" or c.op == "<=" then "below " else "above ") .. math.floor(c.rhs * 100) .. "% HP"
		else cs = string.gsub(c.lhs, "%.", " ") .. " " .. c.op .. " " .. (if c.pct then math.floor(c.rhs * 100) .. "%" else numText(c.rhs)) end
		return "If " .. cs .. ", " .. string.lower(string.sub(E.describe(eff["then"], C), 1, 1)) .. string.sub(E.describe(eff["then"], C), 2)
	elseif op == "damage" then
		local s = "Deal " .. numText(eff.n) .. " damage"
		if t == "all" then s ..= " to ALL enemies" elseif t == "random" then s ..= " to a random enemy" elseif t == "self" then s = "Take " .. numText(eff.n) .. " damage" end
		if eff.hits then s ..= " " .. numText(eff.hits) .. " times" end
		return s
	elseif op == "block" then return "Gain " .. numText(eff.n) .. " Block"
	elseif op == "draw" then return "Draw " .. numText(eff.n) .. plural(eff.n, " card", " cards")
	elseif op == "energy" then return "Gain " .. numText(eff.n) .. " Energy"
	elseif op == "heal" then return "Heal " .. numText(eff.n) .. " HP"
	elseif op == "lose_hp" then return "Lose " .. numText(eff.n) .. " HP"
	elseif op == "gold" then return "Gain " .. numText(eff.n) .. " Gold"
	elseif op == "max_hp" then return "Gain " .. numText(eff.n) .. " Max HP"
	elseif op == "apply" then
		if t == "self" then return "Gain " .. numText(eff.n) .. " " .. cap(eff.status) end
		return "Apply " .. numText(eff.n) .. " " .. cap(eff.status) .. (if t == "all" then " to ALL enemies" elseif t == "random" then " to a random enemy" else "")
	elseif op == "remove" then return "Remove " .. cap(eff.status)
	elseif op == "double" then return "Double " .. (if t == "self" then "your " else "the enemy's ") .. cap(eff.status)
	elseif op == "discard" then return "Discard " .. numText(eff.n) .. plural(eff.n, " random card", " random cards")
	elseif op == "exhaust" then return "Exhaust " .. numText(eff.n) .. plural(eff.n, " random card", " random cards")
	elseif op == "add" then
		local cd = C and C.cards[eff.card]
		return "Add " .. numText(eff.n) .. " " .. (if cd then cd.name else eff.card) .. " into your " .. (if eff.pile == "draw" then "draw pile" elseif eff.pile == "discard" then "discard pile" else eff.pile)
	elseif op == "upgrade" then return if eff.which == "hand" then "Upgrade ALL cards in your hand" else "Upgrade a random card in your hand"
	elseif op == "relic" then return "Obtain " .. (if eff.relic == "random" then "a random relic" else eff.relic)
	elseif op == "card" then return "Obtain " .. (if eff.card == "random" then "a random card" else eff.card)
	elseif op == "remove_card" then return "Remove " .. numText(eff.n) .. plural(eff.n, " card", " cards") .. " from your deck"
	elseif op == "upgrade_deck" then return "Upgrade " .. numText(eff.n) .. " random" .. plural(eff.n, " card", " cards")
	end
	return eff.src or op
end

-- auto-upgrade: first damage/block +3, else first number +1
local function autoUpgrade(effects)
	local out = table.clone(effects)
	for i, s in out do
		if type(s) == "string" then
			local verb, num = string.match(s, "^(%a[%w_]*) (%d+)")
			if verb == "damage" or verb == "block" then
				out[i] = string.gsub(s, "^(%a[%w_]*) (%d+)", function(v, d) return v .. " " .. (tonumber(d) + 3) end, 1)
				return out
			end
		end
	end
	for i, s in out do
		if type(s) == "string" and string.match(s, "^apply %a[%w_]* %d+") then
			out[i] = string.gsub(s, "^apply (%a[%w_]*) (%d+)", function(st, d) return "apply " .. st .. " " .. (tonumber(d) + 1) end, 1)
			return out
		end
		if type(s) == "string" and string.match(s, "^(%a[%w_]*) (%d+)") then
			out[i] = string.gsub(s, "^(%a[%w_]*) (%d+)", function(v, d) return v .. " " .. (tonumber(d) + 1) end, 1)
			return out
		end
	end
	return out
end

-- card(C, id, upgraded) -> resolved def (cached): { id, name, cost, type, target, rarity, effects, exhaust, retain, ethereal, innate, text, upgraded }
function E.card(C, id, up)
	C._cardCache = C._cardCache or {}
	local key = id .. (if up then "+" else "")
	local hit = C._cardCache[key]
	if hit then return hit end
	local base = C.cards[id]
	if base == nil then error("deckbuilder: unknown card '" .. tostring(id) .. "'", 2) end
	local d = table.clone(base)
	d.upgraded = up == true
	if up then
		local u = base.upgrade
		if u then for k, v in u do d[k] = v end else d.effects = autoUpgrade(base.effects) end
		d.name = (base.name or id) .. "+"
		if u and u.text == nil then d.text = nil end
		if u == nil then d.text = nil end
	end
	if d.text == nil then
		local parts = {}
		if d.innate then table.insert(parts, "Innate.") end
		for _, e in d.effects do table.insert(parts, E.describe(e, C) .. ".") end
		if d.retain then table.insert(parts, "Retain.") end
		if d.ethereal then table.insert(parts, "Ethereal.") end
		if d.exhaust then table.insert(parts, "Exhaust.") end
		if d.unplayable or d.cost == -1 then table.insert(parts, "Unplayable.") end
		d.text = table.concat(parts, " ")
	end
	C._cardCache[key] = d
	return d
end

function E.canUpgrade(C, id, up)
	if up then return false end
	local d = C.cards[id]
	return d ~= nil and d.type ~= "curse" and d.type ~= "status" and d.noUpgrade ~= true
end

return E
