-- Kit roguelike demo: procgen floors + ai enemies + combat (status effects, projectiles, loot), stairs, run reset.
local combat = require("@kit/combat")
local ai = require("@kit/ai")
local procgen = require("@kit/procgen")
local content = procgen.content({ "enemies", "loot", "rooms" }) -- data/enemies/*.json, data/loot/*.json, data/rooms/*.txt
local config = require("../shared/config")

local TS = 16
local map = entity("map")
local player = entity("player")
local pickupRoot = entity("pickups")
local hud = entity("hud_text")
local statusText = entity("status_text")
local msg = entity("msg_text")
local cam = entity("camera_main")

local run = { seed = 0, floor = 1, gold = 0, gems = 0, hasKey = false, kills = 0, dead = false, facing = { x = 1, y = 0 }, swingCd = 0, boltCd = 0, maxHp = config.heroHp }
local enemies = {}
local pickups = {}
local grid = nil -- ai PathGrid of the current floor ("#" and "+" solid)
local botGrid = nil -- same, but doors passable (the bot walks into doors to open them)
local hero = nil -- hero Fighter
local level = nil
local changing = false
local newRun -- forward

local enemyList = {}
for id, e in content.enemies do if not e.boss then table.insert(enemyList, e) end end
table.sort(enemyList, function(a, b) return a.id < b.id end)

combat.setup({
	solidAt = function(x, y) return grid ~= nil and grid:solidAt(x, y) end,
	lootTables = content.loot,
	rollLoot = procgen.loot.roll,
})

local function say(text: string, secs: number?)
	msg.text = text
	local mine = text
	after(secs or 1.6, function() if msg.text == mine then msg.text = "" end end)
end

local function updateHud()
	if not hero then return end
	local hp = math.max(0, math.ceil(hero.hp))
	hud.text = `F{run.floor}   ♥ {hp}/{hero.maxHp}   $ {run.gold}` .. (if run.hasKey and level and level.key then "   KEY" else "")
	local st = {}
	for name in hero.statuses do table.insert(st, string.upper(name)) end
	table.sort(st)
	statusText.text = if #st > 0 then table.concat(st, " ") else `seed {run.seed}  kills {run.kills}`
end

------------------------------------------------------------------ pickups
local SPRITES = { coin = "asset:coin", potion = "asset:potion", gem = "asset:gem", heart = "asset:potion", chest = "asset:chest" }

local function spawnPickup(item: string, count: number, x: number, y: number)
	local e = spawn("Sprite2D", { position = vec2(x, y), texture = SPRITES[item] or "asset:coin", size = if item == "chest" then vec2(12, 8) else vec2(8, 8), modulate = if item == "heart" then color("#ff6b9b") else color("#ffffff") }, pickupRoot)
	table.insert(pickups, { e = e, item = item, count = count, x = x, y = y })
	if item ~= "chest" then tween(e, { position = vec2(x, y - 3) }, 0.5, { easing = "sine_in_out", loop = true, yoyo = true }) end
end

combat.on("drop", function(drops, x, y)
	for i, d in drops do
		local a = i * 2.1
		spawnPickup(d.item, d.count, x + math.cos(a) * 7, y + math.sin(a) * 7)
	end
end)

local function collect(p)
	if p.item == "coin" then run.gold += p.count sfx.play("coin")
	elseif p.item == "gem" then run.gold += 10 * p.count run.gems += p.count sfx.play("coin") say("Gem! +" .. 10 * p.count, 1)
	elseif p.item == "potion" then hero:heal(4) hero:clearStatus("poison") sfx.play("coin")
	elseif p.item == "heart" then hero.maxHp += 2 run.maxHp = hero.maxHp hero:heal(hero.maxHp) say("Max HP up!", 1.2) sfx.play("coin")
	elseif p.item == "chest" then
		for i, d in procgen.loot.roll(content.loot.chest, nil, { tables = content.loot, state = run }) do
			local a = i * 2.4
			spawnPickup(d.item, d.count, p.x + math.cos(a) * 12, p.y + math.sin(a) * 12)
		end
		sfx.play("door")
	end
	p.e:destroy()
end

------------------------------------------------------------------ enemies
local spawnEnemy

local function onEnemyAction(f, data, name: string, a: any)
	if f.dead then return nil end
	local x, y = f:pos()
	if name == "shoot" and data.projectile then
		local pr = data.projectile
		combat.shoot({ x = x, y = y, dx = a.dx, dy = a.dy, speed = pr.speed, amount = pr.amount, status = pr.status, source = f, sprite = pr.sprite, size = { 8, 4 }, pool = "arrow", lifetime = 1.6, radius = 3 })
		sfx.play("shoot", { volume = 0.4 })
	elseif name == "ring" then
		local n = a.count or 8
		local off = time() * 0.7
		for i = 1, n do
			local ang = off + i * math.pi * 2 / n
			combat.shoot({ x = x, y = y, dx = math.cos(ang), dy = math.sin(ang), speed = 90, amount = 1, status = { name = "burn", chance = 0.5, duration = 2 }, source = f, sprite = "asset:orb", size = { 6, 6 }, pool = "orb", lifetime = 2.2, radius = 3 })
		end
		sfx.play("shoot")
	elseif name == "summon" then
		local kid = spawnEnemy(a.kind or "bat", x + 20, y - 10)
		return kid
	elseif name == "slam" then
		combat.hitbox({ x = x, y = y, radius = 34, duration = 0.15, amount = 2, knockback = 260, source = f, status = { name = "stun", duration = 0.6 } })
		camera.shake(3, 0.3)
	elseif name == "telegraph" then
		local s = f.entity:children()[1]
		if s then tween(s, { scale = vec2(1.3, 0.8) }, 0.25, { yoyo = true }) end
	elseif name == "spawn" then
		return spawnEnemy(a.kind, x, y)
	end
	return nil
end

function spawnEnemy(id: string, x: number, y: number): any
	local d = content.enemies[id]
	assert(d, "unknown enemy " .. tostring(id))
	local size = d.size or 10
	local body = spawn("Body2D", { position = vec2(x, y), body = "dynamic", gravity_scale = 0, lock_rotation = true, friction = 0,
		shape = "circle", size = vec2(size, size), layer = "enemy", mask = "world", z_index = if d.flying then 6 else 4 })
	spawn("Sprite2D", { texture = d.sprite, size = vec2(size + 4, size + 4) }, body)
	body:addTag("enemy")
	local f = combat.add(body, { hp = d.hp, armor = d.armor, resist = d.resist, team = "enemy", contact = d.contact, loot = d.loot,
		knockbackResist = d.knockbackResist, radius = size / 2, data = { id = id } })
	local ctl = ai.attach(body, d, {
		grid = grid, target = player,
		canAct = function() return not f:busy() and not run.dead end,
		speedMult = function() return f:speedMult() end,
		hp = function() return f.hp, f.maxHp end,
		onAction = function(name, a) return onEnemyAction(f, d, name, a) end,
		rand = function() return random() end,
	})
	table.insert(enemies, { e = body, f = f, ctl = ctl, id = id })
	return body
end

combat.on("hit", function(info)
	if info.target == hero and info.dealt > 0 then
		sfx.play("hurt")
		camera.shake(2, 0.15)
	elseif info.target ~= hero and info.amount > 0 then
		sfx.play("hit", { volume = 0.5 })
	end
	updateHud()
end)

combat.on("death", function(f)
	if f == hero then
		run.dead = true
		print(`died floor {run.floor} gold {run.gold} kills {run.kills}`)
		player.velocity = vec2(0, 0)
		say(`You fell on floor {run.floor}\n{run.gold} gold`, 2.4)
		after(2.5, function() newRun() end)
	else
		run.kills += 1
		if f.data.id == "ogre" then say("Boss defeated!", 1.5) end
	end
	updateHud()
end)

------------------------------------------------------------------ floors
local function clearFloor()
	for _, en in enemies do
		if combat.alive(en.e) then en.e:destroy() end
	end
	enemies = {}
	for _, p in pickups do if combat.alive(p.e) then p.e:destroy() end end
	pickups = {}
	combat.reset()
end

local function worldOf(c) return procgen.cellToWorld(c.x, c.y, TS) end

local function buildFloor()
	clearFloor()
	local seed = run.seed * 1000 + run.floor
	local kind = (run.floor - 1) % 3
	if kind == 0 then
		level = procgen.rooms({ templates = content.rooms, seed = seed, rooms = 3 + math.min(run.floor, 4), branches = 2 })
	elseif kind == 1 then
		level = procgen.dungeon({ seed = seed, w = 30, h = 30, rooms = 6 + math.min(run.floor, 4), minRoom = 4, maxRoom = 7, enemies = 0, items = { 0, 1 } })
	else
		level = procgen.caves({ seed = seed, w = 30, h = 30, enemies = 0, items = 2, minOpen = 0.3 })
	end
	local g = level.grid
	g:set(level.exit.x, level.exit.y, ">")
	run.hasKey = level.key == nil
	map.data = procgen.toTileMap(level, { ["."] = "f" })
	grid = ai.grid(map, { solid = "#+" })
	botGrid = ai.grid(map, { solid = "#" })
	local sx, sy = worldOf(level.start)
	player.position = vec2(sx, sy)
	player.velocity = vec2(0, 0)
	camera.snap()
	hero = combat.add(player, { hp = config.heroHp, maxHp = run.maxHp, team = "player", iframes = 0.8, destroyOnDeath = false, radius = 5 })
	hero.hp = run.hp or run.maxHp
	-- enemies: budgeted encounter from the data list, placed on template markers first, then spread out
	local rng = procgen.rng(seed)
	local enc = procgen.waves.encounter(enemyList, config.budget(run.floor), rng, { level = run.floor, maxCount = 14 })
	local spots = {}
	for _, m in level.markers or {} do
		if m.char == "E" then table.insert(spots, { x = m.x, y = m.y }) end
		if m.char == "T" then local x, y = worldOf(m) spawnPickup("chest", 1, x, y) end
	end
	rng:shuffle(spots)
	for _, c in procgen.scatter(level, #enc.ids, { seed = seed + 7, minDist = 6, gap = 2, pass = "." }) do table.insert(spots, c) end
	for i, id in enc.ids do
		local c = spots[i]
		if c then local x, y = worldOf(c) spawnEnemy(id, x, y) end
	end
	for _, s in level.spawns or {} do
		if s.kind == "item" then local x, y = worldOf(s) spawnPickup(if rng:chance(0.5) then "potion" else "chest", 1, x, y) end
	end
	if run.floor % 3 == 0 then
		-- boss guards the stairs
		local ex, ey = worldOf(level.exit)
		local spot = procgen.scatter(level, 1, { seed = seed, from = level.exit, minDist = 2, pass = "." })[1]
		if spot then ex, ey = worldOf(spot) end
		spawnEnemy("ogre", ex, ey)
		say(`Floor {run.floor}\nThe Ogre Chief awaits`, 2)
	else
		say(`Floor {run.floor}` .. (if level.key then "\nFind the key" else ""), 1.6)
	end
	print(`floor {run.floor} seed {run.seed} kind {kind} enemies {#enemies} size {map.cols}x{map.rows}`)
	updateHud()
end

newRun = function()
	run.seed = config.seed or math.floor(random(1, 99999))
	run.floor, run.gold, run.gems, run.kills, run.dead = 1, 0, 0, 0, false
	run.maxHp = config.heroHp
	run.hp = nil
	run["chest:rare"] = nil
	buildFloor()
end

local function nextFloor()
	if changing then return end
	changing = true
	sfx.play("stairs")
	run.hp = hero.hp
	after(0, function()
		run.floor += 1
		buildFloor()
		changing = false
	end)
end

map.tileTouched:connect(function(other, char, col, row)
	if other ~= player or run.dead then return end
	if char == ">" then
		if run.floor % 3 == 0 then
			for _, en in enemies do if en.id == "ogre" and not en.f.dead then say("Defeat the boss first!", 1) return end end
		end
		nextFloor()
	elseif char == "k" then
		run.hasKey = true
		map:setTile(col, row, "f")
		say("Got the key!", 1.2)
		sfx.play("coin")
		updateHud()
	elseif char == "+" then
		if run.hasKey then
			map:setTile(col, row, "f")
			sfx.play("door")
			say("The door opens", 1)
		else
			say("Locked. Find the key", 1)
		end
	end
end)

------------------------------------------------------------------ hero
local function nearestEnemy(range: number)
	local px, py = player.position.x, player.position.y
	local best, bd = nil, range * range
	for _, en in enemies do
		if not en.f.dead and combat.alive(en.e) then
			local p = en.e.position
			local d = (p.x - px) ^ 2 + (p.y - py) ^ 2
			if d < bd and grid:los(px, py, p.x, p.y) then best, bd = en, d end
		end
	end
	return best, math.sqrt(bd)
end

local function attack()
	if run.swingCd > 0 then return end
	run.swingCd = config.swing.cooldown
	local s = config.swing
	combat.swing(hero, { range = s.range, arc = s.arc, dir = run.facing, amount = s.amount, knockback = s.knockback })
	local p = player.position
	local fx = spawn("Sprite2D", { texture = "asset:slash", size = vec2(16, 6), position = vec2(p.x + run.facing.x * 10, p.y + run.facing.y * 10), rotation = math.deg(math.atan2(run.facing.y, run.facing.x)) + 90, z_index = 8 })
	tween(fx, { modulate = color("#ffffff00") }, 0.18).done:connect(function() fx:destroy() end)
end

local function fire()
	if run.boltCd > 0 then return end
	run.boltCd = config.bolt.cooldown
	local en = nearestEnemy(170)
	local dir = run.facing
	if en then
		local d = en.e.position - player.position
		local l = math.max(1, d:length())
		dir = { x = d.x / l, y = d.y / l }
	end
	local b = config.bolt
	combat.shoot({ from = player, dx = dir.x, dy = dir.y, speed = b.speed, amount = b.amount, status = b.status, source = hero, sprite = "asset:bolt", size = { 7, 7 }, pool = "bolt", lifetime = b.lifetime, radius = 4, homing = 90 })
	sfx.play("shoot", { volume = 0.5 })
end

-- bot: walk to the nearest enemy / key / stairs with A*, attack anything close
local bot = { path = nil, i = 1, repath = 0, goal = nil }
local function botInput(dt: number): (number, number, boolean, boolean)
	local p = player.position
	local en, d = nearestEnemy(120)
	local goal
	if en then
		goal = en.e.position
		if d < 60 then
			local dx, dy = goal.x - p.x, goal.y - p.y
			local l = math.max(1, math.sqrt(dx * dx + dy * dy))
			run.facing = { x = dx / l, y = dy / l }
			if d < 26 then return -dx / l * 0.4, -dy / l * 0.4, true, true end
			return dx / l * 0.5, dy / l * 0.5, false, true
		end
	elseif not run.hasKey and level.key then
		local x, y = worldOf(level.key)
		goal = vec2(x, y)
	else
		local x, y = worldOf(level.exit)
		goal = vec2(x, y)
	end
	bot.repath -= dt
	if bot.repath <= 0 or bot.path == nil then
		bot.path = botGrid:findWorld(p.x, p.y, goal.x, goal.y, { nearest = true, maxNodes = 2500 })
		bot.i = 2
		bot.repath = 0.5
	end
	local wp = bot.path and bot.path[bot.i]
	if wp == nil then
		local dx, dy = goal.x - p.x, goal.y - p.y
		local l = math.max(1, math.sqrt(dx * dx + dy * dy))
		return dx / l, dy / l, false, false
	end
	local dx, dy = wp.x - p.x, wp.y - p.y
	local l = math.sqrt(dx * dx + dy * dy)
	if l < 4 then bot.i += 1 end
	l = math.max(1, l)
	return dx / l, dy / l, false, false
end

onTick(function(dt: number)
	if run.dead or hero == nil or changing then return end
	run.swingCd -= dt
	run.boltCd -= dt
	local mx, my, doSwing, doFire
	if config.bot then
		mx, my, doSwing, doFire = botInput(dt)
	else
		mx, my = input.axis("move_x"), input.axis("move_y")
		doSwing, doFire = input.pressed("action"), input.pressed("action2")
	end
	if not hero:busy() then
		local l = math.sqrt(mx * mx + my * my)
		if l > 1 then mx, my = mx / l, my / l end
		local sp = config.heroSpeed * hero:speedMult()
		player.velocity = vec2(mx * sp, my * sp)
		if l > 0.2 then run.facing = { x = mx / math.max(l, 0.001), y = my / math.max(l, 0.001) } end
		if math.abs(mx) > 0.1 then entity("player_sprite").flip_h = mx < 0 end
		if doSwing then attack() end
		if doFire then fire() end
	end
	-- pickups
	local p = player.position
	for i = #pickups, 1, -1 do
		local pk = pickups[i]
		if not combat.alive(pk.e) then
			table.remove(pickups, i)
		elseif (pk.e.position.x - p.x) ^ 2 + (pk.e.position.y - p.y) ^ 2 < 12 * 12 then
			table.remove(pickups, i)
			collect(pk)
			updateHud()
		end
	end
	updateHud()
end)

newRun()
