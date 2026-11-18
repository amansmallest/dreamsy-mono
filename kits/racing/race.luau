--!nonstrict
-- Race = cars on a track: countdown, ordered checkpoint gates, laps/splits/best, positions, finish, elimination,
-- car-car bumps, dropped hazards. Pure sim: step(dt, inputs) and read events. See KIT.md "Race".
local U = require("./util")
local Car = require("./car")
local M = {}
local R = {}
R.__index = R

-- new(track, opts) opts: { laps? (track.laps), mode = "race"|"time_trial"|"elimination", countdown = 3, onEvent?(name, data),
--   bumps = true, items? = { "nitro", "oil" } (tile tag "item" gives one) }
function M.new(track, opts)
	opts = opts or {}
	return setmetatable({
		track = track, laps = opts.laps or track.laps or 3, mode = opts.mode or "race", countdown = opts.countdown or 3,
		cd = opts.countdown or 3, t = 0, phase = if (opts.countdown or 3) > 0 then "countdown" else "racing",
		racers = {}, byId = {}, finishedCount = 0, oils = {}, onEvent = opts.onEvent, events = {},
		bumps = opts.bumps ~= false, items = opts.items or { "nitro", "oil" }, done = false, player = nil, rng = opts.rng or math.random,
	}, R)
end

function R:emit(name, d)
	d = d or {}
	table.insert(self.events, { name = name, data = d })
	if self.onEvent then self.onEvent(name, d) end
end

-- add(id, car, { name?, player?, driver? (racing driver), color? }) -> racer
function R:add(id: string, car, o)
	o = o or {}
	local tr = self.track
	local seg, s = tr:closest(car.x, car.y)
	local rel = (s - tr.startS0) % tr.length
	if rel > tr.length / 2 then rel -= tr.length end
	local r = {
		id = id, name = o.name or id, car = car, player = o.player == true, driver = o.driver, data = o.data,
		seg = seg, s = s, lat = 0, prog = rel, lap = 0, nextGate = if #tr.gates > 1 then 2 else 1, gatesThisLap = 0,
		lapStart = 0, lapTimes = {}, best = nil, splits = {}, bestSplits = nil, finished = false, out = false,
		time = nil, place = 0, item = nil, wrongWay = 0,
	}
	car.id = id
	table.insert(self.racers, r)
	self.byId[id] = r
	if r.player then self.player = r end
	return r
end

-- progress used for ranking: clamped so missed checkpoints never count
function R:rankProg(r): number
	local tr = self.track
	local ng = tr.gates[r.nextGate]
	local cap = if r.nextGate == 1 then (r.lap + 1) * tr.length else r.lap * tr.length + ng.rel
	return math.min(r.prog, cap + tr.ts)
end

local function rankKey(self, r)
	if r.finished then return 1e12 - r.time end
	if r.out then return -1e12 + r.prog end
	return self:rankProg(r)
end
-- order() -> racers sorted 1st..last;  positionOf(id) -> place
function R:order()
	local list = table.clone(self.racers)
	table.sort(list, function(a, b) return rankKey(self, a) > rankKey(self, b) end)
	return list
end
function R:positionOf(id: string): number
	for i, r in self:order() do if r.id == id then return i end end
	return 0
end
function R:leader() return self:order()[1] end

function R:dropOil(x: number, y: number, ttl: number?)
	table.insert(self.oils, { x = x, y = y, ttl = ttl or 20, r = 26 })
	self:emit("oil_dropped", { x = x, y = y })
end

function R:_gates(r, px, py)
	local tr, c = self.track, r.car
	local mx, my = c.x - px, c.y - py
	for gi, g in tr.gates do
		if U.segX(px, py, c.x, c.y, g.ax, g.ay, g.bx, g.by) and mx * g.tx + my * g.ty > 0 then
			if gi == r.nextGate then
				if gi == 1 then
					self:_lap(r)
				else
					r.gatesThisLap += 1
					local split = self.t - r.lapStart
					r.splits[gi - 1] = split
					local ref = r.bestSplits and r.bestSplits[gi - 1]
					self:emit("checkpoint", { id = r.id, gate = gi, split = split, delta = if ref then split - ref else nil })
					r.nextGate = if gi == #tr.gates then 1 else gi + 1
				end
			elseif gi == 1 and not (r.lap == 0 and r.gatesThisLap == 0) then
				r.missed = (r.missed or 0) + 1
				self:emit("missed", { id = r.id, gate = r.nextGate })
			end
		end
	end
end

function R:_lap(r)
	local lt = self.t - r.lapStart
	r.lap += 1
	table.insert(r.lapTimes, lt)
	local newBest = r.best == nil or lt < r.best
	if newBest then r.best = lt r.bestSplits = r.splits end
	r.splits = {}
	r.lapStart = self.t
	r.gatesThisLap = 0
	r.nextGate = if #self.track.gates > 1 then 2 else 1
	self:emit("lap", { id = r.id, lap = r.lap, time = lt, best = newBest })
	if r.lap >= self.laps and not r.out then
		r.finished = true
		r.time = self.t
		self.finishedCount += 1
		r.place = self.finishedCount
		self:emit("finish", { id = r.id, place = r.place, time = r.time, best = r.best })
	elseif self.mode == "elimination" then
		-- the first racer to complete lap k knocks out the current last place
		self.elimLap = self.elimLap or 0
		if r.lap > self.elimLap then
			self.elimLap = r.lap
			local order = self:order()
			for i = #order, 1, -1 do
				local o = order[i]
				if not o.out and not o.finished and o ~= r then
					o.out = true
					o.time = nil
					self:emit("eliminated", { id = o.id, place = i })
					break
				end
			end
		end
	end
end

-- step(dt, inputs? = { [id] = {steer, throttle, brake, nitro, item} }) — racers with a driver steer themselves
function R:step(dt: number, inputs)
	self.events = {}
	if self.done then return self.events end
	if self.phase == "countdown" then
		local before = math.ceil(self.cd)
		self.cd -= dt
		if math.ceil(self.cd) ~= before and self.cd > 0 then self:emit("countdown", { n = math.ceil(self.cd) }) end
		if self.cd <= 0 then
			self.phase = "racing"
			self.t = 0
			self:emit("go")
		end
		return self.events
	end
	self.t += dt
	local tr = self.track
	for _, r in self.racers do
		local c = r.car
		if r.out then
			c.vx *= 0.9 c.vy *= 0.9
			continue
		end
		local inp = inputs and inputs[r.id]
		if r.finished and not inp then
			inp = if r.driver then r.driver:input(r, self, dt) else { throttle = 0.3 }
		elseif not inp and r.driver then
			inp = r.driver:input(r, self, dt)
		end
		inp = inp or {}
		local px, py = c.x, c.y
		local ev = c:step(dt, inp, tr)
		if ev then for _, e in ev do self:emit(e.name, { id = r.id, v = e.v }) end end
		-- items: tile tag "item" grants one; input.item uses it
		if not r.item and c.air <= 0 and tr:surface(c.x, c.y).item then
			r.item = self.items[math.floor(self.rng() * #self.items) + 1]
			self:emit("item", { id = r.id, item = r.item })
		end
		if inp.item and r.item then
			if r.item == "nitro" then c.nitro = 1
			elseif r.item == "oil" then
				local fx, fy = U.fwd(c.a)
				self:dropOil(c.x - fx * 40, c.y - fy * 40)
			end
			self:emit("item_used", { id = r.id, item = r.item })
			r.item = nil
		end
		for _, o in self.oils do
			if c.spin <= 0 and c.hitT <= 0 and c.air <= 0 and U.len(c.x - o.x, c.y - o.y) < o.r + c.stats.radius * 0.5 then
				c.spin = c.stats.oilSpin
				c.hitT = c.stats.oilSpin + 0.6
				self:emit("oil", { id = r.id })
			end
		end
		-- track position + gates
		local seg, s, lat = tr:closest(c.x, c.y, r.seg)
		local ds = s - r.s
		if tr.loop then
			if ds > tr.length / 2 then ds -= tr.length elseif ds < -tr.length / 2 then ds += tr.length end
		end
		r.prog += ds
		r.seg, r.s, r.lat = seg, s, lat
		local fx, fy = U.fwd(c.a)
		local _, _, tx, ty = tr:pointAt(s)
		r.wrongWay = if fx * tx + fy * ty < -0.3 and c:speed() > 60 then r.wrongWay + dt else 0
		if not r.finished then self:_gates(r, px, py) end
	end
	for i = #self.oils, 1, -1 do
		local o = self.oils[i]
		o.ttl -= dt
		if o.ttl <= 0 then table.remove(self.oils, i) end
	end
	if self.bumps then
		local rs = self.racers
		for i = 1, #rs do
			for j = i + 1, #rs do
				if not rs[i].out and not rs[j].out then
					local hit = Car.collide(rs[i].car, rs[j].car)
					if hit and hit > 50 then self:emit("bump", { a = rs[i].id, b = rs[j].id, v = hit }) end
				end
			end
		end
	end
	-- done: everyone finished/out (time trial: the player finished)
	local active = 0
	for _, r in self.racers do if not r.finished and not r.out then active += 1 end end
	if active == 0 or (self.mode == "elimination" and active <= 1 and self.finishedCount == 0 and #self.racers > 1) then
		if self.mode == "elimination" then
			for _, r in self.racers do
				if not r.out and not r.finished then
					r.finished = true r.time = self.t self.finishedCount += 1 r.place = self.finishedCount
					self:emit("finish", { id = r.id, place = r.place, time = r.time, best = r.best })
				end
			end
		end
		self.done = true
		self:emit("done", {})
	end
	return self.events
end

-- finishAll(): estimate finish times for racers still running (call once the player is done to end at once)
function R:finishAll()
	local tr = self.track
	for _, r in self:order() do
		if not r.finished and not r.out then
			local left = self.laps * tr.length - r.prog
			local avg = math.max(60, r.prog / math.max(self.t, 0.1))
			r.finished = true
			r.time = self.t + math.max(0, left) / avg
			r.estimated = true
		end
	end
	local list = table.clone(self.racers)
	table.sort(list, function(a, b)
		if a.out ~= b.out then return not a.out end
		return (a.time or math.huge) < (b.time or math.huge)
	end)
	for i, r in list do r.place = i end
	self.finishedCount = #list
	self.done = true
end

-- results() -> { {id, name, place, time, best, out, player, estimated} } sorted by place
function R:results()
	local out = {}
	for i, r in self:order() do
		table.insert(out, { id = r.id, name = r.name, place = if r.finished and r.place > 0 then r.place else i, time = r.time,
			best = r.best, out = r.out, player = r.player, estimated = r.estimated, lapTimes = r.lapTimes })
	end
	table.sort(out, function(a, b) return a.place < b.place end)
	return out
end

return M
