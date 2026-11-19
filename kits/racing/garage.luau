--!nonstrict
-- Garage: owned cars, purchases + unlock conditions (core conditions, e.g. {"level":3,"track":"driver"} or a flag),
-- per-car upgrade tracks (stat % per level, geometric cost) paid from core.wallet. Saved as core save section "garage".
local CarM = require("./car")
local M = {}
local G = {}
G.__index = G

M.UPGRADES = {
	engine = { name = "Engine", stat = "maxSpeed", pct = 0.04, levels = 5, cost = { base = 150, growth = 1.6 } },
	turbo = { name = "Turbo", stat = "accel", pct = 0.06, levels = 5, cost = { base = 120, growth = 1.6 } },
	tires = { name = "Tires", stat = "grip", pct = 0.06, levels = 5, cost = { base = 100, growth = 1.6 } },
	nitro = { name = "Nitro", stat = "nitro", pct = 0.12, levels = 5, cost = { base = 90, growth = 1.6 } },
}

local function sortedIds(map)
	local ids = {}
	for id in map do table.insert(ids, id) end
	table.sort(ids, function(a, b)
		local oa, ob = map[a].order or 0, map[b].order or 0
		if oa ~= ob then return oa < ob end
		return a < b
	end)
	return ids
end

-- new({ cars = {id = def}, upgrades? = {id = track}, currency = "coins", start? = first car, core? (auto), name? = "garage" })
function M.new(o)
	local okCore, core = pcall(require, "@kit/core")
	if not okCore then core = nil end
	core = o.core or core
	local self = setmetatable({ cars = o.cars or {}, upgrades = o.upgrades or M.UPGRADES, currency = o.currency or "coins",
		core = core, owned = {}, levels = {}, name = o.name or "garage" }, G)
	self.order = sortedIds(self.cars)
	self.upgradeOrder = sortedIds(self.upgrades)
	self.start = o.start or self.order[1]
	self:reset()
	if core and core.save and o.save ~= false then
		core.save.section(self.name, {
			serialize = function() return { o = self.owned, l = self.levels, s = self.selected } end,
			deserialize = function(_, t)
				self:reset()
				if t then
					for k, v in t.o or {} do self.owned[k] = v end
					for k, v in t.l or {} do self.levels[k] = v end
					if t.s and self.cars[t.s] then self.selected = t.s end
				end
			end,
			reset = function() self:reset() end,
		})
	end
	return self
end
function G:reset()
	self.owned, self.levels = {}, {}
	for id, d in self.cars do if d.price == nil or d.price == 0 or id == self.start then self.owned[id] = true end end
	self.selected = self.start
end

function G:owns(id: string): boolean return self.owned[id] == true end
function G:isUnlocked(id: string): boolean
	local d = self.cars[id]
	if not d then return false end
	if d.unlock == nil or self.core == nil then return true end
	return self.core.check(d.unlock)
end
function G:wallet() return self.core and self.core.wallet end
-- canBuy(id) -> ok, reason ("owned"|"locked"|"cost")
function G:canBuy(id: string)
	if self:owns(id) then return false, "owned" end
	if not self:isUnlocked(id) then return false, "locked" end
	local w = self:wallet()
	local cur = self.cars[id].currency or self.currency
	if w and not w.has(cur, self.cars[id].price or 0) then return false, "cost" end
	return true
end
function G:buy(id: string)
	local ok, why = self:canBuy(id)
	if not ok then return false, why end
	local w = self:wallet()
	if w and not w.spend(self.cars[id].currency or self.currency, self.cars[id].price or 0) then return false, "cost" end
	self.owned[id] = true
	if self.core then self.core.emit("car_bought", { car = id }) end
	return true
end
function G:select(id: string): boolean
	if not self:owns(id) then return false end
	self.selected = id
	return true
end

function G:level(car: string, up: string): number return (self.levels[car] and self.levels[car][up]) or 0 end
function G:maxLevel(car: string, up: string): number
	local d = self.cars[car]
	local caps = d and d.upgradeLevels
	return (caps and caps[up]) or self.upgrades[up].levels or 5
end
-- upgradeCost(car, up) -> amount (nil at max)
function G:upgradeCost(car: string, up: string): number?
	local u = self.upgrades[up]
	local L = self:level(car, up)
	if L >= self:maxLevel(car, up) then return nil end
	local mul = (self.cars[car] and self.cars[car].upgradeCost) or 1
	return math.floor(u.cost.base * (u.cost.growth or 1.5) ^ L * mul + 0.5)
end
function G:canUpgrade(car: string, up: string)
	if not self:owns(car) then return false, "not_owned" end
	local c = self:upgradeCost(car, up)
	if not c then return false, "max" end
	local w = self:wallet()
	if w and not w.has(self.currency, c) then return false, "cost" end
	return true
end
function G:upgrade(car: string, up: string)
	local ok, why = self:canUpgrade(car, up)
	if not ok then return false, why end
	local c = self:upgradeCost(car, up)
	local w = self:wallet()
	if w and not w.spend(self.currency, c) then return false, "cost" end
	self.levels[car] = self.levels[car] or {}
	self.levels[car][up] = self:level(car, up) + 1
	if self.core then self.core.emit("car_upgraded", { car = car, upgrade = up, level = self.levels[car][up] }) end
	return true
end
-- mods(car) -> { {stat, pct} } for Car.stats;  stats(car) -> full physics stats
function G:mods(car: string)
	local out = {}
	for _, up in self.upgradeOrder do
		local u = self.upgrades[up]
		local L = self:level(car, up)
		if L > 0 then table.insert(out, { stat = u.stat, pct = (u.pct or 0) * L, add = (u.add or 0) * L }) end
	end
	return out
end
function G:stats(car: string?) car = car or self.selected return CarM.stats(self.cars[car], self:mods(car)) end
-- rating(car) -> { speed, accel, handling, nitro } each 0..1 for stat bars (vs. opts.ref ranges)
M.RANGES = { maxSpeed = { 380, 760 }, accel = { 280, 760 }, grip = { 5, 16 }, nitro = { 1, 4 } }
function G:rating(car: string?)
	local s = self:stats(car)
	local function f(k) local r = M.RANGES[k] return math.clamp((s[k] - r[1]) / (r[2] - r[1]), 0, 1) end
	return { speed = f("maxSpeed"), accel = f("accel"), handling = f("grip"), nitro = f("nitro") }
end
-- list() -> { {id, def, owned, unlocked, selected, price} } in `order`
function G:list()
	local out = {}
	for _, id in self.order do
		local d = self.cars[id]
		table.insert(out, { id = id, def = d, owned = self:owns(id), unlocked = self:isUnlocked(id), selected = self.selected == id, price = d.price or 0 })
	end
	return out
end
return M
