-- Rooms-and-corridors dungeon. Always connected (MST over rooms + optional loops), validated before returning.
local RNG = require("./rng")
local Grid = require("./grid")
local validate = require("./validate")

local D = {}

local function overlaps(a, b, m)
	return a.x - m < b.x + b.w and b.x - m < a.x + a.w and a.y - m < b.y + b.h and b.y - m < a.y + a.h
end

local function carveL(g, rng, x1, y1, x2, y2, floor, width)
	local function dig(x, y)
		for i = 0, width - 1 do
			for j = 0, width - 1 do
				if x + i > 0 and y + j > 0 and x + i < g.w - 1 and y + j < g.h - 1 then g:set(x + i, y + j, floor) end
			end
		end
	end
	local horizFirst = rng:chance(0.5)
	local x, y = x1, y1
	local function walkX(tx) while x ~= tx do dig(x, y); x += if tx > x then 1 else -1 end dig(x, y) end
	local function walkY(ty) while y ~= ty do dig(x, y); y += if ty > y then 1 else -1 end dig(x, y) end
	if horizFirst then walkX(x2); walkY(y2) else walkY(y2); walkX(x2) end
	dig(x, y)
end

-- random floor cells of a room (interior), avoiding `taken` set
local function roomCells(g, room, floor)
	local out = {}
	for y = room.y, room.y + room.h - 1 do
		for x = room.x, room.x + room.w - 1 do
			if g:get(x, y) == floor then table.insert(out, { x = x, y = y }) end
		end
	end
	return out
end

--[[ opts: { seed|rng, w = 48, h = 48, rooms = 10, minRoom = 4, maxRoom = 9, loops = 0.15, corridor = 1,
            wall = "#", floor = ".", enemies = {min,max} per room | number, items = {min,max} per room }
     -> level: { grid, w, h, rooms = { {id,x,y,w,h,cx,cy,dist} }, start = {x,y}, exit = {x,y},
                 spawns = { {kind = "enemy"|"item", x, y, room} }, report } ]]
function D.generate(opts: any?): any
	opts = opts or {}
	local rng = RNG.from(opts.rng or opts.seed)
	local W, H = opts.w or 48, opts.h or 48
	local wall, floor = opts.wall or Grid.WALL, opts.floor or Grid.FLOOR
	for attempt = 1, 20 do
		local g = Grid.new(W, H, wall)
		local rooms = {}
		local want = opts.rooms or 10
		local tries = 0
		while #rooms < want and tries < want * 40 do
			tries += 1
			local rw = rng:int(opts.minRoom or 4, opts.maxRoom or 9)
			local rh = rng:int(opts.minRoom or 4, opts.maxRoom or 9)
			if rw <= W - 2 and rh <= H - 2 then
				local r = { x = rng:int(1, W - rw - 1), y = rng:int(1, H - rh - 1), w = rw, h = rh }
				local free = true
				for _, o in rooms do if overlaps(r, o, 2) then free = false break end end
				if free then
					r.id = #rooms + 1
					r.cx, r.cy = r.x + rw // 2, r.y + rh // 2
					table.insert(rooms, r)
					g:fill(r.x, r.y, rw, rh, floor)
				end
			end
		end
		if #rooms >= 2 then
			-- Prim MST over room centres (deterministic), then extra loop edges
			local inTree = { [1] = true }
			local edges = {}
			for _ = 2, #rooms do
				local best, bi, bj = math.huge, 0, 0
				for i in inTree do
					for j = 1, #rooms do
						if not inTree[j] then
							local a, b = rooms[i], rooms[j]
							local d = math.abs(a.cx - b.cx) + math.abs(a.cy - b.cy)
							if d < best or (d == best and (i < bi or (i == bi and j < bj))) then best, bi, bj = d, i, j end
						end
					end
				end
				inTree[bj] = true
				table.insert(edges, { bi, bj })
			end
			for i = 1, #rooms do
				for j = i + 1, #rooms do
					if rng:chance((opts.loops or 0.15) / #rooms * 2) then table.insert(edges, { i, j }) end
				end
			end
			for _, e in edges do
				local a, b = rooms[e[1]], rooms[e[2]]
				carveL(g, rng, a.cx, a.cy, b.cx, b.cy, floor, opts.corridor or 1)
			end
			-- start = first room; exit = room farthest (BFS) from start
			local s = rooms[1]
			local seen = g:flood(s.cx, s.cy, function(c) return c == floor end)
			local far, farD = rooms[#rooms], -1
			for _, r in rooms do
				r.dist = seen[r.cy * W + r.cx] or 0
				if r.dist > farD then far, farD = r, r.dist end
			end
			local level = {
				grid = g, w = W, h = H, rooms = rooms, seed = opts.seed,
				start = { x = s.cx, y = s.cy }, exit = { x = far.cx, y = far.cy }, exitRoom = far.id, spawns = {},
			}
			local function count(spec)
				if spec == nil then return 0 end
				if type(spec) == "number" then return spec end
				return rng:int(spec[1] or spec.min, spec[2] or spec.max)
			end
			for _, r in rooms do
				if r ~= s then
					local cells = rng:shuffle(roomCells(g, r, floor))
					local k = 1
					for _, ks in { { "enemy", opts.enemies or { 1, 3 } }, { "item", opts.items or { 0, 1 } } } do
						local kind, spec = ks[1], ks[2]
						for _ = 1, count(spec) do
							local c = cells[k]
							if c and not (c.x == far.cx and c.y == far.cy) then
								table.insert(level.spawns, { kind = kind, x = c.x, y = c.y, room = r.id })
							end
							k += 1
						end
					end
				end
			end
			table.sort(level.spawns, function(a, b)
				if a.room ~= b.room then return a.room < b.room end
				if a.kind ~= b.kind then return a.kind < b.kind end
				return a.y * W + a.x < b.y * W + b.x
			end)
			level.report = validate(g, { pass = function(c) return c == floor end, from = level.start, targets = { level.exit } })
			if level.report.ok then return level end
		end
	end
	error("procgen.dungeon: could not generate a connected dungeon (map too small for the room count?)")
end

return D
