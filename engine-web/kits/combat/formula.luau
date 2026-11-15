-- Turn-based damage helpers (RPGs, deckbuilders, autobattlers). Pure functions.
local F = {}

-- type chart: { fire = { grass = 2, water = 0.5 }, ... } -> mult(attackType, defenderTypes) (missing = 1)
function F.typeChart(chart: any): any
	local tc = {}
	function tc.mult(atk: string?, defTypes: any): number
		if atk == nil then return 1 end
		if type(defTypes) == "string" then defTypes = { defTypes } end
		local row = chart[atk] or {}
		local m = 1
		for _, d in defTypes or {} do m *= row[d] or 1 end
		return m
	end
	function tc.label(m: number): string?
		if m == 0 then return "immune" elseif m >= 2 then return "super effective" elseif m < 1 then return "not very effective" end
		return nil
	end
	return tc
end

--[[ damage(a) -> amount, info
   a: { power = 40, attack = 10, defense = 10, level = 5, typeMult = 1, stab = false (x1.5 same-type bonus),
        crit = bool | nil (rolled with critChance using rand), critChance = 1/16, critMult = 1.5,
        variance = 0.15 (random 85..100%), rand = fn() -> [0,1) (default math.random), flat = 0, min = 1,
        style = "pokemon" (level-scaled) | "simple" (power * atk / def) | "subtract" (atk + power - def) } ]]
function F.damage(a: any): (number, any)
	local rand = a.rand or math.random
	local power, atk, def = a.power or 40, a.attack or 10, math.max(1, a.defense or 10)
	local base
	local style = a.style or "pokemon"
	if style == "simple" then
		base = power * atk / def / 2
	elseif style == "subtract" then
		base = atk + power - def
	else
		local lvl = a.level or 5
		base = ((2 * lvl / 5 + 2) * power * atk / def) / 50 + 2
	end
	local crit = a.crit
	if crit == nil then crit = rand() < (a.critChance or 1 / 16) end
	local mult = (a.typeMult or 1) * (if a.stab then 1.5 else 1) * (if crit then (a.critMult or 1.5) else 1)
	local variance = a.variance or 0.15
	local roll = 1 - variance + rand() * variance
	local amount = math.floor(base * mult * roll + (a.flat or 0))
	if (a.typeMult or 1) == 0 then amount = 0 elseif amount < (a.min or 1) then amount = a.min or 1 end
	return amount, { crit = crit, mult = mult, roll = roll, base = base }
end

-- accuracy check: hit if rand < accuracy * acc / eva (stages are plain multipliers)
function F.hits(accuracy: number?, acc: number?, eva: number?, rand: any?): boolean
	local r = (rand or math.random)()
	return r < (accuracy or 1) * (acc or 1) / math.max(0.01, eva or 1)
end

-- stat at level: base * (1 + growth)^(level-1) (rounded)
function F.stat(base: number, level: number, growth: number?): number
	return math.floor(base * (1 + (growth or 0.08)) ^ (level - 1) + 0.5)
end

-- xp curve: xp needed to reach `level` (cubic-ish): k * level^p
function F.xpFor(level: number, k: number?, p: number?): number
	return math.floor((k or 10) * level ^ (p or 2.4))
end

-- turn order: list of units with `speed` -> sorted copy (ties by `id` / original order)
function F.turnOrder(units: { any }): { any }
	local list = {}
	for i, u in units do table.insert(list, { u = u, i = i }) end
	table.sort(list, function(a, b)
		if (a.u.speed or 0) ~= (b.u.speed or 0) then return (a.u.speed or 0) > (b.u.speed or 0) end
		return a.i < b.i
	end)
	local out = {}
	for _, x in list do table.insert(out, x.u) end
	return out
end

return F
