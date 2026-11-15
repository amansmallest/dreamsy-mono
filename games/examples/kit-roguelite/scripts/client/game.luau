-- Lanternfall: roguelite kit showcase. Title → class/heat → doors → seeded arenas (procgen per biome) with ai enemies
-- and combat → relic picks / shop / campfire / events → bosses → summary → meta tree. Everything is data in data/.
local core = require("@kit/core")
local R = require("@kit/roguelite")
local combat = require("@kit/combat")
local ai = require("@kit/ai")
local juice = require("@kit/juice")
local procgen = require("@kit/procgen")
local config = require("../shared/config")

local TS = config.tileSize
local map = entity("map")
local player = entity("player")
local psprite = entity("player_sprite")
local fxRoot = entity("fx")
local titleText, subText = entity("title_text"), entity("subtitle_text")
local hudPanel, hud, hudSub, msg, bag = entity("hud_panel"), entity("hud_text"), entity("hud_sub"), entity("msg_text"), entity("bag_button")

core.setup({ save = { key = "lanternfall", version = 1 }, theme = { primary = "#5a3482", accent = "#f4cf5c", background = "#1b1a2e", text = "#f4efe6", font = "pixel", disabled = "#3a3550" } })
R.setup()
core.save.load()
R.ui.ICONS = { combat = "asset:d_fight", elite = "asset:d_elite", treasure = "asset:d_chest", shop = "asset:d_shop", event = "asset:d_event", rest = "asset:d_rest", boss = "asset:d_boss" }

local run = nil
local hero = nil
local heroBind = nil
local enemies = {}
local grid = nil
local level = nil
local mode = "title"
local atkCd = 0
local clearing = false
local finishing = false
local facing = { x = 0, y = -1 }
local showTitle, showDoors, startRoom, afterRoom -- forward

local function say(text: string, secs: number?)
	msg.text = text
	local mine = text
	after(secs or 1.6, function() if msg.text == mine then msg.text = "" end end)
end

local function setHud(on: boolean)
	for _, e in { hudPanel, hud, hudSub, bag } do e.visible = on end
	titleText.visible = not on
	subText.visible = not on
end

local function updateHud()
	if not run then return end
	local st = run:statsNow()
	local hp = math.max(0, math.ceil(if hero and not hero.dead then hero.hp else run.hp))
	local act = ""
	if run.active then
		local ok, d = run:activeReady()
		local short = string.upper(string.split(d.name, " ")[2] or d.name)
		act = if ok then "  " .. short .. "!" else "  " .. short .. " " .. run.charge .. "/" .. (d.charge or 3)
	end
	hud.text = `HP {hp}/{st.hp}   {run.gold}g`
	local biome = run:biome()
	hudSub.text = `{biome and biome.name or ""} {run.floor}-{if run.state == "choose" then run.step + 1 else run.step}  {#run.relics} relics{act}`
end

------------------------------------------------------------------ arena + enemies
local function clearArena()
	for _, en in enemies do if combat.alive(en.e) then en.e:destroy() end end
	enemies = {}
	for _, c in fxRoot:children() do c:destroy() end
	if heroBind then heroBind.disconnect() heroBind = nil end
	combat.reset()
	hero = nil
end

local spawnEnemy
local function onEnemyAction(f, d, name: string, a: any)
	if f.dead or run == nil then return nil end
	local x, y = f:pos()
	local dm = f.data.damageMult or 1
	if name == "shoot" and d.projectile then
		local pr = d.projectile
		combat.shoot({ x = x, y = y, dx = a.dx, dy = a.dy, speed = pr.speed, amount = math.max(1, math.floor((pr.amount or 1) * dm + 0.5)), status = pr.status, source = f,
			sprite = pr.sprite, size = { 6, 6 }, pool = "shot", lifetime = 1.8, radius = 3 })
		sfx.play("shoot", { volume = 0.35 })
	elseif name == "ring" then
		local n = a.count or 8
		local off = time() * 0.9
		for i = 1, n do
			local ang = off + i * math.pi * 2 / n
			combat.shoot({ x = x, y = y, dx = math.cos(ang), dy = math.sin(ang), speed = 80, amount = math.max(1, math.floor(dm + 0.5)), source = f, sprite = "asset:orb", size = { 6, 6 }, pool = "orb", lifetime = 2.4, radius = 3 })
		end
		sfx.play("shoot")
	elseif name == "summon" or name == "spawn" then
		if #enemies < 14 then return spawnEnemy(a.kind or "bat", x + math.random(-14, 14), y + 12, true) end
	elseif name == "slam" then
		combat.hitbox({ x = x, y = y, radius = 34, duration = 0.15, amount = math.floor(2 * dm + 0.5), knockback = 240, source = f, status = { name = "stun", duration = 0.5 } })
		juice.shake("medium")
		sfx.play("boom", { volume = 0.5 })
	elseif name == "telegraph" then
		local s = f.entity:children()[1]
		if s then juice.squash(s, { amount = 0.3 }) end
	end
	return nil
end

function spawnEnemy(id: string, x: number, y: number, minion: boolean?): any
	local d = core.content.require("enemies", id)
	local size = d.size or 10
	local body = spawn("Body2D", { position = vec2(x, y), body = "dynamic", gravity_scale = 0, lock_rotation = true, friction = 0, shape = "circle",
		size = vec2(size, size), layer = "enemy", mask = "world", z_index = if d.flying then 6 else 4 })
	local spr = spawn("Sprite2D", { texture = d.sprite, size = vec2(size + 6, size + 6) }, body)
	if run.room and run.room.elite and not minion then spr.modulate = color("#ffb0a0") spr.scale = vec2(1.25, 1.25) end
	body:addTag("enemy")
	local f = combat.add(body, R.enemyDef(run, d, { radius = size / 2 }))
	if minion then f.maxHp = math.max(1, math.floor(f.maxHp * 0.5)) f.hp = f.maxHp f.data.minion = true end
	local ctl = ai.attach(body, d, { grid = grid, target = player,
		canAct = function() return not f:busy() and run ~= nil and run.state == "room" and not juice.stopped() end,
		speedMult = function() return f:speedMult() end, hp = function() return f.hp, f.maxHp end,
		onAction = function(name, a) return onEnemyAction(f, d, name, a) end, rand = function() return random() end })
	table.insert(enemies, { e = body, f = f, ctl = ctl, id = id })
	if not minion then juice.punch(spr, 0.4) end
	return body
end

local function cellWorld(c) return procgen.cellToWorld(c.x, c.y, TS) end

local function buildArena(room)
	clearArena()
	level = R.arena(room, config.arena)
	local biome = core.content.require("biomes", room.biome)
	local t = biome.tiles or { wall = "#", floor = "f" }
	map.data = procgen.toTileMap(level, { ["#"] = t.wall, ["."] = t.floor })
	grid = ai.grid(map, { solid = t.wall })
	local sx, sy = cellWorld(level.start)
	player.position = vec2(sx, sy)
	player.velocity = vec2(0, 0)
	player.visible = true
	if not player:hasTag("player") then player:addTag("player") end -- the hero is the avatar only while it is in play
	hero = combat.add(player, R.heroDef(run, { radius = 5, iframes = config.heroIframes }))
	heroBind = R.bindCombat(combat, hero, run)
	local cls = core.content.require("classes", run.classId)
	psprite.texture = cls.sprite
	music.play(if room.type == "boss" then "boss" else (biome.music or "depths"))
	for i, id in room.enemies or {} do
		local c = level.spawns[i]
		local x, y = cellWorld(c)
		spawnEnemy(id, x, y)
	end
	updateHud()
end

------------------------------------------------------------------ hero attacks + actives
local function nearestEnemy(range: number, anySight: boolean?)
	local px, py = player.position.x, player.position.y
	local best, bd = nil, range * range
	for _, en in enemies do
		if not en.f.dead and combat.alive(en.e) then
			local p = en.e.position
			local d = (p.x - px) ^ 2 + (p.y - py) ^ 2
			if d < bd and (anySight or grid:los(px, py, p.x, p.y)) then best, bd = en, d end
		end
	end
	return best, math.sqrt(bd)
end

local function heroAttack(dt: number)
	atkCd -= dt
	if atkCd > 0 or hero == nil or hero.dead then return end
	local st = run:statsNow()
	local cls = core.content.require("classes", run.classId)
	local wpn = cls.weapon or {}
	local range = (if wpn.kind == "swing" then (wpn.range or 22) else 150) * st.range
	local en, d = nearestEnemy(range + 8)
	if not en then return end
	atkCd = 1 / math.max(0.2, st.fireRate)
	local p = player.position
	local dir = en.e.position - p
	local l = math.max(1, dir:length())
	facing = { x = dir.x / l, y = dir.y / l }
	local statuses = run:hitStatuses()
	if wpn.kind == "swing" then
		combat.swing(hero, { range = range, arc = wpn.arc or 140, dir = facing, amount = st.damage, knockback = wpn.knockback or 160, status = if #statuses > 0 then statuses else nil })
		local fx = spawn("Sprite2D", { texture = "asset:slash", size = vec2(18, 8), position = vec2(p.x + facing.x * 12, p.y + facing.y * 12), rotation = math.deg(math.atan2(facing.y, facing.x)) + 90, z_index = 9 }, fxRoot)
		tween(fx, { modulate = color("#ffffff00") }, 0.18).done:connect(function() fx:destroy() end)
		sfx.play("swing", { volume = 0.5 })
	else
		for k = 1, math.max(1, math.floor(st.projectiles)) do
			local spread = (k - (st.projectiles + 1) / 2) * 0.18
			local a = math.atan2(facing.y, facing.x) + spread
			combat.shoot({ from = player, dx = math.cos(a), dy = math.sin(a), speed = wpn.speed or 220, amount = st.damage, source = hero, sprite = "asset:bolt",
				size = { 6, 6 }, pool = "bolt", lifetime = wpn.lifetime or 0.9, radius = 4, homing = 120, status = if #statuses > 0 then statuses else nil })
		end
		sfx.play("shoot", { volume = 0.4 })
	end
end

local function useActive()
	local d = run:useActive()
	if not d then return end
	local p = player.position
	if d.action == "bomb" then
		for _, f in combat.query(p.x, p.y, 70, { hostileTo = hero }) do combat.damage(f, { amount = 6, source = hero, knockback = 220, status = "burn" }) end
		juice.shake("heavy") juice.sparkle(p, { color = "#e98a3b", n = 24 }) sfx.play("boom")
	elseif d.action == "nova" then
		for _, f in combat.query(p.x, p.y, 90, { hostileTo = hero }) do combat.applyStatus(f, "freeze", { duration = 2 }) end
		juice.sparkle(p, { color = "#7fe0d0", n = 20 }) sfx.play("relic")
	else
		juice.sparkle(p, { color = "#5fae58", n = 14 }) sfx.play("heal")
	end
	updateHud()
end

------------------------------------------------------------------ combat feedback
combat.on("hit", function(info)
	if run == nil or info.blocked then return end
	local t = info.target
	if t == hero then
		if info.dealt > 0 then sfx.play("hurt") juice.shake("light") juice.flash(psprite, "#ff6b4a") end
	elseif info.amount > 0 and t.entity and combat.alive(t.entity) then
		local x, y = t:pos()
		juice.damage(info.amount, vec2(x, y - 10), { crit = info.crit })
		sfx.play("hit", { volume = 0.4 })
	end
	updateHud()
end)
combat.on("death", function(f)
	if run == nil or f == hero then return end
	local x, y = f:pos()
	juice.sparkle(vec2(x, y), { color = if f.data.boss then "#f4cf5c" else "#f4efe6", n = if f.data.boss then 40 else 8 })
	if f.data.boss then juice.hitstop(0.12) juice.shake("explosion") say(core.content.require("enemies", f.data.id).name .. "\nfalls!", 2) end
end)
core.events.on("relic_gained", function(d) sfx.play("relic") end)

------------------------------------------------------------------ room flow
local function bot(): boolean return config.bot == true end

local function endRun()
	if finishing or not run then return end
	finishing = true
	local r = run
	after(if bot() then 0.3 else 1.4, function()
		local sum = R.finish(r)
		print(`run over: {sum.class} won={sum.won} floor={sum.floor} rooms={sum.rooms} kills={sum.kills} embers+{sum.metaEarned}`)
		clearArena()
		player.visible = false
		player:removeTag("player")
		run = nil
		finishing = false
		mode = "summary"
		if bot() then showTitle() return end
		music.play("title")
		R.ui.summary(sum, function() showTitle() end)
	end)
end

function afterRoom()
	updateHud()
	if run.state == "won" then
		juice.confetti()
		say("VICTORY!", 2.5)
		endRun()
	elseif run.state == "dead" then
		endRun()
	elseif run.state == "reward" then
		mode = "menu"
		if bot() then run:takeRelic(R.sim.policy.relic(run, run.pending)) afterRoom() return end
		R.ui.relicChoice(run, function(id)
			if id then local n = R.ui.relicText(id) say(n, 1.4) end
			afterRoom()
		end)
	else
		R.save()
		showDoors()
	end
end

function startRoom(i: number)
	local room = run:enter(i)
	print(`room {run.floor}-{run.step} {room.type} enemies {#(room.enemies or {})} hp {run.hp} gold {run.gold}`)
	sfx.play("door")
	buildArena(room)
	mode = "room"
	clearing = false
	local t = room.type
	if t == "combat" or t == "elite" or t == "boss" then
		mode = "fight"
		if t == "boss" then say(core.content.require("enemies", room.boss).name, 2) sfx.play("boss") juice.zoomPunch(0.1) end
		if t == "elite" then say("Elite!", 1.2) end
		return
	end
	-- non-combat rooms: a quiet arena with the menu on top
	mode = "menu"
	if t == "treasure" then
		juice.sparkle(player.position + vec2(0, -30), { n = 16 })
		run:clear()
		afterRoom()
	elseif t == "shop" then
		if bot() then for _, k in R.sim.policy.shop(run, run.room.stock) do run:buy(k) end run:clear() afterRoom() return end
		R.ui.shop(run, function() afterRoom() end)
	elseif t == "rest" then
		if bot() then run:rest(R.sim.policy.rest(run)) afterRoom() return end
		R.ui.rest(run, function() sfx.play("heal") afterRoom() end)
	elseif t == "event" then
		if bot() then run:choose(R.sim.policy.event(run, run:eventChoices())) afterRoom() return end
		R.ui.event(run, function() afterRoom() end)
	end
end

function showDoors()
	mode = "doors"
	updateHud()
	if bot() then startRoom(R.sim.policy.door(run, run:choices())) return end
	R.ui.doors(run, function(i) startRoom(i) end)
end

local function beginRun(opts)
	run = R.newRun(opts)
	setHud(true)
	print(`run start class={run.classId} seed={run.seed} heat={run.heat}`)
	clearArena()
	local room1 = run:choices()[1]
	buildArena(room1) -- preview arena behind the first door menu
	for _, en in enemies do en.e:destroy() end
	enemies = {}
	showDoors()
end

local function resumeRun()
	run = R.resume()
	if not run then showTitle() return end
	setHud(true)
	if run.state == "room" then
		-- an interrupted room restarts (fights) or reopens its menu
		run.step -= 1
		run.state = "choose"
		local idx = 1
		for i, c in run:choices() do if c == run.room then idx = i end end
		run.room = nil
		run.stats.rooms -= 1
		startRoom(idx)
	else
		afterRoom()
	end
end

function showTitle()
	mode = "title"
	setHud(false)
	clearArena()
	player.visible = false
	player:removeTag("player")
	map.data = "."
	music.play("title")
	local d = R.daily()
	subText.text = `Embers {R.metaCurrency()}   Runs {R.meta.data.runs}   Wins {R.meta.data.wins}`
	if bot() then
		local cls = config.class
		if cls == nil then for _, c in R.classes() do if c.unlocked then cls = c.id break end end end
		after(0.2, function() beginRun({ class = cls, seed = config.seed, heat = 0 }) end)
		return
	end
	local items = {}
	if R.hasSavedRun() then table.insert(items, { label = "Continue run", onSelect = function() resumeRun() end }) end
	table.insert(items, { label = "New run", onSelect = function()
		R.ui.classSelect({ classes = R.classes(), onPick = function(cls, heat) beginRun({ class = cls, heat = heat, seed = config.seed }) end, onBack = function() showTitle() end })
	end })
	table.insert(items, { label = if d.played then "Daily run (done)" else "Daily run", disabled = d.played, onSelect = function() beginRun({ daily = true }) end })
	table.insert(items, { label = "Ember tree", detail = tostring(R.metaCurrency()), onSelect = function() R.ui.metaTree(function() showTitle() end) end })
	core.menus.list({ title = "Descend", items = items, closeLabel = false, pause = false, offsetY = 140 })
end

bag.pressed:connect(function() if run then R.ui.relicList(run) end end)

------------------------------------------------------------------ tick
local botState = { path = nil, i = 1, repath = 0 }
local function botMove(dt: number): (number, number)
	local p = player.position
	local en, d = nearestEnemy(600, true)
	if not en then return 0, 0 end
	local g = en.e.position
	local cls = core.content.require("classes", run.classId)
	local want = if (cls.weapon or {}).kind == "swing" then 14 else 90
	local dx, dy = g.x - p.x, g.y - p.y
	local l = math.max(1, math.sqrt(dx * dx + dy * dy))
	if d < want * 0.6 then return -dx / l * 0.6, -dy / l * 0.6 end
	if d < want and grid:los(p.x, p.y, g.x, g.y) then return dy / l * 0.5, -dx / l * 0.5 end
	botState.repath -= dt
	if botState.repath <= 0 or botState.path == nil then
		botState.path = grid:findWorld(p.x, p.y, g.x, g.y, { nearest = true, maxNodes = 1500 })
		botState.i = 2
		botState.repath = 0.4
	end
	local wp = botState.path and botState.path[botState.i]
	if not wp then return dx / l, dy / l end
	local wx, wy = wp.x - p.x, wp.y - p.y
	local wl = math.sqrt(wx * wx + wy * wy)
	if wl < 4 then botState.i += 1 end
	wl = math.max(1, wl)
	return wx / wl, wy / wl
end

onTick(function(dt: number)
	if mode ~= "fight" or run == nil or hero == nil then return end
	if juice.stopped() then return end
	run.stats.time += dt
	if run.state == "dead" or hero.dead then
		player.velocity = vec2(0, 0)
		if not finishing then sfx.play("death") say("You fall...", 2) juice.shake("heavy") endRun() end
		return
	end
	local mx, my
	if bot() then mx, my = botMove(dt) else mx, my = input.axis("move_x"), input.axis("move_y") end
	if not hero:busy() then
		local l = math.sqrt(mx * mx + my * my)
		if l > 1 then mx, my = mx / l, my / l end
		local sp = run:statsNow().speed * hero:speedMult()
		player.velocity = vec2(mx * sp, my * sp)
		if math.abs(mx) > 0.1 then psprite.flip_h = mx < 0 end
	end
	heroAttack(dt)
	if (bot() and run:activeReady() and #enemies > 2) or (not bot() and input.pressed("action")) then useActive() end
	-- room cleared?
	local left = 0
	for _, en in enemies do if not en.f.dead then left += 1 end end
	if left == 0 and not clearing then
		clearing = true
		after(0.7, function()
			if run == nil or run.state ~= "room" then return end
			local reward = run:clear()
			if reward.gold > 0 then
				juice.coinBurst(player.position, { n = math.min(12, 3 + math.floor(reward.gold / 5)), texture = "asset:coin", size = 6 })
				sfx.play("coin")
				say("+" .. reward.gold .. " gold", 1)
			end
			mode = "menu"
			afterRoom()
		end)
	end
	updateHud()
end)

showTitle()
