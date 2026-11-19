-- Room-template stitching (Isaac/Spelunky-style): hand-made room chunks assembled on a room grid.
-- Guaranteed: start -> key reachable without passing the locked door; start -> exit reachable with it.
local RNG = require("./rng")
local Grid = require("./grid")
local validate = require("./validate")

local R = {}

-- normalize templates: list of {id, grid, tags?, weight?} | map id -> text | id -> {grid, tags}
function R.templates(input: any): { any }
	local out = {}
	local function add(id, t)
		if type(t) == "string" then t = { grid = t } end
		local tags = t.tags
		if tags == nil then
			tags = {}
			local prefix = string.match(id, "^([a-z]+)_") or id
			table.insert(tags, prefix)
		end
		local g = Grid.fromString(t.grid, Grid.FLOOR)
		table.insert(out, { id = id, grid = g, tags = tags, weight = t.weight or 1 })
	end
	if #input > 0 then
		for i, t in input do add(t.id or tostring(i), t) end
	else
		local keys = {}
		for k in input do table.insert(keys, k) end
		table.sort(keys)
		for _, k in keys do add(k, input[k]) end
	end
	assert(#out > 0, "procgen.rooms: no templates")
	local w, h = out[1].grid.w, out[1].grid.h
	for _, t in out do
		if t.grid.w ~= w or t.grid.h ~= h then
			error(`procgen.rooms: template "{t.id}" is {t.grid.w}x{t.grid.h}, expected {w}x{h} (all room templates must be the same size)`)
		end
	end
	return out
end

local function hasTag(t, tag) return table.find(t.tags, tag) ~= nil end

local DIRS = { { 1, 0, "e" }, { -1, 0, "w" }, { 0, 1, "s" }, { 0, -1, "n" } }

--[[ opts: { templates (required), seed|rng, rooms = 6 (main path length incl. start+exit), branches = 2,
            key = true (lock the exit room's door, put a key in a side room), wall = "#", floor = ".",
            door = "+" (locked door char), keyChar = "k", exitChar = ">", startChar = nil,
            markers = "floor" | "keep" (template marker chars become floor (default) or stay) }
   template chars: wall / floor as configured, "?" = random wall-or-floor (50%), any other char = marker
   (reported in level.markers {char,x,y,room}; e.g. "E" enemy, "T" treasure).
   template tags (or id prefix: "start_1", "exit_boss", "key_a", "room_3"): start, exit|boss, key|treasure, others = normal.
   -> level { grid, start, exit, key?, door?, rooms = {{id, template, gx, gy, x, y, w, h, role}}, markers, report } ]]
function R.generate(opts: any): any
	local rng = RNG.from(opts.rng or opts.seed)
	local temps = R.templates(opts.templates)
	local TW, TH = temps[1].grid.w, temps[1].grid.h
	local wall, floor = opts.wall or Grid.WALL, opts.floor or Grid.FLOOR
	local nPath = math.max(2, opts.rooms or 6)
	local nBranch = opts.branches or 2
	local useKey = opts.key ~= false

	local function pickTemplate(role)
		local pool = {}
		local tagsFor = ({ start = { "start" }, exit = { "exit", "boss" }, key = { "key", "treasure" } })[role]
		if tagsFor then
			for _, t in temps do
				for _, tg in tagsFor do if hasTag(t, tg) then table.insert(pool, t) break end end
			end
		end
		if #pool == 0 then
			for _, t in temps do
				if not (hasTag(t, "start") or hasTag(t, "exit") or hasTag(t, "boss") or hasTag(t, "key") or hasTag(t, "treasure")) then
					table.insert(pool, t)
				end
			end
		end
		if #pool == 0 then pool = temps end
		return rng:weighted(pool)
	end

	for attempt = 1, 40 do
		-- 1. layout: self-avoiding random walk for the main path
		local cells = {} -- "x,y" -> room
		local rooms = {}
		local function key(x, y) return x .. "," .. y end
		local x, y = 0, 0
		local okWalk = true
		for i = 1, nPath do
			local r = { id = i, gx = x, gy = y, role = if i == 1 then "start" elseif i == nPath then "exit" else "path", links = {} }
			cells[key(x, y)] = r
			table.insert(rooms, r)
			if i < nPath then
				local opts2 = {}
				for _, d in DIRS do if not cells[key(x + d[1], y + d[2])] then table.insert(opts2, d) end end
				if #opts2 == 0 then okWalk = false break end
				local d = rng:pick(opts2)
				x += d[1]; y += d[2]
			end
		end
		if okWalk then
			for i = 1, nPath - 1 do
				table.insert(rooms[i].links, rooms[i + 1])
				table.insert(rooms[i + 1].links, rooms[i])
			end
			-- 2. branches off path rooms (never off the exit)
			for b = 1, nBranch do
				for _ = 1, 20 do
					local host = rooms[rng:int(1, nPath - 1)]
					local d = rng:pick(DIRS)
					local bx, by = host.gx + d[1], host.gy + d[2]
					if not cells[key(bx, by)] then
						local r = { id = #rooms + 1, gx = bx, gy = by, role = "side", links = { host } }
						table.insert(host.links, r)
						cells[key(bx, by)] = r
						table.insert(rooms, r)
						break
					end
				end
			end
			-- key room: the side room farthest along the path, else the room before the exit
			local keyRoom = nil
			if useKey then
				for i = #rooms, nPath + 1, -1 do keyRoom = rooms[i] break end
				if keyRoom == nil then keyRoom = rooms[nPath - 1] end
				if keyRoom.role == "side" then keyRoom.role = "key" end
			end
			-- 3. assemble
			local minX, minY, maxX, maxY = 0, 0, 0, 0
			for _, r in rooms do
				minX, minY = math.min(minX, r.gx), math.min(minY, r.gy)
				maxX, maxY = math.max(maxX, r.gx), math.max(maxY, r.gy)
			end
			local g = Grid.new((maxX - minX + 1) * TW, (maxY - minY + 1) * TH, opts.background or wall)
			local markers = {}
			for _, r in rooms do
				local t = pickTemplate(if r.role == "key" then "key" elseif r.role == "side" or r.role == "path" then "room" else r.role)
				r.template = t.id
				r.x, r.y, r.w, r.h = (r.gx - minX) * TW, (r.gy - minY) * TH, TW, TH
				for ty = 0, TH - 1 do
					for tx = 0, TW - 1 do
						local c = t.grid:get(tx, ty) or floor
						if c == " " then c = floor end
						if c == "?" then c = if rng:chance(0.5) then wall else floor end
						if c ~= wall and c ~= floor then
							table.insert(markers, { char = c, x = r.x + tx, y = r.y + ty, room = r.id })
							if opts.markers ~= "keep" then c = floor end
						end
						-- seal the border; doors are carved below
						if tx == 0 or ty == 0 or tx == TW - 1 or ty == TH - 1 then c = wall end
						g:set(r.x + tx, r.y + ty, c)
					end
				end
			end
			-- doors: carve the shared edge centre on both sides, then dig inward to the first open cell
			local function isOpen(cx, cy) local c = g:get(cx, cy) return c ~= nil and c ~= wall end
			local function digIn(cx, cy, dx, dy, limit)
				for _ = 1, limit do
					cx += dx; cy += dy
					if isOpen(cx, cy) then return end
					g:set(cx, cy, floor)
				end
			end
			local door = nil
			local exitRoom = rooms[nPath]
			for _, a in rooms do
				for _, b in a.links do
					if a.id < b.id then
						local dx, dy = b.gx - a.gx, b.gy - a.gy
						local ax, ay, bx, by
						if dx ~= 0 then
							local cy = a.y + TH // 2
							ax = if dx > 0 then a.x + TW - 1 else a.x
							bx = ax + dx
							ay, by = cy, cy
						else
							local cx = a.x + TW // 2
							ay = if dy > 0 then a.y + TH - 1 else a.y
							by = ay + dy
							ax, bx = cx, cx
						end
						g:set(ax, ay, floor)
						g:set(bx, by, floor)
						digIn(ax, ay, -dx, -dy, math.max(TW, TH))
						digIn(bx, by, dx, dy, math.max(TW, TH))
						if useKey and (a == exitRoom or b == exitRoom) then
							-- lock on the exit room's side
							local lx, ly = if b == exitRoom then bx else ax, if b == exitRoom then by else ay
							g:set(lx, ly, opts.door or "+")
							door = { x = lx, y = ly }
						end
					end
				end
			end
			-- 4. place start / exit / key at the open cell nearest each room centre
			local function nearestOpen(r)
				local best, bd = nil, math.huge
				local cx, cy = r.x + TW // 2, r.y + TH // 2
				for yy = r.y + 1, r.y + TH - 2 do
					for xx = r.x + 1, r.x + TW - 2 do
						if g:get(xx, yy) == floor then
							local d = math.abs(xx - cx) + math.abs(yy - cy)
							if d < bd then best, bd = { x = xx, y = yy }, d end
						end
					end
				end
				return best
			end
			local level = { grid = g, rooms = rooms, markers = markers, door = door, seed = opts.seed, tileW = TW, tileH = TH }
			level.start = nearestOpen(rooms[1])
			level.exit = nearestOpen(exitRoom)
			if keyRoom then level.key = nearestOpen(keyRoom) end
			for _, r in rooms do r.links = nil end
			if level.start and level.exit and (not useKey or level.key) then
				if level.start then if opts.startChar then g:set(level.start.x, level.start.y, opts.startChar) end end
				g:set(level.exit.x, level.exit.y, opts.exitChar or ">")
				if level.key then g:set(level.key.x, level.key.y, opts.keyChar or "k") end
				local doorChar = opts.door or "+"
				-- without the key: everything but the exit room must be reachable, and the key too
				local function passNoDoor(c) return c ~= nil and c ~= wall and c ~= doorChar end
				local pre = validate(g, { pass = passNoDoor, from = level.start, targets = if level.key then { level.key } else {}, requireAll = false })
				local targets = { level.exit }
				for _, m in markers do table.insert(targets, m) end
				local openFn = function(c) return c ~= nil and c ~= wall end
				local full = validate(g, { pass = openFn, from = level.start, targets = targets, requireAll = false })
				if full.ok then
					-- wall up isolated pockets (from "?" cells) so every visible floor is reachable
					local seen = g:flood(level.start.x, level.start.y, openFn)
					for yy = 0, g.h - 1 do
						for xx = 0, g.w - 1 do
							if openFn(g:get(xx, yy)) and seen[yy * g.w + xx] == nil then g:set(xx, yy, wall) end
						end
					end
					full = validate(g, { pass = openFn, from = level.start, targets = { level.exit } })
				end
				level.report = full
				level.report.keyReachable = pre.ok
				if pre.ok and full.ok then
					level.report.ok = true
					table.sort(markers, function(p, q) return p.y * g.w + p.x < q.y * g.w + q.x end)
					return level
				end
			end
		end
	end
	error("procgen.rooms: could not stitch a valid floor in 40 attempts (check your templates' interiors are connected)")
end

return R
