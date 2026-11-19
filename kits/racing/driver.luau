--!nonstrict
-- AI driver: follows the track's racing line with a lookahead point (ai kit steering), slows for corners by the
-- heading change ahead, uses nitro on straights, recovers when stuck, and rubber-bands toward the player within bounds.
local U = require("./util")
local okAi, AI = pcall(require, "@kit/ai")
local steerSeek = if okAi and AI and AI.steer then AI.steer.seek else function(px, py, tx, ty, sp)
	local dx, dy = tx - px, ty - py
	local l = math.max(1e-6, math.sqrt(dx * dx + dy * dy))
	return dx / l * sp, dy / l * sp
end
local M = {}
local D = {}
D.__index = D

-- presets: skill scales top speed + corner speed; jitter = lane wander (fraction of road half-width); mistakes per minute
M.PRESETS = {
	easy = { skill = 0.84, corner = 0.86, jitter = 0.45, nitro = 0.3, mistakes = 1.2 },
	normal = { skill = 0.91, corner = 0.93, jitter = 0.35, nitro = 0.6, mistakes = 0.6 },
	hard = { skill = 0.97, corner = 0.98, jitter = 0.25, nitro = 0.9, mistakes = 0.25 },
	expert = { skill = 1.0, corner = 1.02, jitter = 0.15, nitro = 1, mistakes = 0 },
	reference = { skill = 1.0, corner = 1.0, jitter = 0, nitro = 0, mistakes = 0 },   -- balance bot: clean line, no nitro
}
M.RUBBER = { min = 0.92, max = 1.08, range = 700, strength = 0.08 }

-- rubber(gap, opts?) -> speed multiplier; gap = this racer's progress − the player's (px; + = ahead → slower)
function M.rubber(gap: number, o)
	o = o or M.RUBBER
	local m = 1 - math.clamp(gap / (o.range or 700), -1, 1) * (o.strength or 0.08) * (if gap > 0 then 1 else 1.25)
	return math.clamp(m, o.min or 0.92, o.max or 1.08)
end

-- new(preset name | opts { skill, corner, jitter, nitro, mistakes, rubber = false | {min,max,range,strength}, cornerFactor = 0.62, seed? })
function M.new(o)
	if type(o) == "string" then o = { preset = o } end
	o = o or {}
	local p = table.clone(M.PRESETS[o.preset or "normal"] or M.PRESETS.normal)
	for k, v in o do p[k] = v end
	local seed = o.seed or 1
	return setmetatable({ p = p, lane = 0, laneTarget = 0, laneT = 0, stuckT = 0, reverseT = 0, mistakeT = 0,
		rubberOn = o.rubber ~= false, rubberOpts = if type(o.rubber) == "table" then o.rubber else M.RUBBER, rand = o.rand or function()
			seed = (seed * 1103515245 + 12345) % 2147483648
			return seed / 2147483648
		end, mult = 1 }, D)
end

-- targetSpeed(car, track, s) -> px/s the driver wants here (corner model, waypoint hints, skill)
function D:targetSpeed(car, track, s: number): number
	local st = car.stats
	local v = math.max(0, car:speed())
	local look = v * v / (2 * st.brake) + 90
	local turn = track:turn(s, look + 120)
	local cf = self.p.cornerFactor or 0.62
	local corner = st.maxSpeed * math.clamp(1 - turn * cf * (10 / math.max(st.grip, 1)) ^ 0.35 * (3 / math.max(st.turn, 0.5)) ^ 0.5, 0.3, 1) * self.p.corner
	local hint = track:speedAt(s + look * 0.5)
	local t = math.min(car:topSpeed() * self.p.skill, corner)
	if hint then t = math.min(t, hint * self.p.corner) end
	return t * self.mult, turn
end

-- input(racer, race, dt) -> { steer, throttle, brake, nitro }
function D:input(r, race, dt: number)
	local c, tr = r.car, race.track
	local p = self.p
	-- rubber band vs the player (not when this is the player or there is none)
	self.mult = 1
	if self.rubberOn and race.player and race.player ~= r and not race.player.finished then
		self.mult = M.rubber(r.prog - race.player.prog, self.rubberOpts)
	end
	-- lane wander + avoid the car ahead
	self.laneT -= dt
	if self.laneT <= 0 then
		self.laneT = 1.5 + self.rand() * 2.5
		self.laneTarget = (self.rand() * 2 - 1) * p.jitter * tr.width
	end
	for _, o in race.racers do
		if o ~= r and not o.out then
			local dp = o.prog - r.prog
			if dp > 0 and dp < 120 and math.abs(o.lat - self.lane) < 40 then
				self.laneTarget = math.clamp(if o.lat > 0 then o.lat - 70 else o.lat + 70, -tr.width * 0.6, tr.width * 0.6)
			end
		end
	end
	self.lane += (self.laneTarget - self.lane) * math.min(1, 1.5 * dt)
	local v = c:speed()
	local la = 70 + math.max(v, 0) * 0.32
	local x, y, tx, ty = tr:pointAt(r.s + la)
	local gx, gy = x - ty * self.lane, y + tx * self.lane
	local hx, hy = steerSeek(c.x, c.y, gx, gy, 1)
	local diff = U.wrap(U.heading(hx, hy) - c.a)
	local steer = math.clamp(diff * 2.6, -1, 1)
	local target, turn = self:targetSpeed(c, tr, r.s)
	-- occasional mistake: a short lift
	self.mistakeT -= dt
	if self.mistakeT <= 0 then
		self.mistakeT = 10
		if self.rand() < (p.mistakes or 0) / 6 then self.liftT = 0.5 end
	end
	if self.liftT and self.liftT > 0 then self.liftT -= dt target *= 0.75 end
	-- stuck: reverse out
	if race.phase == "racing" and math.abs(v) < 25 then self.stuckT += dt else self.stuckT = 0 end
	if self.stuckT > 1.2 then self.reverseT = 0.9 self.stuckT = 0 end
	if self.reverseT > 0 then
		self.reverseT -= dt
		return { steer = -steer, throttle = 0, brake = 1 }
	end
	local thr, brk = 1, 0
	if v > target + 25 then thr, brk = 0, math.clamp((v - target) / 120, 0.2, 1)
	elseif v > target then thr = 0 end
	local nitro = turn < 0.12 and c.nitro > 0.35 and v > target * 0.6 and self.rand() < p.nitro and self.mult >= 1
	return { steer = steer, throttle = thr, brake = brk, nitro = nitro }
end

M.Driver = D
return M
