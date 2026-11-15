--!nonstrict
-- Headless balance: lap times per AI preset vs a reference bot on a track (no rubber band, solo cars).
local Car = require("./car")
local Race = require("./race")
local Driver = require("./driver")
local M = {}

-- laps(track, carStats, preset | driverOpts, { laps = 2, dt = 1/30, maxTime = 400 }) -> { laps = {t...}, best, total, finished, time, walls, offroad (s) }
function M.laps(track, stats, preset, o)
	o = o or {}
	local race = Race.new(track, { laps = o.laps or 2, countdown = 0, bumps = false })
	local x, y, a = track:gridSlot(1)
	local car = Car.new(stats, x, y, a, { nitro = 0.5 })
	local drv = Driver.new(if type(preset) == "table" then preset else { preset = preset, rubber = false })
	drv.rubberOn = false
	local r = race:add("bot", car, { driver = drv })
	local dt, maxT = o.dt or 1 / 30, o.maxTime or 400
	local walls, off = 0, 0
	while not race.done and race.t < maxT do
		for _, e in race:step(dt) do if e.name == "wall" then walls += 1 end end
		if car.offroad then off += dt end
	end
	return { laps = r.lapTimes, best = r.best, total = r.time, finished = r.finished, time = race.t, walls = walls, offroad = off, missed = r.missed or 0 }
end

-- report(track, stats, { presets = {"easy","normal","hard","expert"}, laps = 2 }) -> { reference = res, [preset] = res + ratio }
function M.report(track, stats, o)
	o = o or {}
	local out = { reference = M.laps(track, stats, "reference", o) }
	local ref = out.reference.best
	for _, p in o.presets or { "easy", "normal", "hard", "expert" } do
		local r = M.laps(track, stats, p, o)
		r.ratio = if r.best and ref then r.best / ref else nil
		out[p] = r
	end
	return out
end
return M
