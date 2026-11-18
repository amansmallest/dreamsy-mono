--!nonstrict
-- Board model shared by every mechanic: a w×h grid of named layers (flat arrays, 1-based index) + pieces.
-- Cells are 0-based (x, y) like TileMap2D; index i = y*w + x + 1. Boards are plain tables (deep-copyable).
local B = {}
local Board = {}
Board.__index = Board
B.Board = Board

B.DIRS = { u = { 0, -1 }, r = { 1, 0 }, d = { 0, 1 }, l = { -1, 0 } }
B.ORDER = { "u", "r", "d", "l" }
B.OPPOSITE = { u = "d", d = "u", l = "r", r = "l" }

-- deep copy keeping metatables (boards, rng states)
function B.copy(v, seen)
	if type(v) ~= "table" then return v end
	seen = seen or {}
	if seen[v] then return seen[v] end
	local out = {}
	seen[v] = out
	for k, x in v do out[k] = B.copy(x, seen) end
	local mt = getmetatable(v)
	if mt then setmetatable(out, mt) end
	return out
end

function B.equal(a, b)
	if a == b then return true end
	if type(a) ~= "table" or type(b) ~= "table" then return false end
	for k, v in a do if not B.equal(v, b[k]) then return false end end
	for k in b do if a[k] == nil then return false end end
	return true
end

function B.new(w: number, h: number)
	return setmetatable({ w = w, h = h, layers = {}, pieces = {}, nextId = 1 }, Board)
end

function Board:layer(name: string, fill: any?)
	local L = self.layers[name]
	if not L then
		L = table.create(self.w * self.h, if fill == nil then 0 else fill)
		self.layers[name] = L
	end
	return L
end
function Board:inside(x: number, y: number): boolean return x >= 0 and y >= 0 and x < self.w and y < self.h end
function Board:index(x: number, y: number): number return y * self.w + x + 1 end
function Board:xy(i: number): (number, number) return (i - 1) % self.w, (i - 1) // self.w end
function Board:get(layer: string, x: number, y: number)
	if not self:inside(x, y) then return nil end
	local L = self.layers[layer]
	return L and L[y * self.w + x + 1]
end
function Board:set(layer: string, x: number, y: number, v)
	if not self:inside(x, y) then error("board:set outside the board (" .. x .. "," .. y .. ")", 2) end
	self:layer(layer)[y * self.w + x + 1] = v
end
function Board:fill(layer: string, v) local L = self:layer(layer) for i = 1, self.w * self.h do L[i] = v end end
function Board:count(layer: string, v): number
	local n, L = 0, self.layers[layer] or {}
	for i = 1, self.w * self.h do if L[i] == v then n += 1 end end
	return n
end
-- neighbours inside the board: { {x, y, dir, i} }
function Board:neighbors(x: number, y: number)
	local out = {}
	for _, d in B.ORDER do
		local v = B.DIRS[d]
		local nx, ny = x + v[1], y + v[2]
		if self:inside(nx, ny) then table.insert(out, { x = nx, y = ny, dir = d, i = ny * self.w + nx + 1 }) end
	end
	return out
end
function Board:adjacent(i: number, j: number): boolean
	local ax, ay = self:xy(i)
	local bx, by = self:xy(j)
	return math.abs(ax - bx) + math.abs(ay - by) == 1
end

-- pieces: { id, kind, x, y, ...props } (ids stable for animation)
function Board:addPiece(kind: string, x: number, y: number, props: any?)
	local p = { id = self.nextId, kind = kind, x = x, y = y }
	for k, v in props or {} do p[k] = v end
	self.nextId += 1
	table.insert(self.pieces, p)
	return p
end
function Board:pieceAt(x: number, y: number, kind: string?)
	for _, p in self.pieces do if p.x == x and p.y == y and (kind == nil or p.kind == kind) then return p end end
	return nil
end
function Board:piecesOf(kind: string?)
	local out = {}
	for _, p in self.pieces do if kind == nil or p.kind == kind then table.insert(out, p) end end
	return out
end
function Board:movePiece(p, x: number, y: number) p.x, p.y = x, y end
function Board:removePiece(p)
	local i = table.find(self.pieces, p)
	if i then table.remove(self.pieces, i) end
end
function Board:clone() return B.copy(self) end

-- rows: { "####", "#@ #" } or "####\n#@ #"; legend[char] = { layer = value, ..., piece = kind? } (unknown chars error)
function B.fromRows(rows, legend)
	if type(rows) == "string" then
		rows = string.split((string.gsub(rows, "\r", "")), "\n")
		while #rows > 0 and rows[#rows] == "" do table.remove(rows) end
	end
	local w = 0
	for _, r in rows do w = math.max(w, #r) end
	local b = B.new(w, #rows)
	for name, def in legend._layers or {} do b:layer(name, def) end
	for y = 0, #rows - 1 do
		for x = 0, w - 1 do
			local c = string.sub(rows[y + 1], x + 1, x + 1)
			if c == "" then c = legend._pad or " " end
			local e = legend[c]
			if e == nil then error("board: unknown char '" .. c .. "' at " .. x .. "," .. y, 2) end
			for k, v in e do
				if k == "piece" then b:addPiece(v, x, y) else b:layer(k)[y * w + x + 1] = v end
			end
		end
	end
	return b
end

-- fn(x, y, i) -> char
function Board:toRows(fn): string
	local rows = {}
	for y = 0, self.h - 1 do
		local r = {}
		for x = 0, self.w - 1 do table.insert(r, fn(x, y, y * self.w + x + 1)) end
		table.insert(rows, table.concat(r))
	end
	return table.concat(rows, "\n")
end

-- stable string key of the given layers (+ pieces): plan caching, repeated-state detection
function Board:key(layers: { string }?): string
	local parts = {}
	local names = layers
	if not names then
		names = {}
		for k in self.layers do table.insert(names, k) end
		table.sort(names)
	end
	for _, n in names do
		local L = self.layers[n] or {}
		local s = {}
		for i = 1, self.w * self.h do s[i] = tostring(L[i]) end
		table.insert(parts, n .. "=" .. table.concat(s, ","))
	end
	local ps = {}
	for _, p in self.pieces do table.insert(ps, p.kind .. "@" .. p.x .. "," .. p.y) end
	table.sort(ps)
	table.insert(parts, table.concat(ps, ";"))
	return table.concat(parts, "|")
end

return B
