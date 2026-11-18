-- Char grid, 0-based cells like TileMap2D (col x, row y). Default chars: "#" wall, "." floor.
local Grid = {}
Grid.__index = Grid

Grid.WALL = "#"
Grid.FLOOR = "."

function Grid.new(w: number, h: number, fill: string?): any
	local cells = table.create(w * h, fill or Grid.WALL)
	return setmetatable({ w = w, h = h, cells = cells }, Grid)
end

-- text (rows separated by \n) -> grid; short rows padded with `pad` (default " ")
function Grid.fromString(s: string, pad: string?): any
	s = string.gsub(s, "\r", "")
	local rows = string.split(s, "\n")
	while #rows > 0 and rows[#rows] == "" do table.remove(rows) end
	local w = 0
	for _, r in rows do w = math.max(w, #r) end
	local g = Grid.new(w, #rows, pad or " ")
	for y, r in rows do
		for x = 1, #r do g.cells[(y - 1) * w + x] = string.sub(r, x, x) end
	end
	return g
end

function Grid.is(x: any): boolean return type(x) == "table" and getmetatable(x) == Grid end

function Grid:inside(x: number, y: number): boolean return x >= 0 and y >= 0 and x < self.w and y < self.h end
function Grid:get(x: number, y: number): string?
	if x < 0 or y < 0 or x >= self.w or y >= self.h then return nil end
	return self.cells[y * self.w + x + 1]
end
function Grid:set(x: number, y: number, c: string)
	if x < 0 or y < 0 or x >= self.w or y >= self.h then return end
	self.cells[y * self.w + x + 1] = c
end
function Grid:fill(x: number, y: number, w: number, h: number, c: string)
	for yy = y, y + h - 1 do for xx = x, x + w - 1 do self:set(xx, yy, c) end end
end
function Grid:clone(): any
	return setmetatable({ w = self.w, h = self.h, cells = table.clone(self.cells) }, Grid)
end
-- copy `src` grid into self at (ox, oy); `skip` char in src is transparent
function Grid:blit(src: any, ox: number, oy: number, skip: string?)
	for y = 0, src.h - 1 do
		for x = 0, src.w - 1 do
			local c = src:get(x, y)
			if c and c ~= skip then self:set(ox + x, oy + y, c) end
		end
	end
end
function Grid:count(c: string): number
	local n = 0
	for _, v in self.cells do if v == c then n += 1 end end
	return n
end
-- all cells matching c (or predicate fn(char, x, y))
function Grid:find(c: any): { { x: number, y: number } }
	local out = {}
	for y = 0, self.h - 1 do
		for x = 0, self.w - 1 do
			local v = self.cells[y * self.w + x + 1]
			if (type(c) == "function" and c(v, x, y)) or v == c then table.insert(out, { x = x, y = y }) end
		end
	end
	return out
end

-- rows joined with \n; `map` = { [char] = char } (unmapped chars kept; map value "" or false => ".")
function Grid:toString(map: any?): string
	local rows = table.create(self.h)
	for y = 0, self.h - 1 do
		local row = table.create(self.w)
		for x = 1, self.w do
			local c = self.cells[y * self.w + x]
			if map then
				local m = map[c]
				if m ~= nil then c = if m then m else "." end
			end
			if c == "" then c = "." end
			row[x] = c
		end
		rows[y + 1] = table.concat(row)
	end
	return table.concat(rows, "\n")
end

-- 4-neighbour offsets
Grid.DIRS4 = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }
Grid.DIRS8 = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 }, { 1, 1 }, { 1, -1 }, { -1, 1 }, { -1, -1 } }

-- passable predicate from: nil (not wall "#"), a set {[char]=true}, a string of chars, or fn(char) -> bool
function Grid.passFn(p: any): (string?) -> boolean
	if p == nil then return function(c) return c ~= nil and c ~= Grid.WALL and c ~= " " end end
	if type(p) == "function" then return p end
	if type(p) == "string" then
		local set = {}
		for i = 1, #p do set[string.sub(p, i, i)] = true end
		p = set
	end
	return function(c) return c ~= nil and p[c] == true end
end

-- flood fill from (sx, sy) over passable cells. returns visited set (index -> distance) and count
function Grid:flood(sx: number, sy: number, pass: any?): ({ [number]: number }, number)
	local ok = Grid.passFn(pass)
	local seen = {}
	if not ok(self:get(sx, sy)) then return seen, 0 end
	local qx, qy = { sx }, { sy }
	local head, n = 1, 1
	seen[sy * self.w + sx] = 0
	while head <= #qx do
		local x, y = qx[head], qy[head]
		local d = seen[y * self.w + x]
		head += 1
		for _, dd in Grid.DIRS4 do
			local nx, ny = x + dd[1], y + dd[2]
			local k = ny * self.w + nx
			if seen[k] == nil and self:inside(nx, ny) and ok(self:get(nx, ny)) then
				seen[k] = d + 1
				n += 1
				table.insert(qx, nx)
				table.insert(qy, ny)
			end
		end
	end
	return seen, n
end

-- connected regions of passable cells, largest first: { {cells = {{x,y}}, size} }
function Grid:regions(pass: any?): { any }
	local ok = Grid.passFn(pass)
	local label = {}
	local out = {}
	for y = 0, self.h - 1 do
		for x = 0, self.w - 1 do
			local k = y * self.w + x
			if label[k] == nil and ok(self:get(x, y)) then
				local seen = self:flood(x, y, ok)
				local cells = {}
				for kk in seen do
					label[kk] = #out + 1
					table.insert(cells, { x = kk % self.w, y = kk // self.w })
				end
				table.sort(cells, function(a, b) return a.y * self.w + a.x < b.y * self.w + b.x end)
				table.insert(out, { cells = cells, size = #cells })
			end
		end
	end
	table.sort(out, function(a, b)
		if a.size ~= b.size then return a.size > b.size end
		return a.cells[1].y * self.w + a.cells[1].x < b.cells[1].y * self.w + b.cells[1].x
	end)
	return out
end

return Grid
