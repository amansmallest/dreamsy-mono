--!strict
local C = require("../shared/config")
local S = require("../shared/state")
local Backdrop = require("../shared/backdrop")

local params = sceneParams()
local stageNum: number = tonumber(params.stage) or 1
local stage = C.stages[stageNum] or C.stages[1]

local function E(id: string): any
	local e = entity(id)
	assert(e ~= nil, "missing entity " .. id)
	return e
end

music.play("summer", { fade = 1 })

local bgNode = E("ride_bg")
local objNode = E("ride_objects")
local player = E("player")
local pspr = E("player_sprite")
local cam = E("ride_camera")
local hudTime = E("hud_time")
local hudPeach = E("hud_peaches")
local hudStage = E("hud_stage")
local msgPanel = E("msg_panel")
local msgText = E("msg_text")
local retryBtn = E("retry_button")
local goalSign = E("goal_sign")
local station = E("station")
local train = E("train")

local bd = Backdrop.build(bgNode, stage.evening)

local G = C.GROUND_Y
local PH = C.BIKE_HALF_H
local START_X = 107
local rocks: { number } = {}
local puddles: { number } = {}
local peaches: { any } = {}
local fx: { any } = {}

local function addPeach(px: number, py: number)
	local e = spawn("Sprite2D", { texture = "asset:peach", size = vec2(12, 12), position = vec2(px, py), z_index = 6 }, objNode)
	table.insert(peaches, { e = e, x = px, y = py, alive = true, t = random(0, 6) })
end

local layout: string = stage.layout
for i = 1, #layout do
	local ch = string.sub(layout, i, i)
	local ox = C.FIRST_X + (i - 1) * C.CELL
	if ch == "r" or ch == "R" then
		spawn("Sprite2D", { texture = "asset:rock", size = vec2(16, 12), position = vec2(ox, G - 5), z_index = 4 }, objNode)
		table.insert(rocks, ox)
		if ch == "R" then addPeach(ox, G - 53) end
	elseif ch == "w" or ch == "W" then
		spawn("Sprite2D", { texture = "asset:puddle", size = vec2(32, 6), position = vec2(ox, G - 1), z_index = 3 }, objNode)
		table.insert(puddles, ox)
		if ch == "W" then addPeach(ox, G - 53) end
	elseif ch == "p" then
		addPeach(ox, G - 22)
	elseif ch == "h" then
		addPeach(ox, G - 50)
	end
end

local GOAL_X = C.FIRST_X + #layout * C.CELL + 80
local STOP_X = GOAL_X + 67

if stage.finale then
	goalSign.visible = false
	station.position = vec2(GOAL_X - 27, 148)
	train.position = vec2(GOAL_X + 77, 157)
else
	station.visible = false
	train.visible = false
	goalSign.position = vec2(GOAL_X, 170)
end

-- player state
local x = START_X
local y = G - PH
local vy = 0.0
local speed = 0.0
local grounded = true
local bumpT = 0.0
local invT = 0.0
local jumpBuf = 0.0
local timeLeft: number = stage.time
local state = "ride"
local stagePeaches = 0
local wheelDist = 0.0
local frame = 1
local endT = 0.0
local trainV = 0.0
local whistled = false
local camX = C.HALF_W

local function fmtTime(t: number): string
	local s = math.max(0, math.ceil(t))
	return string.format("%d:%02d", s // 60, s % 60)
end

local function refreshHud()
	hudPeach.text = "x " .. tostring(S.peaches + stagePeaches)
	hudTime.text = "Train  " .. fmtTime(timeLeft)
	hudTime.color = if timeLeft <= 10 and state == "ride" then "#e8c27a" else "#f2ece6"
end

hudStage.text = stage.name
msgPanel.visible = false
msgText.visible = false
retryBtn.visible = false
refreshHud()
ui.toast(if stageNum == 1 then "Jump to hop! Hold right to pedal faster." else "The sun is setting... hurry to the station!", 3)

local function popText(txt: string, px: number, py: number, col: string)
	local e = spawn("Text2D", { text = txt, position = vec2(px, py), font_size = 10, color = col, z_index = 60 }, objNode)
	table.insert(fx, { e = e, vx = 0, vy = -24, life = 0.8, g = 0 })
end

local function burst(px: number, py: number, col: string, n: number)
	for _ = 1, n do
		local e = spawn("Sprite2D", { size = vec2(2, 2), modulate = col, position = vec2(px, py), z_index = 55 }, objNode)
		table.insert(fx, { e = e, vx = random(-53, 53), vy = random(-107, -40), life = random(0.35, 0.65), g = 300 })
	end
end

local function bump(word: string, splash: boolean)
	bumpT = C.BUMP_TIME
	invT = C.INVULN
	speed = math.min(speed, C.BUMP_SPEED)
	popText(word, x, y - 24, "#f2ece6")
	if splash then
		sfx.play("splash")
		burst(x + 7, G - 2, "#81a3c5", 9)
	else
		sfx.play("bump")
		burst(x + 10, G - 8, "#b7c1c2", 6)
	end
	local cx = x
	after(0.35, function()
		sfx.play("meow")
		popText("Mew!", cx + 20, G - 40, "#e8c27a")
	end)
end

local function showMsg(text: string, retry: boolean)
	msgPanel.visible = true
	msgText.visible = true
	msgText.text = text
	retryBtn.visible = retry
end

local function retry()
	sfx.play("select")
	loadScene("scenes/ride.scene.json", { stage = stageNum })
end
retryBtn.pressed:connect(retry)

local function lose()
	state = "lost"
	endT = 0
	sfx.play("lose")
	showMsg("Oh no... the train left without you!\nDon't worry, let's try again.", true)
end

local function win()
	state = "won"
	endT = 0
	S.peaches += stagePeaches
	stagePeaches = 0
	sfx.play("bell")
	if stage.finale then
		showMsg("You made it! All aboard!", false)
	else
		showMsg("Halfway there!\nThe station is past the next fields...", false)
	end
	refreshHud()
end

onTick(function(dt)
	if state == "ride" then
		timeLeft -= dt
		if timeLeft <= 0 then
			timeLeft = 0
			lose()
		end
		local ax = input.axis("move_x")
		local target = C.CRUISE
		if ax > 0.3 then
			target = C.FAST
		elseif ax < -0.3 then
			target = C.SLOW
		end
		if bumpT > 0 then
			bumpT -= dt
			target = C.BUMP_SPEED
		end
		local rate = if target > speed then C.ACCEL else C.BRAKE
		speed += math.clamp(target - speed, -rate * dt, rate * dt)

		if input.pressed("jump") or input.pressed("action") then
			jumpBuf = 0.15
		end
		jumpBuf -= dt
		if grounded and jumpBuf > 0 then
			vy = -C.JUMP_V
			grounded = false
			jumpBuf = 0
			sfx.play("jump")
			burst(x - 10, G - 1, "#dedacd", 4)
		end
	elseif state == "won" then
		endT += dt
		if stage.finale then
			speed = math.max(0, math.min(speed, (STOP_X - x) * 2.5))
			if STOP_X - x < 2 then
				speed = 0
			end
			if endT > 1.4 then
				local a = math.clamp(1 - (endT - 1.4) / 0.6, 0, 1)
				pspr.modulate = string.format("#ffffff%02x", math.floor(a * 255))
			end
			if endT > 2.2 then
				if not whistled then
					whistled = true
					sfx.play("whistle")
				end
				trainV += 53 * dt
				train.position = train.position + vec2(trainV * dt, 0)
			end
			if endT > 5.5 then
				loadScene("scenes/ending.scene.json")
			end
		else
			speed += (C.CRUISE - speed) * math.min(1, dt * 2)
			if endT > 2.8 then
				loadScene("scenes/ride.scene.json", { stage = stageNum + 1 })
			end
		end
	else -- lost
		endT += dt
		speed = math.max(0, speed - 100 * dt)
		if endT > 1 and (input.pressed("jump") or input.pressed("action")) then
			retry()
		end
	end

	-- motion
	x += speed * dt
	if not grounded then
		vy += C.GRAVITY * dt
		y += vy * dt
		if y >= G - PH then
			y = G - PH
			vy = 0
			grounded = true
			sfx.play("land")
			burst(x, G - 1, "#dedacd", 3)
		end
	end

	-- hazards
	if state == "ride" then
		if invT > 0 then
			invT -= dt
		else
			local bottom = y + PH
			for _, rx in rocks do
				if math.abs(rx - x) < 14 and bottom > G - 8 then
					bump("Bump!", false)
					break
				end
			end
			if invT <= 0 and grounded then
				for _, wx in puddles do
					if math.abs(wx - x) < 15 then
						bump("Splash!", true)
						break
					end
				end
			end
		end
		if x >= GOAL_X then
			win()
		end
	end

	-- peaches
	local tnow = time()
	for _, p in peaches do
		if p.alive and math.abs(p.x - camX) < 300 then
			local py = p.y + math.sin(tnow * 3 + p.t) * 1.5
			p.e.position = vec2(p.x, math.floor(py))
			if state == "ride" then
				local dx = p.x - (x + 4)
				local dy = py - (y - 3)
				if dx * dx + dy * dy < 21 * 21 then
					p.alive = false
					p.e:destroy()
					stagePeaches += 1
					sfx.play("peach", { pitch = 1 + (stagePeaches % 5) * 0.06 })
					popText("+1", p.x, py - 10, "#e8c27a")
					burst(p.x, py, "#e8c27a", 5)
				end
			end
		end
	end

	-- fx
	for i = #fx, 1, -1 do
		local f = fx[i]
		f.life -= dt
		if f.life <= 0 then
			f.e:destroy()
			table.remove(fx, i)
		else
			f.vy += f.g * dt
			f.e.position = f.e.position + vec2(f.vx * dt, f.vy * dt)
		end
	end

	-- visuals
	wheelDist += speed * dt
	if wheelDist > 6 then
		wheelDist -= 6
		frame = 3 - frame
		pspr.texture = if frame == 1 then "asset:bike_1" else "asset:bike_2"
	end
	local bob = if grounded and frame == 2 and speed > 4 then -1 else 0
	local rot = 0
	if not grounded then
		rot = math.clamp(vy / 20, -8, 8)
	elseif bumpT > 0 then
		rot = math.sin(tnow * 40) * 6 * (bumpT / C.BUMP_TIME)
	end
	pspr.rotation = rot
	pspr.position = vec2(0, bob)
	if state ~= "won" or not stage.finale then
		if invT > 0 and math.floor(invT * 10) % 2 == 0 then
			pspr.modulate = "#ffffff88"
		else
			pspr.modulate = "#ffffff"
		end
	end
	player.position = vec2(math.floor(x), math.floor(y))

	-- camera + backdrop
	camX = math.max(C.HALF_W, x + 87)
	if stage.finale and state == "won" then
		camX = math.min(camX, GOAL_X + 87)
	end
	camX = math.floor(camX)
	cam.position = vec2(camX, C.CAM_Y)
	bd.update(camX)

	refreshHud()
end)
