--!nonstrict
-- Stat scaling + modifier helpers.
local M = {}
function M.linear(base: number, per: number, level: number) return base + per * (level - 1) end
function M.percent(base: number, pct: number, level: number) return base * (1 + pct * (level - 1)) end
function M.compound(base: number, rate: number, level: number) return base * (1 + rate) ^ (level - 1) end
-- diminishing(x, cap, half): approaches cap; half = x where result = cap/2 (crit chance, dodge, speed caps)
function M.diminishing(x: number, cap: number, half: number) return cap * x / (x + half) end

-- block(spec, level) -> table. spec = { hp = { base = 20, per = 5 }, atk = { base = 4, growth = 0.08 },
--   spd = { base = 10, pct = 0.02 }, crit = 0.05 (constant) }; per → linear, growth → compound, pct → percent.
-- round = true (default) floors values ≥ 1 that came from integer bases.
function M.block(spec, level: number, round: boolean?)
	local out = {}
	for k, s in spec do
		local v
		if type(s) == "number" then v = s
		elseif s.per then v = M.linear(s.base or 0, s.per, level)
		elseif s.growth then v = M.compound(s.base or 0, s.growth, level)
		elseif s.pct then v = M.percent(s.base or 0, s.pct, level)
		else v = s.base or 0 end
		if type(s) == "table" and s.max then v = math.min(v, s.max) end
		if round ~= false and type(s) == "table" and math.floor(s.base or 0) == (s.base or 0) then v = math.floor(v) end
		out[k] = v
	end
	return out
end

-- apply(stats, mods) -> new table. mods = { { stat = "atk", add = 3 }, { stat = "atk", pct = 0.1 }, { stat = "hp", mul = 2 } }
-- final = (base + Σadd) · (1 + Σpct) · Πmul
function M.apply(stats, mods)
	local add, pct, mul = {}, {}, {}
	for _, m in mods or {} do
		local k = m.stat
		if m.add then add[k] = (add[k] or 0) + m.add end
		if m.pct then pct[k] = (pct[k] or 0) + m.pct end
		if m.mul then mul[k] = (mul[k] or 1) * m.mul end
	end
	local out = table.clone(stats)
	local keys = {}
	for k in add do keys[k] = true end
	for k in pct do keys[k] = true end
	for k in mul do keys[k] = true end
	for k in stats do keys[k] = true end
	for k in keys do
		out[k] = ((stats[k] or 0) + (add[k] or 0)) * (1 + (pct[k] or 0)) * (mul[k] or 1)
	end
	return out
end
return M
