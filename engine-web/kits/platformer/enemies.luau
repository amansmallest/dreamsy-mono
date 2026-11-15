-- platformer kit: enemy behaviour library. Definitions come from data/enemies/<id>.json (schemas/enemy.json).
-- Behaviours: patroller, hopper, flyer, shooter, chaser, turret. Each is a pure update over a tile world
-- plus a small ctx (player box, projectile spawner), so they are unit-testable without entities.
local U = require("./util")

local E = {}
E.__index = E

E.DEFAULTS = {
	behaviour = "patroller",
	size = { 14, 14 },
	hp = 1,
	speed = 40,
	damage = 1,
	gravity = 1200,
	max_fall = 420,
	stompable = true,
	shootable = true,
	contact = true,
	edge_turn = true, -- patrollers/chasers turn at ledges
	score = 100,
	knockback = true,
	hop = { interval = 1.2, height = 40, speed = 60, toward_player = true },
	fly = { pattern = "sine", amplitude = 24, period = 2, range = 48 },
	shoot = { interval = 2, speed = 140, range = 200, aim = "player", count = 1, spread = 20, size = { 6, 6 }, gravity = 0, life = 4 },
	chase = { range = 140, jump_height = 36, speed_mult = 1.6 },
}

local AIRBORNE = { flyer = true, turret = true }

-- Create an enemy record. def = content table; x, y = center. ctx optional.
function E.new(def, x: number, y: number)
	local d = U.merge(E.DEFAULTS, def)
	if d.behaviour == "turret" or d.behaviour == "shooter" then
		if def.speed == nil then d.speed = 0 end
	end
	if AIRBORNE[d.behaviour] and def.gravity == nil then d.gravity = 0 end
	local self = setmetatable({}, E)
	self.def = d
	self.id = d.id
	self.x, self.y = x, y
	self.homeX, self.homeY = x, y
	self.w, self.h = d.size[1], d.size[2]
	self.vx, self.vy = 0, 0
	self.hp = d.hp
	self.maxHp = d.hp
	self.dir = if d.start_dir == "right" or d.start_dir == 1 then 1 else -1
	self.t = 0
	self.cool = (d.shoot and d.shoot.delay) or (d.shoot and d.shoot.interval or 2) * 0.5
	self.state = "idle"
	self.alive = true
	self.grounded = false
	self.iframes = 0
	self.active = true
	return self
end

local function gravityStep(self, dt, tiles)
	local d = self.def
	if d.gravity and d.gravity > 0 then
		self.vy = math.min(self.vy + d.gravity * dt, d.max_fall)
	end
	local hitX = tiles:moveX(self, self.vx * dt)
	local vyb = self.vy
	local hitY = tiles:moveY(self, self.vy * dt)
	if hitY then self.vy = 0 end
	self.grounded = hitY and vyb > 0
	if not self.grounded and d.gravity and d.gravity > 0 and self.vy == 0 then
		self.grounded = tiles:onGround(self)
	end
	return hitX, hitY
end

local function walk(self, dt, tiles, speed)
	local d = self.def
	self.vx = self.dir * speed
	local hitX = gravityStep(self, dt, tiles)
	if hitX then
		self.dir = -self.dir
		self.vx = 0
	elseif self.grounded and d.edge_turn and not tiles:groundAhead(self, self.dir) then
		self.dir = -self.dir
	end
end

local B = {}

function B.patroller(self, dt, tiles, ctx)
	walk(self, dt, tiles, self.def.speed)
	-- optional patrol range around home
	local range = self.def.range
	if range and math.abs(self.x - self.homeX) > range and U.sign(self.x - self.homeX) == self.dir then self.dir = -self.dir end
end

function B.hopper(self, dt, tiles, ctx)
	local h = self.def.hop
	if self.grounded then
		self.vx = U.approach(self.vx, 0, 900 * dt)
		self.t += dt
		if self.t >= h.interval then
			self.t = 0
			if h.toward_player and ctx.player then self.dir = if ctx.player.x < self.x then -1 else 1 end
			self.vy = -math.sqrt(2 * self.def.gravity * h.height)
			self.vx = self.dir * h.speed
			self.grounded = false
			self.state = "hop"
		else
			self.state = "idle"
		end
	end
	local hitX = gravityStep(self, dt, tiles)
	if hitX then self.dir = -self.dir end
end

function B.flyer(self, dt, tiles, ctx)
	local f = self.def.fly
	self.t += dt
	local w = 2 * math.pi / math.max(0.1, f.period)
	local tx, ty = self.x, self.y
	if f.pattern == "hover" then
		tx, ty = self.homeX, self.homeY + math.sin(self.t * w) * f.amplitude
	elseif f.pattern == "circle" then
		tx, ty = self.homeX + math.cos(self.t * w) * f.range, self.homeY + math.sin(self.t * w) * f.amplitude
	elseif f.pattern == "swoop" and ctx.player then
		-- drift toward the player horizontally, dive in a sine
		local px = ctx.player.x
		local dx = U.clamp(px - self.x, -self.def.speed * dt, self.def.speed * dt)
		tx, ty = self.x + dx, self.homeY + (math.sin(self.t * w) * 0.5 + 0.5) * f.amplitude
	else -- sine: patrol horizontally while bobbing
		local nx = self.x + self.dir * self.def.speed * dt
		if math.abs(nx - self.homeX) > f.range then self.dir = -self.dir end
		tx, ty = nx, self.homeY + math.sin(self.t * w) * f.amplitude
	end
	self.vx = (tx - self.x) / dt
	self.vy = (ty - self.y) / dt
	if math.abs(self.vx) > 0.1 then self.dir = U.sign(self.vx) end
	-- flyers pass through nothing but solid tiles
	if tiles:moveX(self, tx - self.x) and f.pattern == "sine" then self.dir = -self.dir end
	tiles:moveY(self, ty - self.y)
end

local function fire(self, ctx)
	local s = self.def.shoot
	if not ctx.shoot then return end
	local ax, ay
	if s.aim == "player" and ctx.player then
		local dx, dy = ctx.player.x - self.x, ctx.player.y - self.y
		local l = math.max(0.001, math.sqrt(dx * dx + dy * dy))
		ax, ay = dx / l, dy / l
	elseif s.aim == "fixed" then
		local a = math.rad(s.angle or 0)
		ax, ay = math.cos(a), math.sin(a)
	else -- facing
		ax, ay = self.dir, 0
	end
	local n = math.max(1, s.count or 1)
	local base = math.atan2(ay, ax)
	for i = 1, n do
		local off = if n == 1 then 0 else math.rad((i - 1) / (n - 1) * s.spread - s.spread / 2)
		local a = base + off
		ctx.shoot({
			x = self.x + math.cos(a) * self.w * 0.5, y = self.y + math.sin(a) * self.h * 0.3,
			vx = math.cos(a) * s.speed, vy = math.sin(a) * s.speed,
			w = s.size[1], h = s.size[2], gravity = s.gravity or 0, life = s.life or 4,
			damage = self.def.damage, owner = "enemy", sprite = s.sprite, from = self,
		})
	end
	self.state = "attack"
	self.attackT = 0.25
end

function B.shooter(self, dt, tiles, ctx)
	local s = self.def.shoot
	if ctx.player then self.dir = if ctx.player.x < self.x then -1 else 1 end
	if self.def.speed > 0 then
		walk(self, dt, tiles, self.def.speed)
	else
		self.vx = 0
		gravityStep(self, dt, tiles)
	end
	self.cool -= dt
	local inRange = ctx.player and U.dist(self.x, self.y, ctx.player.x, ctx.player.y) <= s.range
	if self.cool <= 0 and inRange and (s.los == false or tiles:clearLine(self.x, self.y, ctx.player.x, ctx.player.y)) then
		self.cool = s.interval
		fire(self, ctx)
	end
end

function B.turret(self, dt, tiles, ctx)
	local s = self.def.shoot
	self.cool -= dt
	if s.aim == "player" and ctx.player then self.dir = if ctx.player.x < self.x then -1 else 1 end
	if self.def.gravity and self.def.gravity > 0 then gravityStep(self, dt, tiles) end
	local inRange = not s.range or (ctx.player and U.dist(self.x, self.y, ctx.player.x, ctx.player.y) <= s.range)
	if self.cool <= 0 and inRange then
		self.cool = s.interval
		fire(self, ctx)
	end
end

function B.chaser(self, dt, tiles, ctx)
	local c = self.def.chase
	local p = ctx.player
	local chasing = p ~= nil and math.abs(p.x - self.x) <= c.range and math.abs(p.y - self.y) <= c.range * 0.6
	if chasing then
		self.state = "chase"
		self.dir = if p.x < self.x then -1 else 1
		self.vx = self.dir * self.def.speed * c.speed_mult
		local hitX = gravityStep(self, dt, tiles)
		-- hop over walls and gaps
		if self.grounded and (hitX or (not tiles:groundAhead(self, self.dir))) and c.jump_height > 0 then
			self.vy = -math.sqrt(2 * self.def.gravity * c.jump_height)
			self.grounded = false
		end
	else
		self.state = "patrol"
		walk(self, dt, tiles, self.def.speed)
	end
end

E.BEHAVIOURS = B

-- Register a custom behaviour: kit.enemies.define("spinner", function(enemy, dt, tiles, ctx) ... end)
function E.define(name: string, fn)
	B[name] = fn
end

function E:update(dt: number, tiles, ctx)
	if not self.alive then return end
	if self.iframes > 0 then self.iframes -= dt end
	if self.attackT then
		self.attackT -= dt
		if self.attackT <= 0 then self.attackT = nil; self.state = "idle" end
	end
	if self.stunT and self.stunT > 0 then
		self.stunT -= dt
		gravityStep(self, dt, tiles)
		self.vx = U.approach(self.vx, 0, 600 * dt)
		return
	end
	local fn = B[self.def.behaviour]
	if not fn then error("platformer: unknown enemy behaviour \"" .. tostring(self.def.behaviour) .. "\" for " .. tostring(self.id) .. " (use patroller, hopper, flyer, shooter, chaser, turret or kit.enemies.define)", 0) end
	fn(self, dt, tiles, ctx)
end

-- Returns true when this hit killed it.
function E:damage(n: number?, fromX: number?): boolean
	if not self.alive or self.iframes > 0 then return false end
	self.hp -= n or 1
	self.iframes = 0.2
	if self.hp <= 0 then
		self.alive = false
		return true
	end
	if fromX and self.def.knockback and (self.def.gravity or 0) > 0 then
		self.vx = U.sign(self.x - fromX) * 120
		self.vy = -120
		self.stunT = 0.25
	end
	return false
end

return E
