--!nonstrict
-- Difficulty curve: map progress (level, wave, minutes, 0..1) to tier params.
-- difficulty.new({ tiers = { { at = 0, params = { speed = 80, count = 3, enemy = "slime" } }, { at = 10, params = {...} } },
--                  interpolate? (true: numbers lerp between tiers; others come from the lower tier),
--                  beyond? = { speed = 5 } (per unit past the last tier, linear extrapolation per key) })
local M = {}
local Dc = {}
Dc.__index = Dc
function M.new(opts)
	local tiers = table.clone(opts.tiers or {})
	if #tiers == 0 then error("difficulty.new needs tiers = { { at = 0, params = {...} }, ... }", 2) end
	table.sort(tiers, function(a, b) return a.at < b.at end)
	return setmetatable({ tiers = tiers, interpolate = opts.interpolate ~= false, beyond = opts.beyond }, Dc)
end
function Dc:tier(x: number): number
	local idx = 1
	for i, t in self.tiers do if x >= t.at then idx = i end end
	return idx
end
function Dc:at(x: number)
	local i = self:tier(x)
	local a, b = self.tiers[i], self.tiers[i + 1]
	local out = table.clone(a.params)
	if b and self.interpolate and x > a.at then
		local k = (x - a.at) / (b.at - a.at)
		for key, v in a.params do
			local w = b.params[key]
			if type(v) == "number" and type(w) == "number" then out[key] = v + (w - v) * k end
		end
	elseif not b and self.beyond and x > a.at then
		for key, per in self.beyond do
			if type(out[key]) == "number" then out[key] += per * (x - a.at) end
		end
	end
	return out
end
-- ramp(x, from, to, over, easing?) → smooth 0..1 ramp helper: from + (to-from)·ease(clamp(x/over))
function M.ramp(x: number, from: number, to: number, over: number, easing: string?)
	local t = math.clamp(x / over, 0, 1)
	if easing == "quad_in" then t = t * t elseif easing == "quad_out" then t = 1 - (1 - t) ^ 2
	elseif easing == "sine_in_out" then t = 0.5 - math.cos(t * math.pi) / 2 end
	return from + (to - from) * t
end
return M
