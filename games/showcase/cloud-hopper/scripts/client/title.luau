local decor = require("../shared/decor")
local run = require("../shared/run")

music.play("sky_tune")
local w = entity("title_world")
decor.sky(w)
decor.clouds(w, -260, 260, -420, 420, 24)
for i = 1, 4 do
	spawn("Sprite2D", { texture = "asset:far_island", size = vec2(80, 54), position = vec2(random(-160, 160), random(-300, -120)), z_index = -15, modulate = color("#ffffffbb") }, w)
end

-- a little staircase climbing to the flag block: the game in one picture
decor.block(w, vec2(-128, 10), 24, "asset:block_stone")
decor.block(w, vec2(-64, 10), 48, "asset:block_stone")
decor.block(w, vec2(0, 10), 72, "asset:block_goal")
decor.block(w, vec2(104, -36), 24, "asset:block_spring")
spawn("Sprite2D", { texture = "asset:goal_flag", size = vec2(40, 64), anchor = "bottom", position = vec2(16, 16), z = 72 }, w)
local hero = spawn("Sprite2D", { anims = "data/anims/hero.json", anim = "idle", size = vec2(40, 50), anchor = "bottom", position = vec2(-10, 14), z = 72 }, w)
tween(hero, { z = 96 }, 0.42, { easing = "quad_out", loop = true, yoyo = true })
tween(hero, { scale = vec2(1.08, 0.92) }, 0.42, { easing = "sine_in_out", loop = true, yoyo = true })
local gem = spawn("Sprite2D", { texture = "asset:gem", size = vec2(22, 26), anchor = "bottom", position = vec2(-64, 12), z = 100 }, w)
tween(gem, { z = 108 }, 0.7, { easing = "sine_in_out", loop = true, yoyo = true })
-- foreground cloud strip framing the buttons
for i = 0, 3 do
	spawn("Sprite2D", { texture = (i % 2 == 0) and "asset:cloud_a" or "asset:cloud_b", size = vec2(240, 120), position = vec2(-210 + i * 140, 300 + (i % 2) * 18), z_index = 20 }, w)
end

local logo = entity("title_logo")
tween(logo, { scale = vec2(1.03, 1.03) }, 1.4, { easing = "sine_in_out", loop = true, yoyo = true })

local unlocked = math.clamp(save.get("unlocked", 1), 1, 3)
local btnStart = entity("btn_start")
local btnCont = entity("btn_continue")
local btnHow = entity("btn_how")
if unlocked > 1 then
	btnCont.visible = true
	btnCont.text = "Continue: Level " .. unlocked
	btnCont.offset = vec2(0, 250)
	btnStart.text = "New Game"
	btnStart.offset = vec2(0, 366)
	btnHow.offset = vec2(0, 482)
else
	btnCont.visible = false
	btnStart.text = "Play"
	btnStart.offset = vec2(0, 270)
	btnHow.offset = vec2(0, 386)
end

btnStart.pressed:connect(function()
	sfx.play("select")
	run.gems = {}
	loadScene("scenes/level.scene.json", { level = 1 })
end)
btnCont.pressed:connect(function()
	sfx.play("select")
	loadScene("scenes/level.scene.json", { level = unlocked })
end)
btnHow.pressed:connect(function()
	sfx.play("select")
	local P = "asset:pip_portrait"
	ui.dialog({
		{ text = "Goal: hop across floating blocks to the golden flag!", speaker = "Pip", portrait = P },
		{ text = "Move with the joystick. Tap A to jump.", speaker = "Pip", portrait = P },
		{ text = "You can only jump one small step up. Climb tall blocks like stairs!", speaker = "Pip", portrait = P },
		{ text = "Your shadow shows where you'll land. Fall in the clouds and you lose a heart.", speaker = "Pip", portrait = P },
		{ text = "Grab pink gems. Some float high, so jump for them!", speaker = "Pip", portrait = P },
	})
end)
