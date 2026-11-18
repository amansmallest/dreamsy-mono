--!nonstrict
-- Conditions + effects: the tiny data language shared by quests, dialog, achievements, items, skills.
-- A condition is a table (or a list = all of them). Effects are a list of tables (or one table).
local S = require("./shared")
local M = {}
local condKinds: { [string]: (any, any) -> boolean } = {}
local effectKinds: { [string]: (any, any) -> () } = {}
local condOrder: { string } = {}
local effectOrder: { string } = {}

-- numeric/equality comparison on v using the condition's eq/ne/gt/gte/lt/lte (default: truthy / gte 1 for numbers)
function M.compare(v, c, defaultGte: number?)
	local any = false
	if c.eq ~= nil then any = true if v ~= c.eq then return false end end
	if c.ne ~= nil then any = true if v == c.ne then return false end end
	local n = if type(v) == "number" then v else 0
	if c.gt ~= nil then any = true if not (n > c.gt) then return false end end
	if c.gte ~= nil then any = true if not (n >= c.gte) then return false end end
	if c.lt ~= nil then any = true if not (n < c.lt) then return false end end
	if c.lte ~= nil then any = true if not (n <= c.lte) then return false end end
	if any then return true end
	if defaultGte then return n >= defaultGte end
	return v ~= nil and v ~= false and v ~= 0
end

-- register a condition kind: the condition table's key `kind` selects fn(cond, ctx) -> boolean
function M.registerCondition(kind: string, fn)
	if condKinds[kind] == nil then table.insert(condOrder, kind) end
	condKinds[kind] = fn
end
-- register an effect kind: fn(effect, ctx)
function M.registerEffect(kind: string, fn)
	if effectKinds[kind] == nil then table.insert(effectOrder, kind) end
	effectKinds[kind] = fn
end

local function kindOf(t, kinds, order)
	for _, k in order do if t[k] ~= nil then return k end end
	return nil
end

function M.check(cond, ctx): boolean
	if cond == nil then return true end
	if type(cond) == "boolean" then return cond end
	if type(cond) == "function" then return cond(ctx) == true end
	if type(cond) ~= "table" then error("condition must be a table, got " .. type(cond), 2) end
	if #cond > 0 then
		for _, c in cond do if not M.check(c, ctx) then return false end end
		return true
	end
	if next(cond) == nil then return true end
	local k = kindOf(cond, condKinds, condOrder)
	if not k then
		local keys = {}
		for key in cond do table.insert(keys, tostring(key)) end
		error("unknown condition {" .. table.concat(keys, ", ") .. "} (kinds: " .. table.concat(condOrder, ", ") .. ")", 2)
	end
	return condKinds[k](cond, ctx) == true
end

-- why(cond) -> list of failing leaf conditions (for "locked: need 3 apples" UIs)
function M.failing(cond, ctx, out)
	out = out or {}
	if cond == nil or type(cond) ~= "table" then return out end
	if #cond > 0 then
		for _, c in cond do M.failing(c, ctx, out) end
	elseif not M.check(cond, ctx) then
		table.insert(out, cond)
	end
	return out
end

function M.apply(effects, ctx)
	if effects == nil then return end
	if type(effects) == "function" then effects(ctx) return end
	if type(effects) ~= "table" then error("effects must be a list of tables", 2) end
	if #effects == 0 then
		if next(effects) == nil then return end
		effects = { effects }
	end
	for _, e in effects do
		if type(e) == "function" then e(ctx)
		else
			local k = kindOf(e, effectKinds, effectOrder)
			if not k then
				local keys = {}
				for key in e do table.insert(keys, tostring(key)) end
				error("unknown effect {" .. table.concat(keys, ", ") .. "} (kinds: " .. table.concat(effectOrder, ", ") .. ")", 2)
			end
			effectKinds[k](e, ctx)
		end
	end
end

function M.kinds() return { conditions = table.clone(condOrder), effects = table.clone(effectOrder) } end

-- ---------- built-in conditions ----------
local function bagFor(c)
	local inv = c.inventory and S.inventory.get(c.inventory) or S.bag
	if not inv then error("condition item: no inventory \"" .. tostring(c.inventory) .. "\"", 4) end
	return inv
end
M.registerCondition("all", function(c, ctx)
	for _, x in c.all do if not M.check(x, ctx) then return false end end
	return true
end)
M.registerCondition("any", function(c, ctx)
	for _, x in c.any do if M.check(x, ctx) then return true end end
	return false
end)
M.registerCondition("not", function(c, ctx) return not M.check(c["not"], ctx) end)
M.registerCondition("flag", function(c) return M.compare(S.flags.get(c.flag), c) end)
M.registerCondition("item", function(c) return M.compare(bagFor(c):count(c.item), c, c.count or 1) end)
M.registerCondition("currency", function(c) return M.compare(S.wallet.get(c.currency), c, c.amount or 1) end)
M.registerCondition("quest", function(c)
	local st = S.quests.status(c.quest)
	if c.step ~= nil then
		local step = S.quests.step(c.quest)
		return st == "active" and step ~= nil and step.id == c.step
	end
	local want = c.is or "done"
	if want == "started" then return st ~= "inactive" end
	if want == "available" then return S.quests.canStart(c.quest) end
	return st == want
end)
M.registerCondition("achievement", function(c) return S.achievements.isUnlocked(c.achievement) end)
M.registerCondition("seen", function(c) return S.dialog.seen(c.seen) end)
M.registerCondition("chance", function(c) return random() < c.chance end)

-- ---------- built-in effects ----------
M.registerEffect("set", function(e) S.flags.set(e.set, if e.value == nil then true else e.value) end)
M.registerEffect("add", function(e) S.flags.add(e.add, e.value or 1) end)
M.registerEffect("give", function(e)
	local inv = e.inventory and S.inventory.get(e.inventory) or S.bag
	inv:add(e.give, e.count or 1)
end)
M.registerEffect("take", function(e)
	local inv = e.inventory and S.inventory.get(e.inventory) or S.bag
	inv:remove(e.take, math.min(e.count or 1, inv:count(e.take)))
end)
M.registerEffect("earn", function(e) S.wallet.add(e.earn, e.amount or 1) end)
M.registerEffect("spend", function(e) S.wallet.add(e.spend, -(e.amount or 1)) end)
M.registerEffect("quest", function(e)
	local a = e.action or "start"
	if a == "start" then S.quests.start(e.quest, e.force == true)
	elseif a == "complete" then S.quests.complete(e.quest)
	elseif a == "fail" then S.quests.fail(e.quest)
	elseif a == "advance" then S.quests.advance(e.quest)
	elseif a == "reset" then S.quests.reset(e.quest)
	else error("quest effect: action must be start|complete|fail|advance|reset", 3) end
end)
M.registerEffect("unlock", function(e) S.achievements.unlock(e.unlock) end)
M.registerEffect("emit", function(e) S.events.emit(e.emit, e.data or {}) end)
M.registerEffect("toast", function(e)
	if S.menus then S.menus.toast(e.toast, e.seconds) elseif ui and ui.toast then ui.toast(e.toast, e.seconds) end
end)

return M
