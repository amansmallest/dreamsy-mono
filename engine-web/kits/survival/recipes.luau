--!nonstrict
-- Crafting-tree analysis (pure): what is obtainable, in which order (depth), raw resource cost, problems.
local Content = require("./content")
local R = {}

-- recipes producing item id
function R.producers(C, item)
	local out = {}
	for _, r in C.recipes do if r.gives == item then table.insert(out, r) end end
	return out
end

-- structure placed by an item (item.data.place) and the item(s) placing a structure
function R.placer(C, structureId)
	for id, it in C.items do if it.data and it.data.place == structureId then return id end end
	return nil
end

-- analyze(C) -> { obtainable = {[item] = depth}, recipeDepth = {[rid] = depth}, structures = {[sid] = depth}, order = {rid…}, problems = {string} }
--   depth 0 = gathered with bare hands; each crafting step / tool gate adds 1.
function R.analyze(C)
	local have = {} -- item -> depth
	local tools = {} -- kind -> best tier available (with depth)
	local built = {} -- structure -> depth
	local problems = {}
	local function known(id) return C.items[id] ~= nil end
	for _, r in C.recipes do
		if not known(r.gives) then table.insert(problems, "recipe " .. r.id .. " gives unknown item " .. tostring(r.gives)) end
		for it in r.needs do if not known(it) then table.insert(problems, "recipe " .. r.id .. " needs unknown item " .. it) end end
		if r.station and C.structuresById[r.station] == nil then table.insert(problems, "recipe " .. r.id .. " station " .. r.station .. " is not a structure") end
	end
	for _, n in C.nodes do
		for _, d in n.drops do if not known(d.item) then table.insert(problems, "node " .. n.id .. " drops unknown item " .. tostring(d.item)) end end
	end
	local recipeDepth = {}
	local order = {}
	local changed = true
	local guard = 0
	local function give(item, depth)
		if have[item] == nil or have[item] > depth then
			have[item] = depth
			changed = true
			local td = Content.itemData(C, item).tool
			if td then
				local cur = tools[td.kind]
				if cur == nil or (td.tier or 1) > cur.tier then tools[td.kind] = { tier = td.tier or 1, depth = depth } changed = true end
			end
			local place = Content.itemData(C, item).place
			if place and (built[place] == nil or built[place] > depth) then built[place] = depth end
		end
	end
	while changed and guard < 200 do
		changed = false
		guard += 1
		for _, n in C.nodes do
			local d = nil
			if n.tier <= 0 then d = 0
			elseif n.tool then
				local t = tools[n.tool]
				if t and t.tier >= n.tier then d = t.depth + 1 end
			end
			if d then for _, dr in n.drops do give(dr.item, d) end end
		end
		for _, p in C.pois do
			for _, l in p.loot or {} do if l.item then give(l.item, (p.depth or 1)) end end
		end
		for _, r in C.recipes do
			local ok, depth = true, 0
			for it in r.needs do
				if have[it] == nil then ok = false break end
				depth = math.max(depth, have[it])
			end
			if ok and r.station then
				if built[r.station] == nil then ok = false else depth = math.max(depth, built[r.station]) end
			end
			if ok then
				depth += 1
				if recipeDepth[r.id] == nil then table.insert(order, r.id) end
				if recipeDepth[r.id] == nil or recipeDepth[r.id] > depth then recipeDepth[r.id] = depth end
				give(r.gives, depth)
			end
		end
	end
	for _, r in C.recipes do
		if recipeDepth[r.id] == nil then table.insert(problems, "recipe " .. r.id .. " can never be crafted") end
	end
	for _, n in C.nodes do
		if n.tool and n.tier > 0 and (tools[n.tool] == nil or tools[n.tool].tier < n.tier) then
			table.insert(problems, "node " .. n.id .. " needs a tier " .. n.tier .. " " .. n.tool .. " that no recipe makes")
		end
	end
	table.sort(order, function(a, b)
		if recipeDepth[a] ~= recipeDepth[b] then return recipeDepth[a] < recipeDepth[b] end
		return a < b
	end)
	local maxDepth = 0
	for _, d in recipeDepth do maxDepth = math.max(maxDepth, d) end
	return { obtainable = have, recipeDepth = recipeDepth, structures = built, tools = tools, order = order, maxDepth = maxDepth, problems = problems, ok = #problems == 0 }
end

-- raw(C, item, n) -> { [rawItem] = count }: expand recipes (first producer) down to gathered resources
function R.raw(C, item, n, out, depth)
	out = out or {}
	n = n or 1
	depth = depth or 0
	local prod = R.producers(C, item)[1]
	if prod == nil or depth > 12 then
		out[item] = (out[item] or 0) + n
		return out
	end
	local times = math.ceil(n / prod.count)
	for it, c in prod.needs do R.raw(C, it, c * times, out, depth + 1) end
	return out
end

return R
