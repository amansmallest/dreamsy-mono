--!nonstrict
-- Multi-currency wallet (in-game currencies, never platform Stars).
-- Currency defs (optional): wallet.define("gold", { name = "Gold", icon = "asset:coin", max = 99999, start = 0 }).
-- Emits "currency_changed" {currency, amount, delta}.
local S = require("./shared")
local M = {}
local defs: { [string]: any } = {}
local bal: { [string]: number } = {}

local function emit(cur, delta)
	if delta ~= 0 and S.events then S.events.emit("currency_changed", { currency = cur, amount = bal[cur] or 0, delta = delta }) end
end
local function check(cur, n, fn)
	if type(cur) ~= "string" then error("wallet." .. fn .. " expects a currency id string", 3) end
	if n ~= nil and (type(n) ~= "number" or n ~= n) then error("wallet." .. fn .. " expects a number amount", 3) end
end

function M.define(id: string, def)
	def = def or {}
	def.id = id
	defs[id] = def
	if bal[id] == nil then bal[id] = def.start or 0 end
end
function M.defs() return table.clone(defs) end
function M.get(cur: string): number check(cur, nil, "get") return bal[cur] or 0 end
function M.add(cur: string, n: number): number
	check(cur, n, "add")
	local before = bal[cur] or 0
	local v = math.max(0, before + n)
	local max = defs[cur] and defs[cur].max
	if max then v = math.min(v, max) end
	bal[cur] = v
	emit(cur, v - before)
	return v - before
end
function M.set(cur: string, n: number)
	check(cur, n, "set")
	local before = bal[cur] or 0
	bal[cur] = math.max(0, n)
	emit(cur, bal[cur] - before)
end
function M.has(cur: string, n: number) return (bal[cur] or 0) >= n end
function M.spend(cur: string, n: number): boolean
	check(cur, n, "spend")
	if (bal[cur] or 0) < n then return false end
	bal[cur] -= n
	emit(cur, -n)
	return true
end
-- costs = { gold = 10, gems = 1 }
function M.canAfford(costs): boolean
	for c, n in costs or {} do if (bal[c] or 0) < n then return false end end
	return true
end
function M.pay(costs): boolean
	if not M.canAfford(costs) then return false end
	for c, n in costs or {} do M.spend(c, n) end
	return true
end
function M.all() return table.clone(bal) end
function M.reset()
	bal = {}
	for id, d in defs do bal[id] = d.start or 0 end
end
function M.serialize() return table.clone(bal) end
function M.deserialize(t)
	M.reset()
	for k, v in t or {} do bal[k] = v end
end
return M
