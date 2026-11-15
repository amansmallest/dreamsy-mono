-- Seeded RNG (L'Ecuyer combined LCG; exact in doubles, identical on every platform).
-- Independent of the engine's random(): same seed => same output everywhere (tests, harness, server).
local RNG = {}
RNG.__index = RNG

local M1, A1, M2, A2 = 2147483563, 40014, 2147483399, 40692

local function hashString(s: string): number
	local h = 5381
	for i = 1, #s do
		h = (h * 33 + string.byte(s, i)) % 2147483629
	end
	return h
end

local function toSeed(seed: any): number
	if type(seed) == "string" then return hashString(seed) end
	if type(seed) ~= "number" then return 12345 end
	seed = math.floor(math.abs(seed)) % 2147483000
	return seed
end

function RNG.new(seed: any)
	local s = toSeed(seed)
	local self = setmetatable({ seed = seed, s1 = (s % (M1 - 1)) + 1, s2 = ((s * 7 + 13) % (M2 - 1)) + 1 }, RNG)
	for _ = 1, 4 do self:next() end -- warm up
	return self
end

-- [0, 1)
function RNG:next(): number
	self.s1 = (self.s1 * A1) % M1
	self.s2 = (self.s2 * A2) % M2
	local z = (self.s1 - self.s2) % (M1 - 1)
	return z / (M1 - 1)
end

-- integer in [a, b] inclusive (int(n) = [1, n])
function RNG:int(a: number, b: number?): number
	if b == nil then a, b = 1, a end
	return a + math.floor(self:next() * (b - a + 1))
end

function RNG:range(a: number, b: number): number return a + self:next() * (b - a) end
function RNG:chance(p: number): boolean return self:next() < p end
function RNG:sign(): number return if self:next() < 0.5 then -1 else 1 end

function RNG:pick(list: { any }): any
	if #list == 0 then return nil end
	return list[self:int(1, #list)]
end

-- weighted pick: list of items with `weight` field (or weightFn(item)), or a map {key = weight} (returns key).
function RNG:weighted(items: any, weightFn: any?): any
	if #items == 0 and next(items) ~= nil then
		local keys = {}
		for k in items do table.insert(keys, k) end
		table.sort(keys, function(x, y) return tostring(x) < tostring(y) end)
		local total = 0
		for _, k in keys do total += math.max(0, items[k]) end
		if total <= 0 then return nil end
		local r = self:next() * total
		for _, k in keys do
			r -= math.max(0, items[k])
			if r < 0 then return k end
		end
		return keys[#keys]
	end
	local total = 0
	local function w(it)
		if weightFn then return math.max(0, weightFn(it)) end
		if type(it) == "table" then return math.max(0, it.weight or 1) end
		return 1
	end
	for _, it in items do total += w(it) end
	if total <= 0 then return nil end
	local r = self:next() * total
	for _, it in items do
		r -= w(it)
		if r < 0 then return it end
	end
	return items[#items]
end

function RNG:shuffle(list: { any }): { any }
	for i = #list, 2, -1 do
		local j = self:int(1, i)
		list[i], list[j] = list[j], list[i]
	end
	return list
end

-- n distinct items from list (no repeats)
function RNG:sample(list: { any }, n: number): { any }
	local copy = table.clone(list)
	self:shuffle(copy)
	local out = {}
	for i = 1, math.min(n, #copy) do out[i] = copy[i] end
	return out
end

function RNG:gauss(mean: number?, sd: number?): number
	local u = math.max(self:next(), 1e-9)
	local v = self:next()
	return (mean or 0) + (sd or 1) * math.sqrt(-2 * math.log(u)) * math.cos(2 * math.pi * v)
end

-- independent child stream: rng:fork("enemies") never shifts the parent's other draws if order changes later
function RNG:fork(label: any?): any
	local base = tostring(self.seed) .. "/" .. tostring(label or self:int(1, 1e9))
	return RNG.new(base)
end

-- fresh copy with identical state
function RNG:clone(): any
	return setmetatable({ seed = self.seed, s1 = self.s1, s2 = self.s2 }, RNG)
end

return {
	new = RNG.new,
	hash = hashString,
	-- accept an rng, a seed (number|string) or nil (=> engine random())
	from = function(x: any): any
		if type(x) == "table" and getmetatable(x) == RNG then return x end
		if x == nil then return RNG.new(math.floor(random(0, 2147483000))) end
		return RNG.new(x)
	end,
	class = RNG,
}
