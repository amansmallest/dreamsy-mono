--!nonstrict
-- Runtime: a run (session: lives, bombs, weapon, score, credits) and play(run, stageId) (one stage in the current scene:
-- player ship, input, weapons, enemies, emitters, bosses, pickups, collisions via the combat kit, HUD).
local core = require("@kit/core")
local juice = require("@kit/juice")
local combat = require("@kit/combat")
local ai = require("@kit/ai")
local procgen = require("@kit/procgen")
local Content = require("./content")
local Emitter = require("./emitter")
local Motion = require("./motion")
local Weapons = require("./weapons")
local Score = require("./score")
local Stage = require("./stage")
local Boss = require("./boss")
local Hud = require("./hud")

local M = {}
M.events = core.events.new() -- private bus: kill, hit, death, pickup, bomb, boss_phase, stage_clear, game_over, extend
local current = nil -- the playing stage controller

---------------------------------------------------------------- persistent meta (saved): unlocks, best scores
M.meta = { ships = {}, best = {}, highScore = 0, cleared = {} }
local sectionDone = false
local function ensureSection()
	if sectionDone then return end
	sectionDone = true
	core.save.section("shooter", {
		serialize = function() return M.meta end,
		deserialize = function(_, t)
			M.meta = { ships = {}, best = {}, highScore = 0, cleared = {} }
			for k, v in t or {} do M.meta[k] = v end
		end,
		reset = function() M.meta = { ships = {}, best = {}, highScore = 0, cleared = {} } end,
	})
end
M.ensureSection = ensureSection

---------------------------------------------------------------- run
--[[ newRun(opts?) -> run
   opts: { ship = id (default config.startShip), lives?, bombs?, continues?, seed = 1, content = C? }
   run: { C, ship (def), lives, bombs, continues, weapon (Weapons instance), sub (orbital/homing option or nil), score (Score),
          stageIndex, results = {}, seed } ]]
function M.newRun(opts)
	opts = opts or {}
	ensureSection()
	local C = opts.content or Content.load()
	local cfg = C.config
	core.wallet.define(cfg.currency, { name = cfg.currencyName or "Credits", start = 0, max = 9999999 })
	local shipId = opts.ship or cfg.startShip
	local ship = C.ships[shipId]
	assert(ship, `shooter: unknown ship "{tostring(shipId)}"`)
	local run = { C = C, shipId = shipId, ship = ship, lives = opts.lives or ship.lives or cfg.lives, bombs = opts.bombs or ship.bombs or cfg.bombs,
		continues = opts.continues or cfg.continues, stageIndex = 1, results = {}, seed = opts.seed or 1, continued = 0 }
	local wid = ship.weapon or C.weaponsOrder[1]
	run.weapon = Weapons.new(C.weapons[wid], 1)
	run.weaponId = wid
	if ship.sub and C.weapons[ship.sub] then run.sub = Weapons.new(C.weapons[ship.sub], 1) run.subId = ship.sub end
	local sc = cfg.score
	run.score = Score.new({ comboWindow = sc.comboWindow, multEvery = sc.multEvery, maxMult = sc.maxMult, grazePoints = sc.grazePoints,
		extends = sc.extends, onExtend = function(n)
			run.lives += 1
			M.events:emit("extend", { lives = run.lives })
			juice.sfx("extend")
			if current and current.hud then current.hud:banner("EXTEND!", 1.2) end
		end })
	function run.setWeapon(self, id, keepLevel)
		local lvl = if keepLevel ~= false then self.weapon.level else 1
		self.weapon = Weapons.new(self.C.weapons[id], lvl)
		self.weaponId = id
	end
	function run.nextStage(self) return self.C.config.campaign[self.stageIndex] end
	return run
end

-- shop: buy(run, itemId) -> ok, reason ("max" | "credits" | "unknown")
--[[ config.shop items: { id, name, cost, max? (per run), effect = { power = 1 } | { life = 1 } | { bomb = 1 } | { weapon = "spread" }
                         | { sub = "orbit" } | { continue = 1 } } ]]
function M.shopItems(run)
	local out = {}
	for _, it in run.C.config.shop do
		local bought = (run.bought and run.bought[it.id]) or 0
		local ok, why = M.canBuy(run, it.id)
		table.insert(out, { id = it.id, def = it, bought = bought, ok = ok, reason = why })
	end
	return out
end
local function shopDef(run, id) for _, it in run.C.config.shop do if it.id == id then return it end end return nil end
function M.canBuy(run, id)
	local it = shopDef(run, id)
	if not it then return false, "unknown" end
	run.bought = run.bought or {}
	if it.max and (run.bought[id] or 0) >= it.max then return false, "max" end
	local e = it.effect or {}
	if e.power and run.weapon:isMax() then return false, "max" end
	if e.bomb and run.bombs >= run.C.config.maxBombs then return false, "max" end
	if e.weapon and run.weaponId == e.weapon then return false, "owned" end
	if not core.wallet.has(run.C.config.currency, it.cost or 0) then return false, "credits" end
	return true, nil
end
function M.buy(run, id)
	local ok, why = M.canBuy(run, id)
	if not ok then return false, why end
	local it = shopDef(run, id)
	core.wallet.spend(run.C.config.currency, it.cost or 0)
	run.bought[id] = (run.bought[id] or 0) + 1
	local e = it.effect or {}
	if e.power then run.weapon:upgrade(e.power) end
	if e.life then run.lives += e.life end
	if e.bomb then run.bombs = math.min(run.C.config.maxBombs, run.bombs + e.bomb) end
	if e.weapon then run:setWeapon(e.weapon) end
	if e.sub then run.sub = Weapons.new(run.C.weapons[e.sub], 1) run.subId = e.sub end
	if e.continue then run.continues += e.continue end
	M.events:emit("bought", { item = id })
	return true
end

-- ship unlocks (saved): ships with `cost` (credits) or `unlock = { score = n }` / `{ clear = "stage_id" }`
function M.shipState(C, id)
	local s = C.ships[id]
	if M.meta.ships[id] or (s.cost == nil and s.unlock == nil) then return "owned" end
	if s.unlock then
		if s.unlock.score and M.meta.highScore >= s.unlock.score then return "owned" end
		if s.unlock.clear and M.meta.cleared[s.unlock.clear] then return "owned" end
		if s.cost == nil then return "locked" end
	end
	return if core.wallet.has(C.config.currency, s.cost or 0) then "buyable" else "locked"
end
function M.unlockShip(C, id)
	local st = M.shipState(C, id)
	if st == "owned" then return true end
	if st ~= "buyable" then return false end
	core.wallet.spend(C.config.currency, C.ships[id].cost or 0)
	M.meta.ships[id] = true
	pcall(core.save.save)
	return true
end

---------------------------------------------------------------- combat routing (one listener set for the whole game)
local wired = false
local function wire()
	if wired then return end
	wired = true
	combat.on("death", function(f, info) if current and not current.over then current:_death(f, info) end end)
	combat.on("hit", function(info) if current and not current.over then current:_hit(info) end end)
end

local function dist2(ax, ay, bx, by) return (ax - bx) ^ 2 + (ay - by) ^ 2 end
local function alive(e) return e ~= nil and not e.destroyed end

--[[ play(run, stageId, opts?) -> controller
   opts: { autoFire? (config.autoFire), onClear(result), onGameOver(result), hud = true, seed?,
           bounds? {x0,y0,x1,y1} (shmup ship area; default 40,150 .. 680,990 — keeps the ship above the thumb zone) }
   result: { stage, score, kills, bestCombo, grazes, credits (earned), time, deaths, noMiss, cleared }
   controller: { run, stage (def), runner (Stage), player (Entity), fighter, enemies, boss, t, over, hud,
                 bomb(), clearBullets(), spawnEnemy(id, x, y, path?), spawnPickup(kind, x, y), finish(cleared) } ]]
function M.play(run, stageId, opts)
	opts = opts or {}
	wire()
	local C = run.C
	local cfg = C.config
	local def = C.stages[stageId]
	assert(def, `shooter: unknown stage "{tostring(stageId)}"`)
	combat.reset()
	combat.setup({ flash = false, tint = false }) -- the kit flashes sprites itself (combat's red tint would stick under constant fire)
	local mode = def.mode or "shmup"
	local W, H = def.width or 720, def.height or 1280
	local rng = procgen.rng((opts.seed or run.seed) * 101 + run.stageIndex)
	local autoFire = if opts.autoFire ~= nil then opts.autoFire else cfg.autoFire
	local ctl = { run = run, stage = def, stageId = stageId, mode = mode, t = 0, enemies = {}, pickups = {}, ebullets = {}, curved = {},
		over = false, deaths = 0, credits = 0, kills0 = run.score.kills, score0 = run.score.score, orbSprites = {}, orbHits = {}, beamHits = {} }
	current = ctl
	ctl.runner = Stage.new(def, C.enemies, procgen)
	if def.music then pcall(music.play, def.music) end

	---------------------------------------------------------------- world
	local world = spawn("Node2D", { position = vec2(0, 0) })
	ctl.world = world
	local bgs = {}
	if mode == "shmup" then
		for i = 0, 1 do
			local props = { position = vec2(360, 640 - i * 1280), size = vec2(720, 1280), z_index = -100, modulate = color(def.bgColor or "#101828") }
			if def.background then props.texture = def.background props.modulate = color("#ffffff") end
			props.flip_v = i == 1 -- mirrored copy: seamless vertical scroll for any background
			table.insert(bgs, spawn("Sprite2D", props, world))
		end
	else
		local props = { position = vec2(W / 2, H / 2), size = vec2(W, H), z_index = -100, modulate = color(def.bgColor or "#1b2233") }
		if def.background then props.texture = def.background props.modulate = color("#ffffff") end
		spawn("Sprite2D", props, world)
		-- arena border
		local bc = color(def.borderColor or "#5ad1ff")
		for _, r in { { W / 2, -4, W + 16, 8 }, { W / 2, H + 4, W + 16, 8 }, { -4, H / 2, 8, H }, { W + 4, H / 2, 8, H } } do
			spawn("Sprite2D", { position = vec2(r[1], r[2]), size = vec2(r[3], r[4]), modulate = bc, z_index = -90 }, world)
		end
	end
	-- parallax specks (stars / dust)
	local specks = {}
	for i = 1, def.specks or 36 do
		local layer = (i % 3) + 1
		local sz = layer * 1.5 + 1
		local e = spawn("Sprite2D", { position = vec2(rng:range(0, W), rng:range(0, H)), size = vec2(sz, sz),
			modulate = color(def.speckColor or "#ffffff"), z_index = -95 + layer }, world)
		e.modulate = color((def.speckColor or "#ffffff") .. (if layer == 1 then "55" elseif layer == 2 then "88" else "cc"))
		table.insert(specks, { e = e, speed = layer * 0.6 })
	end

	---------------------------------------------------------------- player
	local ship = run.ship
	local b = opts.bounds or (if mode == "shmup" then { 40, 150, 680, 990 } else { 30, 30, W - 30, H - 30 })
	local startX, startY = if mode == "shmup" then 360 else W / 2, if mode == "shmup" then 900 else H / 2
	local player = spawn("Sprite2D", { position = vec2(startX, startY), size = vec2((ship.size and ship.size[1]) or 72, (ship.size and ship.size[2]) or 72),
		texture = ship.sprite, z_index = 20 }, world)
	player:addTag("player")
	ctl.player = player
	local core_ = spawn("Sprite2D", { position = vec2(0, 0), size = vec2(10, 10), modulate = color("#ffffff"), z_index = 1 }, player)
	core_.visible = mode == "shmup"
	local pf = combat.add(player, { hp = ship.hp or 1, team = "player", iframes = ship.iframes or 2, radius = ship.hitbox or 7, destroyOnDeath = false })
	ctl.fighter = pf
	pf.iframeT = 1.5
	local cam = nil
	if mode == "arena" then
		cam = spawn("Camera2D", { follow = player, smoothing = 0.15, limit_min = vec2(-40, -40), limit_max = vec2(W + 40, H + 40) })
	end
	local beam = spawn("Sprite2D", { size = vec2(1, 1), modulate = color("#7ff3ff"), z_index = 15 }, world)
	beam.visible = false

	---------------------------------------------------------------- hud
	if opts.hud ~= false then ctl.hud = Hud.new(ctl, { title = def.name }) end

	---------------------------------------------------------------- bullets
	local function enemyShot(s, style)
		local bdef = s.bullet or style or {}
		local ang = s.angle
		local sp = s.speed
		local sz = bdef.size or { 18, 18 }
		local p = combat.shoot({ x = s.x, y = s.y, angle = ang, speed = sp, source = "enemy", amount = bdef.damage or 1, radius = bdef.radius or 6,
			lifetime = bdef.lifetime or 8, sprite = bdef.sprite, color = if bdef.sprite then (bdef.color or "#ffffff") else (bdef.color or "#ff6b8a"), size = sz, z = 12,
			pool = "eb_" .. tostring(bdef.sprite or bdef.color or "x"), rotate = bdef.rotate == true, parent = world })
		local age = s.age or 0
		if age > 0 then p.x += p.vx * age p.y += p.vy * age end
		local rec = { p = p, b = bdef, age = age, a0 = ang, s0 = sp }
		table.insert(ctl.ebullets, rec)
		if Motion.dynamic(bdef) then rec.curved = true end
		return p
	end
	function ctl.clearBullets(self, toScore)
		for _, r in self.ebullets do
			if not r.p.done then
				if toScore then juice.sparkle(vec2(r.p.x, r.p.y), { n = 2, color = "#ffe066" }) run.score:add(10) end
				r.p.cancel()
			end
		end
		self.ebullets = {}
	end

	---------------------------------------------------------------- enemies
	local function emitterList(d)
		local out = {}
		for _, e in d.emitters or {} do
			local ed = if type(e) == "string" then C.emitters[e] else e
			table.insert(out, Emitter.new(ed))
		end
		return out
	end
	function ctl.spawnEnemy(self, id, x, y, path)
		local d = C.enemies[id]
		assert(d, `shooter: unknown enemy "{tostring(id)}"`)
		local sz = d.size or { 64, 64 }
		local e = spawn("Sprite2D", { position = vec2(x, y), size = vec2(sz[1], sz[2]), texture = d.sprite, z_index = 10,
			modulate = if d.sprite then color("#ffffff") else color(d.color or "#ff5d73") }, world)
		local f = combat.add(e, { hp = d.hp or 1, team = "enemy", radius = d.radius or (sz[1] * 0.4), contact = { amount = 1 }, destroyOnDeath = false })
		local rec = { e = e, f = f, def = d, t = 0, x0 = x, y0 = y, path = path or d.path, ems = emitterList(d), id = id }
		if d.behavior or (mode == "arena" and not (path or d.path)) then
			rec.brain = ai.brain(if d.behavior then d else { behavior = "chase", speed = d.speed or 90, aggro = 4000, leash = 99999 })
			rec.agent = { x = x, y = y, vx = 0, vy = 0, radius = 8 }
		end
		table.insert(self.enemies, rec)
		return rec
	end
	local function spawnBoss(id, x, y)
		local d = C.enemies[id]
		local sz = d.size or { 220, 160 }
		local e = spawn("Sprite2D", { position = vec2(x, y), size = vec2(sz[1], sz[2]), texture = d.sprite, z_index = 11 }, world)
		local f = combat.add(e, { hp = d.hp or 100, team = "enemy", radius = d.radius or sz[1] * 0.35, contact = { amount = 1 }, destroyOnDeath = false })
		local bx = if mode == "shmup" then 360 else x
		local bb = Boss.new(d, C.emitters, ai, { x = bx, y = y, bounds = if mode == "arena" then { 60, 60, W - 60, H - 60 } else nil,
			enter = if mode == "arena" then false else nil })
		ctl.boss = { e = e, f = f, def = d, b = bb, id = id }
		if ctl.hud then ctl.hud:bossBar(d.name or id) ctl.hud:banner("WARNING", 1.6) end
		juice.sfx("warning")
		if d.music then pcall(music.play, d.music) end
	end

	---------------------------------------------------------------- pickups
	--[[ kinds: power, bomb, life, coin (credits), score, weapon:<id> ]]
	local PICK = { power = { "#ffd34d", "P" }, bomb = { "#ff7a59", "B" }, life = { "#7dff9a", "1UP" }, coin = { "#ffe066", "" }, score = { "#9ad0ff", "" } }
	function ctl.spawnPickup(self, kind, x, y)
		local sprite = cfg.pickups and cfg.pickups[kind]
		local look = PICK[kind] or { "#c39bff", "W" }
		local sz = if kind == "coin" then 28 else 44
		local e = spawn("Sprite2D", { position = vec2(x, y), size = vec2(sz, sz), z_index = 14,
			texture = sprite, modulate = if sprite then color("#ffffff") else color(look[1]) }, world)
		table.insert(self.pickups, { e = e, kind = kind, t = 0, vy = -120, x = x, y = y })
	end
	local function collect(pk)
		local k = pk.kind
		if k == "power" then
			if not run.weapon:upgrade(1) then run.score:add(1000) juice.popup("MAX", pk.e.position, { color = "#ffd34d", size = 28 })
			else juice.popup("POWER UP", pk.e.position, { color = "#ffd34d", size = 28 }) end
		elseif k == "bomb" then run.bombs = math.min(cfg.maxBombs, run.bombs + 1)
		elseif k == "life" then run.lives += 1
		elseif k == "coin" then core.wallet.add(cfg.currency, 1) ctl.credits += 1
		elseif k == "score" then run.score:add(500)
		elseif string.sub(k, 1, 7) == "weapon:" then run:setWeapon(string.sub(k, 8)) juice.popup(string.upper(string.sub(k, 8)), pk.e.position, { color = "#c39bff" })
		end
		juice.sfx(if k == "coin" then "coin" else "powerup")
		M.events:emit("pickup", { kind = k })
		pk.e:destroy()
	end
	local function drops(d, x, y)
		local dr = d.drops or {}
		if dr.power and rng:chance(dr.power) then ctl:spawnPickup("power", x, y) end
		if dr.bomb and rng:chance(dr.bomb) then ctl:spawnPickup("bomb", x, y) end
		if dr.life and rng:chance(dr.life) then ctl:spawnPickup("life", x, y) end
		for _ = 1, dr.coins or 0 do ctl:spawnPickup("coin", x + rng:range(-30, 30), y + rng:range(-30, 30)) end
	end

	---------------------------------------------------------------- deaths / hits
	function ctl._hit(self, info)
		if info.target == pf and (info.dealt or 0) > 0 then
			run.score:hit()
		elseif info.target ~= pf and (info.dealt or 0) > 0 then
			if info.target.entity and not info.target.entity.destroyed then juice.flash(info.target.entity, "#ffc2cf", 0.06) end
		end
	end
	local function explode(pos, big)
		juice.emitter(pos, { speed = if big then 320 else 180, spread = 360, lifetime = if big then 0.9 else 0.45, start_size = if big then 18 else 10, end_size = 0,
			start_color = color("#ffd34d"), end_color = color("#ff4d4d00"), shape = "circle" }, if big then 60 else 14)
		juice.sfx(if big then "boom" else "pop")
	end
	function ctl._death(self, f, info)
		if f == pf then
			self.deaths += 1
			run.lives -= 1
			explode(player.position, true)
			juice.shake("heavy")
			M.events:emit("death", { lives = run.lives })
			self:clearBullets(false)
			-- lose one power level, drop it as a pickup to win back
			if run.weapon.level > 1 then run.weapon:upgrade(-1) self:spawnPickup("power", player.position.x, player.position.y - 120) end
			player.visible = false
			after(1.0, function()
				if self.over then return end
				if run.lives > 0 then
					f.dead = false
					f.hp = f.maxHp
					f.iframeT = 2.5
					player.visible = true
					player.position = vec2(startX, startY)
					run.bombs = math.max(run.bombs, cfg.bombs)
				else
					self:_gameOver()
				end
			end)
			return
		end
		if self.boss and f == self.boss.f then
			local bd = self.boss.def
			run.score:add(bd.score or 10000)
			explode(self.boss.e.position, true)
			juice.shake("explosion")
			juice.hitstop(0.12)
			self:clearBullets(true)
			drops(bd, self.boss.e.position.x, self.boss.e.position.y)
			M.events:emit("boss_defeated", { boss = self.boss.id })
			local e = self.boss.e
			after(0.3, function() if alive(e) then e:destroy() end end)
			if self.hud then self.hud:bossBar(nil) end
			self.boss = nil
			return
		end
		for i, r in self.enemies do
			if r.f == f then
				local pos = r.e.position
				local gained = run.score:kill(r.def.score or 100)
				juice.popup(tostring(gained), pos, { color = "#ffffff", size = 24, rise = 40, seconds = 0.5 })
				explode(pos, false)
				drops(r.def, pos.x, pos.y)
				M.events:emit("kill", { enemy = r.id, score = gained })
				r.e:destroy()
				table.remove(self.enemies, i)
				break
			end
		end
	end
	function ctl._gameOver(self)
		if run.continues > 0 and opts.noContinue ~= true then
			core.menus.confirm("Continue? (" .. run.continues .. " left)", function()
				run.continues -= 1
				run.continued += 1
				run.lives = run.ship.lives or cfg.lives
				run.bombs = cfg.bombs
				pf.dead = false
				pf.hp = pf.maxHp
				pf.iframeT = 3
				player.visible = true
				player.position = vec2(startX, startY)
				M.events:emit("continue", { left = run.continues })
			end, function() self:finish(false) end, { yes = "Continue", no = "Give up", title = "GAME OVER" })
		else
			self:finish(false)
		end
	end

	function ctl.result(self, cleared)
		return { stage = stageId, cleared = cleared, score = run.score.score, stageScore = run.score.score - self.score0,
			kills = run.score.kills - self.kills0, bestCombo = run.score.bestCombo, grazes = run.score.grazes, credits = self.credits,
			time = self.t, deaths = self.deaths, noMiss = self.deaths == 0 }
	end
	function ctl.finish(self, cleared)
		if self.over then return end
		self.over = true
		local reward = (def.reward and def.reward.credits) or 0
		if cleared then
			if self.deaths == 0 then reward += (def.reward and def.reward.noMiss) or 0 end
			core.wallet.add(cfg.currency, reward)
			self.credits += reward
			M.meta.cleared[stageId] = true
			run.stageIndex += 1
		end
		M.meta.best[stageId] = math.max(M.meta.best[stageId] or 0, run.score.score - self.score0)
		M.meta.highScore = math.max(M.meta.highScore, run.score.score)
		local res = self:result(cleared)
		table.insert(run.results, res)
		pcall(core.save.save)
		beam.visible = false
		M.events:emit(if cleared then "stage_clear" else "game_over", res)
		if self.hud then self.hud:banner(if cleared then "STAGE CLEAR" else "GAME OVER", 2) end
		if cleared then juice.sfx("clear") juice.confetti() end
		after(if cleared then 2 else 1.5, function()
			if cleared then
				if opts.onClear then opts.onClear(res) end
			else
				if opts.onGameOver then opts.onGameOver(res) end
			end
		end)
	end

	function ctl.bomb(self)
		if run.bombs <= 0 or pf.dead or self.over then return false end
		run.bombs -= 1
		self:clearBullets(true)
		juice.shake("explosion")
		explode(player.position, true)
		for _, r in table.clone(self.enemies) do if not r.f.dead then combat.damage(r.f, { amount = cfg.bombDamage or 30, source = pf }) end end
		if self.boss then combat.damage(self.boss.f, { amount = cfg.bombBossDamage or 20, source = pf }) end
		pf.iframeT = math.max(pf.iframeT, 2)
		M.events:emit("bomb", { left = run.bombs })
		juice.sfx("bomb")
		return true
	end

	---------------------------------------------------------------- aim (arena: look stick > nearest enemy > movement)
	local lastAim = -90
	local function aimAngle(px, py, mx, my)
		if mode == "shmup" then return -90 end
		local lx, ly = input.axis("look_x"), input.axis("look_y")
		if lx * lx + ly * ly > 0.09 then lastAim = math.deg(math.atan2(ly, lx)) return lastAim end
		local best, bd = nil, (cfg.autoAimRange or 650) ^ 2
		for _, r in ctl.enemies do
			local d = dist2(px, py, r.e.position.x, r.e.position.y)
			if d < bd then best, bd = r, d end
		end
		if ctl.boss then
			local d = dist2(px, py, ctl.boss.e.position.x, ctl.boss.e.position.y)
			if d < bd then best = ctl.boss end
		end
		if best then lastAim = math.deg(math.atan2(best.e.position.y - py, best.e.position.x - px))
		elseif mx * mx + my * my > 0.04 then lastAim = math.deg(math.atan2(my, mx)) end
		return lastAim
	end

	---------------------------------------------------------------- tick
	local function playerFire(dt, firing)
		local p = player.position
		local aim = aimAngle(p.x, p.y, input.axis("move_x"), input.axis("move_y"))
		local wd = run.weapon.def
		local out = run.weapon:update(dt, firing and not pf.dead, p.x, p.y - (if mode == "shmup" then 30 else 0), aim)
		local function fireShots(shots, def_)
			for _, s in shots do
				local sz = def_.size or { 12, 28 }
				combat.shoot({ x = s.x, y = s.y, angle = s.angle, speed = s.speed, source = pf, amount = s.damage, pierce = s.pierce,
					homing = s.homing, homingRange = s.homingRange, radius = s.radius, lifetime = s.lifetime, sprite = def_.sprite,
					color = if def_.sprite then "#ffffff" else (def_.color or "#9ff3ff"), size = sz, pool = "pw_" .. tostring(def_.id), z = 13, parent = world })
			end
			if #shots > 0 and def_.sfx then juice.sfx(def_.sfx, { volume = 0.35 }) end
		end
		fireShots(out.shots, wd)
		-- laser
		if out.beam then
			local bm = out.beam
			local r = math.rad(bm.angle)
			local dx, dy = math.cos(r), math.sin(r)
			beam.visible = true
			beam.position = vec2(bm.x + dx * bm.length / 2, bm.y + dy * bm.length / 2)
			beam.size = vec2(bm.length, bm.width)
			beam.rotation = bm.angle
			if wd.color then beam.modulate = color(wd.color) end
			ctl.beamT = (ctl.beamT or 0) - dt
			if ctl.beamT <= 0 then
				ctl.beamT = bm.tick
				local targets = {}
				for _, rr in ctl.enemies do table.insert(targets, rr.f) end
				if ctl.boss then table.insert(targets, ctl.boss.f) end
				for _, f in targets do
					if not f.dead then
						local fx, fy = f:pos()
						local along = (fx - bm.x) * dx + (fy - bm.y) * dy
						local perp = math.abs((fx - bm.x) * dy - (fy - bm.y) * dx)
						if along > 0 and along < bm.length and perp < bm.width / 2 + f.radius then
							combat.damage(f, { amount = math.max(1, bm.dps * bm.tick), source = pf })
						end
					end
				end
			end
		else
			beam.visible = false
		end
		-- sub weapon (orbitals / homing options)
		if run.sub then
			local so = run.sub:update(dt, firing and not pf.dead, p.x, p.y, aim)
			fireShots(so.shots, run.sub.def)
			local orbs = so.orbs or {}
			for i, o in orbs do
				local e = ctl.orbSprites[i]
				if not alive(e) then
					e = spawn("Sprite2D", { size = vec2(o.radius * 2, o.radius * 2), texture = run.sub.def.sprite, modulate = color(run.sub.def.color or "#ffffff"), z_index = 19 }, world)
					ctl.orbSprites[i] = e
				end
				e.visible = not pf.dead
				e.position = vec2(o.x, o.y)
				if not pf.dead then
					for _, f in combat.query(o.x, o.y, o.radius, { hostileTo = pf }) do
						local last = ctl.orbHits[f]
						if last == nil or ctl.t - last >= run.sub:stats().orbHitEvery then
							ctl.orbHits[f] = ctl.t
							combat.damage(f, { amount = o.damage, source = pf })
						end
					end
					if run.sub:stats().blocks then
						for _, rr in ctl.ebullets do
							if not rr.p.done and dist2(rr.p.x, rr.p.y, o.x, o.y) < (o.radius + 6) ^ 2 then rr.p.cancel() end
						end
					end
				end
			end
		end
	end

	local function updateEnemies(dt)
		local pp = player.position
		local tgt = if pf.dead then nil else { x = pp.x, y = pp.y }
		for i = #ctl.enemies, 1, -1 do
			local r = ctl.enemies[i]
			if r.e.destroyed or r.f.dead then
				if not r.e.destroyed and r.f.dead then r.e:destroy() end
				table.remove(ctl.enemies, i)
			else
				r.t += dt
				local x, y
				if r.brain then
					local acts = ai.step(r.brain, r.agent, { target = tgt, sight = false, rand = function() return rng:next() end }, dt)
					r.agent.x = math.clamp(r.agent.x, 20, W - 20)
					r.agent.y = math.clamp(r.agent.y, 20, H - 20)
					x, y = r.agent.x, r.agent.y
					for _, a in acts do
						if a.name == "shoot" and tgt then
							local d = a.data or {}
							enemyShot({ x = x, y = y, angle = math.deg(math.atan2(tgt.y - y, tgt.x - x)), speed = (r.def.bullet and r.def.bullet.speed) or 220, age = 0 }, r.def.bullet)
						end
					end
				else
					if r.path and r.path.kind == "dive" and r.lockX == nil and r.t >= (r.path.at or 1.2) then r.lockX = pp.x end
					x, y = Motion.path(r.path, r.t, r.x0, r.y0, { lockX = r.lockX })
				end
				r.e.position = vec2(x, y)
				local onScreen = x > -40 and x < W + 40 and y > -20 and y < H + 40
				if onScreen and not pf.dead then
					for _, em in r.ems do
						for _, s in em:update(dt, { x = x, y = y, tx = pp.x, ty = pp.y }) do enemyShot(s, r.def.bullet) end
					end
				end
				if r.t > 1.5 and (y > H + 120 or y < -300 or x < -200 or x > W + 200) then
					combat.remove(r.f)
					r.e:destroy()
					table.remove(ctl.enemies, i)
				end
			end
		end
		-- boss
		local bs = ctl.boss
		if bs then
			local out = bs.b:update(dt, tgt, bs.f.hp)
			bs.e.position = vec2(bs.b.agent.x, bs.b.agent.y)
			if bs.b.entering then pcall(function() bs.f.iframeT = 0.2 end) end
			if out.phase and out.phase > 1 then
				ctl:clearBullets(true)
				juice.shake("medium")
				juice.flash(bs.e, "#ffffff", 0.2)
				M.events:emit("boss_phase", { boss = bs.id, phase = out.phase })
				if ctl.hud then ctl.hud:banner("PHASE " .. out.phase, 0.9) end
			end
			if not pf.dead then for _, s in out.shots do enemyShot(s, bs.def.bullet) end end
			for _, sm in out.summons do ctl:spawnEnemy(sm.id, sm.x, sm.y) end
			if ctl.hud then ctl.hud:bossFill(bs.f.hp / bs.f.maxHp) end
		end
	end

	local function updateBullets(dt)
		local pp = player.position
		local graze2 = (cfg.grazeRadius or 26) ^ 2
		for i = #ctl.ebullets, 1, -1 do
			local r = ctl.ebullets[i]
			local p = r.p
			if p.done then
				table.remove(ctl.ebullets, i)
			else
				r.age += dt
				if r.curved then
					local vx, vy = Motion.velocity(r.b, r.age, r.a0, r.s0)
					p.vx, p.vy = vx, vy
				end
				if p.x < -60 or p.x > W + 60 or p.y < -120 or p.y > H + 60 then
					p.cancel()
					table.remove(ctl.ebullets, i)
				elseif not r.grazed and not pf.dead and dist2(p.x, p.y, pp.x, pp.y) < graze2 then
					r.grazed = true
					run.score:graze(1)
				end
			end
		end
	end

	onTick(function(dt)
		if ctl.over and ctl.overT then return end
		if core.pause.isPaused() or juice.stopped() then return end
		if not alive(player) then return end
		ctl.t += dt
		-- scroll
		if mode == "shmup" then
			local sp = def.scroll or 80
			for _, bg in bgs do
				local y = bg.position.y + sp * dt
				if y >= 640 + 1280 then y -= 2560 end
				bg.position = vec2(360, y)
			end
			for _, s in specks do
				local y = s.e.position.y + sp * s.speed * dt * 2.5
				if y > H + 4 then y -= H + 8 end
				s.e.position = vec2(s.e.position.x, y)
			end
		end
		-- movement
		local mx, my = input.axis("move_x"), input.axis("move_y")
		local l = math.sqrt(mx * mx + my * my)
		if l > 1 then mx, my = mx / l, my / l end
		if not pf.dead then
			local sp = (ship.speed or 420) * pf:speedMult()
			local p = player.position
			player.position = vec2(math.clamp(p.x + mx * sp * dt, b[1], b[3]), math.clamp(p.y + my * sp * dt, b[2], b[4]))
		end
		local firing = autoFire or input.held("action")
		if not ctl.over then playerFire(dt, firing) end
		if input.pressed("action2") then ctl:bomb() end
		-- stage script
		if not ctl.over then
			for _, en in ctl.runner:update(dt, #ctl.enemies + (if ctl.boss then 1 else 0)) do
				if en.kind == "enemy" then ctl:spawnEnemy(en.id, en.x, en.y, en.path)
				elseif en.kind == "boss" then spawnBoss(en.id, en.x, en.y)
				elseif en.kind == "text" then if ctl.hud then ctl.hud:banner(en.text, 1.4) end
				elseif en.kind == "pickup" then ctl:spawnPickup(en.id, en.x, en.y) end
			end
		end
		updateEnemies(dt)
		updateBullets(dt)
		-- pickups
		local pp = player.position
		for i = #ctl.pickups, 1, -1 do
			local pk = ctl.pickups[i]
			if pk.e.destroyed then table.remove(ctl.pickups, i) else
				pk.t += dt
				local pos = pk.e.position
				local d2 = dist2(pos.x, pos.y, pp.x, pp.y)
				if not pf.dead and (d2 < (cfg.magnet or 150) ^ 2 or pk.homing) then
					pk.homing = true
					local d = math.sqrt(d2)
					local sp = 700
					if d < 34 then collect(pk) table.remove(ctl.pickups, i) continue end
					pk.e.position = vec2(pos.x + (pp.x - pos.x) / d * sp * dt, pos.y + (pp.y - pos.y) / d * sp * dt)
				elseif mode == "shmup" then
					pk.vy = math.min(140, pk.vy + 300 * dt)
					pk.e.position = vec2(pos.x, pos.y + pk.vy * dt)
					if pos.y > H + 40 then pk.e:destroy() table.remove(ctl.pickups, i) end
				elseif pk.t > 12 then
					pk.e:destroy() table.remove(ctl.pickups, i)
				end
			end
		end
		if cfg.invincible or opts.invincible then pf.iframeT = math.max(pf.iframeT, 0.05) end -- playtest aid
		-- i-frame blink
		if not pf.dead then player.modulate = color(if pf.iframeT > 0 and math.floor(pf.iframeT * 12) % 2 == 0 then "#ffffff55" else "#ffffff") end
		run.score:update(dt)
		if ctl.hud then ctl.hud:update(dt) end
		-- clear?
		if not ctl.over and ctl.boss == nil and ctl.runner:finished(#ctl.enemies) then ctl:finish(true) end
	end)
	return ctl
end

function M.current() return current end

return M
