-- Path grids (TileMap2D / char grid / text), A* on grids and graphs, line of sight.
local Path = {}

local PathGrid = {}
PathGrid.__index = PathGrid

local function charSet(s: any): any
	if s == nil then return nil end
	if type(s) == "function" then return s end
	if type(s) == "string" then
		local set = {}
		for i = 1, #s do set[string.sub(s, i, i)] = true end
		return function(c) return c ~= nil and set[c] == true end
	end
	return function(c) return c ~= nil and s[c] == true end
end

--[[ Path.grid(source, opts) -> PathGrid
   source: TileMap2D entity | text ("#..\n...") | grid table with :get(x,y), w, h (procgen.Grid)
   opts: { solid = "#W" | {[char]=true} | fn(char)->bool  (TileMap default: the tileset's `solid` flag via map:isSolid;
                                                          text/grid default: "#"),
           tileSize = 16, origin = {x,y} (world top-left of cell 0,0; TileMap: its position), diagonal = false } ]]
function Path.grid(source: any, opts: any?): any
	opts = opts or {}
	local self = setmetatable({ diagonal = opts.diagonal == true, blocked = {} }, PathGrid)
	if type(source) == "string" then
		source = string.gsub(source, "\r", "")
		local rows = string.split(source, "\n")
		while #rows > 0 and rows[#rows] == "" do table.remove(rows) end
		local w = 0
		for _, r in rows do w = math.max(w, #r) end
		self.w, self.h = w, #rows
		self.get = function(x, y) local r = rows[y + 1] if r == nil or x < 0 or x >= w then return nil end local c = string.sub(r, x + 1, x + 1) return if c == "" then "." else c end
		self.isSolid = charSet(opts.solid or "#")
		self.tileSize = opts.tileSize or 16
		self.ox, self.oy = 0, 0
	elseif type(source) == "table" and rawget(source, "cells") ~= nil then
		self.w, self.h = source.w, source.h
		self.get = function(x, y) return source:get(x, y) end
		self.isSolid = charSet(opts.solid or "#")
		self.tileSize = opts.tileSize or 16
		self.ox, self.oy = 0, 0
	else
		-- TileMap2D entity
		local map = source
		self.map = map
		self.w, self.h = map.cols, map.rows
		self.get = function(x, y) if x < 0 or y < 0 or x >= self.w or y >= self.h then return nil end return map:getTile(x, y) end
		self.isSolid = charSet(opts.solid)
		if not self.isSolid then
			self.solidCell = function(x, y) return map:isSolid(x, y) end
		end
		self.tileSize = opts.tileSize or map.tile_size or 16
		local p = map.position
		self.ox, self.oy = p.x, p.y
	end
	if opts.origin then self.ox, self.oy = opts.origin.x or opts.origin[1], opts.origin.y or opts.origin[2] end
	return self
end

-- solid (or outside / temporarily blocked) cell?
function PathGrid:solid(x: number, y: number): boolean
	if x < 0 or y < 0 or x >= self.w or y >= self.h then return true end
	if self.blocked[y * self.w + x] then return true end
	if self.solidCell then return self.solidCell(x, y) end
	return self.isSolid(self.get(x, y))
end
-- mark a cell blocked/unblocked at runtime (doors, placed towers)
function PathGrid:block(x: number, y: number, on: boolean?) self.blocked[y * self.w + x] = if on == false then nil else true end

function PathGrid:toCell(wx: number, wy: number): (number, number)
	return math.floor((wx - self.ox) / self.tileSize), math.floor((wy - self.oy) / self.tileSize)
end
function PathGrid:toWorld(cx: number, cy: number): (number, number)
	return self.ox + (cx + 0.5) * self.tileSize, self.oy + (cy + 0.5) * self.tileSize
end
function PathGrid:solidAt(wx: number, wy: number): boolean
	local cx, cy = self:toCell(wx, wy)
	return self:solid(cx, cy)
end

-- binary heap keyed by f
local function heapPush(h, item, f)
	table.insert(h, { item, f })
	local i = #h
	while i > 1 do
		local p = i // 2
		if h[p][2] <= h[i][2] then break end
		h[p], h[i] = h[i], h[p]
		i = p
	end
end
local function heapPop(h)
	local top = h[1]
	local last = table.remove(h)
	if #h > 0 then
		h[1] = last
		local i = 1
		while true do
			local l, r, s = i * 2, i * 2 + 1, i
			if l <= #h and h[l][2] < h[s][2] then s = l end
			if r <= #h and h[r][2] < h[s][2] then s = r end
			if s == i then break end
			h[s], h[i] = h[i], h[s]
			i = s
		end
	end
	return top[1]
end

--[[ grid A*: cells in, list of {x,y} cells out (start..goal inclusive), or nil.
     opts: { diagonal = grid.diagonal, maxNodes = 4000, cost = fn(x,y) -> extra cost?, nearest = false
             (when the goal is unreachable/solid, path to the closest reached cell instead) } ]]
function PathGrid:find(sx: number, sy: number, gx: number, gy: number, opts: any?): { any }?
	opts = opts or {}
	local diag = if opts.diagonal == nil then self.diagonal else opts.diagonal
	local W = self.w
	if self:solid(sx, sy) then
		-- standing slightly inside a wall: allow start anyway
	end
	local goalSolid = self:solid(gx, gy)
	if goalSolid and not opts.nearest then return nil end
	local function h(x, y)
		local dx, dy = math.abs(x - gx), math.abs(y - gy)
		if diag then return math.max(dx, dy) + 0.4142 * math.min(dx, dy) end
		return dx + dy
	end
	local start = sy * W + sx
	local goal = gy * W + gx
	local g = { [start] = 0 }
	local came = {}
	local open = {}
	local closed = {}
	heapPush(open, start, h(sx, sy))
	local maxNodes = opts.maxNodes or 4000
	local expanded = 0
	local bestK, bestH = start, h(sx, sy)
	local dirs = if diag
		then { { 1, 0, 1 }, { -1, 0, 1 }, { 0, 1, 1 }, { 0, -1, 1 }, { 1, 1, 1.4142 }, { 1, -1, 1.4142 }, { -1, 1, 1.4142 }, { -1, -1, 1.4142 } }
		else { { 1, 0, 1 }, { -1, 0, 1 }, { 0, 1, 1 }, { 0, -1, 1 } }
	local found = false
	while #open > 0 do
		local k = heapPop(open)
		if not closed[k] then
			closed[k] = true
			if k == goal then found = true break end
			expanded += 1
			if expanded > maxNodes then break end
			local x, y = k % W, k // W
			local hk = h(x, y)
			if hk < bestH then bestK, bestH = k, hk end
			for _, d in dirs do
				local nx, ny = x + d[1], y + d[2]
				local ok = not self:solid(nx, ny) or (nx == gx and ny == gy and not goalSolid)
				if ok and d[1] ~= 0 and d[2] ~= 0 then
					-- no corner cutting
					ok = not self:solid(x + d[1], y) and not self:solid(x, y + d[2])
				end
				if ok then
					local nk = ny * W + nx
					local ng = g[k] + d[3] + (if opts.cost then opts.cost(nx, ny) or 0 else 0)
					if g[nk] == nil or ng < g[nk] then
						g[nk] = ng
						came[nk] = k
						heapPush(open, nk, ng + h(nx, ny))
					end
				end
			end
		end
	end
	local endK = if found then goal elseif opts.nearest then bestK else nil
	if endK == nil then return nil end
	local out = {}
	local k = endK
	while k ~= nil do
		table.insert(out, 1, { x = k % W, y = k // W })
		k = came[k]
	end
	return out
end

-- world -> world path: list of {x,y} world points (cell centres; first = start cell)
function PathGrid:findWorld(fx: number, fy: number, tx: number, ty: number, opts: any?): { any }?
	local sx, sy = self:toCell(fx, fy)
	local gx, gy = self:toCell(tx, ty)
	local cells = self:find(sx, sy, gx, gy, opts)
	if not cells then return nil end
	local out = {}
	for _, c in cells do
		local wx, wy = self:toWorld(c.x, c.y)
		table.insert(out, { x = wx, y = wy })
	end
	return out
end

-- line of sight between two world points (no solid cell crossed); samples every tileSize/4
function PathGrid:los(x0: number, y0: number, x1: number, y1: number): boolean
	local dx, dy = x1 - x0, y1 - y0
	local dist = math.sqrt(dx * dx + dy * dy)
	local step = self.tileSize / 4
	local n = math.max(1, math.ceil(dist / step))
	for i = 1, n - 1 do
		local t = i / n
		if self:solidAt(x0 + dx * t, y0 + dy * t) then return false end
	end
	return true
end
-- cell-space line of sight (Bresenham)
function PathGrid:losCells(x0: number, y0: number, x1: number, y1: number): boolean
	local dx, dy = math.abs(x1 - x0), -math.abs(y1 - y0)
	local sx, sy = if x0 < x1 then 1 else -1, if y0 < y1 then 1 else -1
	local err = dx + dy
	while true do
		if not (x0 == x1 and y0 == y1) and self:solid(x0, y0) then return false end
		if x0 == x1 and y0 == y1 then return true end
		local e2 = 2 * err
		if e2 >= dy then err += dy; x0 += sx end
		if e2 <= dx then err += dx; y0 += sy end
	end
end

--[[ graph A*: nodes = { [id] = { x?, y?, links = { [otherId] = cost } | { otherId, ... } } }
     -> list of ids (start..goal) and total cost, or nil ]]
function Path.graph(nodes: any, start: any, goal: any, opts: any?): ({ any }?, number?)
	opts = opts or {}
	local function hf(id)
		local a, b = nodes[id], nodes[goal]
		if opts.heuristic then return opts.heuristic(id, goal) end
		if a and b and a.x and b.x then return math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2) end
		return 0
	end
	local g = { [start] = 0 }
	local came = {}
	local open = {}
	local closed = {}
	local order = {}
	heapPush(open, start, hf(start))
	while #open > 0 do
		local id = heapPop(open)
		if not closed[id] then
			closed[id] = true
			if id == goal then
				local out = {}
				local k = goal
				while k ~= nil do table.insert(out, 1, k) k = came[k] end
				return out, g[goal]
			end
			local node = nodes[id]
			if node then
				local links = node.links or {}
				local list = {}
				if #links > 0 then
					for _, other in links do
						local cost = 1
						local b = nodes[other]
						if node.x and b and b.x then cost = math.sqrt((node.x - b.x) ^ 2 + (node.y - b.y) ^ 2) end
						table.insert(list, { other, cost })
					end
				else
					for other, cost in links do table.insert(list, { other, cost }) end
					table.sort(list, function(a, b) return tostring(a[1]) < tostring(b[1]) end)
				end
				for _, l in list do
					local ng = g[id] + l[2]
					if g[l[1]] == nil or ng < g[l[1]] then
						g[l[1]] = ng
						came[l[1]] = id
						heapPush(open, l[1], ng + hf(l[1]))
					end
				end
			end
		end
	end
	return nil, nil
end

Path.PathGrid = PathGrid
return Path
