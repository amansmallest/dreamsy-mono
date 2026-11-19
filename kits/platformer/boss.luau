-- platformer kit: bosses driven by phase scripts from data/bosses/<id>.json (schemas/boss.json).
-- A boss loops through the steps of its current phase; phases switch on hp thresholds.
-- Steps: wait, walk, charge, jump, move (fly), shoot, summon, vulnerable, face, anim.
local U = require("./util")

local Boss = {}
Boss.__index = Boss

Boss.DEFAULTS = {
	hp = 10,
	size = { 32, 32 },
	damage = 1,
	gravity = 1200,
	max_fall = 500,
	stompable = true,
	shootable = true,
	stomp_damage = 1,
	iframes = 0.8, -- invulnerable time after each hit
	needs_vulnerable = false, -- true: only takes damage during "vulnerable" steps
	phases = { { ["until"] = 0, steps = { { ["do"] = "walk", speed = 60, time = 2 }, { ["do"] = "wait", time = 0.6 } } } },
}

function Boss.new(def, x: number, y: number)
	local d = U.merge(Boss.DEFAULTS, def)
	local self = setmetatable({}, Boss)
	self.def = d
	self.id = d.id
	self.name = d.name or d.id
	self.x, self.y = x, y
	self.homeX, self.homeY = x, y
	self.w, self.h = d.size[1], d.size[2]
	self.vx, self.vy = 0, 0
	self.hp, self.maxHp = d.hp, d.hp
	self.alive = true
	self.iframes = 0
	self.dir = -1
	self.phase = 1
	self.step = 1
	self.stepT = 0
	self.stepInit = false
	self.vulnerable = not d.needs_vulnerable
	self.grounded = false
	self.isBoss = true
	self.state = "idle"
	self.events = {}
	return self
end

function Boss:currentPhase()
	return self.def.phases[self.phase]
end

local function physics(self, dt, tiles)
	local g = self.def.gravity
	if self.flying then g = 0 end
	if g > 0 then self.vy = math.min(self.vy + g * dt, self.def.max_fall) end
	local hitX = tiles:moveX(self, self.vx * dt)
	local vyb = self.vy
	local hitY = tiles:moveY(self, self.vy * dt)
	if hitY then self.vy = 0 end
	self.grounded = (hitY and vyb > 0) or (g > 0 and self.vy == 0 and tiles:onGround(self))
	return hitX, hitY
end

local function nextStep(self)
	local ph = self:currentPhase()
	self.step += 1
	if self.step > #ph.steps then self.step = 1 end
	self.stepT = 0
	self.stepInit = false
end

local function dirTo(self, toward, ctx)
	if toward == "player" and ctx.player then return if ctx.player.x < self.x then -1 else 1 end
	if toward == "home" then return if self.homeX < self.x then -1 else 1 end
	if toward == "left" then return -1 end
	if toward == "right" then return 1 end
	if toward == "turn" then return -self.dir end
	return self.dir
end

function Boss:update(dt: number, tiles, ctx)
	self.events = {}
	if not self.alive then return end
	if self.iframes > 0 then self.iframes -= dt end
	local ph = self:currentPhase()
	local mult = ph.speed_mult or 1
	local s = ph.steps[self.step]
	if not s then return end
	local kind = s["do"]
	local first = not self.stepInit
	self.stepInit = true
	self.stepT += dt
	self.state = kind

	if kind == "wait" then
		self.vx = U.approach(self.vx, 0, 800 * dt)
		physics(self, dt, tiles)
		if self.stepT >= (s.time or 1) then nextStep(self) end
	elseif kind == "face" then
		self.dir = dirTo(self, s.toward or "player", ctx)
		nextStep(self)
	elseif kind == "walk" then
		if first then self.dir = dirTo(self, s.toward, ctx) end
		self.vx = self.dir * (s.speed or 60) * mult
		local hitX = physics(self, dt, tiles)
		if hitX then self.dir = -self.dir end
		if self.stepT >= (s.time or 2) then nextStep(self) end
	elseif kind == "charge" then
		if first then
			self.dir = dirTo(self, s.toward or "player", ctx)
			self.events.charge = true
		end
		if self.stepT < (s.windup or 0.4) then
			self.vx = 0
			physics(self, dt, tiles)
		else
			self.vx = self.dir * (s.speed or 220) * mult
			local hitX = physics(self, dt, tiles)
			if hitX or self.stepT >= (s.time or 3) then
				self.events.slam = true
				self.vx = 0
				nextStep(self)
			end
		end
	elseif kind == "jump" then
		if first then
			self.dir = dirTo(self, s.toward or "player", ctx)
			local h = s.height or 64
			self.vy = -math.sqrt(2 * self.def.gravity * h)
			local airT = 2 * math.sqrt(2 * h / self.def.gravity)
			local dist = s.distance
			if s.toward == "player" and ctx.player and not dist then dist = math.abs(ctx.player.x - self.x) end
			self.vx = self.dir * (dist or 80) / airT
			self.grounded = false
		end
		local hitX = physics(self, dt, tiles)
		if hitX then self.vx = 0 end
		if self.grounded and self.stepT > 0.05 then
			self.vx = 0
			self.events.slam = true
			nextStep(self)
		end
	elseif kind == "move" then
		-- flying bosses: glide to a point relative to home (or above the player)
		self.flying = true
		local tx, ty
		if s.to == "player" and ctx.player then tx, ty = ctx.player.x, ctx.player.y - (s.above or 48)
		elseif type(s.to) == "table" then tx, ty = self.homeX + s.to[1], self.homeY + s.to[2]
		else tx, ty = self.homeX, self.homeY end
		local sp = (s.speed or 80) * mult * dt
		local dx, dy = tx - self.x, ty - self.y
		local l = math.sqrt(dx * dx + dy * dy)
		if l <= sp then
			self.x, self.y = tx, ty
			self.vx, self.vy = 0, 0
			nextStep(self)
		else
			self.vx, self.vy = dx / l * sp / dt, dy / l * sp / dt
			if math.abs(dx) > 1 then self.dir = U.sign(dx) end
			tiles:moveX(self, dx / l * sp)
			tiles:moveY(self, dy / l * sp)
			if self.stepT >= (s.time or 6) then nextStep(self) end
		end
	elseif kind == "land" then
		self.flying = false
		physics(self, dt, tiles)
		if self.grounded then nextStep(self) end
	elseif kind == "shoot" then
		self.vx = 0
		if not self.flying then physics(self, dt, tiles) end
		local volleys = s.volleys or 1
		local interval = s.interval or 0.4
		self.fired = if first then 0 else self.fired
		if self.fired < volleys and self.stepT >= self.fired * interval then
			self.fired += 1
			if ctx.shoot then
				local n = s.count or 1
				local spread = s.spread or 30
				local ax, ay
				if (s.aim or "player") == "player" and ctx.player then
					local dx, dy = ctx.player.x - self.x, ctx.player.y - self.y
					local l = math.max(0.001, math.sqrt(dx * dx + dy * dy))
					ax, ay = dx / l, dy / l
				elseif s.aim == "fixed" then
					local a = math.rad(s.angle or 0)
					ax, ay = math.cos(a), math.sin(a)
				else
					ax, ay = self.dir, 0
				end
				local base = math.atan2(ay, ax)
				for i = 1, n do
					local a = base + (if n == 1 then 0 else math.rad((i - 1) / (n - 1) * spread - spread / 2))
					ctx.shoot({
						x = self.x, y = self.y, vx = math.cos(a) * (s.speed or 150), vy = math.sin(a) * (s.speed or 150),
						w = (s.size and s.size[1]) or 8, h = (s.size and s.size[2]) or 8, gravity = s.gravity or 0,
						life = 5, damage = self.def.damage, owner = "enemy", sprite = s.sprite, from = self,
					})
				end
			end
			self.events.shoot = true
		end
		if self.fired >= volleys and self.stepT >= (volleys - 1) * interval + (s.after or 0.3) then nextStep(self) end
	elseif kind == "summon" then
		if ctx.summon then
			local n = s.count or 1
			for i = 1, n do
				local off = (i - (n + 1) / 2) * (s.gap or 32)
				ctx.summon(s.enemy, self.x + off, self.y - (s.above or 0))
			end
		end
		self.events.summon = true
		nextStep(self)
	elseif kind == "vulnerable" then
		self.vulnerable = true
		self.vx = 0
		if not self.flying then physics(self, dt, tiles) end
		if self.stepT >= (s.time or 2) then
			self.vulnerable = not self.def.needs_vulnerable
			nextStep(self)
		end
	elseif kind == "anim" then
		self.events.anim = s.name
		nextStep(self)
	else
		error("platformer boss " .. tostring(self.id) .. ": unknown step \"" .. tostring(kind) .. "\" (use wait, face, walk, charge, jump, move, land, shoot, summon, vulnerable, anim)", 0)
	end
end

-- Returns killed, phaseChanged.
function Boss:damage(n: number?, fromX: number?): (boolean, boolean)
	if not self.alive or self.iframes > 0 or not self.vulnerable then return false, false end
	self.hp = math.max(0, self.hp - (n or 1))
	self.iframes = self.def.iframes
	if self.hp <= 0 then
		self.alive = false
		return true, false
	end
	local frac = self.hp / self.maxHp
	local phases = self.def.phases
	local target = self.phase
	while target < #phases and frac <= (phases[target]["until"] or 0) do target += 1 end
	if target ~= self.phase then
		self.phase = target
		self.step = 1
		self.stepT = 0
		self.stepInit = false
		self.flying = false
		self.iframes = math.max(self.iframes, 1.2)
		return false, true
	end
	return false, false
end

return Boss
