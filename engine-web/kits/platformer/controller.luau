-- platformer kit: player controller. Pure simulation over a tile world (tiles.luau): no entity access,
-- so feel numbers are exact and testable. level.luau wires it to the player entity and input.
local U = require("./util")

local Ctl = {}
Ctl.__index = Ctl

-- All distances in px, times in s. Jumps are specified by height + time to apex (gravity is derived).
Ctl.DEFAULTS = {
	run_speed = 140,
	ground_accel = 1600,
	ground_decel = 2000,
	turn_accel = 2800,
	air_accel = 1100,
	air_decel = 500,
	ice_factor = 0.2, -- accel multiplier on tiles tagged "ice"
	jump_height = 56, -- 3.5 tiles at 16 px
	jump_time = 0.36, -- seconds to apex
	fall_gravity_mult = 1.6,
	max_fall = 420,
	jump_cut = 0.45, -- vy multiplier when jump is released while rising (variable jump)
	coyote_time = 0.1,
	jump_buffer = 0.12,
	air_jumps = 1, -- extra jumps with double_jump
	double_jump_height = 40,
	wall_slide_speed = 60,
	wall_jump_x = 160,
	wall_jump_height = 48,
	wall_jump_lock = 0.14, -- input ignored after a wall jump
	dash_speed = 340,
	dash_time = 0.14,
	dash_cooldown = 0.3,
	dash_dirs = 8, -- 8 = any direction, 2 = horizontal only
	climb_speed = 80,
	spring_height = 120,
	stomp_height = 28,
	-- abilities: toggled per game, unlocked by powerups (level.luau) or kit.progress
	abilities = {
		variable_jump = true,
		coyote = true,
		buffer = true,
		ladder = true,
		wall_slide = false,
		wall_jump = false,
		dash = false,
		double_jump = false,
		shoot = false,
	},
}

function Ctl.new(params, body)
	local self = setmetatable({}, Ctl)
	self.p = U.merge(Ctl.DEFAULTS, params)
	self.body = body or { x = 0, y = 0, w = 12, h = 14 }
	self.body.vx = self.body.vx or 0
	self.body.vy = self.body.vy or 0
	self.facing = 1
	self.grounded = false
	self.coyote = 0
	self.buffer = 0
	self.airJumps = 0
	self.dashT = 0
	self.dashCd = 0
	self.canDash = true
	self.wallLock = 0
	self.wallDir = 0
	self.climbing = false
	self.jumping = false
	self.prevHeld = false
	self.frozen = false
	self.events = {}
	self:derive()
	return self
end

function Ctl:derive()
	local p = self.p
	self.gravity = 2 * p.jump_height / (p.jump_time * p.jump_time)
	self.jumpV = 2 * p.jump_height / p.jump_time
	self.doubleV = math.sqrt(2 * self.gravity * p.double_jump_height)
	self.wallV = math.sqrt(2 * self.gravity * p.wall_jump_height)
	self.springV = math.sqrt(2 * self.gravity * p.spring_height)
	self.stompV = math.sqrt(2 * self.gravity * p.stomp_height)
end

function Ctl:has(ability: string): boolean
	return self.p.abilities[ability] == true
end

function Ctl:setAbility(ability: string, on: boolean)
	self.p.abilities[ability] = on
end

-- Launch upward to `height` px (springs, stomps). Restores dash and resets the jump cut.
function Ctl:bounce(height: number?)
	local v = if height then math.sqrt(2 * self.gravity * height) else self.stompV
	self.body.vy = -v
	self.jumping = false
	self.canDash = true
	self.airJumps = self.p.air_jumps
	self.grounded = false
	self.coyote = 0
	self.climbing = false
	self.body.climbing = false
end

function Ctl:knockback(dir: number, vx: number?, vy: number?)
	self.body.vx = dir * (vx or 140)
	self.body.vy = -(vy or 180)
	self.dashT = 0
	self.wallLock = 0.2
	self.climbing = false
	self.body.climbing = false
	self.jumping = false
end

local function ev(self, name, value)
	self.events[name] = value or true
end

-- inp = { x = -1..1, y = -1..1 (+1 down), jump = pressed, jumpHeld = held, dash = pressed }
function Ctl:step(dt: number, inp, tiles)
	local p, b = self.p, self.body
	self.events = {}
	if self.frozen then return end
	local ix, iy = inp.x or 0, inp.y or 0
	if math.abs(ix) < 0.2 then ix = 0 end
	if math.abs(iy) < 0.35 then iy = 0 end
	local released = self.prevHeld and not inp.jumpHeld
	self.prevHeld = inp.jumpHeld == true

	-- timers
	if inp.jump then self.buffer = if self:has("buffer") then p.jump_buffer else dt * 0.5 else self.buffer -= dt end
	self.wallLock = math.max(0, self.wallLock - dt)
	self.dashCd = math.max(0, self.dashCd - dt)
	if self.grounded then
		self.coyote = if self:has("coyote") then p.coyote_time else 0
		self.airJumps = p.air_jumps
		self.canDash = true
	else
		self.coyote -= dt
	end
	if ix ~= 0 and self.wallLock <= 0 and self.dashT <= 0 then self.facing = U.sign(ix) end

	-- drop through one-way platforms: down + jump while standing on one
	b.dropThrough = false
	if b.dropThroughT and b.dropThroughT > 0 then
		b.dropThroughT -= dt
		b.dropThrough = true
	end
	if self.grounded and iy > 0 and inp.jump and not self.climbing then
		local c, r = tiles:cellOf(b.x, b.y + b.h / 2 + 1)
		local onOneway = (tiles:onewayAt(c, r) and not tiles:has(c, r, "ladder")) or (b.ground ~= nil and b.ground.oneway)
		if onOneway and not tiles:solidAt(c, r) then
			b.dropThrough = true
			b.dropThroughT = 0.15
			b.vy = 40
			self.buffer = 0
			self.grounded = false
			self.coyote = 0
			ev(self, "dropped")
		end
	end

	-- ladders
	local onLadder = self:has("ladder") and tiles:overlapTag(b, "ladder", 2)
	if not self.climbing and self:has("ladder") and iy ~= 0 and self.dashT <= 0 then
		if onLadder then
			self.climbing = true
		elseif iy > 0 and self.grounded then
			-- standing on a ladder top: climb down
			local c, r = tiles:cellOf(b.x, b.y + b.h / 2 + 2)
			if tiles:has(c, r, "ladder") then
				self.climbing = true
				b.y += 2
			end
		end
	end
	if self.climbing and not onLadder then
		local c, r = tiles:cellOf(b.x, b.y + b.h / 2 + 2)
		if not tiles:has(c, r, "ladder") or iy <= 0 then self.climbing = false end
	end
	b.climbing = self.climbing

	if self.climbing then
		b.vx = ix * p.climb_speed * 0.6
		b.vy = iy * p.climb_speed
		if self.buffer > 0 then
			self.climbing = false
			b.climbing = false
			self.buffer = 0
			b.vy = -self.jumpV * 0.8
			self.jumping = true
			ev(self, "jumped")
		end
	elseif self.dashT > 0 then
		self.dashT -= dt
		if self.dashT <= 0 then
			b.vx *= 0.55
			b.vy *= 0.4
			ev(self, "dashEnded")
		end
	else
		-- start a dash
		if inp.dash and self:has("dash") and self.canDash and self.dashCd <= 0 then
			local dx, dy = ix, if p.dash_dirs == 8 then iy else 0
			if dx == 0 and dy == 0 then dx = self.facing end
			local l = math.sqrt(dx * dx + dy * dy)
			b.vx, b.vy = dx / l * p.dash_speed, dy / l * p.dash_speed
			self.dashT = p.dash_time
			self.dashCd = p.dash_cooldown
			self.canDash = self.grounded and dy >= 0
			self.jumping = false
			ev(self, "dashed", { x = dx / l, y = dy / l })
		else
			-- horizontal
			local target = ix * p.run_speed
			local accel
			if self.grounded then
				if ix == 0 then accel = p.ground_decel
				elseif b.vx ~= 0 and U.sign(b.vx) ~= U.sign(ix) then accel = p.turn_accel
				else accel = p.ground_accel end
				local c, r = tiles:cellOf(b.x, b.y + b.h / 2 + 1)
				if tiles:has(c, r, "ice") then accel *= p.ice_factor end
			else
				accel = if ix == 0 then p.air_decel else p.air_accel
			end
			if self.wallLock <= 0 then b.vx = U.approach(b.vx, target, accel * dt) end

			-- gravity (stronger when falling)
			local g = self.gravity
			if b.vy > 0 then g *= p.fall_gravity_mult end
			b.vy = math.min(b.vy + g * dt, p.max_fall)

			-- variable jump height
			if released and self.jumping and b.vy < 0 and self:has("variable_jump") then
				b.vy *= p.jump_cut
				self.jumping = false
			end
			if b.vy >= 0 then self.jumping = false end

			-- wall contact
			self.wallDir = 0
			if not self.grounded then
				if tiles:wallAt(b, 1) then self.wallDir = 1 elseif tiles:wallAt(b, -1) then self.wallDir = -1 end
			end
			local sliding = self.wallDir ~= 0 and ix == self.wallDir and b.vy > 0 and self:has("wall_slide")
			if sliding then
				b.vy = math.min(b.vy, p.wall_slide_speed)
				ev(self, "wallSliding")
			end

			-- jumps: ground (incl. coyote) > wall > air
			if self.buffer > 0 then
				if self.grounded or self.coyote > 0 then
					b.vy = -self.jumpV
					self.jumping = true
					self.buffer = 0
					self.coyote = 0
					self.grounded = false
					ev(self, "jumped")
				elseif self.wallDir ~= 0 and self:has("wall_jump") then
					b.vy = -self.wallV
					b.vx = -self.wallDir * p.wall_jump_x
					self.facing = -self.wallDir
					self.wallLock = p.wall_jump_lock
					self.jumping = true
					self.buffer = 0
					self.canDash = true
					ev(self, "wallJumped")
				elseif self.airJumps > 0 and self:has("double_jump") then
					b.vy = -self.doubleV
					self.airJumps -= 1
					self.jumping = true
					self.buffer = 0
					ev(self, "doubleJumped")
				end
			end
		end
	end


	-- move
	local wasGrounded = self.grounded
	b.hitCell = nil
	if tiles:moveX(b, b.vx * dt) then
		if self.dashT > 0 and b.hitCell then ev(self, "dashHit", b.hitCell) end
		b.vx = 0
	end
	b.hitCell = nil
	local vyBefore = b.vy
	local hitY = tiles:moveY(b, b.vy * dt)
	if hitY then
		if vyBefore > 0 then
			b.vy = 0
			local cell = b.hitCell
			if cell and tiles:has(cell[1], cell[2], "spring") then
				self:bounce(self.p.spring_height)
				ev(self, "sprung", cell)
			end
		elseif vyBefore < 0 then
			b.vy = 0
			self.jumping = false
			if b.hitCell then ev(self, "bonked", b.hitCell) end
		end
	end
	if self.climbing then
		self.grounded = false
	elseif b.vy >= 0 then
		self.grounded = (hitY and vyBefore > 0) or tiles:onGround(b)
	else
		self.grounded = false
	end
	if self.grounded and not wasGrounded then ev(self, "landed", vyBefore) end
	if self.grounded and self.dashT <= 0 then self.canDash = true end
end

return Ctl
