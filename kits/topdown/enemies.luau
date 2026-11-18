-- topdown kit: enemy library from data/enemies/<id>.json (schemas/enemy.json).
-- Behaviours: wanderer, chaser, charger, archer, spawner, ai (an @kit/ai brain from def.ai) (+ kit.enemies.define).
-- Pure updates over grid.luau with a ctx { player = box, shoot = fn(p), summon = fn(id, x, y), random = fn }.
local U = require("./util")
local AI = require("@kit/ai")

local E = {}
E.__index = E

E.DEFAULTS = {
	behaviour = "wanderer",
	size = { 12, 12 },
	hp = 2,
	speed = 30,
	damage = 1, -- half hearts
	knockback = true,
	iframes = 0.35,
	turn = { 0.8, 2.0 }, -- wanderer: seconds between direction changes (min, max)
	aggro = 72, -- chaser / charger: px
	charge = { speed = 140, windup = 0.35, stun = 0.6 },
	shoot = { interval = 1.8, speed = 110, range = 120, keep = 48, size = { 6, 6 }, life = 2.5, aligned = true },
	spawn = { enemy = nil, interval = 3, max = 3, radius = 16 },
	drops = nil, -- { { item = "heart", chance = 0.3 }, { item = "rupee", chance = 0.5 } }
	flying = false,
	touch = true, -- contact damage
}

local DIRS4 = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }

function E.new(def, x: number, y: number)
	local d = U.merge(E.DEFAULTS, def)
	local self = setmetatable({}, E)
	self.def = d
	self.id = d.id
	self.x, self.y, self.w, self.h = x, y, d.size[1], d.size[2]
	self.homeX, self.homeY = x, y
	self.flying = d.flying
	self.vx, self.vy = 0, 0
	self.hp, self.maxHp = d.hp, d.hp
	self.alive = true
	self.iframes = 0
	self.t = 0
	self.state = "idle"
	self.dx, self.dy = 0, 1
	self.cool = d.shoot.interval * 0.6
	self.kbT, self.kbx, self.kby = 0, 0, 0
	self.stunT = 0
	self.children = {}
	return self
end

local function rnd(ctx, a, b)
	if ctx.random then return ctx.random(a, b) end
	return random(a, b)
end

local function pickDir(self, ctx)
	local i = math.floor(rnd(ctx, 1, 5))
	local d = DIRS4[math.clamp(i, 1, 4)]
	self.dx, self.dy = d[1], d[2]
	self.t = rnd(ctx, self.def.turn[1], self.def.turn[2])
end

local function walk(self, dt, grid, sp)
	local hx, hy = grid:move(self, self.dx * sp * dt, self.dy * sp * dt, 0)
	return hx or hy
end

local B = {}

function B.wanderer(self, dt, grid, ctx)
	self.t -= dt
	if self.t <= 0 then pickDir(self, ctx) end
	self.state = "walk"
	if walk(self, dt, grid, self.def.speed) then pickDir(self, ctx) end
end

function B.chaser(self, dt, grid, ctx)
	local p = ctx.player
	if p and U.dist(p.x, p.y, self.x, self.y) <= self.def.aggro then
		local dx, dy = p.x - self.x, p.y - self.y
		local l = math.max(0.01, math.sqrt(dx * dx + dy * dy))
		self.dx, self.dy = dx / l, dy / l
		self.state = "chase"
		grid:move(self, self.dx * self.def.speed * 1.4 * dt, self.dy * self.def.speed * 1.4 * dt, 0)
	else
		B.wanderer(self, dt, grid, ctx)
	end
end

function B.charger(self, dt, grid, ctx)
	local c = self.def.charge
	local p = ctx.player
	if self.state == "windup" then
		self.t -= dt
		if self.t <= 0 then self.state = "charge" end
		return
	elseif self.state == "charge" then
		if walk(self, dt, grid, c.speed) then
			self.state = "stunned"
			self.t = c.stun
			ctx.event("slam", self)
		end
		return
	elseif self.state == "stunned" then
		self.t -= dt
		if self.t <= 0 then self.state = "walk" pickDir(self, ctx) end
		return
	end
	-- lined up with the player on an axis, close enough, clear line: charge
	if p then
		local ax, ay = math.abs(p.x - self.x), math.abs(p.y - self.y)
		local aligned = (ax < 8 and ay <= self.def.aggro * 1.5) or (ay < 8 and ax <= self.def.aggro * 1.5)
		if aligned and grid:clearLine(self.x, self.y, p.x, p.y, self) then
			if ax < 8 then self.dx, self.dy = 0, U.sign(p.y - self.y) else self.dx, self.dy = U.sign(p.x - self.x), 0 end
			self.state = "windup"
			self.t = c.windup
			return
		end
	end
	B.wanderer(self, dt, grid, ctx)
end

function B.archer(self, dt, grid, ctx)
	local s = self.def.shoot
	local p = ctx.player
	self.cool -= dt
	if p and U.dist(p.x, p.y, self.x, self.y) <= s.range then
		local dx, dy = p.x - self.x, p.y - self.y
		-- face the player on the dominant axis
		if math.abs(dx) > math.abs(dy) then self.fx, self.fy = U.sign(dx), 0 else self.fx, self.fy = 0, U.sign(dy) end
		local d = math.sqrt(dx * dx + dy * dy)
		-- keep distance: step away when too close
		if d < s.keep then
			grid:move(self, -dx / d * self.def.speed * dt, -dy / d * self.def.speed * dt, 0)
		end
		local aligned = not s.aligned or math.abs(dx) < 10 or math.abs(dy) < 10
		if self.cool <= 0 and aligned and grid:clearLine(self.x, self.y, p.x, p.y, { flying = true }) then
			self.cool = s.interval
			local ax, ay
			if s.aligned then ax, ay = self.fx, self.fy else ax, ay = dx / d, dy / d end
			ctx.shoot({ x = self.x + ax * 8, y = self.y + ay * 8, vx = ax * s.speed, vy = ay * s.speed, w = s.size[1], h = s.size[2], life = s.life, damage = self.def.damage, owner = "enemy", sprite = s.sprite, from = self })
			self.state = "shoot"
			ctx.event("shoot", self)
		else
			self.state = "aim"
		end
	else
		B.wanderer(self, dt, grid, ctx)
	end
end

function B.spawner(self, dt, grid, ctx)
	local s = self.def.spawn
	self.state = "idle"
	self.t += dt
	local alive = 0
	for i = #self.children, 1, -1 do
		if self.children[i].alive then alive += 1 else table.remove(self.children, i) end
	end
	if self.t >= s.interval and alive < s.max and s.enemy then
		self.t = 0
		local a = rnd(ctx, 0, 2 * math.pi)
		local child = ctx.summon(s.enemy, self.x + math.cos(a) * s.radius, self.y + math.sin(a) * s.radius)
		if child then table.insert(self.children, child) end
		self.state = "spawn"
	end
end

-- "ai": any @kit/ai behaviour spec in def.ai (wander, patrol, chase, keep_distance, turret, spawner, fsm, utility,
-- boss phases). The brain steers; the kit's grid collision moves the box. Actions: shoot → a projectile with the
-- def's shoot params, spawn → summon, others → area event enemy_<name>.
function B.ai(self, dt, grid, ctx)
	if not self.brain then
		self.brain = AI.brain(self.def.ai or { behavior = "wander" })
		self.home = { x = self.homeX, y = self.homeY }
		grid.pathGrid = grid.pathGrid or AI.grid(grid, { solid = "#", tileSize = grid.ts, origin = { x = grid.ox, y = grid.oy } })
	end
	local p = ctx.player
	local s = self.def.shoot
	local vx, vy = self.brain:update({
		dt = dt, x = self.x, y = self.y, vx = self.vx, vy = self.vy, onFloor = true, home = self.home,
		target = if p then { x = p.x, y = p.y } else nil, grid = grid.pathGrid, mode = if self.flying then "flyer" else "topdown",
		rand = function() return rnd(ctx, 0, 1) end, hp = self.hp, maxHp = self.maxHp,
		children = function()
			local n = 0
			for _, c in self.children do if c.alive then n += 1 end end
			return n
		end,
		emit = function(name, a)
			if name == "shoot" then
				ctx.shoot({ x = self.x + a.dx * 8, y = self.y + a.dy * 8, vx = a.dx * s.speed, vy = a.dy * s.speed, w = s.size[1], h = s.size[2], life = s.life, damage = self.def.damage, owner = "enemy", sprite = s.sprite, from = self })
			elseif name == "spawn" then
				local child = ctx.summon(a.kind or self.def.spawn.enemy, a.x or self.x, a.y or self.y)
				if child then table.insert(self.children, child) end
			end
			ctx.event(name, self)
		end,
	})
	self.vx, self.vy = vx or 0, vy or 0
	self.state = if self.vx ~= 0 or self.vy ~= 0 then "walk" else "idle"
	if self.state == "walk" then
		local l = math.sqrt(self.vx * self.vx + self.vy * self.vy)
		self.dx, self.dy = self.vx / l, self.vy / l
		grid:move(self, self.vx * dt, self.vy * dt, 0)
	end
end

E.BEHAVIOURS = B
function E.define(name: string, fn) B[name] = fn end

function E:update(dt: number, grid, ctx)
	if not self.alive then return end
	if self.iframes > 0 then self.iframes -= dt end
	if self.kbT > 0 then
		self.kbT -= dt
		grid:move(self, self.kbx * dt, self.kby * dt, 0)
		return
	end
	if self.stunT > 0 then self.stunT -= dt return end
	local fn = B[self.def.behaviour]
	if not fn then error("topdown: unknown enemy behaviour \"" .. tostring(self.def.behaviour) .. "\" (use wanderer, chaser, charger, archer, spawner, ai or kit.enemies.define)", 0) end
	fn(self, dt, grid, ctx)
end

-- returns true when killed
function E:damage(n: number, fromX: number?, fromY: number?, kb: number?): boolean
	if not self.alive or self.iframes > 0 then return false end
	if self.def.invulnerable then return false end
	self.hp -= n
	self.iframes = self.def.iframes
	if self.hp <= 0 then
		self.alive = false
		return true
	end
	if fromX and self.def.knockback then
		local dx, dy = self.x - fromX, self.y - (fromY or self.y)
		local l = math.max(0.01, math.sqrt(dx * dx + dy * dy))
		self.kbx, self.kby = dx / l * (kb or 160), dy / l * (kb or 160)
		self.kbT = 0.15
		if self.state == "charge" or self.state == "windup" then self.state = "walk" end
	end
	return false
end

function E:stun(t: number)
	self.stunT = math.max(self.stunT, t)
end

return E
