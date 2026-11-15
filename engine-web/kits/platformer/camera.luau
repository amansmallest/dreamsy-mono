-- platformer kit: camera rules — smoothed follow with look-ahead, level bounds, room locks
-- (Area2D entities tagged "camera_room" clamp the view to their rect while the player is inside),
-- and explicit locks (boss arenas). Drives a Camera2D's position directly.
local U = require("./util")

local Cam = {}
Cam.__index = Cam

Cam.DEFAULTS = {
	look_ahead = 40, -- px ahead of the facing direction
	look_speed = 3, -- how fast look-ahead swings (1/s)
	lerp_x = 10, -- follow speed (1/s); higher = tighter
	lerp_y = 6,
	offset_y = -12, -- frame the player slightly below center
	deadzone_y = 24, -- vertical slack before the camera moves (while grounded jumps stay steady)
	room_tag = "camera_room",
}

-- e: Camera2D. bounds = { x0, y0, x1, y1 } (world px) or nil = unbounded.
function Cam.new(e, bounds, opts)
	local self = setmetatable({}, Cam)
	self.e = e
	self.o = U.merge(Cam.DEFAULTS, opts)
	self.bounds = bounds
	self.rooms = {}
	self.lockRect = nil
	self.look = 0
	local c = camera.center()
	local tl = camera.screenToWorld(vec2(0, 0))
	self.hw, self.hh = math.abs(c.x - tl.x), math.abs(c.y - tl.y)
	if self.hw < 1 then self.hw, self.hh = 640, 360 end
	self.x, self.y = c.x, c.y
	self.anchorY = nil
	for _, r in entitiesTagged(self.o.room_tag) do
		local p, s = r.position, r.size
		table.insert(self.rooms, { x0 = p.x - s.x / 2, y0 = p.y - s.y / 2, x1 = p.x + s.x / 2, y1 = p.y + s.y / 2, e = r })
	end
	return self
end

function Cam:addRoom(x0: number, y0: number, x1: number, y1: number)
	local r = { x0 = x0, y0 = y0, x1 = x1, y1 = y1 }
	table.insert(self.rooms, r)
	return r
end

-- lock the view inside a rect (boss arena); unlock() releases
function Cam:lock(x0: number, y0: number, x1: number, y1: number)
	self.lockRect = { x0 = x0, y0 = y0, x1 = x1, y1 = y1 }
end

function Cam:unlock()
	self.lockRect = nil
end

function Cam:roomAt(x: number, y: number)
	for _, r in self.rooms do
		if x >= r.x0 and x <= r.x1 and y >= r.y0 and y <= r.y1 then return r end
	end
	return nil
end

local function clampAxis(v, lo, hi, half)
	if hi - lo <= half * 2 then return (lo + hi) / 2 end
	return U.clamp(v, lo + half, hi - half)
end

function Cam:target(body, facing: number, grounded: boolean)
	local tx = body.x + self.look
	-- vertical: hold while grounded within the deadzone, follow when falling/rising far
	if self.anchorY == nil or grounded or math.abs(body.y - self.anchorY) > self.o.deadzone_y * 2 then self.anchorY = body.y end
	local ty = self.anchorY + self.o.offset_y
	local rect = self.lockRect or self:roomAt(body.x, body.y) or self.bounds
	if rect then
		tx = clampAxis(tx, rect.x0 or rect[1], rect.x1 or rect[3], self.hw)
		ty = clampAxis(ty, rect.y0 or rect[2], rect.y1 or rect[4], self.hh)
	end
	return tx, ty
end

function Cam:update(dt: number, body, facing: number, grounded: boolean)
	self.look = U.approach(self.look, facing * self.o.look_ahead, self.o.look_ahead * self.o.look_speed * dt)
	local tx, ty = self:target(body, facing, grounded)
	local kx = 1 - math.exp(-self.o.lerp_x * dt)
	local ky = 1 - math.exp(-self.o.lerp_y * dt)
	self.x += (tx - self.x) * kx
	self.y += (ty - self.y) * ky
	self:apply()
end

function Cam:snap(body, facing: number)
	self.look = facing * self.o.look_ahead
	self.anchorY = nil
	self.x, self.y = self:target(body, facing, true)
	self:apply()
	camera.snap()
end

function Cam:apply()
	if self.e then self.e.position = vec2(math.floor(self.x * 4 + 0.5) / 4, math.floor(self.y * 4 + 0.5) / 4) end
end

-- ---------- parallax ----------
-- Layers move at `factor` of the camera (0 = fixed to the screen, 1 = world-locked).
local Parallax = {}
Parallax.__index = Parallax

function Cam.parallax()
	return setmetatable({ layers = {} }, Parallax)
end

function Parallax:add(e, fx: number, fy: number?)
	local p = e.position
	table.insert(self.layers, { e = e, bx = p.x, by = p.y, fx = fx, fy = fy or fx })
end

-- Scene positions are where layers sit when the camera is at its first update position.
function Parallax:update(cx: number, cy: number)
	if self.c0x == nil then self.c0x, self.c0y = cx, cy end
	local dx, dy = cx - self.c0x, cy - self.c0y
	for _, l in self.layers do
		if l.e then l.e.position = vec2(l.bx + dx * (1 - l.fx), l.by + dy * (1 - l.fy)) end
	end
end

-- adds every entity tagged parallax_<NN> (NN = percent, e.g. parallax_20) to a Parallax set
function Parallax:addTagged()
	for pct = 0, 100, 5 do
		local tag = "parallax_" .. pct
		for _, e in entitiesTagged(tag) do self:add(e, pct / 100) end
	end
end

return Cam
