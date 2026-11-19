-- Loot tables: weighted entries, rarity tiers, nested tables, guaranteed drops, optional pity.
local RNG = require("./rng")
local L = {}

L.RARITIES = { "common", "uncommon", "rare", "epic", "legendary" }
local RANK = {}
for i, r in L.RARITIES do RANK[r] = i end

local function count(spec, rng)
	if spec == nil then return 1 end
	if type(spec) == "number" then return spec end
	return rng:int(spec[1] or spec.min or 1, spec[2] or spec.max or 1)
end

--[[ table: { id?, rolls = 1 | {min,max}, entries = { entry }, guaranteed = { entry }?,
              rarities = { common = 60, rare = 30, ... }? (pick a tier first, then an entry of that tier),
              pity = { rarity = "legendary", after = 30 }? (guarantee >= rarity after N rolls without one) }
   entry: { item = "id", weight = 1, count = n | {min,max}, rarity = "common", chance? (independent 0..1, ignores weight) }
        | { table = "other_table_id" (nested; needs `tables` lookup), weight } | { nothing = true, weight }
   roll(t, rng|seed, { tables = { id -> table }, state = {} (pity counters; keep across rolls) })
   -> { {item, count, rarity} } (merged by item) ]]
function L.roll(t: any, rngOrSeed: any?, opts: any?): { any }
	opts = opts or {}
	local rng = RNG.from(rngOrSeed)
	local out = {}
	local function addDrop(e, n)
		if n <= 0 then return end
		for _, d in out do
			if d.item == e.item then d.count += n return end
		end
		table.insert(out, { item = e.item, count = n, rarity = e.rarity or "common" })
	end
	local function resolve(e, depth)
		if e == nil or e.nothing then return end
		if e.table then
			assert(depth < 8, "loot: nested tables too deep")
			local sub = (opts.tables or {})[e.table]
			assert(sub, `loot: unknown table "{e.table}" (pass opts.tables)`)
			for _, d in L.roll(sub, rng, { tables = opts.tables, state = opts.state, depth = depth + 1 }) do addDrop(d, d.count) end
			for _ = 2, count(e.count, rng) do
				for _, d in L.roll(sub, rng, { tables = opts.tables, state = opts.state, depth = depth + 1 }) do addDrop(d, d.count) end
			end
			return
		end
		addDrop(e, count(e.count, rng))
	end
	local depth = opts.depth or 0
	for _, e in t.guaranteed or {} do resolve(e, depth) end
	-- independent-chance entries
	local weighted = {}
	for _, e in t.entries or {} do
		if e.chance ~= nil then
			if rng:chance(e.chance) then resolve(e, depth) end
		else
			table.insert(weighted, e)
		end
	end
	if #weighted == 0 then return out end
	local state = opts.state
	local pity = t.pity
	local pkey = if pity then (t.id or "table") .. ":" .. pity.rarity else nil
	for _ = 1, count(t.rolls, rng) do
		local pool = weighted
		-- pity: force the tier when the counter is due
		if pity and state and (state[pkey] or 0) >= pity.after - 1 then
			local forced = {}
			for _, e in weighted do if (RANK[e.rarity or "common"] or 1) >= (RANK[pity.rarity] or 99) then table.insert(forced, e) end end
			if #forced > 0 then pool = forced end
		elseif t.rarities then
			local tiers = {}
			for _, e in weighted do tiers[e.rarity or "common"] = t.rarities[e.rarity or "common"] or 0 end
			local tier = rng:weighted(tiers)
			local inTier = {}
			for _, e in weighted do if (e.rarity or "common") == tier then table.insert(inTier, e) end end
			if #inTier > 0 then pool = inTier end
		end
		local e = rng:weighted(pool)
		if pity and state then
			if e and (RANK[e.rarity or "common"] or 1) >= (RANK[pity.rarity] or 99) then state[pkey] = 0 else state[pkey] = (state[pkey] or 0) + 1 end
		end
		resolve(e, depth)
	end
	return out
end

-- expected probability of each item per roll (single-level, weights only; ignores pity/chance/nesting): { item -> p }
function L.odds(t: any): { [string]: number }
	local res = {}
	local weighted = {}
	for _, e in t.entries or {} do if e.chance == nil then table.insert(weighted, e) end end
	if t.rarities then
		local present, tierTotal = {}, 0
		for _, e in weighted do
			local r = e.rarity or "common"
			if not present[r] then present[r] = 0 tierTotal += t.rarities[r] or 0 end
			present[r] += e.weight or 1
		end
		for _, e in weighted do
			local r = e.rarity or "common"
			local key = e.item or e.table or "nothing"
			res[key] = (res[key] or 0) + ((t.rarities[r] or 0) / tierTotal) * ((e.weight or 1) / present[r])
		end
	else
		local total = 0
		for _, e in weighted do total += e.weight or 1 end
		for _, e in weighted do
			local key = e.item or e.table or "nothing"
			res[key] = (res[key] or 0) + (e.weight or 1) / total
		end
	end
	return res
end

return L
