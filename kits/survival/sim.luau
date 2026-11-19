--!nonstrict
-- survival state (pure, headless-testable): clock + day/night, needs, gathering with tool tiers, crafting with
-- stations, building placement on the world grid, temperature, night waves, death/respawn, POIs, save.
local core = require("@kit/core")
local procgen = require("@kit/procgen")
local Content = require("./content")
local World = require("./world")
local Recipes = require("./recipes")

local Sim = {}
Sim.__index = Sim
local DIRS = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }

local function emit(s, name, d)
	if s.quiet then return end
	core.events.emit(name, d or {})
end

-- new(C, opts?) opts: { seed?, bag? (core inventory; default core.bag), rand? fn()->[0,1), world? (pre-generated), quiet? (no core events) }
function Sim.new(C, opts)
	opts = opts or {}
	local s = setmetatable({}, Sim)
	s.C = C
	s.cfg = C.config
	s.seed = opts.seed or C.config.world.seed
	s.world = opts.world or World.generate(C, s.seed)
	s.bag = opts.bag or core.bag
	local r = procgen.rng((s.seed or 1) * 7 + 3)
	s.rand = opts.rand or function() return r:next() end
	s.quiet = opts.quiet
	s:reset()
	return s
end

function Sim:reset()
	local cfg = self.cfg
	self.time = cfg.day.start * cfg.day.length
	self.needs = {}
	for k, n in cfg.needs do self.needs[k] = n.start end
	self.player = { x = self.world.start.x, y = self.world.start.y }
	self.structures, self.structAt = {}, {}
	self.depleted = {}
	self.night = 0
	self.nightActive = self:isNight()
	self.stats = { gathered = 0, crafted = 0, built = 0, deaths = 0, nightsSurvived = 0, found = 0 }
	self.stashes = {}
	self.lowWarned = {}
	self.storages = {}
	self.reached = {}
	self.crafted = {}
	self.builtIds = {}
	for item, n in cfg.start.items or {} do self.bag:add(item, n) end
end

-- ---------- clock ----------
function Sim:dayLength() return self.cfg.day.length end
function Sim:timeOfDay() return (self.time % self.cfg.day.length) / self.cfg.day.length end -- 0 = dawn
function Sim:dayNumber() return math.floor(self.time / self.cfg.day.length) + 1 end
function Sim:isNight() return self:timeOfDay() >= 1 - self.cfg.day.night end
-- phase: "day" | "dusk" (last 10% before night) | "night" | "dawn" (first 6% of the day)
function Sim:phase()
	local t, n = self:timeOfDay(), self.cfg.day.night
	if t >= 1 - n then return "night" end
	if t >= 1 - n - 0.1 then return "dusk" end
	if t < 0.06 then return "dawn" end
	return "day"
end
-- darkness 0..1 for a night overlay (smooth dusk/dawn ramps)
function Sim:darkness()
	local t, n = self:timeOfDay(), self.cfg.day.night
	local ns = 1 - n
	if t >= ns then return math.min(1, (t - ns) / 0.05) end
	if t >= ns - 0.1 then return (t - (ns - 0.1)) / 0.1 * 0.35 end
	if t < 0.06 then return (1 - t / 0.06) * 0.6 end
	return 0
end
-- clock string "Day 2  18:40"
function Sim:clockText()
	local mins = math.floor(((self:timeOfDay() * 24 + 6) % 24) * 60)
	return string.format("Day %d  %02d:%02d", self:dayNumber(), math.floor(mins / 60), mins % 60)
end
function Sim:secondsUntilNight()
	local t, n = self:timeOfDay(), self.cfg.day.night
	if t >= 1 - n then return 0 end
	return (1 - n - t) * self.cfg.day.length
end

-- ---------- world queries ----------
function Sim:idx(x, y) return self.world.idx(x, y) end
function Sim:inside(x, y) return x >= 0 and y >= 0 and x < self.world.w and y < self.world.h end
function Sim:biomeAt(x, y) return self.C.biomeByChar[self.world.grid:get(x, y) or ""] end
function Sim:nodeAt(x, y) local n = self.world.nodeAt[self:idx(x, y)] return if n and n.hp > 0 then n else nil end
function Sim:structureAt(x, y) return self.structAt[self:idx(x, y)] end
function Sim:poiAt(x, y) return self.world.poiAt[self:idx(x, y)] end
-- walkable for the player / enemies (doors: passable unless forEnemies)
function Sim:passable(x, y, forEnemies)
	if not self:inside(x, y) then return false end
	local b = self:biomeAt(x, y)
	if not b or b.walkable == false then
		local st = self:structureAt(x, y)
		return st ~= nil and self.C.structuresById[st.id].kind == "floor"
	end
	local n = self:nodeAt(x, y)
	if n and self.C.nodesById[n.id].solid ~= false then return false end
	local st = self:structureAt(x, y)
	if st then
		local d = self.C.structuresById[st.id]
		if d.kind == "door" then return not forEnemies end
		if d.solid then return false end
	end
	return true
end
-- tile character for a cell (map view): structure > node > poi > biome.
--   layer: nil = everything on one map; "ground" = biome only; "objects" = structure/node/POI or nil (empty)
function Sim:tileChar(x, y, layer)
	if layer == "ground" then return self.world.grid:get(x, y) end
	local st = self:structureAt(x, y)
	if st then return self.C.structuresById[st.id].tile end
	local n = self:nodeAt(x, y)
	if n then return self.C.nodesById[n.id].tile end
	local p = self:poiAt(x, y)
	if p then
		local d = self.C.poisById[p.id]
		return if p.found and d.foundTile then d.foundTile else d.tile
	end
	if layer == "objects" then return nil end
	return self.world.grid:get(x, y)
end
function Sim:tileString(layer)
	local rows = {}
	for y = 0, self.world.h - 1 do
		local row = table.create(self.world.w)
		for x = 0, self.world.w - 1 do row[x + 1] = self:tileChar(x, y, layer) or (if layer == "objects" then "." else "~") end
		rows[y + 1] = table.concat(row)
	end
	return table.concat(rows, "\n")
end
function Sim:setPlayer(x, y) self.player.x, self.player.y = x, y end
function Sim:distance(x, y) return math.max(math.abs(x - self.player.x), math.abs(y - self.player.y)) end

-- ---------- tick: clock, needs, temperature, respawns ----------
function Sim:tick(dt)
	local wasNight = self.nightActive
	self.time += dt
	local night = self:isNight()
	if night ~= wasNight then
		self.nightActive = night
		if night then
			self.night += 1
			local wave = self:nightWave(self.night)
			emit(self, "night_started", { night = self.night, wave = wave })
			if self.onNight then self.onNight(self.night, wave) end
		else
			self.stats.nightsSurvived += 1
			emit(self, "dawn", { night = self.night, day = self:dayNumber() })
			if self.onDawn then self.onDawn(self.night) end
		end
	end
	local N, nd = self.needs, self.cfg.needs
	local m = dt / 60
	local hurt = 0
	for _, k in { "hunger", "thirst" } do
		local def = nd[k]
		N[k] = math.max(0, N[k] - def.decay * m)
		if N[k] <= 0 then hurt += def.damage * m end
		if N[k] <= (def.low or 0) and not self.lowWarned[k] then
			self.lowWarned[k] = true
			emit(self, "need_low", { need = k, value = N[k] })
		elseif N[k] > (def.low or 0) then
			self.lowWarned[k] = nil
		end
	end
	local td = nd.temperature
	local env = self:temperatureAt(self.player.x, self.player.y)
	N.temperature += (env - N.temperature) * math.min(1, td.follow * dt)
	local cold = N.temperature < td.min or N.temperature > td.max
	if cold then hurt += td.damage * m end
	local hd = nd.health
	if hurt > 0 then
		N.health = math.max(0, N.health - hurt)
	elseif N.hunger >= hd.regenAbove and N.thirst >= hd.regenAbove then
		N.health = math.min(hd.max, N.health + hd.regen * m)
	end
	for i = #self.depleted, 1, -1 do
		local n = self.depleted[i]
		if self.time >= n.respawnAt then
			table.remove(self.depleted, i)
			-- don't respawn under a structure or the player
			if self:structureAt(n.x, n.y) == nil and not (n.x == self.player.x and n.y == self.player.y) then
				n.hp = self.C.nodesById[n.id].hp
				n.respawnAt = nil
				emit(self, "node_respawned", { node = n.id, x = n.x, y = n.y })
				if self.onTile then self.onTile(n.x, n.y) end
			else
				n.respawnAt = self.time + 30
				table.insert(self.depleted, n)
			end
		end
	end
	if N.health <= 0 then
		local cause = if N.hunger <= 0 then "hunger" elseif N.thirst <= 0 then "thirst" elseif cold then "cold" else "wounds"
		self:die(cause)
	end
end

-- ---------- needs ----------
function Sim:hurt(n, cause)
	self.needs.health = math.max(0, self.needs.health - n)
	if self.needs.health <= 0 then self:die(cause or "wounds") return true end
	return false
end
-- consume(item) -> ok, reason: item.data.food = { hunger?, thirst?, health?, temperature? }
function Sim:consume(item)
	local f = Content.itemData(self.C, item).food
	if not f then return false, "inedible" end
	if not self.bag:has(item, 1) then return false, "none" end
	self.bag:remove(item, 1)
	local N, nd = self.needs, self.cfg.needs
	for k, v in f do
		if N[k] ~= nil then
			if k == "temperature" then N[k] += v else N[k] = math.clamp(N[k] + v, 0, nd[k].max) end
		end
	end
	emit(self, "consumed", { item = item })
	return true
end
function Sim:warmthAt(x, y)
	local best = 0
	for _, st in self.structures do
		local d = self.C.structuresById[st.id]
		if d.warmth and math.max(math.abs(st.x - x), math.abs(st.y - y)) <= d.radius then best = math.max(best, d.warmth) end
	end
	return best
end
function Sim:temperatureAt(x, y)
	local b = self:biomeAt(x, y)
	local t = (b and b.temp or 20) + self:warmthAt(x, y)
	if self:isNight() then t += self.cfg.day.nightTemp end
	return t
end

-- ---------- tools + gathering ----------
-- bestTool(kind) -> itemId?, toolData: highest tier then power among items in the bag with data.tool.kind == kind
function Sim:bestTool(kind)
	local best, bd = nil, nil
	for _, st in self.bag:list() do
		local t = Content.itemData(self.C, st.id).tool
		if t and t.kind == kind then
			if bd == nil or (t.tier or 1) > (bd.tier or 1) or ((t.tier or 1) == (bd.tier or 1) and (t.power or 1) > (bd.power or 1)) then best, bd = st.id, t end
		end
	end
	return best, bd
end
-- canGather(x, y) -> ok, reason ("none"|"tool"|"tier"), node, power
function Sim:canGather(x, y)
	local n = self:nodeAt(x, y)
	if not n then return false, "none" end
	local def = self.C.nodesById[n.id]
	local power = 1
	if def.tool then
		local id, t = self:bestTool(def.tool)
		if not id then
			if def.tier > 0 then return false, "tool", n end
		else
			if (t.tier or 1) < def.tier then return false, "tier", n end
			power = t.power or 1
		end
	end
	return true, nil, n, power
end
local function rollCount(c, rand)
	if type(c) == "table" then return c[1] + math.floor(rand() * (c[2] - c[1] + 1)) end
	return c or 1
end
-- hit(x, y) -> { ok, reason?, damage, broken, drops = { {item, count} } }
function Sim:hit(x, y)
	local ok, why, n, power = self:canGather(x, y)
	if not ok then return { ok = false, reason = why, damage = 0, broken = false, drops = {} } end
	local def = self.C.nodesById[n.id]
	n.hp -= power
	local res = { ok = true, damage = power, broken = n.hp <= 0, drops = {}, node = n.id }
	if res.broken then
		n.hp = 0
		for _, d in def.drops do
			if d.chance == nil or self.rand() < d.chance then
				local c = rollCount(d.count, self.rand)
				if c > 0 then
					local added = self.bag:add(d.item, c)
					table.insert(res.drops, { item = d.item, count = c, added = added })
					self.stats.gathered += c
					emit(self, "gathered", { item = d.item, count = c, node = n.id })
				end
			end
		end
		if def.respawn and def.respawn > 0 then
			n.respawnAt = self.time + def.respawn
			table.insert(self.depleted, n)
		end
		emit(self, "node_depleted", { node = n.id, x = n.x, y = n.y })
		if self.onTile then self.onTile(n.x, n.y) end
	end
	return res
end
-- gather(x, y) -> result of the breaking hit (+ hits = number of swings); stops at the first failure
function Sim:gather(x, y)
	local hits = 0
	local r
	repeat
		r = self:hit(x, y)
		if r.ok then hits += 1 end
	until not r.ok or r.broken
	r.hits = hits
	return r
end
function Sim:hitsFor(nodeId)
	local def = self.C.nodesById[nodeId]
	local power = 1
	if def.tool then local _, t = self:bestTool(def.tool) if t then power = t.power or 1 end end
	return math.ceil(def.hp / power)
end

-- ---------- crafting ----------
function Sim:stationNear(sid, x, y)
	x, y = x or self.player.x, y or self.player.y
	for _, st in self.structures do
		if st.id == sid then
			local d = self.C.structuresById[sid]
			if math.max(math.abs(st.x - x), math.abs(st.y - y)) <= math.max(1, d.radius) then return true end
		end
	end
	return false
end
-- canCraft(rid) -> ok, reason ("unknown"|"locked"|"station"|"items"|"space"), missing = { {item, need, have} }
function Sim:canCraft(rid)
	local r = self.C.recipesById[rid]
	if not r then return false, "unknown" end
	if r.unlock and not core.check(r.unlock) then return false, "locked" end
	if r.station and not self:stationNear(r.station) then return false, "station" end
	local missing = {}
	for it, n in r.needs do
		local have = self.bag:count(it)
		if have < n then table.insert(missing, { item = it, need = n, have = have }) end
	end
	if #missing > 0 then
		table.sort(missing, function(a, b) return a.item < b.item end)
		return false, "items", missing
	end
	if self.bag:canAdd(r.gives, r.count) < r.count then return false, "space" end
	return true
end
function Sim:craft(rid)
	local ok, why, missing = self:canCraft(rid)
	if not ok then return false, why, missing end
	local r = self.C.recipesById[rid]
	for it, n in r.needs do self.bag:remove(it, n) end
	self.bag:add(r.gives, r.count)
	self.stats.crafted += 1
	self.crafted[rid] = true
	emit(self, "crafted", { recipe = rid, item = r.gives, count = r.count })
	return true
end
-- recipeList(category?) -> { {id, def, state = "ready"|"station"|"items"|"locked"|"space", missing} } in tree order
function Sim:recipeList(category)
	self._tree = self._tree or Recipes.analyze(self.C)
	local out = {}
	local function push(rid)
		local r = self.C.recipesById[rid]
		if category == nil or r.category == category then
			local ok, why, missing = self:canCraft(rid)
			table.insert(out, { id = rid, def = r, state = if ok then "ready" else why, missing = missing, depth = self._tree.recipeDepth[rid] or 99 })
		end
	end
	local seen = {}
	for _, rid in self._tree.order do push(rid) seen[rid] = true end
	for _, r in self.C.recipes do if not seen[r.id] then push(r.id) end end
	return out
end

-- ---------- building ----------
function Sim:placerItem(sid) return Recipes.placer(self.C, sid) end
function Sim:count(sid)
	local n = 0
	for _, st in self.structures do if st.id == sid then n += 1 end end
	return n
end
-- canPlace(sid, x, y, opts?) -> ok, reason: "unknown"|"bounds"|"terrain"|"biome"|"occupied"|"player"|"limit"|"adjacent"|"item"|"reach"
--   opts: { free = true (no item needed), reach = cells (max distance from the player) }
function Sim:canPlace(sid, x, y, opts)
	opts = opts or {}
	local d = self.C.structuresById[sid]
	if not d then return false, "unknown" end
	if not self:inside(x, y) then return false, "bounds" end
	local b = self:biomeAt(x, y)
	if d.kind == "floor" then
		if b and b.walkable ~= false then return false, "terrain" end
	elseif not b or b.walkable == false then
		return false, "terrain"
	end
	if d.biomes and (b == nil or table.find(d.biomes, b.id) == nil) then return false, "biome" end
	if self:nodeAt(x, y) or self:structureAt(x, y) or self:poiAt(x, y) then return false, "occupied" end
	if (d.solid or d.kind == "station") and x == self.player.x and y == self.player.y then return false, "player" end
	if d.limit and self:count(sid) >= d.limit then return false, "limit" end
	if d.adjacent then
		local ok = false
		for _, dir in DIRS do
			local o = self:structureAt(x + dir[1], y + dir[2])
			if o and (o.id == d.adjacent or self.C.structuresById[o.id].kind == d.adjacent) then ok = true break end
		end
		if not ok then return false, "adjacent" end
	end
	if opts.reach and self:distance(x, y) > opts.reach then return false, "reach" end
	if not opts.free then
		local item = self:placerItem(sid)
		if not item or not self.bag:has(item, 1) then return false, "item" end
	end
	return true
end
function Sim:place(sid, x, y, opts)
	local ok, why = self:canPlace(sid, x, y, opts)
	if not ok then return nil, why end
	if not (opts and opts.free) then self.bag:remove(self:placerItem(sid), 1) end
	local d = self.C.structuresById[sid]
	local st = { id = sid, x = x, y = y, hp = d.hp, idx = self:idx(x, y) }
	table.insert(self.structures, st)
	self.structAt[st.idx] = st
	self.stats.built += 1
	self.builtIds[sid] = true
	emit(self, "built", { structure = sid, x = x, y = y })
	if self.onTile then self.onTile(x, y) end
	return st
end
-- removeStructure(x, y, refund? = true) -> structure?
function Sim:removeStructure(x, y, refund)
	local st = self:structureAt(x, y)
	if not st then return nil end
	self.structAt[st.idx] = nil
	table.remove(self.structures, table.find(self.structures, st))
	if refund ~= false then
		local item = self:placerItem(st.id)
		if item then self.bag:add(item, 1) end
	end
	if self.onTile then self.onTile(x, y) end
	return st
end
-- damageStructure(x, y, n) -> destroyed: boolean
function Sim:damageStructure(x, y, n)
	local st = self:structureAt(x, y)
	if not st then return false end
	st.hp -= n
	if st.hp <= 0 then
		self:removeStructure(x, y, false)
		emit(self, "structure_destroyed", { structure = st.id, x = x, y = y })
		return true
	end
	return false
end
-- storage(x, y) -> core inventory for a storage structure (slots from def.slots), saved in the survival section
function Sim:storage(x, y)
	local st = self:structureAt(x, y)
	if not st or self.C.structuresById[st.id].kind ~= "storage" then return nil end
	local key = st.x .. "," .. st.y
	if not self.storages[key] then
		local inv = core.inventory.new({ id = "surv_store_" .. key .. "_" .. tostring(self.seed), slots = self.C.structuresById[st.id].slots or 12, strict = false })
		inv.saved = false
		self.storages[key] = inv
	end
	return self.storages[key]
end
-- base(): centre of the base = first bed, else first fire/station, else the player
function Sim:base()
	for _, kind in { "bed", "fire", "station" } do
		for _, st in self.structures do
			if self.C.structuresById[st.id].kind == kind then return { x = st.x, y = st.y } end
		end
	end
	return { x = self.player.x, y = self.player.y }
end

-- ---------- nights ----------
-- nightDef(n): exact data/nights entry for night n, else the last one scaled by config.nightGrowth per extra night
function Sim:nightDef(n)
	local last = nil
	for _, d in self.C.nights do
		if d.night == n then return d end
		if d.night <= n then last = d end
	end
	if not last then return { night = n, budget = 2 * n, enemies = nil } end
	local d = table.clone(last)
	d.budget = math.floor(last.budget * self.cfg.nightGrowth ^ (n - last.night) + 0.5)
	d.night = n
	return d
end
-- nightWave(n) -> { night, ids = {enemyId…}, spawns = { {id, x, y, delay} } (cells), boss? }
function Sim:nightWave(n)
	local def = self:nightDef(n)
	local pool = {}
	for _, e in self.C.enemies do
		if def.enemies == nil or table.find(def.enemies, e.id) then table.insert(pool, { id = e.id, cost = e.cost, weight = e.weight or 1, minLevel = e.minLevel, maxLevel = e.maxLevel }) end
	end
	local rng = procgen.rng((self.seed or 1) * 1000 + n)
	local ids = {}
	if #pool > 0 then ids = procgen.waves.encounter(pool, def.budget, rng, { level = n, maxCount = def.maxCount or 16 }).ids end
	if def.boss then table.insert(ids, def.boss) end
	local base = self:base()
	local minD, maxD = def.minDist or 7, (def.minDist or 7) + 6
	local cand = {}
	for y = 0, self.world.h - 1 do
		for x = 0, self.world.w - 1 do
			local d = math.max(math.abs(x - base.x), math.abs(y - base.y))
			if d >= minD and d <= maxD and self:passable(x, y, true) then table.insert(cand, { x = x, y = y }) end
		end
	end
	rng:shuffle(cand)
	local spawns = {}
	local every = def.spawnEvery or 2
	for i, id in ids do
		local c = cand[((i - 1) % math.max(1, #cand)) + 1]
		if c then table.insert(spawns, { id = id, x = c.x, y = c.y, delay = (i - 1) * every }) end
	end
	return { night = n, ids = ids, spawns = spawns, def = def }
end

-- ---------- death / respawn ----------
-- die(cause) -> stash { x, y, items = { {item, count} } }, respawnCell
function Sim:die(cause)
	local de = self.cfg.death
	self.stats.deaths += 1
	local stash = { x = self.player.x, y = self.player.y, items = {} }
	if de.drop ~= "none" then
		for _, st in self.bag:list() do
			local data = Content.itemData(self.C, st.id)
			if not (de.keepTools and (data.tool or data.weapon)) then
				local n = if de.drop == "all" then st.count else math.floor(st.count / 2)
				if n > 0 then
					self.bag:remove(st.id, n)
					table.insert(stash.items, { item = st.id, count = n })
				end
			end
		end
	end
	if #stash.items > 0 then table.insert(self.stashes, stash) end
	local at = { x = self.world.start.x, y = self.world.start.y }
	if de.respawn == "bed" then
		for _, st in self.structures do
			if self.C.structuresById[st.id].kind == "bed" then at = { x = st.x, y = st.y } break end
		end
	end
	self.player.x, self.player.y = at.x, at.y
	local nd = self.cfg.needs
	for k, v in de.restore do if self.needs[k] ~= nil then self.needs[k] = math.max(self.needs[k], math.min(v, nd[k].max or v)) end end
	self.needs.temperature = self:temperatureAt(at.x, at.y)
	emit(self, "player_died", { cause = cause, stash = stash, x = at.x, y = at.y })
	if self.onDeath then self.onDeath(cause, stash, at) end
	return stash, at
end
-- collectStash(x, y) -> items recovered (stash within 1 cell)
function Sim:collectStash(x, y)
	for i, st in self.stashes do
		if math.max(math.abs(st.x - x), math.abs(st.y - y)) <= 1 then
			table.remove(self.stashes, i)
			for _, it in st.items do self.bag:add(it.item, it.count) end
			emit(self, "stash_recovered", { count = #st.items })
			return st.items
		end
	end
	return nil
end

-- ---------- POIs ----------
-- discover(x, y) -> loot list (nil if none / already found). def: { loot = { {item, count} }, effects? (core), message? }
function Sim:discover(x, y)
	local p = self:poiAt(x, y)
	if not p or p.found then return nil end
	p.found = true
	local d = self.C.poisById[p.id]
	local loot = {}
	for _, l in d.loot or {} do
		if l.chance == nil or self.rand() < l.chance then
			local c = rollCount(l.count, self.rand)
			self.bag:add(l.item, c)
			table.insert(loot, { item = l.item, count = c })
		end
	end
	if d.effects then core.apply(d.effects) end
	self.stats.found += 1
	emit(self, "poi_found", { poi = p.id, x = x, y = y })
	if self.onTile then self.onTile(x, y) end
	return loot
end

-- ---------- milestones (config.milestones: { id, label?, item?|structure?|recipe?|night?, count? }) ----------
function Sim:milestoneDone(m)
	if self.reached[m.id] then return true end
	local ok = false
	if m.item then ok = self.bag:count(m.item) >= (m.count or 1)
	elseif m.structure then ok = self.builtIds[m.structure] == true
	elseif m.recipe then ok = self.crafted[m.recipe] == true
	elseif m.night then ok = self.stats.nightsSurvived >= m.night end
	if ok then
		self.reached[m.id] = true
		emit(self, "milestone_reached", { milestone = m.id })
	end
	return ok
end
-- nextMilestone() -> milestone def (first not yet reached, in order) | nil when all done; also marks reached ones
function Sim:nextMilestone()
	for _, m in self.cfg.milestones do
		if not self:milestoneDone(m) then return m end
	end
	return nil
end

-- ---------- save ----------
function Sim:serialize()
	local nodes = {}
	for _, n in self.world.nodes do
		if n.hp ~= self.C.nodesById[n.id].hp then nodes[tostring(n.idx)] = { n.hp, n.respawnAt } end
	end
	local sts = {}
	for _, st in self.structures do
		local store = nil
		local inv = self.storages[st.x .. "," .. st.y]
		if inv then store = inv:serialize() end
		table.insert(sts, { st.id, st.x, st.y, st.hp, store })
	end
	local pois = {}
	for _, p in self.world.pois do if p.found then table.insert(pois, p.idx) end end
	return { v = 1, seed = self.seed, time = self.time, needs = table.clone(self.needs), player = { self.player.x, self.player.y },
		nodes = nodes, structures = sts, pois = pois, night = self.night, stats = table.clone(self.stats), stashes = self.stashes,
		reached = table.clone(self.reached), crafted = table.clone(self.crafted), builtIds = table.clone(self.builtIds) }
end
function Sim:deserialize(t)
	if not t then return end
	if t.seed ~= self.seed then
		self.seed = t.seed
		self.world = World.generate(self.C, t.seed)
	end
	self.time = t.time or self.time
	for k, v in t.needs or {} do self.needs[k] = v end
	if t.player then self.player = { x = t.player[1], y = t.player[2] } end
	self.depleted = {}
	for _, n in self.world.nodes do
		local e = t.nodes and t.nodes[tostring(n.idx)]
		if e then
			n.hp, n.respawnAt = e[1], e[2]
			if n.respawnAt then table.insert(self.depleted, n) end
		else
			n.hp = self.C.nodesById[n.id].hp
		end
	end
	self.structures, self.structAt, self.storages = {}, {}, {}
	for _, e in t.structures or {} do
		local st = { id = e[1], x = e[2], y = e[3], hp = e[4], idx = self:idx(e[2], e[3]) }
		table.insert(self.structures, st)
		self.structAt[st.idx] = st
		if e[5] then local inv = self:storage(st.x, st.y) if inv then inv:deserialize(e[5]) end end
	end
	for _, p in self.world.pois do p.found = table.find(t.pois or {}, p.idx) ~= nil end
	self.night = t.night or 0
	self.nightActive = self:isNight()
	for k, v in t.stats or {} do self.stats[k] = v end
	self.stashes = t.stashes or {}
	self.reached = t.reached or {}
	self.crafted = t.crafted or {}
	self.builtIds = t.builtIds or {}
end

return Sim
