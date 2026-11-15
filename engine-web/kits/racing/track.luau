--!nonstrict
-- Track = TileMap2D grid (surface + walls from tile tags/solid) + racing line polyline (waypoints) + gates.
-- Pure: no entities. See KIT.md "Tracks".
local U = require("./util")
local T = {}
T.__index = T
local M = { CHARS = { road = "=", curb = "c", offroad = ",", wall = "#", finish = "F", boost = ">", oil = "o", ramp = "^", item = "?" } }

-- default tile behaviour for the rasterizer chars (games may override with def.tiles / a tileset)
M.TILES = {
	["="] = {}, c = {}, [","] = { tags = { "offroad" } }, ["#"] = { solid = true },
	F = { tags = { "finish" } }, [">"] = { tags = { "boost" } }, o = { tags = { "oil" } }, ["^"] = { tags = { "ramp" } }, ["?"] = { tags = { "item" } },
}

local function readText(src: string): string
	if string.sub(src, 1, 5) == "file:" then
		local path = string.sub(src, 6)
		if type(data) ~= "table" or type(data.read) ~= "function" then error("racing: data.read unavailable for " .. path, 3) end
		return data.read(path)
	end
	return src
end
M.readText = readText

local function splitRows(text: string)
	local rows = {}
	for line in string.gmatch(text .. "\n", "([^\n]*)\n") do table.insert(rows, (string.gsub(line, "\r", ""))) end
	while #rows > 0 and rows[#rows] == "" do table.remove(rows) end
	return rows
end

-- distance from (x,y) to segment a-b
local function segDist(x, y, ax, ay, bx, by)
	local dx, dy = bx - ax, by - ay
	local l2 = dx * dx + dy * dy
	local t = if l2 > 0 then math.clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1) else 0
	local px, py = ax + dx * t, ay + dy * t
	return U.len(x - px, y - py), t
end

local function linePoints(def, ts, ox, oy)
	local pts = {}
	local cells = (def.units or "cells") == "cells"
	for i, p in def.line or def.waypoints or {} do
		local x = p.x or p[1]
		local y = p.y or p[2]
		if cells then x, y = ox + (x + 0.5) * ts, oy + (y + 0.5) * ts end
		table.insert(pts, { x = x, y = y, speed = p.speed or p[3] })
	end
	if #pts < 3 then error("racing track: `line` needs at least 3 waypoints", 3) end
	return pts
end

-- rasterize(def) -> grid text: road within `width` tiles of the line, curb, offroad band, walls beyond `wall`
function M.rasterize(def, opts)
	opts = opts or {}
	local ch = setmetatable(def.chars or {}, { __index = M.CHARS })
	local ts = def.tileSize or 64
	local pts = linePoints(def, ts, 0, 0)
	local loop = def.loop ~= false
	local w = def.width or 1.5
	local wallD = def.wall or (w + 3)
	local minx, miny, maxx, maxy = math.huge, math.huge, -math.huge, -math.huge
	for _, p in pts do
		minx, miny = math.min(minx, p.x), math.min(miny, p.y)
		maxx, maxy = math.max(maxx, p.x), math.max(maxy, p.y)
	end
	local margin = def.margin or math.ceil(w + 2)
	local cols = def.cols or math.ceil(maxx / ts + margin + 0.5)
	local rows = def.rows or math.ceil(maxy / ts + margin + 0.5)
	local nseg = if loop then #pts else #pts - 1
	local out = {}
	for r = 0, rows - 1 do
		local line = table.create(cols, ch.wall)
		for c = 0, cols - 1 do
			local x, y = (c + 0.5) * ts, (r + 0.5) * ts
			local d = math.huge
			for i = 1, nseg do
				local a, b = pts[i], pts[(i % #pts) + 1]
				local dd = segDist(x, y, a.x, a.y, b.x, b.y)
				if dd < d then d = dd end
			end
			d /= ts
			local k = if d <= w then ch.road elseif d <= w + 0.55 then ch.curb elseif d <= wallD then ch.offroad else ch.wall
			if r == 0 or c == 0 or r == rows - 1 or c == cols - 1 then k = ch.wall end
			line[c + 1] = k
		end
		out[r + 1] = line
	end
	local tmp = setmetatable({ ts = ts, ox = 0, oy = 0, pts = pts, loop = loop }, T)
	tmp:_build()
	local function stamp(x, y, k)
		local c, r = math.floor(x / ts), math.floor(y / ts)
		if out[r + 1] and c >= 1 and c < cols - 1 and r >= 1 and r < rows - 1 then out[r + 1][c + 1] = k end
	end
	-- finish line across the road at the start waypoint
	local sx, sy, tx, ty = tmp:pointAt(tmp.startS(def))
	for k = -math.ceil(w), math.ceil(w) do stamp(sx - ty * k * ts, sy + tx * k * ts, ch.finish) end
	for _, h in def.hazards or {} do
		local hx, hy, htx, hty = tmp:pointAt((h.at or 0) * tmp.length)
		local off = (h.offset or 0) * ts
		for k = 0, (h.size or 1) - 1 do
			local along = (k - ((h.size or 1) - 1) / 2) * ts
			stamp(hx - hty * off + htx * along, hy + htx * off + hty * along, ch[h.kind] or h.kind)
		end
	end
	local lines = {}
	for i, l in out do lines[i] = table.concat(l) end
	return table.concat(lines, "\n")
end

function T:_build()
	local pts = self.pts
	local n = #pts
	local s = 0
	self.cum = { 0 }
	local nseg = if self.loop then n else n - 1
	for i = 1, nseg do
		local a, b = pts[i], pts[(i % n) + 1]
		s += U.len(b.x - a.x, b.y - a.y)
		self.cum[i + 1] = s
	end
	self.nseg = nseg
	self.length = s
	-- start/finish line: middle of segment `start` (waypoint start → start+1), unless startAt (0..1 of the lap) is given
	self.startS = function(def)
		if def and def.startAt then return def.startAt * s end
		local i = (def and def.start) or 1
		return ((self.cum[i] or 0) + (self.cum[i + 1] or s)) / 2
	end
end

-- new(def, opts?) -> track. def: { name?, tileSize=64, origin={x,y}, line={{col,row,speed?}...}, units="cells"|"px",
--   width=1.5 (road half-width, tiles), grid? (text | "file:data/levels/x.txt"; absent = rasterize), tiles? | tileset?,
--   checkpoints = 4 | {waypoint indices}, start = 1, laps = 3, loop = true, hazards? }
function M.new(def, opts)
	opts = opts or {}
	local ts = def.tileSize or 64
	local o = def.origin or {}
	local self = setmetatable({ def = def, name = def.name or def.id or "track", id = def.id, ts = ts, ox = o.x or o[1] or 0, oy = o.y or o[2] or 0,
		loop = def.loop ~= false, laps = def.laps or 3, width = (def.width or 1.5) * ts }, T)
	self.pts = linePoints(def, ts, self.ox, self.oy)
	self:_build()
	self.gridText = if def.grid then readText(def.grid) else M.rasterize(def)
	self.rows = splitRows(self.gridText)
	self.rowCount = #self.rows
	self.cols = 0
	for _, r in self.rows do self.cols = math.max(self.cols, #r) end
	-- tiles: def.tiles > tileset file > defaults
	local tiles = def.tiles
	if not tiles and def.tileset and type(data) == "table" and data.read then tiles = data.read(def.tileset).tiles end
	tiles = tiles or M.TILES
	self.tiles = {}
	for c, t in tiles do
		local tags = {}
		for _, g in t.tags or {} do tags[g] = true end
		self.tiles[c] = { solid = t.solid == true, tags = tags }
	end
	-- gates: 1 = start/finish, then checkpoints in order
	self.startS0 = self.startS(def)
	local list = {}
	local cp = def.checkpoints or 4
	if type(cp) == "number" then
		for k = 1, cp - 1 do table.insert(list, (self.startS0 + k * self.length / cp) % self.length) end
	else
		for _, i in cp do table.insert(list, self.cum[i]) end
		table.sort(list, function(a, b) return (a - self.startS0) % self.length < (b - self.startS0) % self.length end)
	end
	self.gates = {}
	local half = def.gateWidth and def.gateWidth * ts or (self.width + ts * 2.5)
	local function gate(s)
		local x, y, tx, ty = self:pointAt(s)
		local nx, ny = -ty, tx
		table.insert(self.gates, { s = s, rel = (s - self.startS0) % self.length, x = x, y = y, tx = tx, ty = ty,
			ax = x - nx * half, ay = y - ny * half, bx = x + nx * half, by = y + ny * half })
	end
	gate(self.startS0)
	for _, s in list do gate(s) end
	return self
end

-- pointAt(s) -> x, y, tx, ty (unit tangent); s wraps on loops
function T:pointAt(s: number)
	local L = self.length
	if self.loop then s %= L else s = math.clamp(s, 0, L) end
	local cum, pts, n = self.cum, self.pts, #self.pts
	local lo, hi = 1, self.nseg
	while lo < hi do
		local mid = (lo + hi + 1) // 2
		if cum[mid] <= s then lo = mid else hi = mid - 1 end
	end
	local a, b = pts[lo], pts[(lo % n) + 1]
	local seg = cum[lo + 1] - cum[lo]
	local t = if seg > 0 then (s - cum[lo]) / seg else 0
	local tx, ty = (b.x - a.x) / math.max(seg, 1e-6), (b.y - a.y) / math.max(seg, 1e-6)
	return a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, tx, ty, lo
end

-- closest(x, y, hintSeg?) -> seg, s, lateral (+ = right of travel), tx, ty
function T:closest(x: number, y: number, hint: number?)
	local pts, n = self.pts, #self.pts
	local best, bi, bt = math.huge, 1, 0
	local function test(i)
		local a, b = pts[i], pts[(i % n) + 1]
		local d, t = segDist(x, y, a.x, a.y, b.x, b.y)
		if d < best then best, bi, bt = d, i, t end
	end
	if hint then
		for k = -4, 4 do
			local i = hint + k
			if self.loop then i = ((i - 1) % self.nseg) + 1 end
			if i >= 1 and i <= self.nseg then test(i) end
		end
	end
	if not hint or best > self.width * 2.5 then
		for i = 1, self.nseg do test(i) end
	end
	local a, b = pts[bi], pts[(bi % n) + 1]
	local seg = self.cum[bi + 1] - self.cum[bi]
	local tx, ty = (b.x - a.x) / math.max(seg, 1e-6), (b.y - a.y) / math.max(seg, 1e-6)
	local px, py = a.x + (b.x - a.x) * bt, a.y + (b.y - a.y) * bt
	local lat = (x - px) * -ty + (y - py) * tx
	return bi, self.cum[bi] + seg * bt, lat, tx, ty
end

-- speedAt(s): waypoint speed hint (px/s) of the segment, nil if none
function T:speedAt(s: number): number?
	local _, _, _, _, seg = self:pointAt(s)
	return self.pts[seg].speed
end

-- turn(s, ahead) -> max |heading change| (rad) over [s, s+ahead] relative to the heading at s
function T:turn(s: number, ahead: number): number
	local _, _, tx, ty = self:pointAt(s)
	local h0 = U.heading(tx, ty)
	local m = 0
	local step = math.max(16, self.ts * 0.5)
	local d = step
	while d <= ahead do
		local _, _, tx2, ty2 = self:pointAt(s + d)
		m = math.max(m, math.abs(U.wrap(U.heading(tx2, ty2) - h0)))
		d += step
	end
	return m
end

-- tiles
function T:cell(x: number, y: number) return math.floor((x - self.ox) / self.ts), math.floor((y - self.oy) / self.ts) end
function T:charAt(c: number, r: number): string?
	local row = self.rows[r + 1]
	if not row or c < 0 then return nil end
	local k = string.sub(row, c + 1, c + 1)
	if k == "" or k == "." or k == " " then return nil end
	return k
end
function T:tileAt(x: number, y: number): string? return self:charAt(self:cell(x, y)) end
function T:solidCell(c: number, r: number): boolean
	if c < 0 or r < 0 or c >= self.cols or r >= self.rowCount then return true end
	local k = self:charAt(c, r)
	local t = k and self.tiles[k]
	return t ~= nil and t.solid
end
function T:solidAt(x: number, y: number): boolean return self:solidCell(self:cell(x, y)) end
-- surface(x, y) -> tag set { offroad = true, boost = true, ... } (empty table for plain road / undefined chars)
local EMPTY = {}
function T:surface(x: number, y: number)
	local k = self:tileAt(x, y)
	local t = k and self.tiles[k]
	return if t then t.tags else EMPTY
end

-- collide(x, y, r) -> nx, ny, depth (push-out normal) or nil: circle vs solid cells / map edge
function T:collide(x: number, y: number, r: number)
	local ts = self.ts
	local c0, r0 = self:cell(x - r, y - r)
	local c1, r1 = self:cell(x + r, y + r)
	local px, py, hit = 0, 0, false
	for rr = r0, r1 do
		for cc = c0, c1 do
			if self:solidCell(cc, rr) then
				local lx, ly = self.ox + cc * ts, self.oy + rr * ts
				local qx, qy = math.clamp(x, lx, lx + ts), math.clamp(y, ly, ly + ts)
				local dx, dy = x - qx, y - qy
				local d = U.len(dx, dy)
				if d < r then
					if d < 1e-6 then
						-- centre inside the cell: push out through the nearest edge that has an open neighbour
						local bestD, bx, by = math.huge, 0, 0
						for _, o in { { -1, 0, x - lx }, { 1, 0, lx + ts - x }, { 0, -1, y - ly }, { 0, 1, ly + ts - y } } do
							if not self:solidCell(cc + o[1], rr + o[2]) and o[3] < bestD then bestD, bx, by = o[3], o[1], o[2] end
						end
						if bestD == math.huge then bestD, bx, by = 0, 0, 1 end
						px += bx * (bestD + r)
						py += by * (bestD + r)
					else
						px += dx / d * (r - d)
						py += dy / d * (r - d)
					end
					hit = true
				end
			end
		end
	end
	if not hit then return nil end
	local d = U.len(px, py)
	if d < 1e-6 then return nil end
	return px / d, py / d, d
end

-- grid(x, y) start slots: k-th car (1-based) behind the start line, 2 abreast
function T:gridSlot(k: number, opts)
	opts = opts or {}
	local row = (k - 1) // 2
	local side = if k % 2 == 1 then -1 else 1
	local back = (opts.first or 70) + row * (opts.spacing or 90)
	local x, y, tx, ty = self:pointAt(self.startS0 - back)
	local lat = side * (opts.lateral or math.min(self.width * 0.5, 48))
	return x - ty * lat, y + tx * lat, U.heading(tx, ty)
end

-- sample(n) -> { {x, y} } evenly along the line (mini-maps); bounds() -> minx, miny, maxx, maxy (px)
function T:sample(n: number)
	local out = {}
	for i = 0, n - 1 do
		local x, y = self:pointAt(i * self.length / n)
		table.insert(out, { x = x, y = y })
	end
	return out
end
function T:bounds() return self.ox, self.oy, self.ox + self.cols * self.ts, self.oy + self.rowCount * self.ts end

return M
