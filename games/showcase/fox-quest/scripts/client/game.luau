-- Fox Explorer: player movement + whole game loop (gems, beetles, spikes, flag, HUD)
local C = require("../shared/config")

local player = script.entity
local art = entity("player_art")
local hudLives = entity("hud_lives")
local hudGems = entity("hud_gems")
local hudLevel = entity("hud_level")
local overScreen = entity("game_over_screen")
local overDetail = entity("game_over_detail")
local winScreen = entity("win_screen")
local winDetail = entity("win_detail")
local retryButton = entity("retry_button")
local againButton = entity("play_again_button")
local flag = entity("flag")
local foxSprite = entity("fox_body")
local frameName = ""
local function setFox(n)
	if n ~= frameName then
		frameName = n
		foxSprite.texture = "asset:" .. n
	end
end

local HALF_W, HALF_H = 7, 12

local state = "playing"
local lives = C.START_LIVES
local gemCount = 0
local checkpoint = 1
local invuln = 0
local coyote = 0
local jumpBuffer = 0
local jumping = false
local facing = 1
local screenTime = 0

-- gems
local gems = {}
for _, g in entitiesTagged("gem") do
	local kids = g:children()
	table.insert(gems, { e = g, taken = false, art = kids[1], phase = g.position.x * 0.05 })
end
local totalGems = #gems

-- beetles
local beetles = {}
for _, b in entitiesTagged("beetle") do
	local range = C.BEETLE_PATROL[b.id] or { b.position.x - 64, b.position.x + 64 }
	local kids = b:children()
	table.insert(beetles, {
		shell = kids[1] and kids[1]:children()[1],
		e = b, sx = b.position.x, sy = b.position.y,
		minX = range[1], maxX = range[2], dir = -1, alive = true, art = kids[1],
	})
end

-- spike pits: decorate with dark pit + spike teeth
local spikes = entitiesTagged("spike")
for _, s in spikes do
	local w = s.size.x
	spawn("Sprite2D", { position = vec2(0, -20), size = vec2(w, 64), modulate = "#3b2414", z_index = -3 }, s)
	local n = math.floor(w / 16)
	for i = 0, n - 1 do
		spawn("Sprite2D", { texture = "asset:spike", position = vec2(-w / 2 + 8 + i * 16, 4), size = vec2(16, 16) }, s)
	end
end

-- floating text popups
local popups = {}
local function popup(text, pos, col)
	local t = spawn("Text2D", { text = text, position = pos, font_size = 8, color = col, z_index = 50 })
	table.insert(popups, { e = t, age = 0 })
end

local function overlaps(e, shrink)
	local p = player.position
	local ep = e.position
	local s = e.size
	return math.abs(p.x - ep.x) < HALF_W + s.x / 2 - shrink
		and math.abs(p.y - ep.y) < HALF_H + s.y / 2 - shrink
end

local function updateHud()
	hudLives.text = "LIVES " .. tostring(lives)
	hudGems.text = "GEMS " .. tostring(gemCount) .. "/" .. tostring(totalGems)
	hudLevel.text = "LEVEL " .. tostring(checkpoint) .. "/" .. tostring(#C.CHECKPOINTS)
end

local function respawn()
	local cp = C.CHECKPOINTS[checkpoint]
	player.position = vec2(cp.x, cp.y)
	player.velocity = vec2(0, 0)
	jumping = false
end

local function gameOver()
	state = "over"
	screenTime = 0
	art.visible = true
	overDetail.text = "Gems: " .. tostring(gemCount) .. "/" .. tostring(totalGems) .. "\nReached " .. C.CHECKPOINTS[checkpoint].name
	overScreen.visible = true
end

local function win()
	state = "won"
	screenTime = 0
	art.visible = true
	winDetail.text = "Gems: " .. tostring(gemCount) .. "/" .. tostring(totalGems) .. "\nLives left: " .. tostring(lives)
	winScreen.visible = true
	popup("HOORAY!", vec2(player.position.x, player.position.y - 24), "#ffe14a")
end

local function hurt(respawnToo)
	if state ~= "playing" then return end
	if invuln > 0 then
		if respawnToo then respawn() end
		return
	end
	lives -= 1
	updateHud()
	if lives <= 0 then
		gameOver()
		return
	end
	invuln = C.INVULN
	ui.toast("Ouch!", 1)
	if respawnToo then respawn() end
end

local function restart()
	lives = C.START_LIVES
	gemCount = 0
	checkpoint = 1
	invuln = 0
	for _, g in gems do
		g.taken = false
		g.e.visible = true
	end
	for _, b in beetles do
		b.alive = true
		b.dir = -1
		b.e.visible = true
		b.e.position = vec2(b.sx, b.sy)
		if b.art then b.art.scale = vec2(-1, 1) end
	end
	overScreen.visible = false
	winScreen.visible = false
	art.visible = true
	state = "playing"
	respawn()
	updateHud()
end

retryButton.pressed:connect(restart)
againButton.pressed:connect(restart)

overScreen.visible = false
winScreen.visible = false
updateHud()
respawn()
ui.toast("Reach the flag! Stomp beetles, grab gems!", 3)

onTick(function(rawDt)
	local dt = math.min(rawDt, 1 / 20)
	local t = time()

	-- popups float up and fade away
	for i = #popups, 1, -1 do
		local pp = popups[i]
		pp.age += dt
		if pp.age > 0.7 then
			pp.e:destroy()
			table.remove(popups, i)
		else
			local pos = pp.e.position
			pp.e.position = vec2(pos.x, pos.y - 30 * dt)
		end
	end

	-- gems bob
	for _, g in gems do
		if not g.taken and g.art then
			g.art.position = vec2(0, math.sin(t * 4 + g.phase) * 2)
		end
	end

	if state ~= "playing" then
		player.velocity = vec2(0, 0)
		screenTime += dt
		if screenTime > 0.8 and input.pressed("jump") then restart() end
		return
	end

	-- beetles patrol
	for _, b in beetles do
		if b.alive then
			local p = b.e.position
			local nx = p.x + b.dir * C.BEETLE_SPEED * dt
			if nx < b.minX then
				nx = b.minX
				b.dir = 1
			elseif nx > b.maxX then
				nx = b.maxX
				b.dir = -1
			end
			b.e.position = vec2(nx, p.y)
			if b.art then b.art.scale = vec2(b.dir, 1) end
			if b.shell then b.shell.texture = if math.floor(t * 6) % 2 == 0 then "asset:beetle_1" else "asset:beetle_2" end
		end
	end

	-- movement
	local v = player.velocity
	local onFloor = player.onFloor
	local ax = input.axis("move_x")
	if math.abs(ax) < 0.15 then ax = 0 end
	local target = ax * C.MOVE_SPEED
	local accel = if onFloor then C.GROUND_ACCEL else C.AIR_ACCEL
	local vx = v.x
	if vx < target then
		vx = math.min(vx + accel * dt, target)
	elseif vx > target then
		vx = math.max(vx - accel * dt, target)
	end
	local vy = math.min(v.y + C.GRAVITY * dt, C.MAX_FALL)

	if onFloor then coyote = C.COYOTE else coyote -= dt end
	if input.pressed("jump") or input.pressed("action") then
		jumpBuffer = C.JUMP_BUFFER
	else
		jumpBuffer -= dt
	end
	if jumpBuffer > 0 and coyote > 0 then
		vy = -C.JUMP_SPEED
		jumpBuffer = 0
		coyote = 0
		jumping = true
	end
	local holding = input.held("jump") or input.held("action")
	if jumping and vy < 0 and not holding then
		vy *= 0.5
		jumping = false
	end
	if vy >= 0 then jumping = false end

	-- facing & animation
	if ax > 0 then facing = 1 elseif ax < 0 then facing = -1 end
	if onFloor and math.abs(vx) > 10 then
		art.position = vec2(0, 0)
		art.scale = vec2(facing, 1)
		setFox(if math.floor(t * 10) % 2 == 0 then "fox_run_1" else "fox_run_2")
	elseif not onFloor then
		art.position = vec2(0, 0)
		art.scale = vec2(facing, 1)
		setFox("fox_jump")
	else
		art.position = vec2(0, 0)
		art.scale = vec2(facing, 1)
		setFox("fox_idle")
	end

	if invuln > 0 then
		invuln -= dt
		art.visible = invuln <= 0 or (math.floor(t * 12) % 2 == 0)
	else
		art.visible = true
	end

	-- checkpoints / level progress
	local px = player.position.x
	for i = #C.CHECKPOINTS, 1, -1 do
		if i > checkpoint and px >= C.CHECKPOINTS[i].trigger then
			checkpoint = i
			ui.toast(C.CHECKPOINTS[i].name .. "!", 1.5)
			updateHud()
			break
		end
	end

	-- gems
	for _, g in gems do
		if not g.taken and overlaps(g.e, 0) then
			g.taken = true
			g.e.visible = false
			gemCount += 1
			popup("+1", g.e.position, "#7ff7ff")
			updateHud()
			if gemCount == totalGems then ui.toast("All gems found!", 2) end
		end
	end

	-- beetles: stomp or get hurt
	for _, b in beetles do
		if b.alive and overlaps(b.e, 2) then
			if player.position.y < b.e.position.y - 8 and v.y > -60 then
				b.alive = false
				if b.art then b.art.scale = vec2(b.dir, 0.35) end
				local be = b.e
				after(0.3, function()
					if not b.alive then be.visible = false end
				end)
				vy = -C.STOMP_BOUNCE
				jumping = false
				popup("STOMP!", vec2(be.position.x, be.position.y - 16), "#ffe14a")
			elseif invuln <= 0 then
				local away = if player.position.x < b.e.position.x then -1 else 1
				hurt(false)
				vx = away * 220
				vy = -260
			end
		end
	end

	player.velocity = vec2(vx, vy)

	-- spikes & falling
	for _, s in spikes do
		if overlaps(s, 3) then
			hurt(true)
			break
		end
	end
	if state == "playing" and player.position.y > C.FALL_LIMIT then
		hurt(true)
	end

	-- goal
	if state == "playing" and flag and overlaps(flag, 0) then
		win()
	end
end)
