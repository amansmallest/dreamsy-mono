-- tower-defense kit: paths. All coordinates are in TILE units (cell (c, r) spans [c, c+1) x [r, r+1); its
-- center is (c + 0.5, r + 0.5)). The view converts to world pixels with the map origin + tile size.
local Path = {}
local PathM = {}
PathM.__index = PathM

-- Build a path from waypoints { {x, y}, ... } (tile units).
function Path.new(id, points)
	assert(#points >= 2, "path " .. tostring(id) .. " needs at least 2 points")
	local pts, cum = {}, { 0 }
	for i, p in points do
		pts[i] = { x = p[1] or p.x, y = p[2] or p.y }
	end
	for i = 2, #pts do
		local a, b = pts[i - 1], pts[i]
		cum[i] = cum[i - 1] + math.sqrt((b.x - a.x) ^ 2 + (b.y - a.y) ^ 2)
	end
	return setmetatable({ id = id, points = pts, cum = cum, length = cum[#cum] }, PathM)
end

-- Position at distance d along the path (clamped). Returns x, y.
function PathM:at(d)
	local pts, cum = self.points, self.cum
	if d <= 0 then
		return pts[1].x, pts[1].y
	end
	if d >= self.length then
		local p = pts[#pts]
		return p.x, p.y
	end
	-- binary search the segment
	local lo, hi = 1, #cum
	while hi - lo > 1 do
		local mid = (lo + hi) // 2
		if cum[mid] <= d then
			lo = mid
		else
			hi = mid
		end
	end
	local a, b = pts[lo], pts[hi]
	local seg = cum[hi] - cum[lo]
	local t = if seg > 0 then (d - cum[lo]) / seg else 0
	return a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t
end

-- Straight line from the path's first to last point (flying enemies).
function PathM:direct()
	if not self._direct then
		local a, b = self.points[1], self.points[#self.points]
		self._direct = Path.new(self.id .. ":air", { { a.x, a.y }, { b.x, b.y } })
	end
	return self._direct
end

-- Total path length (tile units) within `range` of (x, y), sampled every `step` tiles.
function PathM:coverage(x, y, range, step)
	step = step or 0.25
	local n, d = 0, 0
	local r2 = range * range
	while d <= self.length do
		local px, py = self:at(d)
		if (px - x) ^ 2 + (py - y) ^ 2 <= r2 then
			n += 1
		end
		d += step
	end
	return n * step
end

-- ---------- grids ----------

-- Split grid text into rows.
function Path.rows(grid)
	if type(grid) == "table" then
		return grid
	end
	local rows = string.split((string.gsub(grid, "\r", "")), "\n")
	while #rows > 0 and rows[#rows] == "" do
		table.remove(rows)
	end
	return rows
end

local DEFAULT_LEGEND = { path = "#", spawns = "S", exits = "E", build = "o" }
Path.DEFAULT_LEGEND = DEFAULT_LEGEND

local function has(chars, ch)
	return ch ~= "" and string.find(chars, ch, 1, true) ~= nil
end

-- Analyze a grid: returns { cols, rows, build = { {c, r} }, paths = { [spawnChar .. n] = Path }, pathIds = {...} }.
-- Walkable = path, spawn and exit chars. From each spawn tile, BFS (4-neighbour) finds the shortest route to the
-- nearest exit tile; the route's cell centers (collinear points merged) become the path. A spawn char used on
-- several tiles makes ids "S", "S2", "S3", … in reading order. The path starts half a tile outside the map if the
-- spawn is on an edge (enemies walk in) and ends at the exit tile's center.
function Path.fromGrid(grid, legend)
	legend = legend or DEFAULT_LEGEND
	local L = {
		path = legend.path or DEFAULT_LEGEND.path,
		spawns = legend.spawns or DEFAULT_LEGEND.spawns,
		exits = legend.exits or DEFAULT_LEGEND.exits,
		build = legend.build or DEFAULT_LEGEND.build,
	}
	local rows = Path.rows(grid)
	local nr, nc = #rows, 0
	for _, row in rows do
		nc = math.max(nc, #row)
	end
	local function ch(c, r)
		if r < 0 or r >= nr or c < 0 then
			return ""
		end
		return string.sub(rows[r + 1], c + 1, c + 1)
	end
	local function walk(c, r)
		local x = ch(c, r)
		return has(L.path, x) or has(L.spawns, x) or has(L.exits, x)
	end
	local build, spawns = {}, {}
	for r = 0, nr - 1 do
		for c = 0, nc - 1 do
			local x = ch(c, r)
			if has(L.build, x) then
				table.insert(build, { c, r })
			end
			if has(L.spawns, x) then
				table.insert(spawns, { c = c, r = r, ch = x })
			end
		end
	end
	local paths, ids, count = {}, {}, {}
	for _, s in spawns do
		-- BFS
		local key = function(c, r)
			return r * 4096 + c
		end
		local prev = { [key(s.c, s.r)] = -1 }
		local q, head = { { s.c, s.r } }, 1
		local goal = nil
		while head <= #q do
			local cur = q[head]
			head += 1
			if has(L.exits, ch(cur[1], cur[2])) then
				goal = cur
				break
			end
			for _, d in { { 1, 0 }, { 0, 1 }, { -1, 0 }, { 0, -1 } } do
				local nc2, nr2 = cur[1] + d[1], cur[2] + d[2]
				local k = key(nc2, nr2)
				if prev[k] == nil and walk(nc2, nr2) then
					prev[k] = key(cur[1], cur[2])
					table.insert(q, { nc2, nr2 })
				end
			end
		end
		if not goal then
			error("tower-defense: spawn '" .. s.ch .. "' at (" .. s.c .. "," .. s.r .. ") has no walkable route to an exit")
		end
		local cells = {}
		local k = key(goal[1], goal[2])
		while k ~= -1 do
			table.insert(cells, 1, { k % 4096, k // 4096 })
			k = prev[k]
		end
		local pts = {}
		for i, cell in cells do
			local x, y = cell[1] + 0.5, cell[2] + 0.5
			local n = #pts
			if n >= 2 then
				local a, b = pts[n - 1], pts[n]
				if (b[1] - a[1]) * (y - b[2]) == (b[2] - a[2]) * (x - b[1]) then
					pts[n] = { x, y } -- collinear: extend
					continue
				end
			end
			table.insert(pts, { x, y })
		end
		-- walk in / out through map edges
		local function edgeOut(cell, p)
			local c, r = cell[1], cell[2]
			if c == 0 then
				return { p[1] - 1, p[2] }
			elseif c == nc - 1 then
				return { p[1] + 1, p[2] }
			elseif r == 0 then
				return { p[1], p[2] - 1 }
			elseif r == nr - 1 then
				return { p[1], p[2] + 1 }
			end
			return nil
		end
		local first = edgeOut(cells[1], pts[1])
		if first then
			table.insert(pts, 1, first)
		end
		if #pts == 1 then
			table.insert(pts, { pts[1][1], pts[1][2] })
		end
		count[s.ch] = (count[s.ch] or 0) + 1
		local id = if count[s.ch] == 1 then s.ch else s.ch .. count[s.ch]
		paths[id] = Path.new(id, pts)
		table.insert(ids, id)
	end
	return { cols = nc, rows = nr, build = build, paths = paths, pathIds = ids, grid = rows }
end

-- Same as fromGrid but reads a live TileMap2D entity (map:getTile, map.cols/rows).
function Path.fromTileMap(map, legend)
	local rows = {}
	for r = 0, map.rows - 1 do
		local parts = table.create(map.cols)
		for c = 0, map.cols - 1 do
			parts[c + 1] = map:getTile(c, r) or "."
		end
		rows[r + 1] = table.concat(parts)
	end
	return Path.fromGrid(rows, legend)
end

return Path
