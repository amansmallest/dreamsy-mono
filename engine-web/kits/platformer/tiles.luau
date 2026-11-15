-- platformer kit: tile world. Mirrors TileMap2D grids in Luau (collision queries run every sub-step, so
-- they stay in Luau rather than calling map:isSolid) and moves box actors against them (deterministic,
-- no physics engine). Tile behaviour comes from tileset tags:
--   solid      blocks from every side            oneway   blocks only from above (jump-through)
--   ladder     climbable; its top acts as oneway  hazard / spike  hurts on overlap
--   spring     bounces actors that land on it     breakable  solid; breaks when bonked from below / dashed
--   ice        low-friction floor                 fake     looks solid, isn't (secret passage)
-- Markers (replaced by entities at level start, see level.luau): player_start, checkpoint, goal,
--   enemy + <id>, boss + <id>, platform (+ move_x | move_y), coin, gem, heart, powerup + <ability>.
local T = {}
T.__index = T

local EPS = 0.001

-- maps: a TileMap2D or a list of them (same tile_size and position). opts.solidChars: extra solid chars.
function T.new(maps, opts)
	opts = opts or {}
	if isEntity(maps) then maps = { maps } end
	local list = {}
	for _, m in maps do table.insert(list, m) end
	if #list == 0 then error("platformer tiles: need at least one TileMap2D", 2) end
	local first = list[1]
	local self = setmetatable({}, T)
	self.maps = list
	self.ts = first.tile_size
	local p = first.position
	self.ox, self.oy = p.x, p.y
	self.cols, self.rows = first.cols, first.rows
	self.cells = {}
	self.info = {}
	self.solids = {}
	self.solidChars = opts.solidChars or ""
	for mi, m in list do
		local cells = table.create(m.cols * m.rows, false)
		for r = 0, m.rows - 1 do
			for c = 0, m.cols - 1 do
				local ch = m:getTile(c, r)
				if ch then cells[r * m.cols + c + 1] = ch end
			end
		end
		self.cells[mi] = cells
		self.info[mi] = {}
		if m.cols > self.cols then self.cols = m.cols end
		if m.rows > self.rows then self.rows = m.rows end
	end
	self.width = self.cols * self.ts
	self.height = self.rows * self.ts
	return self
end

-- tile info for a char on map mi (cached per char; from the tileset entry via map:tileDef).
-- solid = tileset "solid" / tag solid / breakable / opts.solidChars, never fake.
function T:charInfo(mi: number, ch: string)
	local cache = self.info[mi]
	local inf = cache[ch]
	if inf then return inf end
	local def = self.maps[mi]:tileDef(ch)
	local tags = (def and def.tags) or {}
	local set = {}
	for _, t in tags do set[t] = true end
	inf = {
		char = ch,
		tags = set,
		list = tags,
		solid = ((def and def.solid) or set.solid == true or set.breakable == true or string.find(self.solidChars, ch, 1, true) ~= nil) and not set.fake,
		oneway = set.oneway == true,
		ladder = set.ladder == true,
	}
	cache[ch] = inf
	return inf
end

function T:inBounds(c: number, r: number): boolean
	return c >= 0 and r >= 0 and c < self.cols and r < self.rows
end

-- char + info on map mi at (c, r); nil when empty
function T:cell(mi: number, c: number, r: number)
	local m = self.maps[mi]
	if c < 0 or r < 0 or c >= m.cols or r >= m.rows then return nil end
	local ch = self.cells[mi][r * m.cols + c + 1]
	if not ch then return nil end
	return self:charInfo(mi, ch)
end

-- true if any map has `tag` at (c, r); returns the map index too
function T:has(c: number, r: number, tag: string): (boolean, number?)
	for mi = 1, #self.maps do
		local inf = self:cell(mi, c, r)
		if inf and inf.tags[tag] then return true, mi end
	end
	return false, nil
end

function T:solidAt(c: number, r: number): boolean
	if c < 0 or c >= self.cols then return true end -- side walls of the level
	if r < 0 or r >= self.rows then return false end -- open top and bottom (falling out = death)
	for mi = 1, #self.maps do
		local inf = self:cell(mi, c, r)
		if inf and inf.solid then return true end
	end
	return false
end

-- one-way surface: oneway tiles, and the top of a ladder
function T:onewayAt(c: number, r: number): boolean
	for mi = 1, #self.maps do
		local inf = self:cell(mi, c, r)
		if inf then
			if inf.oneway then return true end
			if inf.ladder then
				local above = false
				for mj = 1, #self.maps do
					local a = self:cell(mj, c, r - 1)
					if a and a.ladder then above = true end
				end
				if not above then return true end
			end
		end
	end
	return false
end

function T:cellOf(x: number, y: number): (number, number)
	return math.floor((x - self.ox) / self.ts), math.floor((y - self.oy) / self.ts)
end

function T:cellCenter(c: number, r: number): (number, number)
	return self.ox + (c + 0.5) * self.ts, self.oy + (r + 0.5) * self.ts
end

-- Change a tile (updates the TileMap2D and the mirror). ch nil/"." clears.
function T:setTile(mi: number, c: number, r: number, ch: string?)
	local m = self.maps[mi]
	if ch == "." or ch == "" then ch = nil end
	m:setTile(c, r, ch)
	self.cells[mi][r * m.cols + c + 1] = ch or false
end

-- every cell with `tag`: { {c, r, mi, char, tags} }
function T:find(tag: string)
	local out = {}
	for mi, m in self.maps do
		local cells = self.cells[mi]
		for r = 0, m.rows - 1 do
			for c = 0, m.cols - 1 do
				local ch = cells[r * m.cols + c + 1]
				if ch then
					local inf = self:charInfo(mi, ch)
					if inf.tags[tag] then table.insert(out, { c = c, r = r, mi = mi, char = ch, tags = inf.tags, list = inf.list }) end
				end
			end
		end
	end
	return out
end

-- cells overlapped by a centered box (shrunk by `shrink` px) that have `tag`
function T:overlapTag(a, tag: string, shrink: number?)
	local s = shrink or 0
	local c0, r0 = self:cellOf(a.x - a.w / 2 + s, a.y - a.h / 2 + s)
	local c1, r1 = self:cellOf(a.x + a.w / 2 - s - EPS, a.y + a.h / 2 - s - EPS)
	for r = r0, r1 do
		for c = c0, c1 do
			local ok, mi = self:has(c, r, tag)
			if ok then return true, c, r, mi end
		end
	end
	return false
end

-- ---------- moving solids (platforms, blocks) ----------
-- s = { x, y, w, h, oneway = bool }; actors standing on one get a.ground = s and ride along.
function T:addSolid(s)
	table.insert(self.solids, s)
	return s
end

function T:removeSolid(s)
	local i = table.find(self.solids, s)
	if i then table.remove(self.solids, i) end
end

-- ---------- actor movement ----------
-- a = { x, y, w, h } (center + size). Returns true when blocked. Sets a.hitCell = {c, r} on tile hits.
function T:moveX(a, dx: number): boolean
	if dx == 0 then return false end
	local ts = self.ts
	local maxStep = ts / 2 - 0.01
	local remaining = dx
	while remaining ~= 0 do
		local step = math.clamp(remaining, -maxStep, maxStep)
		remaining -= step
		local nx = a.x + step
		local top, bottom = a.y - a.h / 2 + EPS, a.y + a.h / 2 - EPS
		local r0, r1 = math.floor((top - self.oy) / ts), math.floor((bottom - self.oy) / ts)
		local col
		if step > 0 then col = math.floor((nx + a.w / 2 - EPS - self.ox) / ts) else col = math.floor((nx - a.w / 2 - self.ox) / ts) end
		for r = r0, r1 do
			if self:solidAt(col, r) then
				if step > 0 then a.x = self.ox + col * ts - a.w / 2 else a.x = self.ox + (col + 1) * ts + a.w / 2 end
				a.hitCell = { col, r }
				return true
			end
		end
		for _, s in self.solids do
			if s ~= a and not s.oneway and not s.disabled and math.abs(a.y - s.y) < (a.h + s.h) / 2 - EPS then
				local gap = (a.w + s.w) / 2
				if step > 0 and a.x <= s.x - gap + EPS and nx > s.x - gap then
					a.x = s.x - gap
					a.hitSolid = s
					return true
				elseif step < 0 and a.x >= s.x + gap - EPS and nx < s.x + gap then
					a.x = s.x + gap
					a.hitSolid = s
					return true
				end
			end
		end
		a.x = nx
	end
	return false
end

function T:moveY(a, dy: number): boolean
	if dy == 0 then return false end
	local ts = self.ts
	local maxStep = ts / 2 - 0.01
	local remaining = dy
	a.ground = nil
	while remaining ~= 0 do
		local step = math.clamp(remaining, -maxStep, maxStep)
		remaining -= step
		local ny = a.y + step
		local left, right = a.x - a.w / 2 + EPS, a.x + a.w / 2 - EPS
		local c0, c1 = math.floor((left - self.ox) / ts), math.floor((right - self.ox) / ts)
		local row
		if step > 0 then row = math.floor((ny + a.h / 2 - EPS - self.oy) / ts) else row = math.floor((ny - a.h / 2 - self.oy) / ts) end
		for c = c0, c1 do
			local blocked = self:solidAt(c, row)
			if not blocked and step > 0 and not a.dropThrough and not a.climbing then
				local rowTop = self.oy + row * ts
				if a.y + a.h / 2 <= rowTop + 0.01 and self:onewayAt(c, row) then blocked = true end
			end
			if blocked then
				if step > 0 then a.y = self.oy + row * ts - a.h / 2 else a.y = self.oy + (row + 1) * ts + a.h / 2 end
				a.hitCell = { c, row }
				return true
			end
		end
		for _, s in self.solids do
			if s ~= a and not s.disabled and math.abs(a.x - s.x) < (a.w + s.w) / 2 - EPS then
				local gap = (a.h + s.h) / 2
				if step > 0 and a.y <= s.y - gap + EPS and ny > s.y - gap and not (s.oneway and a.dropThrough) then
					a.y = s.y - gap
					a.ground = s
					a.hitSolid = s
					return true
				elseif step < 0 and not s.oneway and a.y >= s.y + gap - EPS and ny < s.y + gap then
					a.y = s.y + gap
					a.hitSolid = s
					return true
				end
			end
		end
		a.y = ny
	end
	return false
end

-- standing on something (probe 1px below)?
function T:onGround(a): boolean
	local probe = { x = a.x, y = a.y, w = a.w, h = a.h, dropThrough = a.dropThrough, climbing = a.climbing }
	local hit = self:moveY(probe, 1)
	a.ground = probe.ground
	return hit
end

-- touching a solid wall on side dir (-1 / 1)?
function T:wallAt(a, dir: number): boolean
	local x = if dir > 0 then a.x + a.w / 2 + 1 else a.x - a.w / 2 - 1
	local c = math.floor((x - self.ox) / self.ts)
	local r0 = math.floor((a.y - a.h / 2 + 2 - self.oy) / self.ts)
	local r1 = math.floor((a.y + a.h / 2 - 2 - self.oy) / self.ts)
	for r = r0, r1 do
		if c >= 0 and c < self.cols and self:solidAt(c, r) then return true end
	end
	return false
end

-- floor ahead of a walker (ledge detection): is there ground under the point dir px ahead of its feet?
function T:groundAhead(a, dir: number): boolean
	local x = if dir > 0 then a.x + a.w / 2 + 1 else a.x - a.w / 2 - 1
	local c = math.floor((x - self.ox) / self.ts)
	local r = math.floor((a.y + a.h / 2 + 2 - self.oy) / self.ts)
	if self:solidAt(c, r) or self:onewayAt(c, r) then return true end
	for _, s in self.solids do
		if not s.disabled and math.abs(x - s.x) < s.w / 2 and math.abs((a.y + a.h / 2 + 2) - (s.y - s.h / 2)) < 4 then return true end
	end
	return false
end

-- line of sight between two points (tiles only)
function T:clearLine(x0: number, y0: number, x1: number, y1: number): boolean
	local d = math.sqrt((x1 - x0) ^ 2 + (y1 - y0) ^ 2)
	local n = math.max(1, math.ceil(d / (self.ts / 2)))
	for i = 1, n - 1 do
		local t = i / n
		local c, r = self:cellOf(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)
		if r >= 0 and r < self.rows and c >= 0 and c < self.cols and self:solidAt(c, r) then return false end
	end
	return true
end

return T
