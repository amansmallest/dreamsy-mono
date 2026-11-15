--!nonstrict
-- Prestige / rebirth layers.
-- prestige.new({ name?, threshold (1e6), exponent (0.5), scale (1), bonusPer (0.1 → +10% per point), multiplier?(points) -> number,
--                onPrestige?(gained, layer) })
-- gain(x) = floor(scale · (x / threshold)^exponent) − (claimed points if cumulative = true)
local M = {}
local Layer = {}
Layer.__index = Layer

function M.new(opts)
	opts = opts or {}
	return setmetatable({
		name = opts.name or "prestige", threshold = opts.threshold or 1e6, exponent = opts.exponent or 0.5,
		scale = opts.scale or 1, bonusPer = opts.bonusPer or 0.1, multFn = opts.multiplier, cumulative = opts.cumulative == true,
		points = 0, total = 0, count = 0, listeners = {}, onPrestigeFn = opts.onPrestige,
	}, Layer)
end
-- pending(x): points a prestige would give for x (e.g. lifetime earnings this run)
function Layer:pending(x: number): number
	if x < self.threshold then return 0 end
	local g = math.floor(self.scale * (x / self.threshold) ^ self.exponent)
	if self.cumulative then g -= self.total end
	return math.max(0, g)
end
-- nextAt(x): x needed for one more point than pending(x)
function Layer:nextAt(x: number): number
	local want = self:pending(x) + 1 + (if self.cumulative then self.total else 0)
	return self.threshold * (want / self.scale) ^ (1 / self.exponent)
end
function Layer:multiplier(points: number?): number
	points = points or self.points
	if self.multFn then return self.multFn(points) end
	return 1 + points * self.bonusPer
end
-- prestige(x, resetFn?) -> gained (0 = not allowed; nothing happens)
function Layer:prestige(x: number, resetFn): number
	local g = self:pending(x)
	if g <= 0 then return 0 end
	self.points += g
	self.total += g
	self.count += 1
	if resetFn then resetFn(g, self) end
	if self.onPrestigeFn then self.onPrestigeFn(g, self) end
	return g
end
function Layer:spend(n: number): boolean
	if self.points < n then return false end
	self.points -= n
	return true
end
function Layer:serialize() return { p = self.points, t = self.total, c = self.count } end
function Layer:deserialize(t)
	t = t or {}
	self.points, self.total, self.count = t.p or 0, t.t or 0, t.c or 0
end
function Layer:reset() self:deserialize(nil) end
return M
