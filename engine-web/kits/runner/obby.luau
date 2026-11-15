--!nonstrict
-- Obby (obstacle course) simulation: deterministic box platformer in stage px (y down; the course climbs upward).
-- Stage (data/stages/<id>.json or obby.generate): { name, width = 720, height, spawn = {x, y}, par? (s),
--   parts = { { kind, x, y, w, h, ... } } } where (x, y) is the part's top-left. Kinds:
--   "solid" · "move" { dx, dy, period (s), phase? (0..1) } ping-pong · "vanish" { on = 1.2, off = 1.2, phase?, step? (true:
--   starts its cycle when stood on) } · "conveyor" { speed px/s (+ right) } · "bounce" { power = 1500 } ·
--   "spinner" { r = arm length, speed = deg/s, arms = 1 } (x, y = hub centre; touching an arm kills) ·
--   "spike" (kills) · "checkpoint" (trigger area) · "goal" (trigger area).
-- o = obby.new(stage, { ghost? (encoded), params? }) ; o:step(dt, ax (-1..1), jumpPressed, jumpHeld)
-- state: x, y (feet centre), vx, vy, ground, checkpoint (index), deaths, time, finished, events (this step), ghost (recording)
local S = require("./state")
local M = {}
local O = {}
O.__index = O
M.Obby = O

local SOLID = { solid = true, move = true, vanish = true, conveyor = true, bounce = true }

local function partPos(p, t)
	if p.kind == "move" then
		local per = math.max(0.1, p.period or 3)
		local u = ((t / per) + (p.phase or 0)) % 1
		local k = if u < 0.5 then u * 2 else 2 - u * 2
		k = k * k * (3 - 2 * k) -- smoothstep ease at the ends
		return p.x + (p.dx or 0) * k, p.y + (p.dy or 0) * k
	end
	return p.x, p.y
end
M.partPos = partPos

function M.new(stage, opts)
	opts = opts or {}
	local c = table.clone(S.config.obby)
	for k, v in opts.params or {} do c[k] = v end
	local parts = {}
	for i, p in stage.parts do
		local q = table.clone(p)
		q.index = i
		q.px, q.py = partPos(q, 0)
		q.visible = true
		q.timer = 0
		table.insert(parts, q)
	end
	local cps = {}
	for _, p in parts do if p.kind == "checkpoint" then table.insert(cps, p) end end
	table.sort(cps, function(a, b) return a.y > b.y end) -- lower on screen first
	for i, p in cps do p.cp = i end
	local self = setmetatable({
		stage = stage, c = c, parts = parts, checkpoints = cps, x = stage.spawn.x, y = stage.spawn.y, vx = 0, vy = 0,
		ground = nil, checkpoint = 0, deaths = 0, time = 0, finished = false, dead = 0, events = {}, coyote = 0, buffer = 0,
		tick = 0, ghost = {}, ghostPlay = opts.ghost and M.decodeGhost(opts.ghost) or nil, height = stage.height or 2000,
	}, O)
	self:record()
	return self
end

function O:emit(name, data) data = data or {} data.name = name table.insert(self.events, data) end

function O:spawnPoint()
	local cp = self.checkpoints[self.checkpoint]
	if cp then return cp.x + cp.w / 2, cp.y + cp.h end
	return self.stage.spawn.x, self.stage.spawn.y
end

function O:die(why)
	if self.dead > 0 or self.finished then return end
	self.deaths += 1
	self.dead = self.c.respawnDelay
	self:emit("death", { why = why, x = self.x, y = self.y })
end

local function overlap(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1) return ax0 < bx1 and ax1 > bx0 and ay0 < by1 and ay1 > by0 end

local function segDist(px, py, ax, ay, bx, by)
	local dx, dy = bx - ax, by - ay
	local l2 = dx * dx + dy * dy
	local t = if l2 > 0 then math.clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) else 0
	local qx, qy = ax + dx * t, ay + dy * t
	return math.sqrt((px - qx) ^ 2 + (py - qy) ^ 2)
end

-- spinner arm endpoints at time t: { {ax, ay, bx, by} }
function M.spinnerArms(p, t)
	local out = {}
	local n = p.arms or 1
	for i = 0, n - 1 do
		local a = math.rad((p.angle or 0) + (p.speed or 90) * t) + i * math.pi * 2 / n
		table.insert(out, { p.x, p.y, p.x + math.cos(a) * (p.r or 100), p.y + math.sin(a) * (p.r or 100) })
	end
	return out
end

function O:updateParts(dt)
	for _, p in self.parts do
		local ox, oy = p.px, p.py
		p.px, p.py = partPos(p, self.time)
		p.dxStep, p.dyStep = p.px - ox, p.py - oy
		if p.kind == "vanish" then
			local on, off = p.on or 1.2, p.off or 1.2
			if p.step ~= false then
				-- triggered: stood on → visible for `on` s → gone for `off` s → back
				if p.state == "fading" then
					p.timer += dt
					if p.timer >= on then p.state = "gone" p.timer = 0 p.visible = false self:emit("vanish", { part = p.index }) end
				elseif p.state == "gone" then
					p.timer += dt
					if p.timer >= off then p.state = nil p.timer = 0 p.visible = true self:emit("appear", { part = p.index }) end
				end
			else
				local u = ((self.time / (on + off)) + (p.phase or 0)) % 1
				local vis = u < on / (on + off)
				if vis ~= p.visible then p.visible = vis self:emit(if vis then "appear" else "vanish", { part = p.index }) end
			end
		end
	end
end

-- step(dt, ax, jumpPressed, jumpHeld)
function O:step(dt, ax, jump, held)
	self.events = {}
	if self.finished then return self.events end
	self.time += dt
	self.tick += 1
	self:updateParts(dt)
	if self.dead > 0 then
		self.dead -= dt
		if self.dead <= 0 then
			self.dead = 0
			self.x, self.y = self:spawnPoint()
			self.vx, self.vy, self.ground = 0, 0, nil
			for _, p in self.parts do if p.kind == "vanish" and p.step ~= false then p.state = nil p.timer = 0 p.visible = true end end
			self:emit("respawn", { checkpoint = self.checkpoint })
		end
		self:record()
		return self.events
	end
	local c = self.c
	ax = math.clamp(ax or 0, -1, 1)
	-- carry from the ground part
	local carryX = 0
	local g = self.ground
	if g then
		if g.dxStep then self.x += g.dxStep self.y += g.dyStep or 0 end
		if g.kind == "conveyor" then carryX = (g.speed or 120) * dt end
	end
	-- horizontal
	local target = ax * c.run
	local acc = (if g then c.accel else c.airAccel) * dt
	if math.abs(target - self.vx) <= acc then self.vx = target else self.vx += acc * math.sign(target - self.vx) end
	-- jump (buffer + coyote)
	if jump then self.buffer = c.buffer else self.buffer = math.max(0, self.buffer - dt) end
	if g then self.coyote = c.coyote else self.coyote = math.max(0, self.coyote - dt) end
	if self.buffer > 0 and self.coyote > 0 then
		self.vy = -c.jump
		self.buffer, self.coyote = 0, 0
		self.ground = nil
		self:emit("jump")
	end
	if not held and self.vy < -c.jump * 0.45 then self.vy = -c.jump * 0.45 end -- variable jump height
	self.vy = math.min(c.maxFall, self.vy + c.gravity * dt)
	local hw, h = c.w / 2, c.h
	-- move x (platforms are one-way: no side walls, jump through from below)
	local nx = self.x + self.vx * dt + carryX
	nx = math.clamp(nx, hw, (self.stage.width or 720) - hw)
	self.x = nx
	-- move y: land on a platform top when falling through it this step
	local ny = self.y + self.vy * dt
	local landed = nil
	if self.vy >= 0 then
		for _, p in self.parts do
			if SOLID[p.kind] and p.visible and self.x + hw > p.px and self.x - hw < p.px + p.w and self.y <= p.py + 2 + math.max(0, p.dyStep or 0) and ny >= p.py then
				if landed == nil or p.py < landed.py then landed = p end
			end
		end
	end
	if landed then ny = landed.py end
	self.y = ny
	if landed then
		if landed.kind == "bounce" then
			self.vy = -(landed.power or 1500)
			self.ground = nil
			self:emit("bounce", { part = landed.index })
		else
			if self.ground ~= landed then self:emit("land", { part = landed.index }) end
			self.vy = 0
			self.ground = landed
			if landed.kind == "vanish" and landed.step ~= false and landed.state == nil then landed.state = "fading" landed.timer = 0 self:emit("crumble", { part = landed.index }) end
		end
	else
		self.ground = nil
	end
	-- hazards + triggers
	local x0, y0, x1, y1 = self.x - hw + 3, self.y - h + 3, self.x + hw - 3, self.y - 1
	for _, p in self.parts do
		if p.kind == "spike" and overlap(x0, y0, x1, y1, p.px, p.py, p.px + p.w, p.py + p.h) then self:die("spike") break
		elseif p.kind == "spinner" then
			for _, a in M.spinnerArms(p, self.time) do
				if segDist(self.x, self.y - h / 2, a[1], a[2], a[3], a[4]) < (p.thick or 10) + hw * 0.8 then self:die("spinner") break end
			end
		elseif p.kind == "checkpoint" and p.cp > self.checkpoint and overlap(x0, y0, x1, y1, p.px, p.py, p.px + p.w, p.py + p.h) then
			self.checkpoint = p.cp
			self:emit("checkpoint", { index = p.cp, time = self.time })
		elseif p.kind == "goal" and overlap(x0, y0, x1, y1, p.px, p.py, p.px + p.w, p.py + p.h) then
			self.finished = true
			self:emit("finish", { time = self.time, deaths = self.deaths })
		end
	end
	if self.y > self.height + c.killBelow then self:die("fall") end
	self:record()
	return self.events
end

------------------------------------------------------------------ ghost (compact: every N ticks, 4 px grid, 2 base-64 chars per coord)
local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
local function enc(n)
	n = math.clamp(math.floor(n / 4 + 0.5), 0, 4095)
	local a, b = n // 64, n % 64
	return string.sub(B64, a + 1, a + 1) .. string.sub(B64, b + 1, b + 1)
end
local DEC = {}
for i = 1, 64 do DEC[string.sub(B64, i, i)] = i - 1 end

function O:record()
	if (self.tick % self.c.ghostEvery) == 0 and #self.ghost < 2400 then
		table.insert(self.ghost, enc(self.x) .. enc(self.y + 2000))
	end
end
-- ghostString() -> encoded recording of this attempt
function O:ghostString() return table.concat(self.ghost) end
function M.decodeGhost(s)
	local out = {}
	for i = 1, #s, 4 do
		local function d(j) return DEC[string.sub(s, i + j, i + j)] or 0 end
		table.insert(out, { x = (d(0) * 64 + d(1)) * 4, y = (d(2) * 64 + d(3)) * 4 - 2000 })
	end
	return out
end
-- ghostAt(t) -> x, y (interpolated) | nil when no ghost / past its end
function O:ghostAt(t)
	local g = self.ghostPlay
	if not g or #g == 0 then return nil end
	local f = t * 60 / self.c.ghostEvery
	local i = math.floor(f) + 1
	if i >= #g then return nil end
	local a, b = g[i], g[i + 1]
	local k = f - math.floor(f)
	return a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k
end

------------------------------------------------------------------ procgen stages
-- generate({ seed, difficulty = 1..10, platforms = 14, width = 720, checkpointEvery = 5, name? }) -> stage
-- Climbs upward; every gap is within the jump envelope (dy ≤ maxRise, horizontal edge gap ≤ maxGap) so stages are
-- always completable; difficulty raises gaps and mixes in movers, vanishers, conveyors, spinners and spikes.
function M.generate(opts)
	opts = opts or {}
	local r = S.procgen.rng(opts.seed or 1):fork("obby")
	local diff = math.clamp(opts.difficulty or 3, 1, 10)
	local W = opts.width or 720
	local n = opts.platforms or 14
	local c = S.config.obby
	local apex = c.jump * c.jump / (2 * c.gravity)
	local maxRise = math.min(apex * 0.8, 90 + diff * 9)
	local maxGap = math.min(170, 50 + diff * 12)
	local parts = {}
	local y = 0
	local floorW = W - 80
	table.insert(parts, { kind = "solid", x = 40, y = y, w = floorW, h = 40 })
	local prev = { x = 40, w = floorW, y = 0 }
	local weights = { solid = 10, move = diff * 1.2, vanish = diff, conveyor = diff * 0.8, spinner = math.max(0, diff - 2) * 0.8, spike = math.max(0, diff - 1) * 0.7, bounce = 1 }
	for i = 1, n do
		local isCp = i % (opts.checkpointEvery or 5) == 0 and i < n
		local kind = if isCp or i == n then "solid" else r:weighted(weights)
		local w = if kind == "spinner" or kind == "spike" then r:int(200, 280) else r:int(math.max(90, 190 - diff * 10), 220 - diff * 6)
		local rise = if kind == "bounce" then r:range(40, 70) else r:range(maxRise * 0.6, maxRise)
		y -= rise
		-- horizontal: edge gap ≤ maxGap from the previous platform, inside the screen
		local gap = r:range(20, maxGap) * (if rise > maxRise * 0.85 then 0.7 else 1)
		local goRight = r:chance(0.5)
		local x
		if goRight then x = prev.x + prev.w + gap else x = prev.x - gap - w end
		if x < 20 or x + w > W - 20 then
			goRight = not goRight
			x = if goRight then prev.x + prev.w + gap else prev.x - gap - w
		end
		x = math.clamp(x, 20, W - 20 - w)
		local p = { kind = if kind == "spinner" or kind == "spike" then "solid" else kind, x = math.floor(x), y = math.floor(y), w = w, h = 28 }
		if kind == "move" then
			local span = r:int(80, 120 + diff * 8)
			p.dx = if p.x + w + span < W - 20 then span else -span
			p.period = math.max(1.6, 4 - diff * 0.2)
			p.phase = r:next()
		elseif kind == "vanish" then p.on = math.max(0.5, 1.4 - diff * 0.08) p.off = 1.4
		elseif kind == "conveyor" then p.speed = (if r:chance(0.5) then 1 else -1) * (80 + diff * 12)
		elseif kind == "bounce" then p.power = 1350 + diff * 20 p.w = math.min(p.w, 140) end
		table.insert(parts, p)
		if kind == "spinner" then
			table.insert(parts, { kind = "spinner", x = p.x + p.w / 2, y = p.y - 10, w = 0, h = 0, r = math.min(p.w / 2 - 50, 60 + diff * 4), speed = (60 + diff * 10) * (if r:chance(0.5) then 1 else -1), arms = if diff >= 7 then 2 else 1, angle = r:int(0, 359) })
		elseif kind == "spike" then
			local sw = 44
			local sx = if r:chance(0.5) then p.x + 8 else p.x + p.w - 8 - sw
			table.insert(parts, { kind = "spike", x = sx, y = p.y - 18, w = sw, h = 18 })
		end
		if isCp then table.insert(parts, { kind = "checkpoint", x = p.x + p.w / 2 - 30, y = p.y - 90, w = 60, h = 90 }) end
		if i == n then table.insert(parts, { kind = "goal", x = p.x + p.w / 2 - 40, y = p.y - 110, w = 80, h = 110 }) end
		prev = { x = p.x, w = p.w, y = p.y }
	end
	-- shift everything so the top is at y = 200 (stage coords are positive)
	local top = y - 200
	for _, p in parts do p.y -= top end
	local height = 0
	for _, p in parts do height = math.max(height, p.y + (p.h or 0)) end
	return { name = opts.name or ("Stage " .. (opts.seed or 1)), width = W, height = height, spawn = { x = 40 + floorW / 2, y = parts[1].y },
		parts = parts, par = math.floor(n * (2.4 - diff * 0.08) + 0.5), generated = true, difficulty = diff, maxRise = maxRise, maxGap = maxGap }
end

-- check(stage) -> ok, problems: consecutive platforms within the jump envelope (generated stages)
function M.check(stage)
	local plats = {}
	for _, p in stage.parts do if SOLID[p.kind] then table.insert(plats, p) end end
	local probs = {}
	local apex = S.config.obby.jump ^ 2 / (2 * S.config.obby.gravity)
	for i = 2, #plats do
		local a, b = plats[i - 1], plats[i]
		local rise = a.y - b.y
		local ax0, ax1 = a.x + math.min(0, a.dx or 0), a.x + a.w + math.max(0, a.dx or 0)
		local bx0, bx1 = b.x + math.min(0, b.dx or 0), b.x + b.w + math.max(0, b.dx or 0)
		local gap = math.max(0, bx0 - ax1, ax0 - bx1)
		if a.kind ~= "bounce" and rise > apex * 0.85 then table.insert(probs, "rise " .. i .. " " .. math.floor(rise)) end
		if gap > 230 then table.insert(probs, "gap " .. i .. " " .. math.floor(gap)) end
	end
	return #probs == 0, probs
end

------------------------------------------------------------------ bot (demos, tests, screenshots)
-- botInput(o, bot) -> ax, jumpPressed, jumpHeld: greedy climber (targets the nearest platform above)
function M.botInput(o, bot)
	bot.t = (bot.t or 0) + 1
	if o.dead > 0 or o.finished then return 0, false, false end
	-- pick a target only while standing (keep it through the jump)
	local best = bot.target
	if o.ground or best == nil or not best.visible then
		best = nil
		local bd = math.huge
		for _, p in o.parts do
			if SOLID[p.kind] and p.visible and p.py < o.y - 8 and p ~= o.ground then
				local dy = o.y - p.py
				local cx = p.px + p.w / 2
				local d = dy * 2 + math.abs(cx - o.x)
				if dy < 190 and d < bd then best, bd = p, d end
			end
		end
		bot.target = best
	end
	if not best then
		-- nothing reachable above: walk toward the goal
		for _, p in o.parts do if p.kind == "goal" then return math.clamp((p.px + p.w / 2 - o.x) / 40, -1, 1), false, false end end
		return 0, false, false
	end
	local tx = best.px + best.w / 2
	local edgeDx = math.max(0, best.px - o.x, o.x - (best.px + best.w))
	local ax = math.clamp((tx - o.x) / 40, -1, 1)
	local jump = false
	if o.ground then
		local g = o.ground
		local nearEdge = (ax > 0 and o.x > g.px + g.w - 24) or (ax < 0 and o.x < g.px + 24)
		if edgeDx < 110 or nearEdge then jump = true end
		if bot.lastJump and bot.t - bot.lastJump < 8 then jump = false end
		if jump then bot.lastJump = bot.t end
	elseif o.vy > 0 and o.y > best.py then
		-- falling below the target: keep steering
		ax = math.clamp((tx - o.x) / 30, -1, 1)
	end
	return ax, jump, true
end

return M
