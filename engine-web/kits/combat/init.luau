-- combat kit: health/shields/armor, typed damage + resistances, crits, knockback, i-frames, status effects,
-- hitboxes/hurtboxes, projectiles (pooled), melee swings, death/respawn, loot drops, teams. See KIT.md.
local STATUS = require("./status")
local Loot = require("@kit/procgen/loot")
local Content = require("@kit/procgen/content")

local C = {}
C.VERSION = "0.1.0"
C.formula = require("./formula")
C.STATUS = STATUS

local fighters: { any } = {}
local byEntity: { [string]: any } = {}
local listeners: { [string]: { any } } = {}
local hitboxes: { any } = {}
local projectiles: { any } = {}
local pools: { [string]: { any } } = {}
local timers: { any } = {}
local nextId = 0
local lastUpdate = -1
local config: any = {
	friendlyFire = false, minDamage = 1, round = true, teams = nil, rand = nil,
	lootTables = {}, rollLoot = nil, flash = true, tint = true, blink = true, solidAt = nil,
}
C.config = config

local function rand(): number return if config.rand then config.rand() else math.random() end

local function alive(e) return isEntity(e) and not e.destroyed end
C.alive = alive

-------------------------------------------------------------------- events
-- C.on(event, fn) -> { disconnect }. events: hit(info), death(fighter, info), status(fighter, name, st),
-- statusEnd(fighter, name), heal(fighter, amount), respawn(fighter), drop(drops, x, y, fighter), beforeDamage(info)
function C.on(event: string, fn: any): any
	listeners[event] = listeners[event] or {}
	table.insert(listeners[event], fn)
	return { disconnect = function() local l = listeners[event] local i = table.find(l, fn) if i then table.remove(l, i) end end }
end
local function emit(event, ...)
	for _, fn in table.clone(listeners[event] or {}) do fn(...) end
end
C.emit = emit

function C.setup(cfg: any)
	for k, v in cfg do config[k] = v end
	return C
end

-------------------------------------------------------------------- fighters
local Fighter = {}
Fighter.__index = Fighter

function Fighter:pos(): (number, number)
	if self.entity and alive(self.entity) then
		local p = self.entity.position
		-- world position for top-level entities; nested entities: add parents
		local par = self.entity.parent
		local x, y = p.x, p.y
		while par and par.type ~= "Folder" and par.position ~= nil do
			local pp = par.position
			x += pp.x; y += pp.y
			par = par.parent
		end
		return x, y
	end
	return self.x or 0, self.y or 0
end
function Fighter:isAlive(): boolean return not self.dead end
function Fighter:busy(): boolean
	if self.dead or (self.knock and self.knock.t > 0) then return true end
	for _, st in self.statuses do if st.def.busy then return true end end
	return false
end
function Fighter:speedMult(): number
	local m = 1
	for _, st in self.statuses do if st.def.speedMult then m *= st.def.speedMult end end
	return m
end
function Fighter:hasStatus(name: string): boolean return self.statuses[name] ~= nil end
function Fighter:stacks(name: string): number local s = self.statuses[name] return if s then s.stacks else 0 end
function Fighter:addStatus(name: string, opts: any?) return C.applyStatus(self, name, opts) end
function Fighter:clearStatus(name: string?)
	for n in table.clone(self.statuses) do
		if name == nil or n == name then self.statuses[n] = nil emit("statusEnd", self, n) end
	end
	C._tint(self)
end
function Fighter:heal(n: number): number
	if self.dead then return 0 end
	if self.absorbOnly then if n > 0 then emit("heal", self, n) end return n end -- hp lives in the game's own sim
	local before = self.hp
	self.hp = math.min(self.maxHp, self.hp + n)
	local d = self.hp - before
	if d > 0 then emit("heal", self, d) end
	return d
end
function Fighter:kill(info: any?) C._kill(self, info or { source = nil }) end
function Fighter:fraction(): number return self.hp / self.maxHp end

local function sizeRadius(e)
	if not alive(e) then return 8 end
	local ok, s = pcall(function() return e.size end) -- not every entity type has `size`
	if ok and s and s.x then return math.max(s.x, s.y) / 2 end
	return 8
end

--[[ add(entity|nil, def) -> Fighter
   def: { hp = 10, maxHp = hp, shield = 0, shieldRegen = 0 (/s), shieldDelay = 2 (s after a hit), armor = 0 (flat),
          resist = { fire = 0.5, ice = -0.5 (weak), poison = 1 (immune) }, immune = { "stun" }, team = "enemy",
          iframes = 0 (s after a hit; players ~0.6), radius (hurtbox; default from entity size), x, y (no entity),
          critChance = 0, critMult = 2, knockbackResist = 0..1, contact = { amount, type, knockback, status }? (touch damage),
          attack, defense, level, types (turn-based), loot = "table_id" | table, respawn = { delay = 1.5, x?, y?, hp? },
          destroyOnDeath = true (entity destroyed on death unless respawn), deathDelay = 0, data = {},
          flash = true | false | "#hex" (hit flash; overrides setup), flashTime = 0.1, tint = bool (status tints), blink = bool (i-frames),
          absorbOnly = false (hits/i-frames/knockback/statuses/events run, but hp is never changed and it never dies:
                              info.dealt is for the game's own health sim; f:kill() still works) } ]]
function C.add(e: any?, def: any?): any
	def = def or {}
	nextId += 1
	local hp = def.hp or def.maxHp or 10
	local f = setmetatable({
		id = nextId, entity = e, x = def.x, y = def.y, team = def.team or "enemy",
		hp = hp, maxHp = def.maxHp or hp, shield = def.shield or 0, maxShield = def.maxShield or def.shield or 0,
		shieldRegen = def.shieldRegen or 0, shieldDelay = def.shieldDelay or 2, shieldT = 0,
		armor = def.armor or 0, resist = def.resist or {}, immune = {}, immuneT = {},
		iframes = def.iframes or 0, iframeT = 0, radius = def.radius or (if e then sizeRadius(e) else 8),
		critChance = def.critChance or 0, critMult = def.critMult or 2, knockbackResist = def.knockbackResist or 0,
		contact = def.contact, attack = def.attack, defense = def.defense, level = def.level, types = def.types,
		loot = def.loot, respawn = def.respawn, destroyOnDeath = def.destroyOnDeath, deathDelay = def.deathDelay or 0,
		statuses = {}, dead = false, data = def.data or {}, def = def, flashT = 0, absorbOnly = def.absorbOnly == true,
		flash = def.flash, tint = def.tint, blink = def.blink,
	}, Fighter)
	for _, n in def.immune or {} do f.immune[n] = true end
	if e then
		local p = e.position
		f.spawnX, f.spawnY = p.x, p.y
		byEntity[e.id] = f
		f.entityId = e.id
	end
	table.insert(fighters, f)
	C._ensureTick()
	return f
end

function C.get(e: any): any
	if e == nil then return nil end
	if getmetatable(e) == Fighter then return e end
	if not alive(e) then return nil end
	return byEntity[e.id]
end

function C.remove(f: any)
	f = C.get(f)
	if not f then return end
	local i = table.find(fighters, f)
	if i then table.remove(fighters, i) end
	if f.entityId then byEntity[f.entityId] = nil end
	if f.blinkSprite then if alive(f.blinkSprite) then f.blinkSprite.visible = true end f.blinkSprite = nil end
	f.removed = true
end

function C.all(): { any } return fighters end

function C.reset()
	for _, p in projectiles do if p.entity and alive(p.entity) then p.entity:destroy() end end
	for _, pool in pools do for _, e in pool do if alive(e) then e:destroy() end end end
	fighters, byEntity, hitboxes, projectiles, timers, pools = {}, {}, {}, {}, {}, {}
end

-------------------------------------------------------------------- teams
-- teams config: { player = { "enemy" }, enemy = { "player" } } (hostile lists). Default: different teams are hostile;
-- "neutral" is hostile to nobody.
function C.hostile(a: any, b: any): boolean
	local ta = if type(a) == "string" then a else a.team
	local tb = if type(b) == "string" then b else b.team
	if config.teams then
		local l = config.teams[ta]
		return l ~= nil and table.find(l, tb) ~= nil
	end
	if ta == "neutral" or tb == "neutral" then return false end
	return ta ~= tb
end
function C.canHit(src: any, target: any): boolean
	if src == target then return false end
	if C.hostile(src, target) then return true end
	return config.friendlyFire and (if type(src) == "string" then src else src.team) == target.team
end

-------------------------------------------------------------------- visuals (optional)
local function sprite(f)
	local e = f.entity
	if not e or not alive(e) then return nil end
	if e.type == "Sprite2D" then return e end
	for _, k in e:children() do if k.type == "Sprite2D" then return k end end
	return nil
end
-- per-fighter option (def.flash / def.tint / def.blink) wins over the global setup value
local function opt(f, key: string): any
	local v = f[key]
	if v == nil then return config[key] end
	return v
end
function C._tint(f)
	local tintOn, flashOn = opt(f, "tint") ~= false, opt(f, "flash") ~= false
	if not tintOn and not flashOn then return end
	local s = sprite(f)
	if not s then return end
	if f.baseColor == nil then f.baseColor = s.modulate end
	local col = nil
	if tintOn then for _, st in f.statuses do if st.def.tint then col = st.def.tint end end end
	if flashOn and f.flashT > 0 then
		local fl = opt(f, "flash")
		col = if type(fl) == "string" then fl else (config.flashColor or "#ff5555")
	end
	if col then s.modulate = color(col) else s.modulate = f.baseColor end
end
-- i-frame blink: toggles the sprite (a Sprite2D child, or the fighter's entity when it is the sprite itself)
local function blink(f, on: boolean)
	local s = if on or f.blinkSprite == nil then sprite(f) else f.blinkSprite
	if not s or not alive(s) then f.blinkSprite = nil return end
	if on then
		f.blinkSprite = s
		s.visible = math.floor(f.iframeT * 15) % 2 == 1
	else
		s.visible = true
		f.blinkSprite = nil
	end
end

-------------------------------------------------------------------- damage
--[[ damage(target, hit) -> info
   hit: { amount, type = "physical", source = Fighter|Entity|team string, crit = bool?, critChance?, critMult?,
          knockback = px/s, knockTime = 0.15, dir = {x,y}? (else away from source), status = "burn" | {name, chance, duration, stacks} | list,
          ignoreIframes, ignoreArmor, ignoreShield, dot (status tick), tag? }
   info: { target, source, type, raw, amount (final), dealt (hp lost), absorbed (shield), crit, killed, blocked = nil|"dead"|"team"|"iframes"|"immune" } ]]
function C.damage(target: any, hit: any): any
	local t = C.get(target)
	assert(t, "combat.damage: target is not a fighter (combat.add it first)")
	hit = hit or {}
	local src = hit.source
	if src ~= nil and type(src) ~= "string" then src = C.get(src) or src end
	local info = { target = t, source = src, type = hit.type or "physical", raw = hit.amount or hit.damage or 0, hit = hit, dealt = 0, absorbed = 0, crit = false, killed = false }
	if t.dead then info.blocked = "dead" return info end
	if src ~= nil and not hit.ignoreTeams and (type(src) == "string" or getmetatable(src) == Fighter) and not C.canHit(src, t) then info.blocked = "team" return info end
	if t.iframeT > 0 and not hit.ignoreIframes and not hit.dot then info.blocked = "iframes" return info end
	info.amount = info.raw
	emit("beforeDamage", info)
	if info.cancel then info.blocked = "cancelled" return info end
	local amt = info.amount
	-- crit
	local crit = hit.crit
	if crit == nil and not hit.dot then
		local cc = hit.critChance or (if type(src) == "table" and src.critChance then src.critChance else 0)
		crit = cc > 0 and rand() < cc
	end
	info.crit = crit == true
	if info.crit then amt *= hit.critMult or (if type(src) == "table" and src.critMult then src.critMult else 2) end
	-- resistances + status multipliers
	local res = t.resist[info.type] or 0
	if res >= 1 then info.blocked = "immune" info.amount = 0 emit("hit", info) return info end
	amt *= 1 - res
	for _, st in t.statuses do if st.def.damageTakenMult then amt *= st.def.damageTakenMult end end
	if not hit.ignoreArmor then amt -= t.armor end
	if info.raw > 0 and amt < config.minDamage then amt = config.minDamage end
	if config.round then amt = math.floor(amt + 0.5) end
	amt = math.max(0, amt)
	-- shields
	if not hit.ignoreShield and t.shield > 0 and amt > 0 then
		local a = math.min(t.shield, amt)
		t.shield -= a
		amt -= a
		info.absorbed = a
	end
	if info.absorbed > 0 or amt > 0 then t.shieldT = t.shieldDelay end
	if t.absorbOnly then info.absorbOnly = true else t.hp -= amt end -- absorbOnly: `dealt` is for the game's own hp sim
	info.dealt = amt
	info.amount = amt + info.absorbed
	-- reactions (not for damage-over-time ticks)
	if not hit.dot and info.amount > 0 then
		if t.iframes > 0 then t.iframeT = t.iframes end
		t.flashT = if opt(t, "flash") ~= false then (t.def.flashTime or config.flashTime or 0.1) else 0
		for n, st in table.clone(t.statuses) do
			if st.def.breaksOnHit then t.statuses[n] = nil emit("statusEnd", t, n) end
		end
		local kb = (hit.knockback or 0) * (1 - t.knockbackResist)
		if kb > 0 then
			local dx, dy = 0, 0
			if hit.dir then dx, dy = hit.dir.x or hit.dir[1], hit.dir.y or hit.dir[2]
			elseif type(src) == "table" and src.pos then
				local sx, sy = src:pos()
				local tx, ty = t:pos()
				dx, dy = tx - sx, ty - sy
			end
			local l = math.sqrt(dx * dx + dy * dy)
			if l > 0 then dx, dy = dx / l, dy / l else dx, dy = 0, -1 end
			t.knock = { vx = dx * kb, vy = dy * kb, t = hit.knockTime or 0.15 }
		end
	end
	-- statuses carried by the hit
	if hit.status and not t.dead then
		local list = hit.status
		if type(list) == "string" or list.name then list = { list } end
		for _, s in list do
			local sname = if type(s) == "string" then s else s.name
			if type(s) == "string" or s.chance == nil or rand() < s.chance then
				C.applyStatus(t, sname, if type(s) == "table" then { duration = s.duration, stacks = s.stacks, power = s.power, source = src } else { source = src })
			end
		end
	end
	C._tint(t)
	emit("hit", info)
	if t.def.onHit then t.def.onHit(info) end
	if t.hp <= 0 and not t.absorbOnly then
		t.hp = 0
		info.killed = true
		C._kill(t, info)
	end
	return info
end

-------------------------------------------------------------------- status effects
function C.defineStatus(name: string, def: any) STATUS[name] = def end

-- applyStatus(fighter, name, { duration?, stacks = 1, power = 1, source? }) -> status | nil (immune / ignored)
function C.applyStatus(target: any, name: string, opts: any?): any
	local t = C.get(target)
	opts = opts or {}
	local def = STATUS[name]
	if def == nil and not C._statusesLoaded then -- the game's data/statuses/<name>.json
		C._statusesLoaded = true
		for id, d in Content.load("statuses") do if STATUS[id] == nil then STATUS[id] = d end end
		def = STATUS[name]
	end
	assert(def, `combat: unknown status "{name}" (add data/statuses/{name}.json or combat.defineStatus)`)
	if t.dead or t.immune[name] or (t.immuneT[name] or 0) > 0 or (t.resist[name] or 0) >= 1 then return nil end
	local dur = (opts.duration or def.duration or 1) * (1 - (t.resist[name] or 0))
	local st = t.statuses[name]
	local mode = def.stacking or "refresh"
	if st == nil then
		st = { name = name, def = def, t = dur, duration = dur, stacks = math.min(opts.stacks or 1, def.maxStacks or 1), tickT = def.tick or 0, power = opts.power or 1, source = opts.source }
		t.statuses[name] = st
	elseif mode == "ignore" then
		return st
	elseif mode == "stack" then
		st.stacks = math.min(def.maxStacks or 99, st.stacks + (opts.stacks or 1))
		st.t = math.max(st.t, dur)
	elseif mode == "extend" then
		st.t += dur
	elseif mode == "max" then
		st.t = math.max(st.t, dur)
	else
		st.t = dur
	end
	st.power = math.max(st.power, opts.power or 1)
	C._tint(t)
	emit("status", t, name, st)
	return st
end

-------------------------------------------------------------------- death / respawn / loot
local function after(sec, fn) table.insert(timers, { t = sec, fn = fn }) end
C.after = after

-- loot: procgen.loot (rarity tiers, nested tables, pity). Tables: setup{ lootTables } or the game's data/loot/*.json.
local lootState = {}
local function lootTables()
	if config.lootTables == nil or next(config.lootTables) == nil then
		if not config._lootLoaded then
			config._lootLoaded = true
			config.lootTables = Content.load("loot")
		end
	end
	return config.lootTables
end
local function rollLoot(tbl)
	local tables = lootTables()
	if type(tbl) == "string" then tbl = tables[tbl] end
	if tbl == nil then return {} end
	if config.rollLoot then return config.rollLoot(tbl, nil, { tables = tables }) end
	return Loot.roll(tbl, math.floor(rand() * 2147483647), { tables = tables, state = lootState })
end
C.rollLoot = rollLoot

function C._kill(t, info)
	if t.dead then return end
	t.dead = true
	t.statuses = {}
	t.knock = nil
	t.iframeT = 0
	if t.blinkSprite then blink(t, false) end
	emit("death", t, info)
	if t.def.onDeath then t.def.onDeath(t, info) end
	if t.loot then
		local drops = rollLoot(t.loot)
		if #drops > 0 then
			local x, y = t:pos()
			emit("drop", drops, x, y, t)
		end
	end
	if t.respawn then
		local r = t.respawn
		after(r.delay or 1.5, function()
			if t.removed then return end
			t.dead = false
			t.hp = r.hp or t.maxHp
			t.shield = t.maxShield
			t.iframeT = r.iframes or t.iframes
			if t.entity and alive(t.entity) then
				t.entity.position = vec2(r.x or t.spawnX, r.y or t.spawnY)
				if t.entity.type == "Body2D" then t.entity.velocity = vec2(0, 0) end
			elseif not t.entity then
				t.x, t.y = r.x or t.x, r.y or t.y
			end
			C._tint(t)
			emit("respawn", t)
		end)
	elseif t.entity and t.destroyOnDeath ~= false then
		after(t.deathDelay, function()
			if alive(t.entity) then t.entity:destroy() end
			C.remove(t)
		end)
	end
end

-------------------------------------------------------------------- spatial queries, melee, hitboxes
-- fighters whose hurtbox overlaps the circle; opts: { hostileTo = fighter|team, exclude = fighter, alive = true }
function C.query(x: number, y: number, r: number, opts: any?): { any }
	opts = opts or {}
	local out = {}
	for _, f in fighters do
		if not f.dead and f ~= opts.exclude then
			if opts.hostileTo == nil or C.canHit(opts.hostileTo, f) then
				local fx, fy = f:pos()
				local rr = r + f.radius
				if (fx - x) ^ 2 + (fy - y) ^ 2 <= rr * rr then table.insert(out, f) end
			end
		end
	end
	return out
end

--[[ swing(attacker, opts) -> { info } : instant melee arc.
   opts: { range = 28, arc = 100 (deg, 360 = all around), angle (deg, 0 = right, 90 = down) | dir = {x,y},
           at = {x,y}? (origin; default attacker pos), ...hit fields (amount, type, knockback, status, crit...) } ]]
function C.swing(attacker: any, opts: any): { any }
	local a = C.get(attacker) or attacker
	local ox, oy
	if opts.at then ox, oy = opts.at.x or opts.at[1], opts.at.y or opts.at[2] else ox, oy = a:pos() end
	local ang = if opts.angle then math.rad(opts.angle) elseif opts.dir then math.atan2(opts.dir.y or opts.dir[2], opts.dir.x or opts.dir[1]) else 0
	local half = math.rad(opts.arc or 100) / 2
	local range = opts.range or 28
	local hits = {}
	for _, f in C.query(ox, oy, range, { hostileTo = a, exclude = a }) do
		local fx, fy = f:pos()
		local d = math.atan2(fy - oy, fx - ox) - ang
		d = (d + math.pi) % (2 * math.pi) - math.pi
		local close = (fx - ox) ^ 2 + (fy - oy) ^ 2 <= f.radius * f.radius
		if math.abs(d) <= half or close or (opts.arc or 100) >= 360 then
			local hit = table.clone(opts)
			hit.source = a
			hit.amount = opts.amount or opts.damage or 1
			if hit.knockback and not hit.dir then
				local dx, dy = fx - ox, fy - oy
				hit.dir = { x = dx, y = dy }
			end
			table.insert(hits, C.damage(f, hit))
		end
	end
	return hits
end

--[[ hitbox(opts) -> hb : a damaging circle that lives `duration` s, hits each target once.
   opts: { x, y | follow = Entity (+ offset {x,y}), radius = 12, duration = 0.1, source = Fighter|team, ...hit fields,
           every = s? (re-hit the same target every N s: lingering fire, spikes) } ; hb:cancel() ]]
function C.hitbox(opts: any): any
	local hb = { opts = opts, t = opts.duration or 0.1, hit = {}, done = false }
	function hb.cancel() hb.done = true end
	table.insert(hitboxes, hb)
	C._ensureTick()
	return hb
end

--[[ areaHitbox(area: Area2D|Body2D, hit, opts?) : physics-based hitbox using collision layers. Every body that
     enters the area and is a hostile fighter takes `hit`. opts: { once = false, source = Fighter|team }. Returns Connection. ]]
function C.areaHitbox(area: any, hit: any, opts: any?): any
	opts = opts or {}
	local done = {}
	return area.bodyEntered:connect(function(other)
		local f = C.get(other)
		if f == nil or f.dead then return end
		if opts.once and done[f] then return end
		done[f] = true
		local h = table.clone(hit)
		h.source = opts.source or h.source or C.get(area)
		C.damage(f, h)
	end)
end

-------------------------------------------------------------------- projectiles
-- position of a Fighter | Entity | {x,y} | {x=,y=} | Vec2
function C.xy(v: any): (number, number)
	if type(v) == "table" and getmetatable(v) == Fighter then return v:pos() end
	if isEntity(v) then local p = v.position return p.x, p.y end
	if type(v) == "table" and v.x == nil and v[1] ~= nil then return v[1], v[2] end
	return v.x, v.y
end

local function solidAt(p, x, y)
	local s = p.solid or config.solidAt
	if s == nil then return false end
	if type(s) == "function" then return s(x, y) end
	if s.solidAt then return s:solidAt(x, y) end
	return false
end

local function release(p)
	p.done = true
	if p.entity and alive(p.entity) then
		if p.poolKey then
			p.entity.visible = false
			pools[p.poolKey] = pools[p.poolKey] or {}
			table.insert(pools[p.poolKey], p.entity)
		else
			p.entity:destroy()
		end
	end
	p.entity = nil
end

--[[ shoot(opts) -> projectile
   opts: { x, y | from = {x,y}|Entity, dx, dy | angle (deg) | at = {x,y}|Entity (aim), speed = 220, lifetime = 1.5,
           radius = 4, pierce = 0 (extra targets), homing = 0 (turn rate deg/s; target = nearest hostile within homingRange = 160),
           source = Fighter|team (default team "enemy"), ...hit fields (amount, type, status, knockback, crit...),
           solid = fn(x,y)->bool | PathGrid (stops on walls; default setup{ solidAt }),
           sprite = "asset:<id>" | nil, color = "#ffffff", size = {6,6}, z = 10, parent = Entity?, pool = "key" (reuse entities),
           visual = true, onHit = fn(p, info), onExpire = fn(p), rotate = true,
           update = fn(p, dt)? (every tick before moving: steer p.vx/p.vy or set p.x/p.y — curved/sine/accelerating shots) }
   p: { x, y, vx, vy, speed, t (life left), age, hits, done, entity, opts } ; p:cancel() ]]
function C.shoot(opts: any): any
	local x, y = opts.x, opts.y
	if opts.from then x, y = C.xy(opts.from) end
	local dx, dy = opts.dx, opts.dy
	if opts.angle then dx, dy = math.cos(math.rad(opts.angle)), math.sin(math.rad(opts.angle)) end
	if opts.at then
		local ax, ay = C.xy(opts.at)
		dx, dy = ax - x, ay - y
	end
	dx, dy = dx or 1, dy or 0
	local l = math.sqrt(dx * dx + dy * dy)
	if l > 0 then dx, dy = dx / l, dy / l end
	local speed = opts.speed or 220
	local src = opts.source or "enemy"
	if type(src) ~= "string" then src = C.get(src) or src end
	local p = { x = x, y = y, vx = dx * speed, vy = dy * speed, speed = speed, t = opts.lifetime or 1.5, age = 0, hits = {}, hitCount = 0, opts = opts, source = src, done = false }
	function p.cancel() if not p.done then release(p) end end
	if opts.visual ~= false and (opts.sprite or opts.color or opts.size) then
		local key = opts.pool
		local e = nil
		if key and pools[key] then
			while #pools[key] > 0 and e == nil do
				local cand = table.remove(pools[key])
				if alive(cand) then e = cand end
			end
		end
		local sz = opts.size or { 6, 6 }
		if e then
			e.visible = true
			e.position = vec2(x, y)
		else
			local props: any = { position = vec2(x, y), size = vec2(sz[1] or sz.x, sz[2] or sz.y), z_index = opts.z or 10 }
			if opts.sprite then props.texture = opts.sprite end
			props.modulate = color(opts.color or "#ffffff")
			e = spawn("Sprite2D", props, opts.parent)
		end
		if opts.rotate ~= false then e.rotation = math.deg(math.atan2(dy, dx)) end
		p.entity = e
		p.poolKey = key
	end
	table.insert(projectiles, p)
	C._ensureTick()
	return p
end
function C.projectiles(): { any } return projectiles end

-------------------------------------------------------------------- update
function C.update(dt: number)
	-- fighters
	for i = #fighters, 1, -1 do
		local f = fighters[i]
		if f.entity and not alive(f.entity) then
			table.remove(fighters, i)
			f.removed = true
		end
	end
	for _, f in table.clone(fighters) do
		if not f.dead then
			if f.iframeT > 0 then
				f.iframeT -= dt
				if f.iframeT > 0 and opt(f, "blink") ~= false and f.iframes > 0 then blink(f, true)
				elseif f.blinkSprite then blink(f, false) end
			end
			if f.flashT > 0 then
				f.flashT -= dt
				if f.flashT <= 0 then C._tint(f) end
			end
			if f.shieldT > 0 then f.shieldT -= dt
			elseif f.shieldRegen > 0 and f.shield < f.maxShield then f.shield = math.min(f.maxShield, f.shield + f.shieldRegen * dt) end
			for n, t in f.immuneT do f.immuneT[n] = if t - dt > 0 then t - dt else nil end
			-- statuses
			for name, st in table.clone(f.statuses) do
				if f.dead then break end
				local def = st.def
				if def.tick then
					st.tickT -= dt
					while st.tickT <= 0 and st.t > 0 and not f.dead do
						st.tickT += def.tick
						if def.damage then
							C.damage(f, { amount = def.damage * st.stacks * st.power, type = def.type or name, dot = true, ignoreArmor = def.ignoreArmor, ignoreTeams = true, source = st.source, status = nil })
						end
						if def.heal then f:heal(def.heal * st.stacks * st.power) end
					end
				end
				st.t -= dt
				if st.t <= 0 and f.statuses[name] == st then
					f.statuses[name] = nil
					if def.immuneAfter then f.immuneT[name] = def.immuneAfter end
					C._tint(f)
					emit("statusEnd", f, name)
				end
			end
			-- knockback owns the body's velocity while active
			if f.knock and f.knock.t > 0 then
				f.knock.t -= dt
				if f.entity and alive(f.entity) then
					if f.entity.type == "Body2D" then
						f.entity.velocity = vec2(f.knock.vx, f.knock.vy)
					else
						local p = f.entity.position
						local nx, ny = p.x + f.knock.vx * dt, p.y + f.knock.vy * dt
						if not solidAt({}, nx, ny) then f.entity.position = vec2(nx, ny) end
					end
				elseif not f.entity then
					f.x += f.knock.vx * dt
					f.y += f.knock.vy * dt
				end
				if f.knock.t <= 0 then
					if f.entity and alive(f.entity) and f.entity.type == "Body2D" then f.entity.velocity = vec2(0, f.entity.velocity.y) end
					f.knock = nil
				end
			end
		end
	end
	-- contact damage
	for _, f in fighters do
		if not f.dead and f.contact then
			local x, y = f:pos()
			for _, o in C.query(x, y, f.radius, { hostileTo = f, exclude = f }) do
				local hit = table.clone(f.contact)
				hit.source = f
				hit.amount = hit.amount or hit.damage or 1
				C.damage(o, hit)
			end
		end
	end
	-- hitboxes
	for i = #hitboxes, 1, -1 do
		local hb = hitboxes[i]
		local o = hb.opts
		hb.t -= dt
		if not hb.done then
			local x, y = o.x or 0, o.y or 0
			if o.follow then
				if alive(o.follow) then
					local p = o.follow.position
					x, y = p.x + (o.offset and (o.offset.x or o.offset[1]) or 0), p.y + (o.offset and (o.offset.y or o.offset[2]) or 0)
				else
					hb.done = true
				end
			end
			if not hb.done then
				local src = o.source
				if src ~= nil and type(src) ~= "string" then src = C.get(src) or src end
				for _, f in C.query(x, y, o.radius or 12, { hostileTo = src or "neutral_hb", exclude = if type(src) == "table" then src else nil }) do
					local last = hb.hit[f]
					if last == nil or (o.every and hb.t <= last - o.every) then
						hb.hit[f] = hb.t
						local h = table.clone(o)
						h.source = src
						h.amount = o.amount or o.damage or 1
						C.damage(f, h)
					end
				end
			end
		end
		if hb.t <= 0 or hb.done then table.remove(hitboxes, i) end
	end
	-- projectiles
	for i = #projectiles, 1, -1 do
		local p = projectiles[i]
		local o = p.opts
		if not p.done then
			p.t -= dt
			p.age += dt
			if (o.homing or 0) > 0 then
				local tgt = o.target and C.get(o.target)
				if tgt == nil or tgt.dead then
					local best, bd = nil, (o.homingRange or 160) ^ 2
					for _, f in fighters do
						if not f.dead and C.canHit(p.source, f) then
							local fx, fy = f:pos()
							local d = (fx - p.x) ^ 2 + (fy - p.y) ^ 2
							if d < bd then best, bd = f, d end
						end
					end
					tgt = best
				end
				if tgt then
					local fx, fy = tgt:pos()
					local want = math.atan2(fy - p.y, fx - p.x)
					local cur = math.atan2(p.vy, p.vx)
					local diff = (want - cur + math.pi) % (2 * math.pi) - math.pi
					local maxTurn = math.rad(o.homing) * dt
					cur += math.clamp(diff, -maxTurn, maxTurn)
					p.vx, p.vy = math.cos(cur) * p.speed, math.sin(cur) * p.speed
				end
			end
			-- custom motion (curves, waves, accel): edit p.vx/p.vy or p.x/p.y; p.age = seconds alive; p:cancel() is fine
			if o.update then o.update(p, dt) end
		end
		if not p.done then
			p.x += p.vx * dt
			p.y += p.vy * dt
			if p.entity and alive(p.entity) then
				p.entity.position = vec2(p.x, p.y)
				if o.rotate ~= false then p.entity.rotation = math.deg(math.atan2(p.vy, p.vx)) end
			end
			if solidAt(o, p.x, p.y) then
				if o.onExpire then o.onExpire(p, "wall") end
				release(p)
			else
				for _, f in C.query(p.x, p.y, o.radius or 4, { hostileTo = p.source, exclude = if type(p.source) == "table" then p.source else nil }) do
					if not p.hits[f] and not p.done then
						p.hits[f] = true
						local h = table.clone(o)
						h.source = p.source
						h.amount = o.amount or o.damage or 1
						if h.knockback and not h.dir then h.dir = { x = p.vx, y = p.vy } end
						local info = C.damage(f, h)
						if o.onHit then o.onHit(p, info) end
						if info.blocked ~= "iframes" then p.hitCount += 1 end
						if p.hitCount > (o.pierce or 0) then release(p) end
					end
				end
				if not p.done and p.t <= 0 then
					if o.onExpire then o.onExpire(p, "lifetime") end
					release(p)
				end
			end
		end
		if p.done then table.remove(projectiles, i) end
	end
	-- timers
	for i = #timers, 1, -1 do
		local tm = timers[i]
		tm.t -= dt
		if tm.t <= 0 then
			table.remove(timers, i)
			tm.fn()
		end
	end
end

-- auto-update via onTick (once per frame even if registered from several scripts / scenes). A tick registered by
-- an attached script dies with its scene, so we register again whenever the scene changed (duplicates are no-ops).
local tickScene = nil
function C._ensureTick()
	if config.manual then return end
	local scene = currentScene()
	if tickScene == scene and (lastUpdate < 0 or time() - lastUpdate < 0.25) then return end
	tickScene = scene
	onTick(function(dt)
		local t = time()
		if t == lastUpdate then return end
		lastUpdate = t
		C.update(dt)
	end)
end

return C
