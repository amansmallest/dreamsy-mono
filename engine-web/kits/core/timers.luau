--!nonstrict
-- Timers and cooldowns on the gameplay clock (pause.clock(): stops while core.pause is active).
local Pause = require("./pause")
local M = {}

-- cooldown(seconds) -> { ready(), use() -> boolean, remaining(), progress() 0..1, reset(), set(seconds) }
function M.cooldown(seconds: number)
	local cd = { duration = seconds, last = -math.huge }
	function cd.ready() return Pause.clock() - cd.last >= cd.duration end
	function cd.use()
		if not cd.ready() then return false end
		cd.last = Pause.clock()
		return true
	end
	function cd.remaining() return math.max(0, cd.duration - (Pause.clock() - cd.last)) end
	function cd.progress() return if cd.duration <= 0 then 1 else math.clamp((Pause.clock() - cd.last) / cd.duration, 0, 1) end
	function cd.reset() cd.last = -math.huge end
	function cd.set(s) cd.duration = s end
	return cd
end

local function poll(fn)
	-- 30 Hz polling owned by the calling script (dies with its scene like engine timers)
	return every(1 / 30, fn)
end

-- after(seconds, fn): pausable one-shot. Returns { cancel(), remaining() }
function M.after(seconds: number, fn)
	local due = Pause.clock() + seconds
	local h = { cancelled = false }
	local t
	t = poll(function()
		if h.cancelled then t:cancel() return end
		if Pause.clock() >= due then
			t:cancel()
			h.cancelled = true
			fn()
		end
	end)
	function h.cancel() h.cancelled = true t:cancel() end
	function h.remaining() return math.max(0, due - Pause.clock()) end
	return h
end

-- every(seconds, fn): pausable repeat. Returns { cancel() }
function M.every(seconds: number, fn)
	local nextAt = Pause.clock() + seconds
	local h = {}
	local t = poll(function()
		local c = Pause.clock()
		while c >= nextAt do
			nextAt += seconds
			fn()
		end
	end)
	function h.cancel() t:cancel() end
	return h
end

-- countdown(seconds, onDone, onTick?) -> { remaining(), cancel(), add(seconds) }; onTick(remaining) each poll
function M.countdown(seconds: number, onDone, onTick)
	local due = Pause.clock() + seconds
	local h = {}
	local t
	t = poll(function()
		local r = math.max(0, due - Pause.clock())
		if onTick then onTick(r) end
		if r <= 0 then t:cancel() if onDone then onDone() end end
	end)
	function h.remaining() return math.max(0, due - Pause.clock()) end
	function h.cancel() t:cancel() end
	function h.add(s) due += s end
	return h
end

-- stopwatch() -> { elapsed(), reset() } on the gameplay clock
function M.stopwatch()
	local start = Pause.clock()
	return { elapsed = function() return Pause.clock() - start end, reset = function() start = Pause.clock() end }
end

M.clock = Pause.clock
return M
