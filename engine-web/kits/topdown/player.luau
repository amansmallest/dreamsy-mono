-- topdown kit: hero controller (pure simulation over grid.luau): 8-direction movement with corner
-- sliding, 4-way facing, sword swing hitbox, knockback, i-frames, hearts (hp in half hearts).
local U = require("./util")

local P = {}
P.__index = P

P.DEFAULTS = {
	speed = 80, -- px/s
	size = { 10, 10 }, -- hitbox (feet area)
	hearts = 3, -- max hearts at start (hp = hearts * 2 half-hearts)
	iframes = 1.0,
	knockback = 170, -- px/s, decays over knockback_time
	knockback_time = 0.18,
	corner_nudge = 5, -- px of corner forgiveness
	sword = { damage = 2, time = 0.22, reach = 14, width = 16, cooldown = 0.08, knockback = 180 },
}

local DIRS = { down = { 0, 1 }, up = { 0, -1 }, left = { -1, 0 }, right = { 1, 0 } }
P.DIRS = DIRS

function P.new(opts, x: number, y: number)
	local self = setmetatable({}, P)
	self.o = U.merge(P.DEFAULTS, opts)
	self.body = { x = x, y = y, w = self.o.size[1], h = self.o.size[2], passes = {} }
	self.facing = "down"
	self.maxHp = self.o.hearts * 2
	self.hp = self.maxHp
	self.iframes = 0
	self.kbx, self.kby, self.kbT = 0, 0, 0
	self.swingT = 0
	self.swingCd = 0
	self.speedMult = 1
	self.frozen = false
	self.moving = false
	self.events = {}
	return self
end

function P:dir()
	local d = DIRS[self.facing]
	return d[1], d[2]
end

-- the sword's hit box while swinging (nil otherwise)
function P:swordBox()
	if self.swingT <= 0 then return nil end
	local s = self.o.sword
	local dx, dy = self:dir()
	local b = self.body
	local reach = s.reach
	if dx ~= 0 then
		return { x = b.x + dx * (b.w / 2 + reach / 2), y = b.y - 2, w = reach, h = s.width }
	end
	return { x = b.x, y = b.y + dy * (b.h / 2 + reach / 2) - (if dy < 0 then 2 else 0), w = s.width, h = reach }
end

function P:swing(): boolean
	if self.swingT > 0 or self.swingCd > 0 or self.frozen then return false end
	self.swingT = self.o.sword.time
	self.hitList = {}
	self.events.swing = true
	return true
end

-- point in front of the hero (interaction probe)
function P:front(dist: number?)
	local dx, dy = self:dir()
	local b = self.body
	local d = dist or 10
	return b.x + dx * (b.w / 2 + d), b.y + dy * (b.h / 2 + d)
end

function P:hurt(n: number, fromX: number?, fromY: number?): boolean
	if self.iframes > 0 or self.hp <= 0 then return false end
	self.hp = math.max(0, self.hp - n)
	self.iframes = self.o.iframes
	if fromX then
		local dx, dy = self.body.x - fromX, self.body.y - (fromY or self.body.y)
		local l = math.sqrt(dx * dx + dy * dy)
		if l < 0.01 then dx, dy, l = -DIRS[self.facing][1], -DIRS[self.facing][2], 1 end
		self.kbx, self.kby = dx / l * self.o.knockback, dy / l * self.o.knockback
		self.kbT = self.o.knockback_time
	end
	self.events.hurt = n
	return true
end

function P:heal(n: number)
	self.hp = math.min(self.maxHp, self.hp + n)
end

-- inp = { x, y (-1..1, +y down), attack = pressed }
function P:step(dt: number, inp, grid)
	self.events = {}
	local b = self.body
	if self.iframes > 0 then self.iframes -= dt end
	if self.swingCd > 0 then self.swingCd -= dt end
	if self.swingT > 0 then
		self.swingT -= dt
		if self.swingT <= 0 then self.swingCd = self.o.sword.cooldown end
	end
	if self.frozen then self.moving = false return end
	local ix, iy = inp.x or 0, inp.y or 0
	if math.abs(ix) < 0.25 then ix = 0 end
	if math.abs(iy) < 0.25 then iy = 0 end
	local l = math.sqrt(ix * ix + iy * iy)
	if l > 1 then ix, iy = ix / l, iy / l end
	-- facing: dominant axis (kept while swinging)
	if self.swingT <= 0 and (ix ~= 0 or iy ~= 0) then
		if math.abs(ix) > math.abs(iy) + 0.05 then self.facing = if ix > 0 then "right" else "left"
		elseif math.abs(iy) > 0 then self.facing = if iy > 0 then "down" else "up" end
	end
	local sp = self.o.speed * self.speedMult
	if self.swingT > 0 then sp *= 0.35 end
	local vx, vy = ix * sp, iy * sp
	if self.kbT > 0 then
		self.kbT -= dt
		vx, vy = self.kbx, self.kby
	end
	self.moving = (ix ~= 0 or iy ~= 0)
	local nudge = if self.kbT > 0 then 0 else self.o.corner_nudge
	-- axis-separated so diagonal slides along walls
	if vx ~= 0 and vy ~= 0 then grid:move(b, vx * dt, vy * dt, 0) else grid:move(b, vx * dt, vy * dt, nudge) end
	self.events.bumped = b.hitCell
	self.events.bumpedSolid = b.hitSolid
	if inp.attack then self:swing() end
end

return P
