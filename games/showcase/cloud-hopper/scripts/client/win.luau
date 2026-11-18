local decor = require("../shared/decor")
local run = require("../shared/run")

music.play("sky_tune")
sfx.play("win")
if leaderboard.running("full_run") then leaderboard.finish("full_run") end
platform.runEnded("finish")

local w = entity("win_world")
decor.sky(w)
decor.clouds(w, -320, 320, -520, 520, 30)
decor.block(w, vec2(-130, 140), 48, "asset:block_stone")
decor.block(w, vec2(130, 120), 72, "asset:block_check")
decor.block(w, vec2(0, 60), 120, "asset:block_goal")
spawn("Sprite2D", { texture = "asset:goal_flag", size = vec2(40, 64), anchor = "bottom", position = vec2(18, 68), z = 120 }, w)
local hero = spawn("Sprite2D", { anims = "data/anims/hero.json", anim = "jump", size = vec2(40, 50), anchor = "bottom", position = vec2(-8, 66), z = 120 }, w)
tween(hero, { z = 160 }, 0.4, { easing = "quad_out", loop = true, yoyo = true })
local conf = spawn("Particles2D", { shape = "square", rate = 40, start_color = color("#ffd84a"), end_color = color("#ff5fa800"), speed = 60, direction = 90, spread = 40, gravity = vec2(0, 120), lifetime = 4, start_size = 8, end_size = 6, emission_size = vec2(480, 10), position = vec2(0, -440), z_index = 40, max_particles = 300 }, w)

local total, got = 0, 0
for n = 1, 3 do
	local L = data.read("data/levels/level_" .. n .. ".json")
	for _, line in ipairs(L.rows) do
		for tok in string.gmatch(line, "%S+") do
			if string.find(tok, "[gj]") then total += 1 end
		end
	end
	got += math.max(run.gems[n] or 0, save.get("gems_" .. n, 0))
end
entity("win_gems").text = "Gems found: " .. got .. " / " .. total
if got >= total then entity("win_sub").text = "Every gem! You're a true sky explorer!" end

local t = entity("win_title")
t.scale = vec2(0.3, 0.3)
tween(t, { scale = vec2(1, 1) }, 0.5, "back_out")

entity("win_again").pressed:connect(function()
	sfx.play("select")
	run.gems = {}
	loadScene("scenes/level.scene.json", { level = 1, skipIntro = true })
end)
entity("win_menu").pressed:connect(function()
	sfx.play("select")
	loadScene("scenes/main.scene.json")
end)
