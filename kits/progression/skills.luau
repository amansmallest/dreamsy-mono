--!nonstrict
-- Skill trees / unlock trees (data/skills/*.json; a game may keep several trees: skills, upgrades, map unlocks).
-- Def: { id, name, description?, icon?, branch?, tier?, pos? {x, y}, maxRank? (1),
--        cost? = number (skill points) | { points?, <currency>? } | list per rank,
--        requires? = { "id" | { id, rank } } (all), requiresAny? = { ... } (at least one),
--        condition? (core condition), effects? (core effects, applied on every rank), mods? (stat mods per rank) }
-- Non-"points" costs are paid from core.wallet (requires the core kit) or opts.wallet { canAfford, pay }.
local P = require("./shared")
local M = {}
local Tree = {}
Tree.__index = Tree

-- new({ defs = list|map, name? ("skills"), points? (0), wallet?, onUnlock?(id, rank, tree) })
function M.new(opts)
	opts = opts or {}
	local defs, order = {}, {}
	local src = opts.defs
	if src == nil and P.core then
		local kind = opts.kind or "skills"
		if #P.core.content.all(kind) == 0 then P.core.content.load(kind) end
		src = P.core.content.all(kind)
	end
	src = src or {}
	if #src > 0 then for _, d in src do defs[d.id] = d table.insert(order, d.id) end
	else
		for id, d in src do d.id = d.id or id defs[d.id] = d table.insert(order, d.id) end
		table.sort(order)
	end
	for id, d in defs do
		for _, r in d.requires or {} do
			local rid = if type(r) == "table" then r.id else r
			if not defs[rid] then error("skill \"" .. id .. "\" requires unknown skill \"" .. tostring(rid) .. "\"", 2) end
		end
	end
	local t = setmetatable({ defs = defs, order = order, name = opts.name or "skills", points = opts.points or 0, ranks = {}, spent = {}, wallet = opts.wallet, listeners = {} }, Tree)
	if opts.onUnlock then table.insert(t.listeners, opts.onUnlock) end
	return t
end

function Tree:def(id: string)
	local d = self.defs[id]
	if not d then error("unknown skill \"" .. tostring(id) .. "\"", 3) end
	return d
end
function Tree:rank(id: string): number self:def(id) return self.ranks[id] or 0 end
function Tree:has(id: string, rank: number?): boolean return self:rank(id) >= (rank or 1) end
function Tree:onUnlock(fn) table.insert(self.listeners, fn) end

-- cost(id) -> { points = n, gold = n, ... } for the next rank
function Tree:cost(id: string)
	local d = self:def(id)
	local c = d.cost
	if type(c) == "table" and #c > 0 then c = c[math.min(self:rank(id) + 1, #c)] end
	if c == nil then return {} end
	if type(c) == "number" then return { points = c } end
	return table.clone(c)
end

local function wallet(self)
	if self.wallet then return self.wallet end
	if P.core then return P.core.wallet end
	return nil
end

local function prereqOk(self, r)
	if type(r) == "table" then return self:rank(r.id) >= (r.rank or 1) end
	return self:rank(r) >= 1
end

-- canUnlock(id) -> ok, reason ("max" | "requires" | "condition" | "points" | "cost"), detail
function Tree:canUnlock(id: string)
	local d = self:def(id)
	if self:rank(id) >= (d.maxRank or 1) then return false, "max" end
	for _, r in d.requires or {} do
		if not prereqOk(self, r) then return false, "requires", (if type(r) == "table" then r.id else r) end
	end
	if d.requiresAny and #d.requiresAny > 0 then
		local any = false
		for _, r in d.requiresAny do if prereqOk(self, r) then any = true break end end
		if not any then return false, "requires" end
	end
	if d.condition ~= nil then
		if not P.core then error("skill \"" .. id .. "\" has a condition but the core kit isn't enabled", 2) end
		if not P.core.check(d.condition) then return false, "condition" end
	end
	local cost = self:cost(id)
	if (cost.points or 0) > self.points then return false, "points" end
	local other = table.clone(cost)
	other.points = nil
	if next(other) then
		local w = wallet(self)
		if not w then error("skill \"" .. id .. "\" costs currency but there is no wallet (enable the core kit or pass opts.wallet)", 2) end
		if not w.canAfford(other) then return false, "cost" end
	end
	return true
end

function Tree:unlock(id: string, free: boolean?)
	if not free then
		local ok, why, detail = self:canUnlock(id)
		if not ok then return false, why, detail end
	elseif self:rank(id) >= (self:def(id).maxRank or 1) then return false, "max" end
	local d = self:def(id)
	if not free then
		local cost = self:cost(id)
		self.points -= cost.points or 0
		local other = table.clone(cost)
		other.points = nil
		if next(other) then wallet(self).pay(other) end
		local sp = self.spent[id] or {}
		for k, v in cost do sp[k] = (sp[k] or 0) + v end
		self.spent[id] = sp
	end
	self.ranks[id] = self:rank(id) + 1
	local r = self.ranks[id]
	if d.effects and P.core then P.core.apply(d.effects, { skill = id, rank = r }) end
	for _, f in self.listeners do f(id, r, self) end
	if P.core then P.core.events.emit("skill_unlocked", { skill = id, rank = r, tree = self.name }) end
	return true
end

function Tree:addPoints(n: number) self.points += n end

-- available() -> ids unlockable right now; list(branch?) -> { {id, def, rank, state = "owned"|"max"|"available"|"unaffordable"|"locked", reason} }
function Tree:available()
	local out = {}
	for _, id in self.order do if self:canUnlock(id) then table.insert(out, id) end end
	return out
end
function Tree:list(branch: string?)
	local out = {}
	for _, id in self.order do
		local d = self.defs[id]
		if branch == nil or d.branch == branch then
			local ok, why = self:canUnlock(id)
			local r = self:rank(id)
			local state = if why == "max" then "max" elseif ok then "available" elseif r > 0 then "owned" elseif why == "points" or why == "cost" then "unaffordable" else "locked"
			table.insert(out, { id = id, def = d, rank = r, state = state, reason = why })
		end
	end
	return out
end
-- mods() -> stat modifiers from all owned ranks (def.mods = list applied per rank) for stats.apply
function Tree:mods()
	local out = {}
	for _, id in self.order do
		local d, r = self.defs[id], self.ranks[id] or 0
		for _ = 1, r do for _, m in d.mods or {} do table.insert(out, m) end end
	end
	return out
end
-- respec(refundPct? = 1): resets ranks, refunds spent points (+ currencies through the wallet)
function Tree:respec(refund: number?)
	refund = refund or 1
	local w = wallet(self)
	for id, sp in self.spent do
		for k, v in sp do
			local back = math.floor(v * refund)
			if k == "points" then self.points += back elseif w then w.add(k, back) end
		end
	end
	self.ranks, self.spent = {}, {}
end
function Tree:serialize() return { p = self.points, r = table.clone(self.ranks), s = table.clone(self.spent) } end
function Tree:deserialize(t)
	t = t or {}
	self.points = t.p or 0
	self.ranks = {}
	for id, r in t.r or {} do if self.defs[id] then self.ranks[id] = r end end
	self.spent = table.clone(t.s or {})
end
function Tree:reset() self:deserialize(nil) end
return M
