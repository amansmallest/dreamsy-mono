-- topdown kit: bosses with phase patterns from data/bosses/<id>.json (schemas/boss.json).
-- Steps: wait, move (to = [dx,dy] from home | "player" | "random"), chase, charge, shoot
-- (pattern ring | aimed | spread), summon, vulnerable, teleport. Phases switch on hp thresholds.
local U = require("./util")

local Boss = {}
Boss.__index = Boss

Boss.DEFAULTS = {
	hp = 12,
	size = { 24, 24 },
	damage = 2,
	speed = 50,
	iframes = 0.6,
	needs_vulnerable = false,
	flying = false,
	phases = { { ["until"] = 0, steps = { { ["do"] = "chase", time = 2 }, { ["do"] = "wait", time = 0.6 } } } },
}

function Boss.new(def, x: number, y: number)
	local d = U.merge(Boss.DEFAULTS, def)
	local self = setmetatable({}, Boss)
	self.def = d
	self.id = d.id
	self.name = d.name or d.id
	self.x, self.y, self.w, self.h = x, y, d.size[1], d.size[2]
	self.homeX, self.homeY = x, y
	self.flying = d.flying
	self.hp, self.maxHp = d.hp, d.hp
	self.alive = true
	self.iframes = 0
	self.phase, self.step, self.stepT, self.init = 1, 1, 0, false
	self.vulnerable = not d.needs_vulnerable
	self.isBoss = true
	self.state = "idle"
	self.dx, self.dy = 0, 1
	self.kbT = 0
	return self
end

local function nextStep(self)
	local ph = self.def.phases[self.phase]
	self.step = self.step % #ph.steps + 1
	self.stepT = 0
	self.init = false
end

local function fire(self, ctx, s)
	local n = s.count or 8
	local sp = s.speed or 90
	local pat = s.pattern or "ring"
	local base = 0
	if ctx.player and pat ~= "ring" then base = math.atan2(ctx.player.y - self.y, ctx.player.x - self.x) end
	if pat == "ring" then base = (s.rotate or 0) * (self.volley or 0) end
	for i = 1, n do
		local a
		if pat == "ring" then a = base + (i - 1) / n * 2 * math.pi
		elseif pat == "aimed" then a = base
		else a = base + (if n == 1 then 0 else math.rad((i - 1) / (n - 1) * (s.spread or 60) - (s.spread or 60) / 2)) end
		ctx.shoot({ x = self.x, y = self.y, vx = math.cos(a) * sp, vy = math.sin(a) * sp, w = (s.size and s.size[1]) or 8, h = (s.size and s.size[2]) or 8, life = s.life or 3, damage = self.def.damage, owner = "enemy", sprite = s.sprite, from = self })
	end
end

function Boss:update(dt: number, grid, ctx)
	if not self.alive then return end
	if self.iframes > 0 then self.iframes -= dt end
	if self.kbT > 0 then self.kbT -= dt end
	local ph = self.def.phases[self.phase]
	local mult = ph.speed_mult or 1
	local s = ph.steps[self.step]
	local kind = s["do"]
	local first = not self.init
	self.init = true
	self.stepT += dt
	self.state = kind
	local sp = (s.speed or self.def.speed) * mult
	if kind == "wait" then
		if self.stepT >= (s.time or 1) then nextStep(self) end
	elseif kind == "move" or kind == "teleport" then
		if first then
			if s.to == "player" and ctx.player then self.tx, self.ty = ctx.player.x, ctx.player.y
			elseif s.to == "random" then
				local r = s.radius or 48
				self.tx, self.ty = self.homeX + ctx.random(-r, r), self.homeY + ctx.random(-r, r)
			elseif type(s.to) == "table" then self.tx, self.ty = self.homeX + s.to[1], self.homeY + s.to[2]
			else self.tx, self.ty = self.homeX, self.homeY end
			if kind == "teleport" then
				self.x, self.y = self.tx, self.ty
				ctx.event("teleport", self)
				nextStep(self)
				return
			end
		end
		local dx, dy = self.tx - self.x, self.ty - self.y
		local l = math.sqrt(dx * dx + dy * dy)
		if l <= sp * dt or self.stepT > (s.time or 4) then
			nextStep(self)
		else
			self.dx, self.dy = dx / l, dy / l
			local hx, hy = grid:move(self, self.dx * sp * dt, self.dy * sp * dt, 0)
			if (hx and hy) then nextStep(self) end
		end
	elseif kind == "chase" then
		if ctx.player then
			local dx, dy = ctx.player.x - self.x, ctx.player.y - self.y
			local l = math.max(0.01, math.sqrt(dx * dx + dy * dy))
			self.dx, self.dy = dx / l, dy / l
			grid:move(self, self.dx * sp * dt, self.dy * sp * dt, 0)
		end
		if self.stepT >= (s.time or 2) then nextStep(self) end
	elseif kind == "charge" then
		if first then
			if ctx.player then
				local dx, dy = ctx.player.x - self.x, ctx.player.y - self.y
				local l = math.max(0.01, math.sqrt(dx * dx + dy * dy))
				self.dx, self.dy = dx / l, dy / l
			end
			ctx.event("windup", self)
		end
		if self.stepT >= (s.windup or 0.5) then
			local cs = (s.speed or 160) * mult
			local hx, hy = grid:move(self, self.dx * cs * dt, self.dy * cs * dt, 0)
			if hx or hy or self.stepT > (s.time or 3) then
				ctx.event("slam", self)
				nextStep(self)
			end
		end
	elseif kind == "shoot" then
		if first then self.volley = 0 end
		local volleys = s.volleys or 1
		local interval = s.interval or 0.5
		if self.volley < volleys and self.stepT >= self.volley * interval then
			fire(self, ctx, s)
			self.volley += 1
			ctx.event("shoot", self)
		end
		if self.volley >= volleys and self.stepT >= (volleys - 1) * interval + (s.after or 0.4) then nextStep(self) end
	elseif kind == "summon" then
		for i = 1, (s.count or 1) do
			local a = (i / (s.count or 1)) * 2 * math.pi
			ctx.summon(s.enemy, self.x + math.cos(a) * 24, self.y + math.sin(a) * 24)
		end
		ctx.event("summon", self)
		nextStep(self)
	elseif kind == "vulnerable" then
		self.vulnerable = true
		if self.stepT >= (s.time or 2) then
			self.vulnerable = not self.def.needs_vulnerable
			nextStep(self)
		end
	else
		error("topdown boss " .. tostring(self.id) .. ": unknown step \"" .. tostring(kind) .. "\" (use wait, move, teleport, chase, charge, shoot, summon, vulnerable)", 0)
	end
end

-- returns killed, phaseChanged
function Boss:damage(n: number): (boolean, boolean)
	if not self.alive or self.iframes > 0 or not self.vulnerable then return false, false end
	self.hp = math.max(0, self.hp - n)
	self.iframes = self.def.iframes
	if self.hp <= 0 then self.alive = false return true, false end
	local frac = self.hp / self.maxHp
	local phases = self.def.phases
	local target = self.phase
	while target < #phases and frac <= (phases[target]["until"] or 0) do target += 1 end
	if target ~= self.phase then
		self.phase, self.step, self.stepT, self.init = target, 1, 0, false
		self.iframes = math.max(self.iframes, 1)
		return false, true
	end
	return false, false
end

return Boss
