-- Behaviour library. Each factory(params) -> behaviour with :update(ctx) -> vx, vy (vy nil = leave vertical
-- velocity alone, e.g. gravity in platformers). Actions are reported with ctx.emit(name, data).
-- ctx: { dt, x, y, vx, vy, onFloor, target = {x,y,vx?,vy?}?, home = {x,y}, grid = PathGrid?, rand = fn() -> [0,1),
--        hp, maxHp, mode = "topdown"|"platformer"|"flyer", emit, speedMult }
local S = require("./steer")

local B = {}
local function p(params, k, d) local v = params[k] if v == nil then return d end return v end
local function dist(ax, ay, bx, by) return math.sqrt((ax - bx) ^ 2 + (ay - by) ^ 2) end
local function horiz(ctx) return ctx.mode == "platformer" end

-- can the agent see the target (range + LOS on the grid when present)?
function B.sees(ctx, range: number): boolean
	local t = ctx.target
	if not t then return false end
	if dist(ctx.x, ctx.y, t.x, t.y) > range then return false end
	if ctx.grid and ctx.sight ~= false then return ctx.grid:los(ctx.x, ctx.y, t.x, t.y) end
	return true
end

-- move toward (tx, ty): straight when visible, else A* path (re-planned every 0.4 s)
function B.moveTo(b, ctx, tx: number, ty: number, speed: number): (number, number?)
	if horiz(ctx) then
		local dx = tx - ctx.x
		if math.abs(dx) < 2 then return 0, nil end
		return (if dx > 0 then 1 else -1) * speed, nil
	end
	local grid = ctx.grid
	if grid and not grid:los(ctx.x, ctx.y, tx, ty) then
		b._repath = (b._repath or 0) - ctx.dt
		if b._path == nil or b._repath <= 0 or b._pathGoal == nil or dist(b._pathGoal.x, b._pathGoal.y, tx, ty) > grid.tileSize * 2 then
			b._path = grid:findWorld(ctx.x, ctx.y, tx, ty, { nearest = true, maxNodes = b.maxNodes or 3000 })
			b._pathI = 2
			b._repath = 0.4
			b._pathGoal = { x = tx, y = ty }
		end
		local path = b._path
		if path and path[b._pathI] then
			local wp = path[b._pathI]
			if dist(ctx.x, ctx.y, wp.x, wp.y) < grid.tileSize * 0.35 then
				b._pathI += 1
				wp = path[b._pathI] or wp
			end
			local vx, vy = S.seek(ctx.x, ctx.y, wp.x, wp.y, speed)
			return vx, vy
		end
	end
	local vx, vy = S.arrive(ctx.x, ctx.y, tx, ty, speed, 8, 2)
	if grid then vx, vy = S.avoid(grid, ctx.x, ctx.y, vx, vy) end
	return vx, vy
end

B.idle = function(params)
	return { update = function(b, ctx) return 0, if horiz(ctx) then nil else 0 end }
end

-- wander { speed = 40, radius = 64, pause = {0.5, 1.5} }
B.wander = function(params)
	return {
		update = function(b, ctx)
			b.wait = (b.wait or 0) - ctx.dt
			if b.wait > 0 then return 0, if horiz(ctx) then nil else 0 end
			if b.goal == nil then
				local r = p(params, "radius", 64)
				local a = ctx.rand() * math.pi * 2
				local d = ctx.rand() * r
				b.goal = { x = ctx.home.x + math.cos(a) * d, y = if horiz(ctx) then ctx.y else ctx.home.y + math.sin(a) * d }
				if ctx.grid and ctx.grid:solidAt(b.goal.x, b.goal.y) then b.goal = nil return 0, if horiz(ctx) then nil else 0 end
				b.t = 0
			end
			b.t += ctx.dt
			if dist(ctx.x, ctx.y, b.goal.x, horiz(ctx) and ctx.y or b.goal.y) < 4 or b.t > 4 then
				b.goal = nil
				local pz = p(params, "pause", { 0.5, 1.5 })
				b.wait = if type(pz) == "table" then pz[1] + ctx.rand() * (pz[2] - pz[1]) else pz
				return 0, if horiz(ctx) then nil else 0
			end
			return B.moveTo(b, ctx, b.goal.x, b.goal.y, p(params, "speed", 40))
		end,
	}
end

-- patrol { points = {{x,y},...} (world; relative = true: offsets from home), speed = 50, wait = 0.5, loop = true }
-- platformer / no points: { distance = 64 } walks back and forth around home, turning at walls and ledges
B.patrol = function(params)
	return {
		update = function(b, ctx)
			local speed = p(params, "speed", 50)
			local pts = params.points
			if pts == nil or #pts == 0 then
				b.dir = b.dir or (if p(params, "startLeft", false) then -1 else 1)
				local d = p(params, "distance", 64)
				local turn = (b.dir > 0 and ctx.x > ctx.home.x + d) or (b.dir < 0 and ctx.x < ctx.home.x - d)
				if ctx.grid then
					local ts = ctx.grid.tileSize
					local ahead = ctx.x + b.dir * ts * 0.6
					if ctx.grid:solidAt(ahead, ctx.y) then turn = true end
					if horiz(ctx) and ctx.onFloor and p(params, "ledges", true) and not ctx.grid:solidAt(ahead, ctx.y + ts) then turn = true end
				end
				b.cool = (b.cool or 0) - ctx.dt
				if turn and b.cool <= 0 then b.dir = -b.dir b.cool = 0.2 end
				return b.dir * speed, if horiz(ctx) then nil else 0
			end
			b.i = b.i or 1
			b.step = b.step or 1
			b.wait = (b.wait or 0) - ctx.dt
			if b.wait > 0 then return 0, if horiz(ctx) then nil else 0 end
			local pt = pts[b.i]
			local tx, ty = pt.x or pt[1], pt.y or pt[2]
			if params.relative then tx += ctx.home.x; ty += ctx.home.y end
			if dist(ctx.x, ctx.y, tx, if horiz(ctx) then ctx.y else ty) < 4 then
				b.wait = p(params, "wait", 0.5)
				if p(params, "loop", true) then
					b.i = b.i % #pts + 1
				else
					if b.i + b.step > #pts or b.i + b.step < 1 then b.step = -b.step end
					b.i += b.step
				end
				return 0, if horiz(ctx) then nil else 0
			end
			return B.moveTo(b, ctx, tx, ty, speed)
		end,
	}
end

-- chase { speed = 70, aggro = 140, leash = 320, forget = 2, idle = "idle"|"wander"|"patrol", ...idle params }
-- sees the target inside `aggro` (LOS on the grid) -> chases (A* around walls); returns home past `leash` or after `forget` s unseen
B.chase = function(params)
	local idleB = B[p(params, "idle", "idle")](params)
	return {
		update = function(b, ctx)
			local t = ctx.target
			local aggro, leash = p(params, "aggro", 140), p(params, "leash", 320)
			if t and B.sees(ctx, aggro) then
				if not b.chasing then ctx.emit("aggro", { target = t }) end
				b.chasing = true
				b.lost = 0
				b.last = { x = t.x, y = t.y }
			elseif b.chasing then
				b.lost = (b.lost or 0) + ctx.dt
				if b.lost > p(params, "forget", 2) then b.chasing = false ctx.emit("lost", {}) end
				if t then b.last = { x = t.x, y = t.y } end -- keep tracking (pathfinding) until we forget
			end
			if b.chasing and dist(ctx.x, ctx.y, ctx.home.x, ctx.home.y) > leash then
				b.chasing = false
				b.returning = true
				ctx.emit("leash", {})
			end
			if b.returning then
				if dist(ctx.x, ctx.y, ctx.home.x, ctx.home.y) < 6 then b.returning = false end
				return B.moveTo(b, ctx, ctx.home.x, ctx.home.y, p(params, "speed", 70))
			end
			if b.chasing and b.last then
				local stop = p(params, "stopAt", 0)
				if dist(ctx.x, ctx.y, b.last.x, b.last.y) <= stop then return 0, if horiz(ctx) then nil else 0 end
				return B.moveTo(b, ctx, b.last.x, b.last.y, p(params, "speed", 70))
			end
			return idleB.update(idleB, ctx)
		end,
	}
end

-- flee { speed = 70, range = 120 }: run from the target while it is close
B.flee = function(params)
	return {
		update = function(b, ctx)
			local t = ctx.target
			if t and dist(ctx.x, ctx.y, t.x, t.y) < p(params, "range", 120) then
				local vx, vy = S.flee(ctx.x, ctx.y, t.x, t.y, p(params, "speed", 70))
				if horiz(ctx) then return vx, nil end
				return S.avoid(ctx.grid, ctx.x, ctx.y, vx, vy)
			end
			return 0, if horiz(ctx) then nil else 0
		end,
	}
end

-- keep_distance (ranged) { speed = 50, min = 80, max = 150, aggro = 220, fireEvery = 1.5 }
-- emits "shoot" { x, y, dx, dy, target } when it has line of sight
B.keep_distance = function(params)
	return {
		update = function(b, ctx)
			local t = ctx.target
			b.cd = (b.cd or p(params, "firstShot", 0.8)) - ctx.dt
			if not t or not B.sees(ctx, p(params, "aggro", 220)) then return 0, if horiz(ctx) then nil else 0 end
			local d = dist(ctx.x, ctx.y, t.x, t.y)
			if b.cd <= 0 then
				b.cd = p(params, "fireEvery", 1.5)
				local dx, dy = S.norm(t.x - ctx.x, t.y - ctx.y)
				ctx.emit("shoot", { x = ctx.x, y = ctx.y, dx = dx, dy = dy, target = t })
			end
			local speed = p(params, "speed", 50)
			local vx, vy = 0, 0
			if d < p(params, "min", 80) then vx, vy = S.flee(ctx.x, ctx.y, t.x, t.y, speed)
			elseif d > p(params, "max", 150) then return B.moveTo(b, ctx, t.x, t.y, speed)
			else
				-- strafe slowly around the target
				local sx, sy = S.norm(-(t.y - ctx.y), t.x - ctx.x)
				vx, vy = sx * speed * 0.4 * (b.strafe or 1), sy * speed * 0.4 * (b.strafe or 1)
				b.flip = (b.flip or 2) - ctx.dt
				if b.flip <= 0 then b.flip = 2 b.strafe = -(b.strafe or 1) end
			end
			if horiz(ctx) then return vx, nil end
			return S.avoid(ctx.grid, ctx.x, ctx.y, vx, vy)
		end,
	}
end

-- charge { range = 150, windup = 0.6, speed = 240, duration = 0.45, cooldown = 1.2, walk = 30 }
-- emits "telegraph" (wind-up starts), "charge" (dash starts)
B.charge = function(params)
	return {
		update = function(b, ctx)
			b.state = b.state or "idle"
			b.t = (b.t or 0) - ctx.dt
			local t = ctx.target
			if b.state == "idle" then
				b.cool = (b.cool or 0) - ctx.dt
				if t and b.cool <= 0 and B.sees(ctx, p(params, "range", 150)) then
					b.state, b.t = "windup", p(params, "windup", 0.6)
					b.dx, b.dy = S.norm(t.x - ctx.x, if horiz(ctx) then 0 else t.y - ctx.y)
					ctx.emit("telegraph", { dx = b.dx, dy = b.dy })
					return 0, if horiz(ctx) then nil else 0
				end
				if t and B.sees(ctx, p(params, "range", 150) * 1.6) then return B.moveTo(b, ctx, t.x, t.y, p(params, "walk", 30)) end
				return 0, if horiz(ctx) then nil else 0
			elseif b.state == "windup" then
				if b.t <= 0 then
					b.state, b.t = "dash", p(params, "duration", 0.45)
					ctx.emit("charge", { dx = b.dx, dy = b.dy })
				end
				return 0, if horiz(ctx) then nil else 0
			elseif b.state == "dash" then
				local sp = p(params, "speed", 240)
				if b.t <= 0 or (ctx.grid and ctx.grid:solidAt(ctx.x + b.dx * ctx.grid.tileSize * 0.6, ctx.y + b.dy * ctx.grid.tileSize * 0.6)) then
					b.state = "idle"
					b.cool = p(params, "cooldown", 1.2)
					return 0, if horiz(ctx) then nil else 0
				end
				return b.dx * sp, if horiz(ctx) then nil else b.dy * sp
			end
			return 0, 0
		end,
	}
end

-- jump_at (platformer hopper) { range = 140, jump = 330, speed = 110, cooldown = 1.0 }: hops toward the target
B.jump_at = function(params)
	return {
		update = function(b, ctx)
			b.cool = (b.cool or 0) - ctx.dt
			local t = ctx.target
			if t and b.cool <= 0 and ctx.onFloor ~= false and B.sees(ctx, p(params, "range", 140)) then
				b.cool = p(params, "cooldown", 1.0)
				b.air = true
				b.dir = if t.x >= ctx.x then 1 else -1
				ctx.emit("jump", { dir = b.dir })
				return b.dir * p(params, "speed", 110), -p(params, "jump", 330)
			end
			if b.air and ctx.onFloor and b.cool < p(params, "cooldown", 1.0) - 0.1 then b.air = false end
			if b.air then return (b.dir or 0) * p(params, "speed", 110), nil end
			return 0, nil
		end,
	}
end

-- swoop (flyer) { hover = 70 (px above target), speed = 60, swoopSpeed = 210, every = 2.2, range = 200, bob = 6 }
-- hovers above the target, dives at its position, climbs back. emits "swoop"
B.swoop = function(params)
	return {
		update = function(b, ctx)
			b.state = b.state or "hover"
			b.clock = (b.clock or 0) + ctx.dt
			local t = ctx.target
			if not t or not B.sees(ctx, p(params, "range", 200)) then
				local vx, vy = S.arrive(ctx.x, ctx.y, ctx.home.x, ctx.home.y + math.sin(b.clock * 3) * p(params, "bob", 6), p(params, "speed", 60), 24)
				return vx, vy
			end
			if b.state == "hover" then
				b.t = (b.t or p(params, "every", 2.2)) - ctx.dt
				local hx, hy = t.x + math.sin(b.clock * 1.3) * 30, t.y - p(params, "hover", 70) + math.sin(b.clock * 3) * p(params, "bob", 6)
				if b.t <= 0 then
					b.state = "dive"
					b.goal = { x = t.x, y = t.y }
					b.t = nil
					ctx.emit("swoop", { x = t.x, y = t.y })
				end
				return S.arrive(ctx.x, ctx.y, hx, hy, p(params, "speed", 60), 30)
			elseif b.state == "dive" then
				if dist(ctx.x, ctx.y, b.goal.x, b.goal.y) < 8 or (ctx.grid and ctx.grid:solidAt(ctx.x, ctx.y + 6)) then
					b.state, b.rise = "rise", 0.6
				end
				return S.seek(ctx.x, ctx.y, b.goal.x, b.goal.y, p(params, "swoopSpeed", 210))
			else
				b.rise -= ctx.dt
				if b.rise <= 0 then b.state = "hover" end
				return 0, -p(params, "speed", 60) * 1.5
			end
		end,
	}
end

-- turret { range = 200, fireEvery = 1.0, burst = 1, spread = 0 (deg between burst shots) }: never moves
B.turret = function(params)
	return {
		update = function(b, ctx)
			b.cd = (b.cd or p(params, "firstShot", 0.5)) - ctx.dt
			local t = ctx.target
			if t and b.cd <= 0 and B.sees(ctx, p(params, "range", 200)) then
				b.cd = p(params, "fireEvery", 1.0)
				local n = p(params, "burst", 1)
				local spread = math.rad(p(params, "spread", 0))
				local base = math.atan2(t.y - ctx.y, t.x - ctx.x)
				for i = 1, n do
					local a = base + (i - (n + 1) / 2) * spread
					ctx.emit("shoot", { x = ctx.x, y = ctx.y, dx = math.cos(a), dy = math.sin(a), target = t })
				end
			end
			return 0, if horiz(ctx) then nil else 0
		end,
	}
end

-- spawner { every = 3, max = 3, spawn = "bat", range = 260 (only while the target is within) }
-- emits "spawn" { kind, x, y }; the attach() onAction handler returns the new entity so `max` is enforced
B.spawner = function(params)
	return {
		update = function(b, ctx)
			b.cd = (b.cd or p(params, "first", 1)) - ctx.dt
			local alive = if ctx.children then ctx.children() else 0
			local t = ctx.target
			local inRange = params.range == nil or (t ~= nil and dist(ctx.x, ctx.y, t.x, t.y) <= params.range)
			if b.cd <= 0 and alive < p(params, "max", 3) and inRange then
				b.cd = p(params, "every", 3)
				ctx.emit("spawn", { kind = params.spawn, x = ctx.x, y = ctx.y })
			end
			return 0, if horiz(ctx) then nil else 0
		end,
	}
end

return B
