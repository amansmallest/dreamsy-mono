-- Deterministic raid simulation. Pure data: no entities, no platform random.
-- Same layout + same deploy log => same result on every device (async raids).
local C = require("./config")

local Sim = {}
local G = C.GRID

-- Park-Miller LCG: exact in doubles, identical everywhere.
function Sim.rng(seed)
	local s = math.floor(seed) % 2147483647
	if s <= 0 then
		s += 2147483646
	end
	return function(a, b)
		s = (s * 16807) % 2147483647
		return a + (s % (b - a + 1))
	end
end

function Sim.generateOutpost(seed, level)
	local r = Sim.rng(seed)
	local list = {}
	local used = {}
	local function put(kind, cx, cy)
		local k = cy * G + cx
		if used[k] then
			return
		end
		used[k] = true
		table.insert(list, { kind = kind, cx = cx, cy = cy })
	end
	local function shuffle(t)
		for i = #t, 2, -1 do
			local j = r(1, i)
			t[i], t[j] = t[j], t[i]
		end
	end

	local c = 5
	put("townhall", c, c)

	local inner = {}
	for j = c - 1, c + 1 do
		for i = c - 1, c + 1 do
			if not (i == c and j == c) then
				table.insert(inner, { i, j })
			end
		end
	end
	shuffle(inner)

	local outer = {}
	for j = 2, G - 3 do
		for i = 2, G - 3 do
			if i < c - 2 or i > c + 2 or j < c - 2 or j > c + 2 then
				table.insert(outer, { i, j })
			end
		end
	end
	shuffle(outer)

	local ii, oi = 1, 1
	local function placeOuter(kind)
		if oi <= #outer then
			local p = outer[oi]
			oi += 1
			put(kind, p[1], p[2])
		end
	end
	local function placeInner(kind)
		if ii <= #inner then
			local p = inner[ii]
			ii += 1
			put(kind, p[1], p[2])
		else
			placeOuter(kind)
		end
	end

	local cannons = math.min(4, 1 + math.floor(level / 2))
	local towers = math.min(3, 1 + math.floor((level - 1) / 2))
	placeInner("cannon")
	placeInner("tower")
	placeInner("storage")
	for n = 2, cannons do
		if n % 2 == 0 then placeInner("cannon") else placeOuter("cannon") end
	end
	for n = 2, towers do
		if n % 2 == 0 then placeOuter("tower") else placeInner("tower") end
	end
	placeOuter("storage")
	local mines = 2 + math.floor(level / 3)
	for _ = 1, mines do
		placeOuter("mine")
		placeOuter("pump")
	end
	placeOuter("barracks")

	-- wall ring around the town hall core, with gaps at low levels
	local ring = {}
	for i = c - 2, c + 2 do
		table.insert(ring, { i, c - 2 })
		table.insert(ring, { i, c + 2 })
	end
	for j = c - 1, c + 1 do
		table.insert(ring, { c - 2, j })
		table.insert(ring, { c + 2, j })
	end
	local gaps = math.max(0, 4 - level)
	local gapAt = {}
	for _ = 1, gaps do
		gapAt[r(1, #ring)] = true
	end
	for n, p in ring do
		if not gapAt[n] then
			put("wall", p[1], p[2])
		end
	end
	if level >= 4 then
		for _ = 1, (level - 3) * 3 do
			placeOuter("wall")
		end
	end
	return list
end

function Sim.new(layout, army, level)
	local st = {
		tick = 0,
		buildings = {},
		troops = {},
		cells = {},
		events = {},
		pending = {},
		log = {},
		army = army,
		total = 0,
		destroyed = 0,
		pct = 0,
		stars = 0,
		thDown = false,
		over = false,
		alive = 0,
		level = level,
		loot = { gold = 250 + level * 150, elixir = 250 + level * 150 },
	}
	for i, b in layout do
		local d = C.buildings[b.kind]
		local bb = {
			id = i, kind = b.kind, cx = b.cx, cy = b.cy, x = b.cx + 0.5, y = b.cy + 0.5,
			hp = d.hp, maxhp = d.hp, cd = 0, alive = true, defense = d.range ~= nil,
		}
		table.insert(st.buildings, bb)
		st.cells[b.cy * G + b.cx] = bb
		if b.kind ~= "wall" then
			st.total += 1
		end
	end
	return st
end

function Sim.deploy(st, kind, cx, cy)
	if st.over or (st.army[kind] or 0) <= 0 then
		return false
	end
	st.army[kind] -= 1
	table.insert(st.pending, { kind = kind, cx = cx, cy = cy })
	return true
end

local function dist(ax, ay, bx, by)
	local dx, dy = bx - ax, by - ay
	return math.sqrt(dx * dx + dy * dy)
end

local function damageBuilding(st, b, dmg)
	if not b.alive then
		return
	end
	b.hp -= dmg
	table.insert(st.events, { type = "bhit", b = b })
	if b.hp <= 0 then
		b.hp = 0
		b.alive = false
		st.cells[b.cy * G + b.cx] = nil
		if b.kind ~= "wall" then
			st.destroyed += 1
		end
		if b.kind == "townhall" then
			st.thDown = true
		end
		table.insert(st.events, { type = "bdie", b = b })
	end
end

local function damageTroop(st, t, dmg)
	if not t.alive then
		return
	end
	t.hp -= dmg
	table.insert(st.events, { type = "thit", t = t })
	if t.hp <= 0 then
		t.alive = false
		st.alive -= 1
		table.insert(st.events, { type = "tdie", t = t })
	end
end

local function findTarget(st, t)
	local d = C.troops[t.kind]
	local best, bestD = nil, math.huge
	if d.prefers == "defense" then
		for _, b in st.buildings do
			if b.alive and b.defense then
				local dd = dist(t.x, t.y, b.x, b.y)
				if dd < bestD then
					best, bestD = b, dd
				end
			end
		end
		if best then
			return best
		end
	end
	for _, b in st.buildings do
		if b.alive and b.kind ~= "wall" then
			local dd = dist(t.x, t.y, b.x, b.y)
			if dd < bestD then
				best, bestD = b, dd
			end
		end
	end
	return best
end

local function troopStep(st, t, dt)
	local d = C.troops[t.kind]
	if t.cd > 0 then
		t.cd -= dt
	end
	if t.target == nil or not t.target.alive then
		t.target = findTarget(st, t)
	end
	local tg = t.target
	if tg == nil then
		return
	end
	local dx, dy = tg.x - t.x, tg.y - t.y
	local len = math.sqrt(dx * dx + dy * dy)
	if len - 0.5 <= d.range then
		if t.cd <= 0 then
			t.cd = d.rate
			table.insert(st.events, { type = "tshot", t = t, b = tg })
			damageBuilding(st, tg, d.dmg)
		end
		return
	end
	local step = d.speed * dt
	local nx, ny = t.x + dx / len * step, t.y + dy / len * step
	local blk = st.cells[math.floor(ny) * G + math.floor(nx)]
	if blk and blk.kind == "wall" and blk ~= tg then
		t.target = blk -- smash through the wall in the way
	else
		t.x, t.y = nx, ny
	end
end

local function defenseStep(st, b, dt)
	local d = C.buildings[b.kind]
	if b.cd > 0 then
		b.cd -= dt
		return
	end
	local best, bestD = nil, d.range + 0.0001
	for _, t in st.troops do
		if t.alive then
			local dd = dist(b.x, b.y, t.x, t.y)
			if dd < bestD then
				best, bestD = t, dd
			end
		end
	end
	if best then
		b.cd = d.rate
		table.insert(st.events, { type = "dshot", b = b, t = best })
		damageTroop(st, best, d.dmg)
	end
end

function Sim.step(st)
	if st.over then
		return
	end
	local dt = C.SIM_DT
	st.tick += 1
	for _, p in st.pending do
		local n = #st.troops
		local d = C.troops[p.kind]
		local x = p.cx + 0.5 + ((n % 3) - 1) * 0.2
		local y = p.cy + 0.5 + ((math.floor(n / 3) % 3) - 1) * 0.2
		local t = { kind = p.kind, x = x, y = y, px = x, py = y, hp = d.hp, maxhp = d.hp, cd = 0, alive = true, target = nil }
		table.insert(st.troops, t)
		st.alive += 1
		table.insert(st.log, { tick = st.tick, kind = p.kind, cx = p.cx, cy = p.cy })
		table.insert(st.events, { type = "spawn", troop = t })
	end
	table.clear(st.pending)

	for _, t in st.troops do
		if t.alive then
			t.px, t.py = t.x, t.y
			troopStep(st, t, dt)
		end
	end
	for _, b in st.buildings do
		if b.alive and b.defense then
			defenseStep(st, b, dt)
		end
	end

	st.pct = st.total > 0 and math.floor(st.destroyed * 100 / st.total) or 100
	st.stars = (st.pct >= 50 and 1 or 0) + (st.thDown and 1 or 0) + (st.pct >= 100 and 1 or 0)

	local left = 0
	for _, c in st.army do
		left += c
	end
	if st.pct >= 100 then
		st.over = true
		st.reason = "wipe"
	elseif st.tick * dt >= C.RAID_TIME then
		st.over = true
		st.reason = "time"
	elseif left == 0 and st.alive == 0 and #st.pending == 0 then
		st.over = true
		st.reason = "army"
	end
end

return Sim
