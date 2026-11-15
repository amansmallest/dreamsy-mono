--!nonstrict
-- Ghosts: record a run as compact samples (x, y, heading) and replay with interpolation. Best per track in save.
local U = require("./util")
local M = {}

-- recorder(interval = 0.1) -> rec: rec:add(t, car)  rec:finish(time) -> ghost { i, t, d = {x,y,a*100,...} }
function M.recorder(interval: number?)
	local rec = { i = interval or 0.1, d = {}, next = 0 }
	function rec:add(t: number, car)
		if t + 1e-9 < self.next then return end
		self.next = t + self.i
		table.insert(self.d, math.floor(car.x + 0.5))
		table.insert(self.d, math.floor(car.y + 0.5))
		table.insert(self.d, math.floor(car.a * 100 + 0.5))
	end
	function rec:finish(time: number, meta)
		return { i = self.i, t = time, d = self.d, car = meta and meta.car, v = 1 }
	end
	return rec
end

-- at(ghost, t) -> x, y, a (nil past the end)
function M.at(g, t: number)
	if not g or not g.d or #g.d < 3 then return nil end
	local n = #g.d // 3
	local f = t / g.i
	local k = math.floor(f)
	if k >= n - 1 then
		if k > n then return nil end
		local j = (n - 1) * 3
		return g.d[j + 1], g.d[j + 2], g.d[j + 3] / 100
	end
	local u = f - k
	local j = k * 3
	return U.lerp(g.d[j + 1], g.d[j + 4], u), U.lerp(g.d[j + 2], g.d[j + 5], u), U.lerpAngle(g.d[j + 3] / 100, g.d[j + 6] / 100, u)
end

local function key(trackId, slot) return "racing_ghost_" .. trackId .. (if slot then "_" .. slot else "") end
-- best(trackId) -> ghost?;  submit(trackId, ghost) -> true when it beat the stored one (and was saved)
function M.best(trackId: string, slot: string?) return if save then save.get(key(trackId, slot)) else nil end
function M.submit(trackId: string, g, slot: string?): boolean
	local old = M.best(trackId, slot)
	if old and old.t <= g.t then return false end
	if save then save.set(key(trackId, slot), g) end
	return true
end
function M.clear(trackId: string, slot: string?) if save then save.remove(key(trackId, slot)) end end
return M
