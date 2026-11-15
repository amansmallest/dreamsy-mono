--!nonstrict
-- survival world: procgen terrain (config biomes) + resource nodes + POIs, with a connectivity guarantee:
-- every walkable free cell is reachable from start, and every node / POI touches a reachable cell.
local procgen = require("@kit/procgen")
local W = {}

local DIRS = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }

-- generate(C, seed?) -> world { w, h, grid, start, nodes = { {id, x, y, hp, idx} }, nodeAt = {[idx] = node}, pois = {...}, poiAt, report }
function W.generate(C, seed)
	local cfg = C.config.world
	seed = seed or cfg.seed
	local rng = procgen.rng(seed)
	local biomes = {}
	for _, b in C.config.biomes do
		table.insert(biomes, { name = b.id, char = b.char, minE = b.minE, maxE = b.maxE, minM = b.minM, maxM = b.maxM, walkable = b.walkable })
	end
	local t = procgen.terrain({ rng = rng:fork("terrain"), w = cfg.w, h = cfg.h, scale = cfg.scale, octaves = cfg.octaves or 3,
		island = cfg.island, biomes = biomes })
	local g = t.grid
	local w = { w = cfg.w, h = cfg.h, grid = g, start = t.start, nodes = {}, nodeAt = {}, pois = {}, poiAt = {}, seed = seed }
	local function idx(x, y) return y * cfg.w + x end
	w.idx = idx
	local function walkable(x, y)
		local b = C.biomeByChar[g:get(x, y) or ""]
		return b ~= nil and b.walkable ~= false
	end
	w.walkable = walkable
	local clear = C.config.world.clearRadius or 3
	-- nodes by biome density
	local nr = rng:fork("nodes")
	for y = 0, cfg.h - 1 do
		for x = 0, cfg.w - 1 do
			if walkable(x, y) and (math.abs(x - t.start.x) + math.abs(y - t.start.y)) > clear then
				local b = C.biomeByChar[g:get(x, y)]
				local keys = {}
				for k in b.nodes do table.insert(keys, k) end
				table.sort(keys)
				for _, k in keys do
					if C.nodesById[k] == nil then error("survival: biome " .. b.id .. " lists unknown node \"" .. k .. "\"") end
					if nr:next() < b.nodes[k] then
						local def = C.nodesById[k]
						local n = { id = k, x = x, y = y, hp = def.hp, idx = idx(x, y) }
						table.insert(w.nodes, n)
						w.nodeAt[n.idx] = n
						break
					end
				end
			end
		end
	end
	local function solidNode(x, y)
		local n = w.nodeAt[idx(x, y)]
		return n ~= nil and C.nodesById[n.id].solid ~= false
	end
	local function free(x, y) return walkable(x, y) and not solidNode(x, y) end
	-- connectivity: carve nodes out of the way of any unreachable pocket
	local function flood()
		local seen = { [idx(t.start.x, t.start.y)] = true }
		local q, h = { t.start }, 1
		while h <= #q do
			local c = q[h] h += 1
			for _, d in DIRS do
				local nx, ny = c.x + d[1], c.y + d[2]
				if nx >= 0 and ny >= 0 and nx < cfg.w and ny < cfg.h and not seen[idx(nx, ny)] and free(nx, ny) then
					seen[idx(nx, ny)] = true
					table.insert(q, { x = nx, y = ny })
				end
			end
		end
		return seen
	end
	local function removeNode(n)
		w.nodeAt[n.idx] = nil
		local i = table.find(w.nodes, n)
		if i then table.remove(w.nodes, i) end
	end
	for _ = 1, 64 do
		local seen = flood()
		local pocket = nil
		for y = 0, cfg.h - 1 do
			for x = 0, cfg.w - 1 do
				if pocket == nil and not seen[idx(x, y)] then
					if free(x, y) then pocket = { x = x, y = y }
					elseif solidNode(x, y) and walkable(x, y) then
						local touch = false
						for _, d in DIRS do
							local nx, ny = x + d[1], y + d[2]
							if nx >= 0 and ny >= 0 and nx < cfg.w and ny < cfg.h and seen[idx(nx, ny)] then touch = true end
						end
						if not touch then pocket = { x = x, y = y, node = true } end
					end
				end
			end
		end
		if pocket == nil then break end
		-- BFS over walkable cells (through nodes) from the pocket to the reached set; clear nodes on the path
		local prev = { [idx(pocket.x, pocket.y)] = -1 }
		local q, h, hit = { pocket }, 1, nil
		while h <= #q and not hit do
			local c = q[h] h += 1
			for _, d in DIRS do
				local nx, ny = c.x + d[1], c.y + d[2]
				local k = idx(nx, ny)
				if nx >= 0 and ny >= 0 and nx < cfg.w and ny < cfg.h and prev[k] == nil and walkable(nx, ny) then
					prev[k] = idx(c.x, c.y)
					if seen[k] then hit = k break end
					table.insert(q, { x = nx, y = ny })
				end
			end
		end
		if not hit then -- isolated land: turn it into the first non-walkable biome char
			local fill = "~"
			for _, b in C.config.biomes do if b.walkable == false then fill = b.char break end end
			for _, c in q do
				local n = w.nodeAt[idx(c.x, c.y)]
				if n then removeNode(n) end
				g:set(c.x, c.y, fill)
			end
		else
			local k = prev[hit]
			local startK = idx(pocket.x, pocket.y)
			while k and k >= 0 and not (pocket.node and k == startK) do
				local n = w.nodeAt[k]
				if n then removeNode(n) end
				k = prev[k]
			end
		end
	end
	local seen = flood()
	-- POIs: on reachable free cells in their biomes, spread out from start
	local pr = rng:fork("pois")
	local taken = {}
	for _, p in C.pois do
		local cand = {}
		for y = 0, cfg.h - 1 do
			for x = 0, cfg.w - 1 do
				local k = idx(x, y)
				local b = C.biomeByChar[g:get(x, y) or ""]
				local okB = p.biomes == nil or (b and table.find(p.biomes, b.id) ~= nil)
				if seen[k] and okB and not taken[k] and (math.abs(x - t.start.x) + math.abs(y - t.start.y)) >= p.minDist then
					table.insert(cand, { x = x, y = y })
				end
			end
		end
		pr:shuffle(cand)
		local placed = 0
		for _, c in cand do
			if placed >= p.count then break end
			local okGap = true
			for _, o in w.pois do if math.abs(o.x - c.x) + math.abs(o.y - c.y) < 5 then okGap = false break end end
			if okGap then
				local poi = { id = p.id, x = c.x, y = c.y, idx = idx(c.x, c.y), found = false }
				table.insert(w.pois, poi)
				w.poiAt[poi.idx] = poi
				taken[poi.idx] = true
				placed += 1
			end
		end
	end
	w.report = W.check(C, w)
	return w
end

-- check(C, world) -> procgen.validate report over free cells + node/POI reachability
function W.check(C, w)
	local g = w.grid
	local cg = procgen.grid(w.w, w.h, "#")
	for y = 0, w.h - 1 do
		for x = 0, w.w - 1 do
			local n = w.nodeAt[w.idx(x, y)]
			local blocked = not w.walkable(x, y) or (n ~= nil and C.nodesById[n.id].solid ~= false)
			if not blocked then cg:set(x, y, ".") end
		end
	end
	local targets = {}
	local function adjFree(x, y)
		for _, d in DIRS do if cg:get(x + d[1], y + d[2]) == "." then return { x = x + d[1], y = y + d[2] } end end
		return nil
	end
	for i, n in w.nodes do
		local a = if cg:get(n.x, n.y) == "." then { x = n.x, y = n.y } else adjFree(n.x, n.y)
		if a then table.insert(targets, { x = a.x, y = a.y, name = "node" .. i }) end
	end
	for i, p in w.pois do table.insert(targets, { x = p.x, y = p.y, name = "poi" .. i }) end
	local rep = procgen.validate(cg, { pass = ".", from = w.start, targets = targets, requireAll = true })
	rep.nodes, rep.pois = #w.nodes, #w.pois
	local byKind = {}
	for _, n in w.nodes do byKind[n.id] = (byKind[n.id] or 0) + 1 end
	rep.nodeCounts = byKind
	return rep
end

return W
