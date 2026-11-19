-- platformer kit: small shared helpers (events, math, tables, sound).
local juice = require("@kit/juice")
local U = {}

-- ---------- events ----------
-- An event bus: bus:on(name, fn) -> connection, bus:emit(name, ...), bus:clear().
-- (Not core.events.new(): level/progress events pass several args, core buses pass one data table.)
local BusM = {}
BusM.__index = BusM

function U.bus()
	return setmetatable({ handlers = {} }, BusM)
end

function BusM:on(name: string, fn)
	if type(fn) ~= "function" then error("on(\"" .. tostring(name) .. "\", fn): fn must be a function", 2) end
	local list = self.handlers[name]
	if not list then
		list = {}
		self.handlers[name] = list
	end
	local rec = { fn = fn, live = true }
	table.insert(list, rec)
	return {
		disconnect = function()
			rec.live = false
		end,
	}
end

function BusM:emit(name: string, ...)
	local list = self.handlers[name]
	if not list then return end
	for _, rec in list do
		if rec.live then rec.fn(...) end
	end
end

function BusM:clear()
	self.handlers = {}
end

-- ---------- math ----------
function U.approach(v: number, target: number, step: number): number
	if v < target then return math.min(v + step, target) end
	return math.max(v - step, target)
end

function U.sign(v: number): number
	if v > 0 then return 1 elseif v < 0 then return -1 end
	return 0
end

function U.clamp(v: number, lo: number, hi: number): number
	if v < lo then return lo elseif v > hi then return hi end
	return v
end

-- centered boxes: a.x, a.y = center; a.w, a.h = size
function U.overlap(a, b, shrink: number?): boolean
	local s = shrink or 0
	return math.abs(a.x - b.x) < (a.w + b.w) / 2 - s and math.abs(a.y - b.y) < (a.h + b.h) / 2 - s
end

function U.dist(ax: number, ay: number, bx: number, by: number): number
	local dx, dy = ax - bx, ay - by
	return math.sqrt(dx * dx + dy * dy)
end

-- ---------- tables ----------
function U.copy(t)
	if type(t) ~= "table" or getmetatable(t) ~= nil then return t end
	local o = {}
	for k, v in t do o[k] = U.copy(v) end
	return o
end

-- defaults <- overrides (deep for plain tables)
function U.merge(defaults, overrides)
	local o = U.copy(defaults or {})
	if overrides then
		for k, v in overrides do
			if type(v) == "table" and getmetatable(v) == nil and type(o[k]) == "table" and #v == 0 and next(v) ~= nil then
				o[k] = U.merge(o[k], v)
			else
				o[k] = U.copy(v)
			end
		end
	end
	return o
end

function U.count(t): number
	local n = 0
	for _ in t do n += 1 end
	return n
end

-- ---------- sound ----------
-- Plays a configured sfx id through juice.sfx; missing/unset ids are ignored (kits never hard-fail on audio).
function U.play(sounds, key: string, opts)
	local id = sounds and sounds[key]
	if type(id) == "string" and id ~= "" then juice.sfx(id, opts) end
end

-- "1:05.3" style time
function U.formatTime(t: number?): string
	if t == nil then return "--:--" end
	local m = math.floor(t / 60)
	local s = t - m * 60
	return string.format("%d:%04.1f", m, s)
end

return U
