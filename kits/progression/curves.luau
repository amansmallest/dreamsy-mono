--!nonstrict
-- XP/level curves. total(L) = XP needed to reach level L from level 1 (total(1) = 0).
-- spec: { kind = "linear" | "quadratic" | "exponential" | "power" | "table" | "custom", base?, growth?, exponent?,
--         linear? (quadratic: extra linear term), table? (totals, table[1] = 0), fn? (custom: fn(L) -> total),
--         maxLevel? (default 99, or #table), round? (default true) }
--   linear      total = base·(L−1)                         (every level costs `base`)
--   quadratic   total = base·(L−1)² + linear·(L−1)
--   exponential toNext(L) = base·growth^(L−1)              (growth default 1.15)
--   power       total = base·(L−1)^exponent                 (exponent default 1.5)
local M = {}
local Curve = {}
Curve.__index = Curve

function M.new(spec)
	if getmetatable(spec) == Curve then return spec end
	spec = spec or {}
	local kind = spec.kind or "quadratic"
	local base = spec.base or 100
	local c = setmetatable({ kind = kind, spec = spec, maxLevel = spec.maxLevel or (if spec.table then #spec.table else 99), round = spec.round ~= false, cache = {} }, Curve)
	local raw
	if kind == "linear" then raw = function(L) return base * (L - 1) end
	elseif kind == "quadratic" then local lin = spec.linear or 0 raw = function(L) return base * (L - 1) ^ 2 + lin * (L - 1) end
	elseif kind == "exponential" then
		local g = spec.growth or 1.15
		raw = function(L) if g == 1 then return base * (L - 1) end return base * (g ^ (L - 1) - 1) / (g - 1) end
	elseif kind == "power" then local e = spec.exponent or 1.5 raw = function(L) return base * (L - 1) ^ e end
	elseif kind == "table" then
		local t = spec.table
		if type(t) ~= "table" or t[1] ~= 0 then error("curve table: list of total XP per level starting with 0 (level 1)", 2) end
		raw = function(L) return t[math.clamp(L, 1, #t)] end
	elseif kind == "custom" then
		if type(spec.fn) ~= "function" then error("curve custom: pass fn(level) -> total xp", 2) end
		raw = spec.fn
	else error("curve kind must be linear|quadratic|exponential|power|table|custom", 2) end
	c.raw = raw
	return c
end

function Curve:total(level: number): number
	level = math.clamp(math.floor(level), 1, self.maxLevel)
	local v = self.cache[level]
	if v == nil then
		v = self.raw(level)
		if self.round then v = math.floor(v + 0.5) end
		self.cache[level] = v
	end
	return v
end
function Curve:toNext(level: number): number
	if level >= self.maxLevel then return math.huge end
	return self:total(level + 1) - self:total(level)
end
-- levelAt(xp) -> level reached with that much total xp
function Curve:levelAt(xp: number): number
	local lo, hi = 1, self.maxLevel
	while lo < hi do
		local mid = math.floor((lo + hi + 1) / 2)
		if self:total(mid) <= xp then lo = mid else hi = mid - 1 end
	end
	return lo
end
-- progress(xp) -> level, xpIntoLevel, xpForLevel, fraction (0..1; 1 at max level)
function Curve:progress(xp: number)
	local L = self:levelAt(xp)
	if L >= self.maxLevel then return L, 0, 0, 1 end
	local into, need = xp - self:total(L), self:toNext(L)
	return L, into, need, into / need
end
-- table(n?) -> { {level, total, toNext} } for docs / balance printouts
function Curve:rows(n: number?)
	local out = {}
	for L = 1, math.min(n or self.maxLevel, self.maxLevel) do table.insert(out, { level = L, total = self:total(L), toNext = self:toNext(L) }) end
	return out
end

-- leveler: tracks xp/level on a curve.
-- prog.leveler({ curve = spec|curve, name? (registry + core "xp"/"level" kinds; default "player"), xp?, onLevelUp?(level, gained, lv) })
local Leveler = {}
Leveler.__index = Leveler
function M.leveler(opts)
	opts = opts or {}
	local lv = setmetatable({ curve = M.new(opts.curve or {}), name = opts.name or "player", xp = opts.xp or 0, listeners = {} }, Leveler)
	if opts.onLevelUp then table.insert(lv.listeners, opts.onLevelUp) end
	lv.level = lv.curve:levelAt(lv.xp)
	return lv
end
function Leveler:onLevelUp(fn) table.insert(self.listeners, fn) end
-- add(xp) -> levels gained
function Leveler:add(n: number): number
	if n <= 0 then return 0 end
	local before = self.level
	local cap = self.curve:total(self.curve.maxLevel)
	self.xp = math.min(self.xp + n, cap)
	self.level = self.curve:levelAt(self.xp)
	local gained = self.level - before
	if gained > 0 then
		for _, f in self.listeners do f(self.level, gained, self) end
	end
	return gained
end
function Leveler:setLevel(L: number)
	self.xp = self.curve:total(L)
	self.level = self.curve:levelAt(self.xp)
end
function Leveler:progress() return self.curve:progress(self.xp) end
function Leveler:isMax() return self.level >= self.curve.maxLevel end
function Leveler:serialize() return { xp = self.xp } end
function Leveler:deserialize(t)
	self.xp = if t and t.xp then t.xp else 0
	self.level = self.curve:levelAt(self.xp)
end
function Leveler:reset() self:deserialize(nil) end
return M
