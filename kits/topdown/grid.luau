-- topdown kit: tile world. Mirrors one or more TileMap2D layers (e.g. floor + objects) in Luau and
-- moves box actors against them in 8 directions (deterministic, no physics engine).
-- Blocking tags: solid, wall, water, gap (pits; hookshot crosses), cracked (bomb breaks), locked
-- (small key), boss_locked (boss key), gate (opened by plates/switches), shutter (closed while a
-- room fight is on), block (pushable), switch, bush (sword cuts), sign, hook/hookable (hookshot targets),
-- rough (needs an item that passes it, e.g. boots). An actor with a.passes = { rough = true } walks
-- through tiles with those tags.
local G = {}
G.__index = G

local EPS = 0.001
G.BLOCKING = { solid = true, wall = true, water = true, gap = true, cracked = true, locked = true, boss_locked = true, gate = true, shutter = true, block = true, switch = true, rough = true, bush = true, sign = true, hook = true, hookable = true }

function G.new(maps, opts)
	opts = opts or {}
	if isEntity(maps) then maps = { maps } end
	local list = {}
	for _, m in maps do table.insert(list, m) end
	if #list == 0 then error("topdown grid: need at least one TileMap2D", 2) end
	local first = list[1]
	local self = setmetatable({}, G)
	self.maps = list
	self.ts = first.tile_size
	local p = first.position
	self.ox, self.oy = p.x, p.y
	self.cols, self.rows = 0, 0
	self.cells, self.info = {}, {}
	self.solids = {}
	self.blocking = opts.blocking or G.BLOCKING
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
		self.cols = math.max(self.cols, m.cols)
		self.rows = math.max(self.rows, m.rows)
	end
	self.width, self.height = self.cols * self.ts, self.rows * self.ts
	self.w, self.h = self.cols, self.rows -- + G:get: readable as an @kit/ai path grid source
	return self
end

-- tile behaviour from the tileset entry's tags (map:tileDef), cached per layer + char
function G:charInfo(mi: number, ch: string)
	local cache = self.info[mi]
	local inf = cache[ch]
	if inf then return inf end
	local def = self.maps[mi]:tileDef(ch)
	local tags = (def and def.tags) or {}
	local set = {}
	local block = false
	for _, t in tags do
		set[t] = true
		if self.blocking[t] then block = true end
	end
	inf = { char = ch, tags = set, list = tags, blocks = block }
	cache[ch] = inf
	return inf
end

function G:cell(mi: number, c: number, r: number)
	local m = self.maps[mi]
	if c < 0 or r < 0 or c >= m.cols or r >= m.rows then return nil end
	local ch = self.cells[mi][r * m.cols + c + 1]
	if not ch then return nil end
	return self:charInfo(mi, ch)
end

function G:inBounds(c: number, r: number): boolean
	return c >= 0 and r >= 0 and c < self.cols and r < self.rows
end

function G:has(c: number, r: number, tag: string): (boolean, number?)
	for mi = #self.maps, 1, -1 do
		local inf = self:cell(mi, c, r)
		if inf and inf.tags[tag] then return true, mi end
	end
	return false, nil
end

-- blocked for an actor (respecting a.passes and a.flying)
function G:blockedAt(c: number, r: number, a): boolean
	if not self:inBounds(c, r) then return true end
	for mi = 1, #self.maps do
		local inf = self:cell(mi, c, r)
		if inf and inf.blocks then
			local passable = false
			if a then
				for t in inf.tags do
					if self.blocking[t] and ((a.passes and a.passes[t]) or (a.flying and (t == "gap" or t == "water"))) then passable = true end
				end
				-- passable only if every blocking tag is passed
				if passable then
					for t in inf.tags do
						if self.blocking[t] and not ((a.passes and a.passes[t]) or (a.flying and (t == "gap" or t == "water"))) then passable = false end
					end
				end
			end
			if not passable then return true end
		end
	end
	return false
end

-- "#" = blocked for a walker, "." = open (@kit/ai: ai.grid(grid, { solid = "#" }) path-finds over the live grid)
function G:get(c: number, r: number): string
	return if self:blockedAt(c, r, nil) then "#" else "."
end

function G:cellOf(x: number, y: number): (number, number)
	return math.floor((x - self.ox) / self.ts), math.floor((y - self.oy) / self.ts)
end

function G:cellCenter(c: number, r: number): (number, number)
	return self.ox + (c + 0.5) * self.ts, self.oy + (r + 0.5) * self.ts
end

-- topmost layer char at a cell (nil = empty everywhere)
function G:topChar(c: number, r: number): (string?, number?)
	for mi = #self.maps, 1, -1 do
		local m = self.maps[mi]
		if c >= 0 and r >= 0 and c < m.cols and r < m.rows then
			local ch = self.cells[mi][r * m.cols + c + 1]
			if ch then return ch, mi end
		end
	end
	return nil, nil
end

function G:setTile(mi: number, c: number, r: number, ch: string?)
	local m = self.maps[mi]
	if ch == "." or ch == "" then ch = nil end
	m:setTile(c, r, ch)
	self.cells[mi][r * m.cols + c + 1] = ch or false
end

function G:find(tag: string)
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

-- first cell with `tag` overlapped by box a (shrunk by s px)
function G:overlapTag(a, tag: string, s: number?)
	s = s or 0
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

-- ---------- solid entities (NPCs, chests, blocks being pushed) ----------
function G:addSolid(s)
	table.insert(self.solids, s)
	return s
end

function G:removeSolid(s)
	local i = table.find(self.solids, s)
	if i then table.remove(self.solids, i) end
end

-- Move along one axis; returns blocked, and sets a.hitCell / a.hitSolid.
local function sweep(self, a, d: number, axis: string): boolean
	if d == 0 then return false end
	local ts = self.ts
	local maxStep = ts / 2 - 0.01
	local remaining = d
	while remaining ~= 0 do
		local step = math.clamp(remaining, -maxStep, maxStep)
		remaining -= step
		if axis == "x" then
			local nx = a.x + step
			local r0, r1 = math.floor((a.y - a.h / 2 + EPS - self.oy) / ts), math.floor((a.y + a.h / 2 - EPS - self.oy) / ts)
			local col = if step > 0 then math.floor((nx + a.w / 2 - EPS - self.ox) / ts) else math.floor((nx - a.w / 2 - self.ox) / ts)
			for r = r0, r1 do
				if self:blockedAt(col, r, a) then
					a.x = if step > 0 then self.ox + col * ts - a.w / 2 else self.ox + (col + 1) * ts + a.w / 2
					a.hitCell = { col, r }
					return true
				end
			end
			for _, s in self.solids do
				if s ~= a and not s.disabled and math.abs(a.y - s.y) < (a.h + s.h) / 2 - EPS then
					local gap = (a.w + s.w) / 2
					if step > 0 and a.x <= s.x - gap + EPS and nx > s.x - gap then a.x = s.x - gap a.hitSolid = s return true end
					if step < 0 and a.x >= s.x + gap - EPS and nx < s.x + gap then a.x = s.x + gap a.hitSolid = s return true end
				end
			end
			a.x = nx
		else
			local ny = a.y + step
			local c0, c1 = math.floor((a.x - a.w / 2 + EPS - self.ox) / ts), math.floor((a.x + a.w / 2 - EPS - self.ox) / ts)
			local row = if step > 0 then math.floor((ny + a.h / 2 - EPS - self.oy) / ts) else math.floor((ny - a.h / 2 - self.oy) / ts)
			for c = c0, c1 do
				if self:blockedAt(c, row, a) then
					a.y = if step > 0 then self.oy + row * ts - a.h / 2 else self.oy + (row + 1) * ts + a.h / 2
					a.hitCell = { c, row }
					return true
				end
			end
			for _, s in self.solids do
				if s ~= a and not s.disabled and math.abs(a.x - s.x) < (a.w + s.w) / 2 - EPS then
					local gap = (a.h + s.h) / 2
					if step > 0 and a.y <= s.y - gap + EPS and ny > s.y - gap then a.y = s.y - gap a.hitSolid = s return true end
					if step < 0 and a.y >= s.y + gap - EPS and ny < s.y + gap then a.y = s.y + gap a.hitSolid = s return true end
				end
			end
			a.y = ny
		end
	end
	return false
end

function G:moveX(a, dx: number): boolean return sweep(self, a, dx, "x") end
function G:moveY(a, dy: number): boolean return sweep(self, a, dy, "y") end

-- Move with corner sliding: when blocked on one axis but nearly past a corner, nudge around it.
function G:move(a, dx: number, dy: number, nudge: number?)
	a.hitCell, a.hitSolid = nil, nil
	local hx = self:moveX(a, dx)
	local cellX = a.hitCell
	local hy = self:moveY(a, dy)
	local n = nudge or 0
	if n > 0 and hx and dy == 0 then
		for _, off in { -1, 1 } do
			local probe = { x = a.x, y = a.y + off * n, w = a.w, h = a.h, passes = a.passes, flying = a.flying }
			if not self:moveY({ x = a.x, y = a.y, w = a.w, h = a.h, passes = a.passes, flying = a.flying }, off * n) and not self:moveX(probe, dx) then
				self:moveY(a, off * math.min(n, math.abs(dx) + 0.5))
				break
			end
		end
	elseif n > 0 and hy and dx == 0 then
		for _, off in { -1, 1 } do
			local probe = { x = a.x + off * n, y = a.y, w = a.w, h = a.h, passes = a.passes, flying = a.flying }
			if not self:moveX({ x = a.x, y = a.y, w = a.w, h = a.h, passes = a.passes, flying = a.flying }, off * n) and not self:moveY(probe, dy) then
				self:moveX(a, off * math.min(n, math.abs(dy) + 0.5))
				break
			end
		end
	end
	if cellX and not a.hitCell then a.hitCell = cellX end
	return hx, hy
end

function G:clearLine(x0: number, y0: number, x1: number, y1: number, a): boolean
	local d = math.sqrt((x1 - x0) ^ 2 + (y1 - y0) ^ 2)
	local n = math.max(1, math.ceil(d / (self.ts / 2)))
	for i = 1, n - 1 do
		local t = i / n
		local c, r = self:cellOf(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)
		if self:blockedAt(c, r, a or { flying = true }) then return false end
	end
	return true
end

return G
