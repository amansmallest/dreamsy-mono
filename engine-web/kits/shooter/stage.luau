--!nonstrict
-- Stage scripts (pure): data/stages/<id>.json → a timeline of spawns; the runner releases them as the clock passes.
--[[ stage def:
   { name, mode = "shmup"|"arena", music?, background? "asset:x", bgColor?, scroll = 80 (px/s, shmup),
     width = 720, height = 1280 (arena size; shmup = the screen), next? (stage id), reward = { credits = 40 },
     events = { { t = 2, enemy = "drone", x = 0.5 (0..1 = fraction of width, else px), xs = {0.2, 0.8}?, y = -40,
                  count = 1, gap = 0.4 (s between copies), dx = 0 (x step per copy), path = {...}? (overrides the enemy's),
                  waitClear = false (hold the clock here until no enemies are alive) },
                { t = 30, text = "WARNING" }, { t = 34, boss = "warden" }, { t = 12, pickup = "power", x = 0.5 } },
     waves = { count = 6, budget = 4, growth = 1.3, gap = 0.6, rest = 2, enemies = {"mite", "spitter"}, boss = { id, every = 6 },
               seed = 1 }  -- arena: procgen.waves budgets (enemy `cost`), each wave waits for the previous to be cleared
     spawns = { {x, y}, … }? (arena spawn points; default: the 4 edges) } ]]
local M = {}

local function xOf(x, w)
	if x == nil then return w / 2 end
	if x <= 1 and x >= 0 then return x * w end
	return x
end

-- expand events (+ arena waves) into a sorted list of entries { t, kind = "enemy"|"boss"|"text"|"pickup", id, x, y, path?, waitClear?, wave? }
function M.timeline(def, enemies, procgen)
	local w = def.width or 720
	local h = def.height or 1280
	local out = {}
	local seq = 0
	local function push(e)
		seq += 1
		e.seq = seq
		table.insert(out, e)
	end
	for _, ev in def.events or {} do
		local t = ev.t or 0
		if ev.enemy then
			local xs = ev.xs or { ev.x }
			for _, x0 in xs do
				for c = 0, (ev.count or 1) - 1 do
					push({ t = t + c * (ev.gap or 0.4), kind = "enemy", id = ev.enemy, x = xOf(x0, w) + c * (ev.dx or 0), y = ev.y or -40,
						path = ev.path, waitClear = ev.waitClear and c == 0 })
				end
			end
		elseif ev.boss then
			push({ t = t, kind = "boss", id = ev.boss, x = xOf(ev.x, w), y = ev.y or -120, waitClear = ev.waitClear ~= false })
		elseif ev.text then
			push({ t = t, kind = "text", text = ev.text })
		elseif ev.pickup then
			push({ t = t, kind = "pickup", id = ev.pickup, x = xOf(ev.x, w), y = ev.y or -20 })
		end
	end
	local wv = def.waves
	if wv then
		assert(procgen, "shooter: arena waves need the procgen kit")
		local list = {}
		for _, id in wv.enemies or {} do
			local e = enemies and enemies[id]
			table.insert(list, { id = id, cost = (e and e.cost) or 1, weight = (e and e.weight) or 1, minLevel = e and e.minLevel })
		end
		local waves = procgen.waves.waves(list, { count = wv.count or 6, budget = wv.budget or 4, growth = wv.growth or 1.3,
			add = wv.add, boss = wv.boss, seed = wv.seed or 1, gap = wv.gap or 0.6 })
		local rng = procgen.rng((wv.seed or 1) * 7 + 3)
		local spawns = def.spawns
		local t = (def.events and #def.events > 0) and ((def.events[#def.events].t or 0) + 1) or 1
		for _, wave in waves do
			push({ t = t, kind = "text", text = "Wave " .. wave.wave, waitClear = true, wave = wave.wave })
			for k, id in wave.ids do
				local x, y
				if spawns and #spawns > 0 then
					local s = spawns[rng:int(1, #spawns)]
					x, y = s[1] or s.x, s[2] or s.y
				else
					local side = rng:int(1, 4)
					if side == 1 then x, y = rng:range(40, w - 40), 40
					elseif side == 2 then x, y = rng:range(40, w - 40), h - 40
					elseif side == 3 then x, y = 40, rng:range(40, h - 40)
					else x, y = w - 40, rng:range(40, h - 40) end
				end
				local isBoss = wv.boss and id == wv.boss.id
				push({ t = t + 1 + wave.spawnTimes[k], kind = if isBoss then "boss" else "enemy", id = id, x = x, y = y, wave = wave.wave })
			end
			t += 1 + (wave.spawnTimes[#wave.spawnTimes] or 0) + (wv.rest or 2)
		end
	end
	table.sort(out, function(a, b) if a.t ~= b.t then return a.t < b.t end return a.seq < b.seq end)
	return out
end

--[[ new(def, enemies?, procgen?) -> runner
   r:update(dt, alive) -> entries due this step (alive = enemies currently alive; a waitClear entry holds the clock until 0)
   r.t (stage clock) r.index r.entries r:finished(alive) -> all released and nothing alive   r:progress() 0..1   r.wave ]]
function M.new(def, enemies, procgen)
	local r = { def = def, t = 0, index = 1, entries = M.timeline(def, enemies, procgen), wave = 0, holding = false }
	function r.update(self, dt, alive)
		local due = {}
		local e = self.entries[self.index]
		if e and e.waitClear and self.t >= e.t and (alive or 0) > 0 then
			self.holding = true
			return due
		end
		self.holding = false
		self.t += dt
		while self.index <= #self.entries do
			local n = self.entries[self.index]
			if n.t > self.t then break end
			if n.waitClear and (alive or 0) + #due > 0 then self.t = n.t self.holding = true break end
			if n.wave then self.wave = math.max(self.wave, n.wave) end
			table.insert(due, n)
			self.index += 1
		end
		return due
	end
	function r.finished(self, alive) return self.index > #self.entries and (alive or 0) == 0 end
	function r.progress(self)
		local last = self.entries[#self.entries]
		if not last or last.t <= 0 then return 1 end
		return math.clamp(self.t / last.t, 0, 1)
	end
	function r.length(self) local last = self.entries[#self.entries] return if last then last.t else 0 end
	return r
end

return M
