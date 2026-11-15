--!nonstrict
-- Bullet motion curves (pure): speed and angle as functions of the bullet's age.
--[[ bullet fields (all optional):
   accel = 0 (px/s² added to speed), minSpeed = 0, maxSpeed = nil,
   speedCurve = { {0, 1}, {0.5, 0.2}, {1.2, 1.5} }   -- {age s, multiplier of the launch speed}, linear between keys, held after the last
   turn = 0 (deg/s; curving / spiralling bullets), turnAfter = 0 (s before turning starts),
   angleCurve = { {0, 0}, {1, 90} }                   -- {age, degrees added to the launch angle} (overrides turn when set)
   waveAmp = 0 (deg), waveFreq = 1 (Hz)               -- snake: angle += amp·sin(2π·freq·age)
   aimAt = nil (s: re-aim at the target once at this age; runtime passes the target) ]]
local M = {}

local function curve(keys, t)
	local n = #keys
	if n == 0 then return nil end
	local k1 = keys[1]
	if t <= (k1[1] or k1.t) then return k1[2] or k1.v end
	for i = 2, n do
		local a, b = keys[i - 1], keys[i]
		local ta, tb = a[1] or a.t, b[1] or b.t
		if t <= tb then
			local f = if tb > ta then (t - ta) / (tb - ta) else 1
			local va, vb = a[2] or a.v, b[2] or b.v
			return va + (vb - va) * f
		end
	end
	local last = keys[n]
	return last[2] or last.v
end
M.curve = curve

-- speed + angle (deg) of a bullet launched with (angle0, speed0) at age t
function M.at(b, t, angle0, speed0): (number, number)
	b = b or {}
	local sp = speed0
	if b.speedCurve then sp = speed0 * curve(b.speedCurve, t) end
	if b.accel then sp += b.accel * t end
	sp = math.max(b.minSpeed or 0, sp)
	if b.maxSpeed then sp = math.min(b.maxSpeed, sp) end
	local a = angle0
	if b.angleCurve then
		a += curve(b.angleCurve, t)
	elseif b.turn then
		a += b.turn * math.max(0, t - (b.turnAfter or 0))
	end
	if b.waveAmp and b.waveAmp ~= 0 then a += b.waveAmp * math.sin(2 * math.pi * (b.waveFreq or 1) * t) end
	return sp, a
end

function M.velocity(b, t, angle0, speed0): (number, number)
	local sp, a = M.at(b, t, angle0, speed0)
	local r = math.rad(a)
	return math.cos(r) * sp, math.sin(r) * sp
end

-- true when the bullet's velocity changes with age (runtime only tracks these)
function M.dynamic(b): boolean
	if b == nil then return false end
	return b.speedCurve ~= nil or (b.accel or 0) ~= 0 or b.angleCurve ~= nil or (b.turn or 0) ~= 0 or (b.waveAmp or 0) ~= 0 or b.aimAt ~= nil
end

-- integrate position (fixed 60 Hz steps) — tests and previews
function M.position(b, seconds, x, y, angle0, speed0, dt)
	dt = dt or 1 / 60
	local t = 0
	while t < seconds - 1e-9 do
		local vx, vy = M.velocity(b, t, angle0, speed0)
		x += vx * dt
		y += vy * dt
		t += dt
	end
	return x, y
end

-- enemy movement paths (shmup), pure: position at age t from spawn (x0, y0). path = { kind, ...params }
--[[ kinds: "straight" { speed = 120, angle = 90 }            "sine" { speed = 100, amp = 80, freq = 0.5 }
           "stop" { speed = 200, stopY = 300, hold = 2, exitSpeed = 160, exitAngle = 90 }  (enter, hover + shoot, leave)
           "swoop" { speed = 220, turn = 60 (deg/s), angle = 90 }  "dive" { speed = 90, at = 1.2, diveSpeed = 380 } (dives at target x)
           "hover" { y = 220, speed = 160, sway = 120, swayFreq = 0.15 } (bosses: enter then sway sideways forever) ]]
function M.path(p, t, x0, y0, ctx)
	p = p or {}
	local kind = p.kind or "straight"
	if kind == "straight" then
		local r = math.rad(p.angle or 90)
		local s = p.speed or 120
		return x0 + math.cos(r) * s * t, y0 + math.sin(r) * s * t
	elseif kind == "sine" then
		local s = p.speed or 100
		return x0 + (p.amp or 80) * math.sin(2 * math.pi * (p.freq or 0.5) * t), y0 + s * t
	elseif kind == "stop" then
		local s = p.speed or 200
		local stopY = p.stopY or 300
		local tIn = math.max(0, (stopY - y0) / s)
		if t <= tIn then return x0, y0 + s * t end
		local hold = p.hold or 2
		if t <= tIn + hold then return x0, stopY end
		local r = math.rad(p.exitAngle or 90)
		local te = t - tIn - hold
		local es = p.exitSpeed or 160
		return x0 + math.cos(r) * es * te, stopY + math.sin(r) * es * te
	elseif kind == "swoop" then
		-- constant turn rate: arc
		local s = p.speed or 220
		local a0 = math.rad(p.angle or 90)
		local w = math.rad(p.turn or 60)
		if math.abs(w) < 1e-6 then return x0 + math.cos(a0) * s * t, y0 + math.sin(a0) * s * t end
		return x0 + s / w * (math.sin(a0 + w * t) - math.sin(a0)), y0 - s / w * (math.cos(a0 + w * t) - math.cos(a0))
	elseif kind == "dive" then
		local s = p.speed or 90
		local at = p.at or 1.2
		if t <= at then return x0, y0 + s * t end
		local yy = y0 + s * at
		local tx = if ctx and ctx.lockX then ctx.lockX else x0
		local ds = p.diveSpeed or 380
		local dx, dy = tx - x0, 600
		local l = math.sqrt(dx * dx + dy * dy)
		local te = t - at
		return x0 + dx / l * ds * te, yy + dy / l * ds * te
	elseif kind == "hover" then
		local s = p.speed or 160
		local yT = p.y or 220
		local tIn = math.max(0, (yT - y0) / s)
		if t <= tIn then return x0, y0 + s * t end
		return x0 + (p.sway or 120) * math.sin(2 * math.pi * (p.swayFreq or 0.15) * (t - tIn)), yT
	end
	error(`shooter: unknown path kind "{kind}" (straight, sine, stop, swoop, dive, hover)`)
end

return M
