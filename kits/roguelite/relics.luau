--!nonstrict
-- Relics (passives), synergies and the stat stack. Pure: works on any run-like table
-- { classId, relics = { {id, count} }, heat, metaMods? }.
-- Stat formula (progression kit): (base + Σadd)·(1 + Σpct)·Πmul over every mod source:
--   class.mods, meta tree mods, relic mods × copies, active synergy mods, heat mods.
local S = require("./state")
local M = {}

-- tag counts over owned relics (copies count)
function M.tagCounts(relics)
	local out = {}
	for _, r in relics do
		local d = S.get("relics", r.id)
		if d then for _, t in d.tags or {} do out[t] = (out[t] or 0) + r.count end end
	end
	return out
end

local function owns(relics, id)
	for _, r in relics do if r.id == id then return r.count end end
	return 0
end
M.owns = owns

-- active synergies: list of { def, tier (1-based), mods, triggers }
-- synergy def: { name, description?, tags = { fire = 3 } (all must hold) | relics = { "a", "b" } (all owned),
--               mods?, triggers?, tiers? = { { count = 2, mods, triggers }, { count = 4, mods } } (tag count of the first tag) }
function M.synergies(relics)
	local counts = M.tagCounts(relics)
	local out = {}
	for _, d in S.all("synergies") do
		local ok = true
		for _, rid in d.relics or {} do if owns(relics, rid) == 0 then ok = false end end
		if d.tiers then
			local tag = next(d.tags or {})
			local n = if tag then counts[tag] or 0 else 0
			local best = nil
			for i, t in d.tiers do if n >= t.count then best = i end end
			if ok and best then
				local mods, trig = {}, {}
				for i = 1, best do
					for _, m in d.tiers[i].mods or {} do table.insert(mods, m) end
					for _, t in d.tiers[i].triggers or {} do table.insert(trig, t) end
				end
				table.insert(out, { def = d, tier = best, mods = mods, triggers = trig })
			end
		else
			for tag, need in d.tags or {} do if (counts[tag] or 0) < need then ok = false end end
			if ok then table.insert(out, { def = d, tier = 1, mods = d.mods or {}, triggers = d.triggers or {} }) end
		end
	end
	return out
end

-- every stat mod affecting the run, in source order (for UIs: { source, mod })
function M.modList(run)
	local list = {}
	local function addAll(src, mods, times)
		for _ = 1, times or 1 do for _, m in mods or {} do table.insert(list, { source = src, mod = m }) end end
	end
	local cls = run.classId and S.get("classes", run.classId)
	if cls then addAll("class:" .. cls.id, cls.mods) end
	for _, m in run.metaMods or {} do table.insert(list, { source = "meta", mod = m }) end
	for _, r in run.relics do
		local d = S.get("relics", r.id)
		if d then
			local copies = r.count
			if d.stack == false then copies = 1 end
			addAll("relic:" .. r.id, d.mods, copies)
		end
	end
	for _, s in M.synergies(run.relics) do addAll("synergy:" .. s.def.id, s.mods) end
	local heat = S.config.heat or {}
	for i = 1, math.min(run.heat or 0, #heat) do addAll("heat:" .. i, heat[i].mods) end
	return list
end

-- stats(run) -> table of final stats (base = config.baseStats overlaid by class.stats)
function M.stats(run)
	local base = table.clone(S.config.baseStats)
	local cls = run.classId and S.get("classes", run.classId)
	if cls then for k, v in cls.stats or {} do base[k] = v end end
	local mods = {}
	for _, e in M.modList(run) do table.insert(mods, e.mod) end
	local st = S.prog.stats.apply(base, mods)
	for k, v in st do if base[k] == nil and type(v) == "number" then st[k] = v end end
	st.hp = math.max(1, math.floor(st.hp + 0.5))
	st.crit = math.clamp(st.crit, 0, 1)
	st.dodge = math.clamp(st.dodge, 0, 0.75)
	return st
end

-- triggers from every source: { { trig, source } }
function M.triggers(run)
	local out = {}
	local function addAll(src, list, copies)
		for _ = 1, copies or 1 do for _, t in list or {} do table.insert(out, { trig = t, source = src }) end end
	end
	local cls = run.classId and S.get("classes", run.classId)
	if cls then addAll("class:" .. cls.id, cls.triggers) end
	for _, r in run.relics do
		local d = S.get("relics", r.id)
		if d then addAll("relic:" .. r.id, d.triggers, if d.stack == false then 1 else r.count) end
	end
	for _, s in M.synergies(run.relics) do addAll("synergy:" .. s.def.id, s.triggers) end
	return out
end

-- statuses applied by the hero's hits (relic onHit lists): { {name, chance, duration, stacks} }
function M.hitStatuses(run)
	local out = {}
	for _, r in run.relics do
		local d = S.get("relics", r.id)
		if d and d.onHit then
			for _ = 1, (if d.stack == false then 1 else r.count) do
				for _, s in (if d.onHit.name then { d.onHit } else d.onHit) do table.insert(out, table.clone(s)) end
			end
		end
	end
	return out
end

-- weighted relic choice: n distinct ids not owned (unless stackable), rarity by weights (+luck shifts toward rare)
function M.roll(rng, run, n, weights, opts)
	opts = opts or {}
	local luck = opts.luck or 0
	local pool = {}
	for _, d in S.all("relics") do
		local have = owns(run.relics, d.id)
		local maxStack = d.maxStack or (if d.stack then 99 else 1)
		local allowed = have < maxStack and d.rarity ~= "starter" and (opts.rarity == nil or d.rarity == opts.rarity)
		if allowed and d.condition and S.core then allowed = S.core.check(d.condition, { run = run }) end
		if allowed then table.insert(pool, d) end
	end
	local out = {}
	weights = weights or S.config.rarity
	for _ = 1, n do
		local byR = {}
		for _, d in pool do
			if not table.find(out, d.id) then
				local r = d.rarity or "common"
				byR[r] = byR[r] or {}
				table.insert(byR[r], d)
			end
		end
		local w = {}
		for r, list in byR do
			local base = weights[r] or 0
			if base > 0 then w[r] = base * (if r == "rare" or r == "boss" then 1 + luck else 1) end
		end
		local r = if next(w) then rng:weighted(w) else nil
		if r == nil then
			-- fall back to any remaining relic
			local any = {}
			for _, list in byR do for _, d in list do table.insert(any, d) end end
			table.sort(any, function(a, b) return a.id < b.id end)
			if #any == 0 then break end
			table.insert(out, rng:pick(any).id)
		else
			table.sort(byR[r], function(a, b) return a.id < b.id end)
			table.insert(out, rng:weighted(byR[r]).id)
		end
	end
	return out
end

return M
