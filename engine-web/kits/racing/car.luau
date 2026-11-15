--!nonstrict
-- Car = kinematic top-down physics on plain numbers (deterministic, no Body2D). See KIT.md "Car physics".
-- Heading a: 0 = up, clockwise. Velocity is split into forward / lateral parts; grip bleeds lateral velocity
-- (drift = low grip while steering hard at speed). Surfaces come from track tile tags.
local U = require("./util")
local M = {}
local Car = {}
Car.__index = Car

M.DEFAULTS = {
	maxSpeed = 520, accel = 420, brake = 900, reverse = 160, coast = 140, turn = 3.0, grip = 10, driftGrip = 3.2,
	driftMin = 260, driftSteer = 0.75, radius = 18, mass = 1,
	offroadSpeed = 0.5, offroadDrag = 1.6,                   -- top speed × on "offroad", extra drag 1/s above that
	nitro = 2.0, nitroAccel = 520, nitroSpeed = 0.28, nitroRegen = 0.06, driftCharge = 0.25, -- capacity s, ×top, meter/s
	boostSpeed = 0.35, boostTime = 0.9, oilSpin = 0.8, rampTime = 0.55, restitution = 0.35,
}

-- stats(def, mods?) -> stats table: DEFAULTS < def.stats < upgrade mods { {stat, add?, pct?} }
function M.stats(def, mods)
	local s = U.copy(M.DEFAULTS)
	for k, v in (def and (def.stats or def)) or {} do if type(v) == "number" and s[k] ~= nil then s[k] = v end end
	local add, pct = {}, {}
	for _, m in mods or {} do
		add[m.stat] = (add[m.stat] or 0) + (m.add or 0)
		pct[m.stat] = (pct[m.stat] or 0) + (m.pct or 0)
	end
	for k, _ in add do if s[k] then s[k] = (s[k] + add[k]) * (1 + (pct[k] or 0)) end end
	return s
end

-- new(stats, x, y, a, opts?) -> car { x, y, a, vx, vy, nitro (0..1), id, ... }
function M.new(stats, x, y, a, opts)
	opts = opts or {}
	return setmetatable({
		id = opts.id or "car", stats = stats, x = x, y = y, a = a or 0, vx = 0, vy = 0, nitro = opts.nitro or 0.5,
		spin = 0, spinDir = 1, boostT = 0, air = 0, drifting = false, usingNitro = false, offroad = false,
		hitT = 0, surf = {}, steerIn = 0,
	}, Car)
end

function Car:speed(): number
	local fx, fy = U.fwd(self.a)
	return self.vx * fx + self.vy * fy
end
function Car:topSpeed(): number
	local s = self.stats
	local top = s.maxSpeed
	if self.offroad and self.air <= 0 then top *= s.offroadSpeed end
	if self.usingNitro then top *= 1 + s.nitroSpeed end
	if self.boostT > 0 then top *= 1 + s.boostSpeed end
	return top
end

-- step(dt, input { steer -1..1, throttle 0..1, brake 0..1, nitro bool }, track?) -> events list ("wall", "boost", "oil", "ramp", "land")
function Car:step(dt: number, inp, track)
	local s = self.stats
	local ev = nil
	local function emit(name, v) ev = ev or {} table.insert(ev, { name = name, v = v }) end
	inp = inp or {}
	local steer = math.clamp(inp.steer or 0, -1, 1)
	local thr = math.clamp(inp.throttle or 0, 0, 1)
	local brk = math.clamp(inp.brake or 0, 0, 1)
	self.steerIn = steer
	-- surface
	if track and self.air <= 0 then
		local tags = track:surface(self.x, self.y)
		self.offroad = tags.offroad == true
		if tags.boost and self.boostT < s.boostTime * 0.5 then self.boostT = s.boostTime emit("boost") end
		if tags.oil and self.spin <= 0 and self.hitT <= 0 then
			self.spin = s.oilSpin
			self.spinDir = if steer < 0 then -1 else 1
			self.hitT = s.oilSpin + 0.6
			emit("oil")
		end
		if tags.ramp and self:speed() > 150 then self.air = s.rampTime emit("ramp") end
	end
	if self.hitT > 0 then self.hitT -= dt end
	if self.boostT > 0 then self.boostT -= dt end
	local wasAir = self.air > 0
	if self.air > 0 then self.air -= dt if self.air <= 0 then emit("land") end end

	-- nitro
	self.usingNitro = inp.nitro == true and self.nitro > 0 and thr > 0
	if self.usingNitro then
		self.nitro = math.max(0, self.nitro - dt / s.nitro)
	else
		self.nitro = math.min(1, self.nitro + s.nitroRegen * dt + (if self.drifting then s.driftCharge * dt else 0))
	end
	local top = self:topSpeed()
	local fx, fy = U.fwd(self.a)
	local vf0 = self.vx * fx + self.vy * fy
	if not wasAir then
		-- steering first (scales in with speed, reverses when backing up); velocity is then split on the new heading,
		-- so the old motion shows up as lateral slip that grip bleeds off
		if self.spin > 0 then
			self.spin -= dt
			self.a = U.wrap(self.a + self.spinDir * 7 * dt)
		else
			local k = math.clamp(math.abs(vf0) / 160, 0, 1)
			local dir = if vf0 < -5 then -1 else 1
			self.a = U.wrap(self.a + steer * s.turn * k * dir * dt)
		end
	end
	fx, fy = U.fwd(self.a)
	local rx, ry = U.right(self.a)
	local vf = self.vx * fx + self.vy * fy
	local vl = self.vx * rx + self.vy * ry
	if not wasAir then
		if self.spin > 0 then vf -= vf * 1.2 * dt end
		-- throttle / brake / coast
		if brk > 0 then
			if vf > 10 then vf = math.max(0, vf - s.brake * brk * dt)
			else vf = math.max(-s.reverse, vf - s.accel * 0.5 * brk * dt) end
		elseif thr > 0 then
			local acc = s.accel + (if self.usingNitro then s.nitroAccel else 0) + (if self.boostT > 0 then s.nitroAccel else 0)
			if vf < top then vf = math.min(top, vf + acc * thr * (1 - 0.55 * math.max(0, vf) / top) * dt) end
		else
			vf -= math.sign(vf) * math.min(math.abs(vf), s.coast * dt)
		end
		if vf > top then vf -= (vf - top) * (if self.offroad then s.offroadDrag else 1.5) * dt end
		-- grip / drift: lateral slip decays fast with grip, slowly while drifting (hard steer at speed)
		local hard = math.abs(steer) >= s.driftSteer and vf > s.driftMin
		local grip = if self.spin > 0 then 0.8 elseif hard then s.driftGrip else s.grip
		-- part of the bled-off slip turns into forward speed (tyres redirect momentum), the rest is lost
		local kept = vl * (1 - math.exp(-grip * dt))
		vl -= kept
		vf += math.abs(kept) * (if hard then 0.35 else 0.85) * (if vf >= 0 then 1 else -1)
		if vf > math.max(top, vf0) then vf = math.max(top, vf0) end
		self.drifting = hard and math.abs(vl) > 40
	end
	self.vx, self.vy = fx * vf + rx * vl, fy * vf + ry * vl
	self.x += self.vx * dt
	self.y += self.vy * dt
	-- walls (also while airborne: no jumping out of the map)
	if track then
		local nx, ny, depth = track:collide(self.x, self.y, s.radius)
		if nx then
			self.x += nx * depth
			self.y += ny * depth
			local vn = self.vx * nx + self.vy * ny
			if vn < 0 then
				self.vx -= (1 + s.restitution) * vn * nx
				self.vy -= (1 + s.restitution) * vn * ny
				self.vx *= 0.92
				self.vy *= 0.92
				if -vn > 60 then emit("wall", -vn) end
			end
		end
	end
	return ev
end

-- collide(a, b): circle push-apart + elastic-ish impulse; returns impact speed or nil
function M.collide(a, b, restitution: number?)
	local dx, dy = b.x - a.x, b.y - a.y
	local R = a.stats.radius + b.stats.radius
	local d2 = dx * dx + dy * dy
	if d2 >= R * R or d2 < 1e-6 then return nil end
	if a.air > 0 or b.air > 0 then return nil end
	local d = math.sqrt(d2)
	local nx, ny = dx / d, dy / d
	local ma, mb = a.stats.mass, b.stats.mass
	local push = R - d
	a.x -= nx * push * mb / (ma + mb)
	a.y -= ny * push * mb / (ma + mb)
	b.x += nx * push * ma / (ma + mb)
	b.y += ny * push * ma / (ma + mb)
	local rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny
	if rel >= 0 then return nil end
	local j = -(1 + (restitution or 0.4)) * rel / (1 / ma + 1 / mb)
	a.vx -= nx * j / ma
	a.vy -= ny * j / ma
	b.vx += nx * j / mb
	b.vy += ny * j / mb
	return -rel
end

M.Car = Car
return M
