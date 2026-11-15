-- platformer kit: level runner. Turns a scene (TileMap2D level + player + Camera2D) into a full level:
-- markers -> entities, controller, enemies, bosses, collectibles, hazards, checkpoints, goal, camera,
-- HUD, save. One call from the level scene's script: kit.level.start({ ... }).
local U = require("./util")
local Tiles = require("./tiles")
local Controller = require("./controller")
local Enemy = require("./enemies")
local Boss = require("./boss")
local Content = require("./content")
local Progress = require("./progress")
local World = require("./world")
local Cam = require("./camera")
local Hud = require("./hud")
local juice = require("@kit/juice")

local Level = {}
Level.__index = Level
Level.current = nil

Level.DEFAULTS = {
	health = 3, -- hits the player can take (hearts)
	iframes = 1.2,
	hazard_damage = 99, -- spikes / hazard tiles: 99 = instant death
	respawn_delay = 0.9,
	complete_delay = 1.8,
	lives = nil, -- nil = infinite (respawn at checkpoint forever)
	player_size = { 12, 14 },
	player_offset = { 0, 0 }, -- entity position = body center + offset
	buttons = { jump = "jump", dash = "action", shoot = "action2" },
	shot = { speed = 300, size = { 8, 4 }, life = 0.7, damage = 1, cooldown = 0.28 },
	stomp_height = 28,
	stomp_height_held = 56, -- holding jump while stomping bounces higher
	activation = 96, -- px outside the view where enemies still update
	platform = { speed = 40, range = 4, fall_delay = 0.5, respawn = 3 },
	boss_completes = true,
	boss_wake = 220, -- px: boss starts when the player is this close (or enters its camera_room)
	goal_size = { 16, 32 },
	checkpoint_size = { 16, 24 },
	art = {}, -- checkpoint, checkpoint_on, goal, platform, shot, enemy_shot, heart, heart_empty
	sounds = {}, -- jump, land, coin, gem, stomp, hurt, die, checkpoint, powerup, shoot, dash, spring, break, clear, boss_hit, boss_defeat
	anims = {}, -- player anim names: idle, run, jump, fall, climb, dash, wall, hurt
	camera = {},
	hud = {},
	controller = {},
	ability_names = {
		double_jump = "DOUBLE JUMP! Jump again in the air",
		wall_jump = "WALL JUMP! Jump while sliding on a wall",
		wall_slide = "WALL SLIDE! Hold toward a wall",
		dash = "DASH! Press the dash button",
		shoot = "BLASTER! Press the shoot button",
	},
}

local function cellBottom(tiles, c, r)
	local x, y = tiles:cellCenter(c, r)
	return x, y + tiles.ts / 2
end

local function otherTag(list, skip)
	for _, t in list do
		if not skip[t] then return t end
	end
	return nil
end

local MARKER_SKIP = { enemy = true, boss = true, powerup = true, platform = true, move_x = true, move_y = true, fall = true, solid = true, oneway = true }

function Level.start(opts)
	opts = opts or {}
	local self = setmetatable({}, Level)
	local o = U.merge(Level.DEFAULTS, opts)
	-- functions / entities must not be deep-copied
	for _, k in { "map", "maps", "player", "camera_entity", "on_complete", "on_death", "on_game_over", "sprite", "input" } do o[k] = opts[k] end
	self.o = o
	self.events = U.bus()
	Level.current = self

	local maps = o.maps or (o.map and { o.map }) or entitiesTagged("level_map")
	if #maps == 0 then
		for _, m in entitiesTagged("map") do table.insert(maps, m) end
	end
	if #maps == 0 then error("platformer level: pass map = <TileMap2D> (or tag it level_map)", 2) end
	self.tiles = Tiles.new(maps, { solidChars = o.solid_chars })
	self.player = o.player or entitiesTagged("player")[1]
	if not self.player then error("platformer level: pass player = <entity> (or tag it player)", 2) end
	self.sprite = o.sprite
	if not self.sprite then
		if self.player.type == "Sprite2D" then self.sprite = self.player
		else
			for _, c in self.player:children() do
				if c.type == "Sprite2D" then self.sprite = c break end
			end
		end
	end

	-- level id: explicit, scene param, or the world.json level whose scene this is
	local id = o.id or sceneParams().level
	if not id and World.has() then
		local l = World.levelForScene(currentScene())
		if l then id = l.id end
	end
	self.id = id or currentScene()

	local pp = self.player.position
	self.body = { x = pp.x - o.player_offset[1], y = pp.y - o.player_offset[2], w = o.player_size[1], h = o.player_size[2], vx = 0, vy = 0 }
	self.ctl = Controller.new(o.controller, self.body)
	for name, on in Progress.load().abilities do
		if on then self.ctl:setAbility(name, true) end
	end
	self.ctl.p.stomp_height = o.stomp_height
	self.ctl:derive()

	self.maxHealth = o.health
	self.health = o.health
	self.lives = o.lives
	self.iframes = 0
	self.dead = false
	self.done = false
	self.time = 0
	self.deaths = 0
	self.shotCd = 0
	self.coins, self.coinsTotal = 0, 0
	self.gems, self.gemsTotal, self.gemIndex = {}, 0, {}
	self.secrets, self.secretsTotal, self.secretIndex = {}, 0, {}
	self.enemies, self.bosses, self.projectiles = {}, {}, {}
	self.checkpoints, self.goals, self.platforms = {}, {}, {}
	self.actors = spawn("Node2D", { z_index = 4 })

	self:scan()
	self.spawnX, self.spawnY = self.body.x, self.body.y

	local camE = o.camera_entity or camera.current()
	if camE then
		self.cam = Cam.new(camE, { self.tiles.ox, self.tiles.oy, self.tiles.ox + self.tiles.width, self.tiles.oy + self.tiles.height }, o.camera)
		self.cam:snap(self.body, 1)
	end
	self.parallax = Cam.parallax()
	self.parallax:addTagged()

	if o.hud ~= false then
		self.hud = Hud.new(o.hud, o.art)
		self.hud:setHearts(self.health, self.maxHealth)
	end
	Progress.setLast(self.id)
	self:sync()
	onTick(function(dt) self:tick(dt) end)
	return self
end

-- ---------- markers ----------
function Level:scan()
	local tiles = self.tiles
	local o = self.o
	local platformCells = {}
	local fakeCells = {}
	for mi, m in tiles.maps do
		for r = 0, m.rows - 1 do
			for c = 0, m.cols - 1 do
				local inf = tiles:cell(mi, c, r)
				if inf then
					local t = inf.tags
					local key = mi .. ":" .. c .. ":" .. r
					if t.player_start then
						local x, y = cellBottom(tiles, c, r)
						self.body.x, self.body.y = x, y - self.body.h / 2
						tiles:setTile(mi, c, r, nil)
					elseif t.checkpoint then
						self:addCheckpoint(c, r)
						tiles:setTile(mi, c, r, nil)
					elseif t.goal then
						self:addGoal(c, r)
						tiles:setTile(mi, c, r, nil)
					elseif t.enemy then
						local eid = otherTag(inf.list, MARKER_SKIP)
						if not eid then error("platformer: enemy marker '" .. inf.char .. "' needs a second tag naming the enemy (tags: [\"enemy\", \"slime\"])", 0) end
						local x, y = cellBottom(tiles, c, r)
						self:addEnemy(eid, x, y, true)
						tiles:setTile(mi, c, r, nil)
					elseif t.boss then
						local bid = otherTag(inf.list, MARKER_SKIP)
						local x, y = cellBottom(tiles, c, r)
						self:addBoss(bid, x, y)
						tiles:setTile(mi, c, r, nil)
					elseif t.platform then
						table.insert(platformCells, { c = c, r = r, mi = mi, tags = t, list = inf.list })
						tiles:setTile(mi, c, r, nil)
					elseif t.coin then
						self.coinsTotal += 1
					elseif t.gem then
						self.gemsTotal += 1
						self.gemIndex[key] = self.gemsTotal
						if Progress.hasGem(self.id, self.gemsTotal) then self.gems[self.gemsTotal] = "old" end
					elseif t.fake then
						fakeCells[c .. ":" .. r] = true
					end
				end
			end
		end
	end
	-- moving platforms: horizontal runs of platform markers with the same tags
	table.sort(platformCells, function(a, b) return if a.r == b.r then a.c < b.c else a.r < b.r end)
	local i = 1
	while i <= #platformCells do
		local first = platformCells[i]
		local j = i
		while j + 1 <= #platformCells and platformCells[j + 1].r == first.r and platformCells[j + 1].c == platformCells[j].c + 1 do j += 1 end
		self:addPlatform(first.c, first.r, j - i + 1, first.list)
		i = j + 1
	end
	-- secret areas: connected groups of fake tiles
	for k in fakeCells do
		if not self.secretIndex[k] then
			self.secretsTotal += 1
			local stack = { k }
			while #stack > 0 do
				local cur = table.remove(stack)
				if fakeCells[cur] and not self.secretIndex[cur] then
					self.secretIndex[cur] = self.secretsTotal
					local c, r = string.match(cur, "(-?%d+):(-?%d+)")
					local cn, rn = tonumber(c), tonumber(r)
					for _, d in { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } } do
						table.insert(stack, (cn + d[1]) .. ":" .. (rn + d[2]))
					end
				end
			end
		end
	end
end

function Level:addCheckpoint(c: number, r: number)
	local x, yb = cellBottom(self.tiles, c, r)
	local s = self.o.checkpoint_size
	local cp = { x = x, y = yb - s[2] / 2, w = s[1], h = s[2], spawnX = x, spawnY = yb - self.body.h / 2, active = false }
	local art = self.o.art
	cp.e = spawn("Sprite2D", { position = vec2(cp.x, cp.y), size = vec2(s[1], s[2]), texture = art.checkpoint, modulate = if art.checkpoint then "#ffffff" else "#8a8aa0", z_index = 2 }, self.actors)
	table.insert(self.checkpoints, cp)
	return cp
end

function Level:addGoal(c: number, r: number)
	local x, yb = cellBottom(self.tiles, c, r)
	local s = self.o.goal_size
	local g = { x = x, y = yb - s[2] / 2, w = s[1], h = s[2] }
	g.e = spawn("Sprite2D", { position = vec2(g.x, g.y), size = vec2(s[1], s[2]), texture = self.o.art.goal, modulate = if self.o.art.goal then "#ffffff" else "#ffd34a", z_index = 2 }, self.actors)
	table.insert(self.goals, g)
	return g
end

local function parseNum(list, prefix)
	for _, t in list do
		local n = string.match(t, "^" .. prefix .. "_(%d+)$")
		if n then return tonumber(n) end
	end
	return nil
end

function Level:addPlatform(c: number, r: number, len: number, list)
	local ts = self.tiles.ts
	local set = {}
	for _, t in list do set[t] = true end
	local x0, y0 = self.tiles.ox + c * ts + len * ts / 2, self.tiles.oy + r * ts + ts / 4
	local pl = {
		x = x0, y = y0, w = len * ts, h = ts / 2, x0 = x0, y0 = y0,
		oneway = not set.solid, axis = if set.move_y then "y" elseif set.move_x then "x" else nil,
		falls = set.fall == true, range = (parseNum(list, "range") or self.o.platform.range) * ts,
		speed = parseNum(list, "speed") or self.o.platform.speed, t = 0, standT = 0, fallV = 0,
	}
	pl.e = spawn("Node2D", { position = vec2(pl.x, pl.y), z_index = 1 }, self.actors)
	for k = 0, len - 1 do
		spawn("Sprite2D", { position = vec2(-pl.w / 2 + (k + 0.5) * ts, 0), size = vec2(ts, ts / 2), texture = self.o.art.platform, modulate = if self.o.art.platform then "#ffffff" else "#b08850" }, pl.e)
	end
	self.tiles:addSolid(pl)
	table.insert(self.platforms, pl)
	return pl
end

-- Spawn an enemy by content id at (x, bottom y). Returns the enemy record.
function Level:addEnemy(id: string, x: number, yBottom: number, fromMarker: boolean?)
	local def = Content.get("enemies", id)
	local en = Enemy.new(def, x, 0)
	local airborne = en.def.behaviour == "flyer" or (en.def.gravity or 0) == 0
	en.y = if airborne and fromMarker then yBottom - self.tiles.ts / 2 else yBottom - en.h / 2
	en.homeY = en.y
	local d = en.def
	local ds = d.draw_size or d.size
	en.e = spawn("Sprite2D", {
		position = vec2(en.x, en.y), size = vec2(ds[1], ds[2]), texture = d.sprite,
		modulate = if d.sprite then "#ffffff" else (d.color or "#d04848"), z_index = 3,
		anims = d.animset or "", anim = (d.anims and d.anims.move) or "",
	}, self.actors)
	table.insert(self.enemies, en)
	self.events:emit("enemySpawned", en)
	return en
end

function Level:addBoss(id: string, x: number, yBottom: number)
	local def = Content.get("bosses", id)
	local b = Boss.new(def, x, 0)
	b.y = yBottom - b.h / 2
	b.homeY = b.y
	local d = b.def
	local ds = d.draw_size or d.size
	b.e = spawn("Sprite2D", { position = vec2(b.x, b.y), size = vec2(ds[1], ds[2]), texture = d.sprite, modulate = if d.sprite then "#ffffff" else "#a040c0", z_index = 3, anims = d.animset or "", anim = (d.anims and d.anims.move) or "" }, self.actors)
	b.awake = false
	table.insert(self.bosses, b)
	return b
end

-- ---------- projectiles ----------
function Level:shoot(p)
	local art = if p.owner == "player" then self.o.art.shot else (p.sprite or self.o.art.enemy_shot)
	p.e = spawn("Sprite2D", { position = vec2(p.x, p.y), size = vec2(p.w, p.h), texture = art, modulate = if art then "#ffffff" else (if p.owner == "player" then "#ffe060" else "#ff5040"), z_index = 6 }, self.actors)
	table.insert(self.projectiles, p)
	return p
end

local function removeProjectile(self, i)
	local p = self.projectiles[i]
	if p.e then p.e:destroy() end
	table.remove(self.projectiles, i)
end

-- ---------- player state ----------
function Level:play(key: string, opts)
	U.play(self.o.sounds, key, opts)
end

-- after() that is skipped once the level's scene is gone (levels started from session scripts)
function Level:later(seconds: number, fn)
	after(seconds, function()
		if not self.actors.destroyed then fn() end
	end)
end

function Level:burst(x: number, y: number, n: number, col: string?)
	juice.emitter(vec2(x, y), { z_index = 20, lifetime = 0.45, speed = 90, spread = 360, start_size = 4, end_size = 1,
		start_color = col or "#ffffff", end_color = "#ffffff00", gravity = vec2(0, 300) }, n)
end

function Level:hurt(n: number?, fromX: number?)
	if self.dead or self.done or self.iframes > 0 then return end
	local dmg = n or 1
	self.health -= dmg
	self.events:emit("hurt", dmg, self.health)
	juice.shake(4, 0.2)
	if self.health <= 0 then
		self:die("hurt")
		return
	end
	self:play("hurt")
	self.iframes = self.o.iframes
	local dir = if fromX then (if self.body.x < fromX then -1 else 1) else -self.ctl.facing
	self.ctl:knockback(dir)
end

function Level:die(cause: string?)
	if self.dead or self.done then return end
	self.dead = true
	self.health = 0
	self.deaths += 1
	self.ctl.frozen = true
	self:play("die")
	self:burst(self.body.x, self.body.y, 24, "#ffffff")
	self.player.visible = false
	juice.shake(6, 0.3)
	self.events:emit("death", cause)
	if self.o.on_death then self.o.on_death(self, cause) end
	if self.lives ~= nil then
		self.lives -= 1
		if self.lives < 0 then
			self.events:emit("gameOver")
			if self.o.on_game_over then
				self.o.on_game_over(self)
			else
				self:later(self.o.respawn_delay, function() loadScene(currentScene(), sceneParams()) end)
			end
			return
		end
	end
	self:later(self.o.respawn_delay, function() self:respawn() end)
end

function Level:respawn()
	local b = self.body
	b.x, b.y = self.spawnX, self.spawnY
	b.vx, b.vy = 0, 0
	b.ground = nil
	self.ctl.frozen = false
	self.ctl.dashT = 0
	self.ctl.climbing = false
	self.ctl.grounded = false
	self.dead = false
	self.health = self.maxHealth
	self.iframes = 1
	self.player.visible = true
	for i = #self.projectiles, 1, -1 do removeProjectile(self, i) end
	if self.cam then self.cam:snap(b, self.ctl.facing) end
	self.events:emit("respawn")
	self:sync()
end

function Level:heal(n: number?)
	self.health = math.min(self.maxHealth, self.health + (n or 1))
end

function Level:unlock(ability: string, quiet: boolean?)
	self.ctl:setAbility(ability, true)
	Progress.unlockAbility(ability)
	-- wall jump comes with wall slide (they read as one move to players)
	if ability == "wall_jump" and not self.ctl:has("wall_slide") then
		self.ctl:setAbility("wall_slide", true)
		Progress.unlockAbility("wall_slide")
	end
	self.events:emit("powerup", ability)
	if not quiet then
		self:play("powerup")
		local msg = self.o.ability_names[ability] or (string.upper(string.gsub(ability, "_", " ")) .. "!")
		if self.hud then self.hud:showBanner(msg, 2.5) else ui.toast(msg, 2.5) end
	end
end

function Level:stats()
	local gems, found = {}, 0
	for k, v in self.gems do
		gems[k] = true
		found += 1
	end
	return { id = self.id, time = self.time, coins = self.coins, coinsTotal = self.coinsTotal, gems = gems, gemsFound = found, gemsTotal = self.gemsTotal, secrets = self.secrets, secretsTotal = self.secretsTotal, deaths = self.deaths }
end

function Level:complete()
	if self.done or self.dead then return end
	self.done = true
	self.ctl.frozen = true
	local st = self:stats()
	local res = Progress.completeLevel(self.id, st)
	self:play("clear")
	self.events:emit("complete", st, res)
	if self.hud then self.hud:showBanner(if res.newBest and not res.first then "NEW BEST " .. U.formatTime(st.time) else "LEVEL CLEAR!", nil) end
	self:later(self.o.complete_delay, function()
		if self.o.on_complete then
			self.o.on_complete(st, res)
		else
			loadScene(if World.has() then World.mapScene() else currentScene(), { completed = self.id })
		end
	end)
end

-- ---------- per tick ----------
function Level:readInput()
	local b = self.o.buttons
	local inp = {
		x = input.axis("move_x"), y = input.axis("move_y"),
		jump = input.pressed(b.jump), jumpHeld = input.held(b.jump),
		dash = input.pressed(b.dash), shoot = input.pressed(b.shoot),
	}
	if self.o.input then inp = self.o.input(inp) or inp end
	return inp
end

function Level:updatePlatforms(dt: number)
	local b = self.body
	for _, pl in self.platforms do
		local ox, oy = pl.x, pl.y
		if pl.falls then
			if b.ground == pl then pl.standT += dt end
			if pl.standT >= self.o.platform.fall_delay and not pl.disabled then
				pl.fallV = math.min(pl.fallV + 900 * dt, 400)
				pl.y += pl.fallV * dt
				if pl.y > self.tiles.oy + self.tiles.height + 64 then
					pl.disabled = true
					pl.e.visible = false
					self:later(self.o.platform.respawn, function()
						pl.disabled = false
						pl.e.visible = true
						pl.x, pl.y, pl.standT, pl.fallV = pl.x0, pl.y0, 0, 0
						pl.e.position = vec2(pl.x, pl.y)
					end)
				end
			end
		elseif pl.axis then
			pl.t += dt
			local w = math.pi * pl.speed / math.max(1, pl.range)
			local off = pl.range * (1 - math.cos(pl.t * w)) / 2
			if pl.axis == "x" then pl.x = pl.x0 + off else pl.y = pl.y0 - off end
		end
		local dx, dy = pl.x - ox, pl.y - oy
		if dx ~= 0 or dy ~= 0 then
			pl.e.position = vec2(pl.x, pl.y)
			local riders = { b }
			for _, en in self.enemies do table.insert(riders, en) end
			for _, a in riders do
				if a.ground == pl then
					self.tiles:moveX(a, dx)
					a.y = pl.y - pl.h / 2 - a.h / 2
					a.ground = pl
				end
			end
		end
	end
end

function Level:inView(x: number, y: number, margin: number): boolean
	if not self.cam then return true end
	return math.abs(x - self.cam.x) <= self.cam.hw + margin and math.abs(y - self.cam.y) <= self.cam.hh + margin
end

function Level:killEnemy(en, how: string)
	en.alive = false
	self:play("stomp")
	self:burst(en.x, en.y, 14, "#ffffff")
	self.events:emit("enemyKilled", en, how)
	if en.def.drops == "coin" then
		self.coins += 1
		self:play("coin")
	elseif en.def.drops == "heart" then
		self:heal(1)
	end
	local e = en.e
	if e then
		tween(e, { scale = vec2(1.3, 0.2) }, 0.15)
		self:later(0.18, function() if en.e then en.e:destroy() en.e = nil end end)
	end
end

function Level:tileEffects()
	local b, tiles = self.body, self.tiles
	local c0, r0 = tiles:cellOf(b.x - b.w / 2 + 1, b.y - b.h / 2 + 1)
	local c1, r1 = tiles:cellOf(b.x + b.w / 2 - 1.001, b.y + b.h / 2 - 1.001)
	for r = r0, r1 do
		for c = c0, c1 do
			for mi = 1, #tiles.maps do
				local inf = tiles:cell(mi, c, r)
				if inf then
					local t = inf.tags
					if t.coin then
						tiles:setTile(mi, c, r, nil)
						self.coins += 1
						self:play("coin", { pitch = 1 + (self.coins % 5) * 0.05 })
						self.events:emit("coin", self.coins)
					elseif t.gem then
						local idx = self.gemIndex[mi .. ":" .. c .. ":" .. r] or 0
						tiles:setTile(mi, c, r, nil)
						self.gems[idx] = true
						Progress.markGem(self.id, idx)
						self:play("gem")
						local x, y = tiles:cellCenter(c, r)
						self:burst(x, y, 20, "#7ff0ff")
						self.events:emit("gem", idx)
						if self.hud then self.hud:showBanner("GEM " .. self:stats().gemsFound .. "/" .. self.gemsTotal, 1.5) end
					elseif t.heart then
						tiles:setTile(mi, c, r, nil)
						self:heal(1)
						self:play("powerup")
						self.events:emit("heart")
					elseif t.powerup then
						local ability = otherTag(inf.list, MARKER_SKIP)
						tiles:setTile(mi, c, r, nil)
						if ability then self:unlock(ability) end
					elseif t.fake then
						local idx = self.secretIndex[c .. ":" .. r]
						if idx and not self.secrets[idx] then
							self.secrets[idx] = true
							self:play("gem")
							self.events:emit("secret", idx)
						end
					end
				end
			end
		end
	end
	-- hazards (slightly smaller box: forgiving)
	if not self.dead and (tiles:overlapTag(b, "hazard", 3) or tiles:overlapTag(b, "spike", 3)) then
		self:hurt(self.o.hazard_damage)
	end
end

function Level:tick(dt: number)
	local b, ctl, tiles = self.body, self.ctl, self.tiles
	if not self.done and not self.dead then self.time += dt end
	local inp = self:readInput()
	self:updatePlatforms(dt)

	-- player
	if not self.dead and not self.done then
		local prevBottom = b.y + b.h / 2
		self.prevBottom = prevBottom
		ctl:step(dt, inp, tiles)
		local ev = ctl.events
		if ev.jumped or ev.doubleJumped or ev.wallJumped then self:play("jump") end
		if type(ev.landed) == "number" and ev.landed > 200 then self:play("land") end
		if ev.dashed then self:play("dash") self:burst(b.x, b.y, 10, "#ffffff") end
		if ev.sprung then self:play("spring") self.events:emit("spring") end
		local function breakAt(cell)
			if not cell then return end
			local ok, mi = tiles:has(cell[1], cell[2], "breakable")
			if ok then
				tiles:setTile(mi, cell[1], cell[2], nil)
				local x, y = tiles:cellCenter(cell[1], cell[2])
				self:burst(x, y, 16, "#c08040")
				self:play("break")
				self.events:emit("break", cell[1], cell[2])
			end
		end
		if ev.bonked then breakAt(ev.bonked) end
		if ev.dashHit then breakAt(ev.dashHit) end
		-- shooting
		self.shotCd -= dt
		if inp.shoot and ctl:has("shoot") and self.shotCd <= 0 then
			local s = self.o.shot
			self.shotCd = s.cooldown
			self:shoot({ x = b.x + ctl.facing * 8, y = b.y - 1, vx = ctl.facing * s.speed, vy = 0, w = s.size[1], h = s.size[2], gravity = 0, life = s.life, damage = s.damage, owner = "player" })
			self:play("shoot")
		end
		if self.iframes > 0 then self.iframes -= dt end
		self:tileEffects()
		if b.y - b.h / 2 > tiles.oy + tiles.height + 32 then self:die("fall") end
	end

	-- enemies
	local ctx = {
		player = if self.dead then nil else b,
		shoot = function(p) self:shoot(p) end,
		summon = function(id, x, y) local en = self:addEnemy(id, x, y) en.vy = -150 end,
	}
	local margin = self.o.activation
	for i = #self.enemies, 1, -1 do
		local en = self.enemies[i]
		if en.alive then
			if self:inView(en.x, en.y, margin) then
				en:update(dt, tiles, ctx)
				if en.y - en.h / 2 > tiles.oy + tiles.height + 64 then en.alive = false end
			end
		elseif en.e == nil then
			table.remove(self.enemies, i)
		end
	end

	-- bosses
	for _, bs in self.bosses do
		if bs.alive then
			if not bs.awake then
				local room = self.cam and self.cam:roomAt(bs.x, bs.y)
				local inRoom = room ~= nil and room == self.cam:roomAt(b.x, b.y)
				if inRoom or U.dist(b.x, b.y, bs.x, bs.y) <= self.o.boss_wake then
					bs.awake = true
					if room and self.cam then self.cam:lock(room.x0, room.y0, room.x1, room.y1) end
					self.events:emit("bossStart", bs)
					if self.hud then self.hud:showBanner(string.upper(bs.name), 1.6) end
				end
			end
			if bs.awake and not self.dead then
				bs:update(dt, tiles, ctx)
				if bs.events.slam then juice.shake(5, 0.25) end
				if bs.events.anim and bs.e then pcall(bs.e.play, bs.e, bs.events.anim) end
			end
			if self.hud and bs.awake then self.hud:boss(bs.name, bs.hp / bs.maxHp) end
		end
	end

	-- projectiles
	for i = #self.projectiles, 1, -1 do
		local p = self.projectiles[i]
		p.life -= dt
		p.vy += (p.gravity or 0) * dt
		p.x += p.vx * dt
		p.y += p.vy * dt
		local c, r = tiles:cellOf(p.x, p.y)
		local remove = p.life <= 0 or (tiles:inBounds(c, r) and tiles:solidAt(c, r))
		if not remove then
			if p.owner == "player" then
				for _, en in self.enemies do
					if en.alive and en.def.shootable and U.overlap(p, en) then
						if en:damage(p.damage, p.x) then self:killEnemy(en, "shot") else self:play("stomp") end
						remove = true
						break
					end
				end
				if not remove then
					for _, bs in self.bosses do
						if bs.alive and bs.awake and bs.def.shootable and U.overlap(p, bs) then
							self:hitBoss(bs, p.damage)
							remove = true
						end
					end
				end
			elseif not self.dead and U.overlap(p, b, 1) then
				self:hurt(p.damage, p.x)
				remove = true
			end
		end
		if remove then removeProjectile(self, i) else p.e.position = vec2(p.x, p.y) end
	end

	-- contacts: enemies & bosses vs player
	if not self.dead and not self.done then
		for _, en in self.enemies do
			if en.alive and U.overlap(b, en, 1) then self:contact(en) end
		end
		for _, bs in self.bosses do
			if bs.alive and bs.awake and U.overlap(b, bs, 2) then self:contact(bs) end
		end
		-- checkpoints
		for _, cp in self.checkpoints do
			if not cp.active and U.overlap(b, cp) then
				for _, other in self.checkpoints do
					if other.active then
						other.active = false
						if self.o.art.checkpoint then other.e.texture = self.o.art.checkpoint end
					end
				end
				cp.active = true
				self.spawnX, self.spawnY = cp.spawnX, cp.spawnY
				if self.o.art.checkpoint_on then cp.e.texture = self.o.art.checkpoint_on else cp.e.modulate = "#60e070" end
				self:heal(self.maxHealth)
				self:play("checkpoint")
				self.events:emit("checkpoint", cp)
			end
		end
		for _, g in self.goals do
			if U.overlap(b, g) then self:complete() end
		end
	end

	self:sync(dt)
end

function Level:hitBoss(bs, n: number)
	local killed, phase = bs:damage(n, self.body.x)
	if killed then
		self:play("boss_defeat")
		self:burst(bs.x, bs.y, 40, "#ffe060")
		juice.shake(10, 0.6)
		if self.cam then self.cam:unlock() end
		if self.hud then self.hud:boss(nil) end
		self.events:emit("bossDefeated", bs)
		if bs.e then
			tween(bs.e, { scale = vec2(0.1, 0.1), rotation = 360 }, 0.8)
			self:later(0.85, function() if bs.e then bs.e:destroy() bs.e = nil end end)
		end
		if self.o.boss_completes then self:later(1.2, function() self:complete() end) end
	elseif bs.iframes > 0 then
		self:play("boss_hit")
		if phase then
			juice.shake(6, 0.4)
			self.events:emit("bossPhase", bs, bs.phase)
		end
	end
	return killed
end

function Level:contact(en)
	local b = self.body
	local falling = b.vy > 0 or (self.prevBottom ~= nil and b.y + b.h / 2 > self.prevBottom)
	local fromAbove = (self.prevBottom or b.y + b.h / 2) <= en.y - en.h / 2 + 6
	if en.def.stompable and falling and fromAbove then
		b.y = en.y - en.h / 2 - b.h / 2
		self.ctl:bounce(if input.held(self.o.buttons.jump) then self.o.stomp_height_held else self.o.stomp_height)
		if en.isBoss then
			self:hitBoss(en, en.def.stomp_damage or 1)
		elseif en:damage(en.def.stomp_damage or 1, b.x) then
			self:killEnemy(en, "stomp")
		else
			self:play("stomp")
		end
		self.events:emit("stomp", en)
		return
	end
	if en.def.contact ~= false and (en.def.damage or 1) > 0 then
		self:hurt(en.def.damage or 1, en.x)
	end
end

local function anyAnim(self, key)
	local name = self.o.anims[key]
	if name and self.sprite then
		pcall(self.player.play, self.player, name)
	end
end

-- write simulation state to entities (positions, flips, anims, HUD, camera)
function Level:sync(dt: number?)
	local b, ctl = self.body, self.ctl
	local off = self.o.player_offset
	self.player.position = vec2(b.x + off[1], b.y + off[2])
	if not self.dead then
		self.player.visible = self.iframes <= 0 or math.floor(self.iframes * 14) % 2 == 0
	end
	if self.sprite then
		local flip = ctl.facing < 0
		if self.sprite.flip_h ~= flip then self.sprite.flip_h = flip end
	end
	-- player animation state
	local st
	if self.dead then st = "hurt"
	elseif ctl.climbing then st = "climb"
	elseif ctl.dashT > 0 then st = "dash"
	elseif not ctl.grounded and ctl.wallDir ~= 0 and b.vy > 0 and ctl:has("wall_slide") then st = "wall"
	elseif not ctl.grounded then st = if b.vy < 0 then "jump" else "fall"
	elseif math.abs(b.vx) > 10 then st = "run"
	else st = "idle" end
	if st ~= self.animState then
		self.animState = st
		anyAnim(self, st)
	end
	for _, en in self.enemies do
		if en.e then
			en.e.position = vec2(en.x, en.y)
			local flip = en.dir < 0
			if en.def.faces == "left" then flip = not flip end
			if en.e.flip_h ~= flip then en.e.flip_h = flip end
			if en.def.anims and en.def.animset and en.state ~= en.animState then
				en.animState = en.state
				local name = en.def.anims[en.state] or en.def.anims.move
				if name then pcall(en.e.play, en.e, name) end
			end
		end
	end
	for _, bs in self.bosses do
		if bs.e then
			bs.e.position = vec2(bs.x, bs.y)
			local flip = bs.dir < 0
			if bs.def.faces == "left" then flip = not flip end
			if bs.e.flip_h ~= flip then bs.e.flip_h = flip end
			bs.e.visible = bs.iframes <= 0 or math.floor(bs.iframes * 14) % 2 == 0
		end
	end
	if self.cam and dt then
		self.cam:update(dt, b, ctl.facing, ctl.grounded)
	end
	if self.cam then self.parallax:update(self.cam.x, self.cam.y) end
	if self.hud then
		local st2 = self:stats()
		self.hud:setHearts(math.max(0, self.health), self.maxHealth)
		self.hud:set({ coins = st2.coins, coinsTotal = st2.coinsTotal, gems = st2.gemsFound, gemsTotal = st2.gemsTotal, time = self.time, lives = self.lives })
	end
end

return Level
