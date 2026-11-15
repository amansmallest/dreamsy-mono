--!nonstrict
-- Player weapons (pure): data/weapons/<id>.json, levels inherit from the previous level.
--[[ def: { name, kind = "shot"|"spread"|"laser"|"homing"|"orbital", sprite?, color?, size? {w,h}, sfx?, icon?,
          levels = { { rate = 8 (shots/s), count = 1, gap = 14 (px between parallel shots: "shot"), spread = 0 (deg: "spread"),
                       damage = 1, speed = 900, pierce = 0, radius = 6, lifetime = 1.4,
                       homing = 0 (deg/s turn: "homing"), homingRange = 400,
                       length = 900, width = 18, dps = 12, tick = 0.1 ("laser"),
                       orbs = 2, orbitRadius = 70, orbitSpeed = 180 (deg/s), orbDamage = 1, orbHitEvery = 0.25, orbRadius = 14,
                       blocks = true ("orbital": orbs erase enemy bullets) }, … } } ]]
local M = {}
M.KINDS = { "shot", "spread", "laser", "homing", "orbital" }

function M.maxLevel(def) return #(def.levels or { {} }) end

function M.stats(def, level)
	local out = { rate = 8, count = 1, gap = 14, spread = 0, damage = 1, speed = 900, pierce = 0, radius = 6, lifetime = 1.4,
		homing = 0, homingRange = 400, length = 900, width = 18, dps = 12, tick = 0.1,
		orbs = 2, orbitRadius = 70, orbitSpeed = 180, orbDamage = 1, orbHitEvery = 0.25, orbRadius = 14, blocks = true }
	local levels = def.levels or { {} }
	level = math.clamp(level or 1, 1, #levels)
	for i = 1, level do for k, v in levels[i] do out[k] = v end end
	out.level = level
	out.kind = def.kind or "shot"
	return out
end

-- shots of one trigger pull at (x, y) aiming `aim` degrees: { {x, y, angle, speed, damage, pierce, homing, radius, lifetime} }
function M.volley(def, level, x, y, aim)
	local s = M.stats(def, level)
	local shots = {}
	local kind = s.kind
	if kind == "laser" or kind == "orbital" then return shots end
	local n = s.count
	for k = 0, n - 1 do
		local a, ox, oy = aim, 0, 0
		if kind == "spread" or kind == "homing" then
			if n > 1 then a = aim - s.spread / 2 + s.spread * k / (n - 1) end
		else
			-- parallel stream, perpendicular to the aim
			local off = (k - (n - 1) / 2) * s.gap
			local r = math.rad(aim + 90)
			ox, oy = math.cos(r) * off, math.sin(r) * off
		end
		table.insert(shots, { x = x + ox, y = y + oy, angle = a, speed = s.speed, damage = s.damage, pierce = s.pierce,
			homing = if kind == "homing" then (if s.homing > 0 then s.homing else 240) else 0, homingRange = s.homingRange,
			radius = s.radius, lifetime = s.lifetime })
	end
	return shots
end

-- orbital positions at time t around (x, y)
function M.orbs(def, level, t, x, y)
	local s = M.stats(def, level)
	local out = {}
	if s.kind ~= "orbital" then return out end
	for k = 0, s.orbs - 1 do
		local a = math.rad(s.orbitSpeed * t + 360 * k / s.orbs)
		table.insert(out, { x = x + math.cos(a) * s.orbitRadius, y = y + math.sin(a) * s.orbitRadius, radius = s.orbRadius, damage = s.orbDamage })
	end
	return out
end

-- beam segment for lasers: { x, y, angle, length, width, dps, tick }
function M.beam(def, level, x, y, aim)
	local s = M.stats(def, level)
	if s.kind ~= "laser" then return nil end
	return { x = x, y = y, angle = aim, length = s.length, width = s.width, dps = s.dps, tick = s.tick }
end

-- estimated single-target DPS (accuracy = fraction of shots that connect; spread weapons hit ~1/2 of the fan up close)
function M.dps(def, level, accuracy)
	accuracy = accuracy or 0.7
	local s = M.stats(def, level)
	if s.kind == "laser" then return s.dps * math.min(1, accuracy + 0.2) end
	if s.kind == "orbital" then return s.orbs * s.orbDamage / s.orbHitEvery * 0.35 end
	local hitting = s.count
	if s.kind == "spread" and s.count > 2 then hitting = math.max(1, s.count * 0.5) end
	return hitting * s.damage * s.rate * accuracy
end

--[[ new(def, level?) -> weapon ; w:update(dt, firing, x, y, aim, t) -> { shots = {...}, beam = {...}?, orbs = {...}? }
   w:upgrade(n = 1) -> bool (changed)   w:setLevel(L)   w.level   w:isMax()   w:stats() ]]
function M.new(def, level)
	local w = { def = def, level = math.clamp(level or 1, 1, M.maxLevel(def)), cd = 0, t = 0 }
	function w.stats(self) return M.stats(self.def, self.level) end
	function w.isMax(self) return self.level >= M.maxLevel(self.def) end
	function w.setLevel(self, L) self.level = math.clamp(L, 1, M.maxLevel(self.def)) end
	function w.upgrade(self, n)
		local old = self.level
		self:setLevel(self.level + (n or 1))
		return self.level ~= old
	end
	function w.update(self, dt, firing, x, y, aim)
		self.t += dt
		local out = { shots = {} }
		local s = self:stats()
		if s.kind == "orbital" then out.orbs = M.orbs(self.def, self.level, self.t, x, y) end
		if not firing then self.cd = math.max(0, self.cd - dt) return out end
		if s.kind == "laser" then
			out.beam = M.beam(self.def, self.level, x, y, aim)
			return out
		end
		self.cd -= dt
		local guard = 0
		while self.cd <= 0 and guard < 8 do
			for _, sh in M.volley(self.def, self.level, x, y, aim) do table.insert(out.shots, sh) end
			self.cd += 1 / math.max(0.1, s.rate)
			guard += 1
		end
		return out
	end
	return w
end

return M
