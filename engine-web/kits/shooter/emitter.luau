--!nonstrict
-- Bullet emitters (pure, deterministic): a def + elapsed time -> volleys of shots. No entities, no randomness.
-- Angles in degrees, screen space: 0 = right, 90 = DOWN, -90 = up.
--[[ def (data/emitters/<id>.json or inline):
   { pattern = "aimed"|"fan"|"ring"|"spiral"|"wave"|"line",
     count = 1 (bullets per volley; spiral: arms), spread = 0 (deg covered by a fan/aimed volley; ring/spiral = 360),
     angle = 90 (base angle), aim = false (fan/wave: base = toward target), spin = 0 (deg/s added to the base angle; spiral 90),
     spinPerVolley = 0 (deg added each volley), waveAmp = 40, waveFreq = 0.5 (Hz; "wave": base swings ±amp),
     rate = 2 (volleys/s), burst = 1 (volleys per burst), burstGap = 0.08 (s inside a burst), delay = 0 (first volley),
     duration = nil (stop after s), volleys = nil (stop after n), speed = 220, speedStep = 0 (+px/s per bullet index: "line"),
     offset = {x, y} (muzzle offset), bullet = { motion curves (see motion.luau), radius, size, sprite, color, damage, lifetime } } ]]
local M = {}

local function num(v, d) return if type(v) == "number" then v else d end

-- defaults per pattern
local DEFAULTS = {
	aimed = { count = 1, spread = 0, aim = true },
	fan = { count = 5, spread = 60 },
	ring = { count = 12, spread = 360 },
	spiral = { count = 2, spread = 360, spin = 90, rate = 12 },
	wave = { count = 3, spread = 30, waveAmp = 40, waveFreq = 0.5, rate = 8 },
	line = { count = 4, spread = 0, speedStep = 30, aim = true },
}
M.PATTERNS = { "aimed", "fan", "ring", "spiral", "wave", "line" }

function M.resolve(def)
	local p = def.pattern or "aimed"
	local d = DEFAULTS[p]
	if d == nil then error(`shooter: unknown emitter pattern "{p}" (aimed, fan, ring, spiral, wave, line)`, 3) end
	local out = {}
	for k, v in d do out[k] = v end
	for k, v in def do out[k] = v end
	out.pattern = p
	out.count = math.max(1, math.floor(num(out.count, 1)))
	out.rate = num(out.rate, 2)
	out.burst = math.max(1, math.floor(num(out.burst, 1)))
	out.burstGap = num(out.burstGap, 0.08)
	out.speed = num(out.speed, 220)
	out.angle = num(out.angle, 90)
	return out
end

-- angles of one volley at time t (volley index v, 0-based); tx, ty = target relative to the emitter (aim)
function M.volleyAngles(d, t, v, dx, dy): { number }
	local base = d.angle
	if d.aim and (dx ~= 0 or dy ~= 0) then base = math.deg(math.atan2(dy, dx)) end
	base += num(d.spin, 0) * t + num(d.spinPerVolley, 0) * v
	if d.pattern == "wave" then base += num(d.waveAmp, 40) * math.sin(2 * math.pi * num(d.waveFreq, 0.5) * t) end
	local n, spread = d.count, num(d.spread, 0)
	local out = {}
	if spread >= 360 then
		for k = 0, n - 1 do table.insert(out, base + 360 * k / n) end
	elseif n == 1 or spread == 0 then
		for _ = 1, n do table.insert(out, base) end
	else
		for k = 0, n - 1 do table.insert(out, base - spread / 2 + spread * k / (n - 1)) end
	end
	return out
end

-- time of volley v (0-based) from emitter start
function M.volleyTime(d, v): number
	local burstIdx = v // d.burst
	local inBurst = v % d.burst
	return num(d.delay, 0) + burstIdx / math.max(d.rate, 1e-6) + inBurst * d.burstGap
end

-- shots of volley v: { {x, y, angle, speed, k, v, t, bullet} } (x, y relative to the emitter origin + offset)
function M.volley(d, v, dx, dy)
	local t = M.volleyTime(d, v)
	local ox = if d.offset then (d.offset.x or d.offset[1] or 0) else 0
	local oy = if d.offset then (d.offset.y or d.offset[2] or 0) else 0
	local shots = {}
	for k, a in M.volleyAngles(d, t, v, dx - ox, dy - oy) do
		table.insert(shots, { x = ox, y = oy, angle = a, speed = d.speed + num(d.speedStep, 0) * (k - 1), k = k, v = v, t = t, bullet = d.bullet })
	end
	return shots
end

--[[ new(def) -> emitter { def, t, v (volleys fired), done } ;
   em:update(dt, ctx { x, y, tx?, ty? }) -> shots due this step, in world coords, each with `age` (s since it was due,
   so the runtime can pre-advance it — results are identical for any dt). ]]
function M.new(def)
	local em = { def = M.resolve(def), t = 0, v = 0, done = false }
	function em.update(self, dt, ctx)
		ctx = ctx or {}
		local d = self.def
		self.t += dt
		local out = {}
		if self.done then return out end
		local x, y = ctx.x or 0, ctx.y or 0
		local dx, dy = (ctx.tx or x) - x, (ctx.ty or (y + 1)) - y
		while true do
			if d.volleys and self.v >= d.volleys then self.done = true break end
			local vt = M.volleyTime(d, self.v)
			if d.duration and vt > d.duration then self.done = true break end
			if vt > self.t + 1e-9 then break end
			for _, s in M.volley(d, self.v, dx, dy) do
				s.x += x
				s.y += y
				s.age = self.t - vt
				table.insert(out, s)
			end
			self.v += 1
		end
		return out
	end
	function em.reset(self) self.t, self.v, self.done = 0, 0, false end
	return em
end

-- all shots fired during the first `seconds` (tests, previews, balance: bullets/s)
function M.preview(def, seconds, ctx)
	local em = M.new(def)
	local all = {}
	local steps = math.floor(seconds * 60 + 0.5)
	for _ = 1, steps do for _, s in em:update(1 / 60, ctx) do table.insert(all, s) end end
	return all
end

return M
