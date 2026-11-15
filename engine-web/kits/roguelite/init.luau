--!nonstrict
-- roguelite kit: run structure (biomes/floors/rooms from data), relics + synergies, actives, classes, meta tree,
-- heat, daily seeds, mid-run save, run summary, balance sim. A thin layer over core / progression / procgen /
-- combat / ai / juice: content in data/<kind>/*.json, stats via progression mods, effects via core effects,
-- floors via procgen, fights via combat + ai. See KIT.md.
local S = require("./state")
local Run = require("./run")
local Relics = require("./relics")
local Meta = require("./meta")
local R = { VERSION = "0.1.0" }

R.Run = Run
R.relics = Relics
R.meta = Meta
R.config = S.config
R.state = S
R.run = nil -- live run (also S.current)

local function liveRun(ctx) return (ctx and ctx.run) or S.current end

---------------------------------------------------------------- effect + condition kinds (core data language)
S.effectKinds = {
	heal = function(e, ctx) local r = liveRun(ctx) if r then r:heal(e.heal) end end,
	healPct = function(e, ctx) local r = liveRun(ctx) if r then r:heal(math.ceil(r:maxHp() * e.healPct)) end end,
	maxHp = function(e, ctx)
		local r = liveRun(ctx)
		if r then table.insert(r.metaMods, { stat = "hp", add = e.maxHp }) r:dirty() r.hp = math.max(1, r.hp + e.maxHp) r.hp = math.min(r.hp, r:maxHp()) r:syncFighter() end
	end,
	gold = function(e, ctx) local r = liveRun(ctx) if r then r:addGold(e.gold, e.raw) end end,
	charge = function(e, ctx) local r = liveRun(ctx) if r then r:addCharge(e.charge) end end,
	shield = function(e, ctx)
		local r = liveRun(ctx)
		if r then
			r.shield += e.shield
			local f = r.fighter
			if f and not f.dead then f.shield += e.shield f.maxShield = math.max(f.maxShield or 0, f.shield) end
		end
	end,
	hurt = function(e, ctx) local r = liveRun(ctx) if r then r:hurt(e.hurt) end end,
	relic = function(e, ctx)
		local r = liveRun(ctx)
		if not r then return end
		local id = e.relic
		if id == "random" or type(id) == "table" then
			local rng = S.procgen.rng(r.seed * 31 + r.stats.rooms * 7 + r.stats.relicsTaken)
			id = Relics.roll(rng, r, 1, if type(id) == "table" then id else S.config.rarity, { luck = r:statsNow().luck })[1]
		end
		if id then r:addRelic(id) end
	end,
	meta = function(e) S.core.wallet.add(S.config.metaCurrency, e.meta) end,
}

local bound = false
local function bindCore()
	if bound then return end
	bound = true
	local C = S.core.conditions
	for k, fn in S.effectKinds do C.registerEffect(k, fn) end
	C.registerCondition("relic", function(c, ctx) local r = liveRun(ctx) return r ~= nil and C.compare(r:relicCount(c.relic), c, c.count or 1) end)
	C.registerCondition("class", function(c, ctx) local r = liveRun(ctx) return r ~= nil and r.classId == c.class end)
	C.registerCondition("heat", function(c, ctx) local r = liveRun(ctx) return r ~= nil and C.compare(r.heat, c, c.heat) end)
	C.registerCondition("runFloor", function(c, ctx) local r = liveRun(ctx) return r ~= nil and C.compare(r.floor, c, c.runFloor) end)
	C.registerCondition("hpBelow", function(c, ctx) local r = liveRun(ctx) return r ~= nil and r.hp < r:maxHp() * c.hpBelow end)
	C.registerCondition("runGold", function(c, ctx) local r = liveRun(ctx) return r ~= nil and C.compare(r.gold, c, c.runGold) end)
	C.registerCondition("wins", function(c) return C.compare(Meta.data.wins, c, c.wins) end)
	C.registerCondition("classWins", function(c) return C.compare(Meta.classStats(c.classWins).wins, c, c.count or 1) end)
end

---------------------------------------------------------------- setup
-- setup({ data? (path-keyed files), content? = { classes = {...}, relics = ..., ... } (tables), config? (overrides;
--         default data/roguelite.json), core? (core.setup opts, when the game hasn't called it), load? (true: core.save.load()) })
local didSetup = false
function R.setup(cfg)
	cfg = cfg or {}
	local core = S.core
	if cfg.core then core.setup(cfg.core) end
	if cfg.data then core.content.registerFiles(cfg.data) end
	for _, kind in S.KINDS do
		if cfg.content and cfg.content[kind] then core.content.register(kind, cfg.content[kind])
		elseif #core.content.all(kind) == 0 and not cfg.data then core.content.load(kind) end
	end
	local conf = cfg.config
	if conf == nil and type(data) == "table" and type(data.exists) == "function" and data.exists("data/roguelite.json") then conf = data.read("data/roguelite.json") end
	if conf == nil and cfg.data then conf = cfg.data["data/roguelite.json"] end
	for k in S.config do S.config[k] = nil end
	for k, v in S.DEFAULTS do S.config[k] = v end
	S.merge(S.config, conf)
	bindCore()
	if not didSetup then Meta.init() didSetup = true end
	if cfg.load then core.save.load() end
	if core.save.onAfterLoad and not R._loadHook then
		R._loadHook = true
		core.save.onAfterLoad(function() R.run = nil S.current = nil end)
	end
	return R
end

---------------------------------------------------------------- runs
-- newRun({ class, heat? (0), seed? (random), daily? (true = today's seed) }) -> Run (live: emits events, mirrors gold to the wallet, saved)
function R.newRun(opts)
	opts = opts or {}
	local seed = opts.seed
	local daily = nil
	if opts.daily then
		local d = Meta.daily(opts.now)
		seed, daily = d.seed, d.day
		opts.class = opts.class or d.class
		opts.heat = 0
	end
	assert(opts.class, "roguelite.newRun: class required")
	assert(Meta.unlocked(opts.class), "roguelite.newRun: class \"" .. opts.class .. "\" is locked")
	assert((opts.heat or 0) <= Meta.maxHeat(opts.class), "roguelite.newRun: heat " .. tostring(opts.heat) .. " not unlocked")
	seed = seed or math.floor(random(1, 2147480000))
	local mods = table.clone(Meta.mods())
	local run = Run.new({ class = opts.class, seed = seed, heat = opts.heat, daily = daily, metaMods = mods })
	R.run, S.current = run, run
	S.core.wallet.set(S.config.runCurrency, run.gold)
	S.core.events.emit("run_started", { class = run.classId, seed = seed, heat = run.heat, daily = daily })
	R.save()
	return run
end

-- resume() -> Run | nil (the saved in-progress run, after core.save.load())
function R.resume()
	local t = Meta.data.run
	if not t then return nil end
	local ok, run = pcall(Run.deserialize, t)
	if not ok then Meta.data.run = nil return nil end
	R.run, S.current = run, run
	S.core.wallet.set(S.config.runCurrency, run.gold)
	return run
end
function R.hasSavedRun() return Meta.data.run ~= nil and Meta.data.run.state ~= "dead" and Meta.data.run.state ~= "won" end

-- save(): store the live run (if config.saveRun) + meta in the core save
function R.save()
	local run = R.run
	if run and S.config.saveRun and run.state ~= "dead" and run.state ~= "won" then Meta.data.run = run:serialize() end
	return S.core.save.save()
end

-- finish() -> summary (records meta, awards meta currency, clears the saved run, resets run gold)
function R.finish(run)
	run = run or R.run
	assert(run, "roguelite.finish: no run")
	if run.state ~= "won" and run.state ~= "dead" then run:die() end
	local sum = Meta.record(run:summary())
	S.core.wallet.set(S.config.runCurrency, 0)
	R.run, S.current = nil, nil
	S.core.events.emit("run_finished", { won = sum.won, floor = sum.floor, class = sum.class, meta = sum.metaEarned })
	S.core.save.save()
	return sum
end

R.daily = Meta.daily
R.dailySeed = Meta.dailySeed
R.classes = Meta.classes
R.unlocked = Meta.unlocked
R.maxHeat = Meta.maxHeat
function R.metaTree() return Meta.tree end
function R.metaCurrency() return Meta.currency() end
function R.stats(run) return Relics.stats(run or R.run) end

---------------------------------------------------------------- combat glue
-- heroDef(run, extra?) -> combat.add def from run stats (hp, armor, crit, team "player")
function R.heroDef(run, extra)
	run = run or R.run
	local st = run:statsNow()
	local d = { hp = run.hp, maxHp = st.hp, armor = st.armor, critChance = st.crit, critMult = st.critMult, team = "player",
		iframes = 0.7, destroyOnDeath = false, shield = run.shield }
	for k, v in extra or {} do d[k] = v end
	return d
end
-- enemyDef(run, enemyData, extra?) -> combat.add def scaled for the room (hp, contact damage, elite/boss flags in data)
function R.enemyDef(run, e, extra)
	run = run or R.run
	local hpM, dmgM = run:enemyScale()
	local contact = e.contact and table.clone(e.contact)
	if contact then contact.amount = math.max(1, math.floor((contact.amount or 1) * dmgM + 0.5)) end
	local d = { hp = math.max(1, math.floor(e.hp * hpM + 0.5)), armor = e.armor, resist = e.resist, team = "enemy", contact = contact,
		loot = e.loot, knockbackResist = e.knockbackResist or (if e.boss then 0.9 else 0), immune = e.immune,
		data = { id = e.id, boss = e.boss == true, elite = run.room ~= nil and run.room.elite == true, damageMult = dmgM } }
	for k, v in extra or {} do d[k] = v end
	return d
end

-- bindCombat(combat, heroFighter, run?) -> { disconnect() }
-- Wires relic triggers + stats into combat events: kill/eliteKill/bossKill, hit, crit, hurt, lowHp triggers; lifesteal,
-- thorns, dodge; keeps run.hp in sync with the hero fighter (dies → run:die()).
function R.bindCombat(combat, hero, run)
	run = run or R.run
	run.fighter = hero
	local steal = 0
	local conns = {}
	table.insert(conns, combat.on("beforeDamage", function(info)
		if info.target == hero then
			local st = run:statsNow()
			if st.dodge > 0 and math.random() < st.dodge then info.cancel = true end
		end
	end))
	table.insert(conns, combat.on("hit", function(info)
		if info.blocked then return end
		if info.source == hero and info.target ~= hero and info.dealt > 0 then
			run:fire("hit", {})
			if info.crit then run:fire("crit", {}) end
			local st = run:statsNow()
			if st.lifesteal > 0 then
				steal += info.dealt * st.lifesteal
				if steal >= 1 then local n = math.floor(steal) steal -= n run:heal(n) end
			end
		elseif info.target == hero and (info.dealt > 0 or info.absorbed > 0) then
			run.hp = hero.hp
			run.shield = hero.shield
			run.stats.damageTaken += info.dealt
			run:fire("hurt", {})
			local st = run:statsNow()
			if st.thorns > 0 and type(info.source) == "table" and info.source.hp and not info.source.dead then
				combat.damage(info.source, { amount = st.thorns, source = hero, ignoreIframes = true })
			end
			if not run.roomLowHp and hero.hp > 0 and hero.hp < hero.maxHp * 0.3 then run.roomLowHp = true run:fire("lowHp", {}) end
		end
	end))
	table.insert(conns, combat.on("heal", function(f) if f == hero then run.hp = hero.hp end end))
	table.insert(conns, combat.on("death", function(f)
		if f == hero then
			run.hp = 0
			run:die()
		elseif f.team ~= "player" then
			run:onKill(f.data.id, if f.data.boss then "boss" elseif f.data.elite then "elite" else nil)
		end
	end))
	return { disconnect = function() for _, c in conns do c.disconnect() end if run.fighter == hero then run.fighter = nil end end }
end

---------------------------------------------------------------- arenas (procgen per biome)
-- arena(room, { w = 15, h = 20 }) -> level { grid, start, spawns = { {x,y} cells for room.enemies }, exit } via the biome's
-- generator: biome.arena = { kind = "caves" | "dungeon" | "open", fill?, pillars? ... }. Deterministic per room seed.
function R.arena(room, opts)
	opts = opts or {}
	local P = S.procgen
	local biome = S.req("biomes", room.biome)
	local a = biome.arena or {}
	local w, h = opts.w or a.w or 15, opts.h or a.h or 20
	local seed = room.seed
	local level
	if a.kind == "caves" then
		level = P.caves({ seed = seed, w = w, h = h, fill = a.fill or 0.38, steps = a.steps or 4, minOpen = a.minOpen or 0.45, enemies = 0, items = 0 })
	elseif a.kind == "dungeon" then
		level = P.dungeon({ seed = seed, w = w, h = h, rooms = a.rooms or 3, minRoom = a.minRoom or 4, maxRoom = a.maxRoom or 8, loops = 0.5, corridor = a.corridor or 2, enemies = 0, items = 0 })
	else
		local g = P.grid(w, h, "#")
		for y = 1, h - 2 do for x = 1, w - 2 do g:set(x, y, ".") end end
		local r = P.rng(seed)
		for _ = 1, a.pillars or 4 do
			local x, y = r:int(2, w - 3), r:int(3, h - 5)
			g:set(x, y, "#")
			if r:chance(0.5) then g:set(x + 1, y, "#") end
		end
		level = { grid = g, start = { x = math.floor(w / 2), y = h - 3 }, exit = { x = math.floor(w / 2), y = 1 } }
		local v = P.validate(g, { from = level.start })
		if not v.ok or v.regions > 1 then
			for y = 1, h - 2 do for x = 1, w - 2 do g:set(x, y, ".") end end
		end
	end
	-- spawns: far from start, spread
	local n = #(room.enemies or {})
	level.spawns = if n > 0 then P.scatter(level, n, { seed = seed + 3, from = level.start, minDist = math.min(6, math.floor(h / 3)), gap = 2, pass = "." }) else {}
	while #level.spawns < n do table.insert(level.spawns, level.spawns[1] or level.start) end
	return level
end

---------------------------------------------------------------- submodules
R.sim = require("./sim")
R.ui = require("./ui")

return R
