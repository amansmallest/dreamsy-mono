--!nonstrict
-- Touch-first controls: swipes (left/right/up/down) + tap, with keyboard/gamepad fallbacks.
-- local ctl = controls.new({ swipe = 60 (px), tap = "jump" | false, keys = true, pointer = true (read input.pointer()) })
-- ctl:poll() -> "left" | "right" | "jump" | "slide" | nil   (call once per onTick)
-- ctl:feed(x, y | nil) — pointer sample (tests / custom input); poll() reads input.pointer() itself.
-- Obby: controls.axis() -> move_x (-1..1), controls.jump() -> pressed, held (jump button / tap-and-hold on the right half).
local M = {}

function M.new(opts)
	opts = opts or {}
	local c = { swipe = opts.swipe or 60, tapAction = if opts.tap == false then nil else (opts.tap or "jump"), keys = opts.keys ~= false, pointer = opts.pointer ~= false,
		start = nil, last = nil, fired = false, queue = {}, prevAxis = 0, prevY = 0 }
	function c:feed(x, y)
		if x == nil then
			-- release
			if self.start and not self.fired and self.tapAction then table.insert(self.queue, self.tapAction) end
			self.start, self.last, self.fired = nil, nil, false
			return
		end
		if not self.start then self.start = { x = x, y = y } self.fired = false end
		self.last = { x = x, y = y }
		if not self.fired then
			local dx, dy = x - self.start.x, y - self.start.y
			if math.max(math.abs(dx), math.abs(dy)) >= self.swipe then
				self.fired = true
				if math.abs(dx) > math.abs(dy) then table.insert(self.queue, if dx < 0 then "left" else "right")
				else table.insert(self.queue, if dy < 0 then "jump" else "slide") end
			end
		end
	end
	function c:poll()
		if self.pointer and type(input) == "table" and type(input.pointer) == "function" then
			local p = input.pointer()
			if p then self:feed(p.x, p.y) elseif self.start then self:feed(nil) end
		end
		if self.keys and type(input) == "table" then
			local ax = input.axis("move_x")
			local ay = input.axis("move_y")
			if ax <= -0.5 and self.prevAxis > -0.5 then table.insert(self.queue, "left") end
			if ax >= 0.5 and self.prevAxis < 0.5 then table.insert(self.queue, "right") end
			if ay >= 0.5 and self.prevY < 0.5 then table.insert(self.queue, "slide") end
			if ay <= -0.5 and self.prevY > -0.5 then table.insert(self.queue, "jump") end
			self.prevAxis, self.prevY = ax, ay
			if input.pressed("jump") then table.insert(self.queue, "jump") end
			if input.pressed("action") then table.insert(self.queue, "slide") end
		end
		return table.remove(self.queue, 1)
	end
	return c
end

-- obby helpers: touch = left/right thirds steer, tap/hold the middle or any jump button
function M.axis()
	local ax = if type(input) == "table" then input.axis("move_x") else 0
	return ax
end
function M.jump()
	if type(input) ~= "table" then return false, false end
	return input.pressed("jump"), input.held("jump")
end

return M
