--!strict
-- Session script: save data, intro dialog + choice, camera zoom-in, HUD.
local state = require("../shared/state")

local runs = save.get("runs", 0) + 1
save.set("runs", runs)
local best = save.get("best", 0)
entity("hud_runs").text = "RUN " .. runs .. (if best > 0 then "  BEST " .. best else "")

music.play("theme", { fade = 1 })

-- start zoomed out a little, then ease in
camera.zoomTo(4, 1.2, "sine_in_out")

-- title pulse (loop + yoyo)
tween(entity("hud_title"), { color = color("#ffcd75") }, 0.9, { easing = "sine_in_out", loop = true, yoyo = true })

after(0.4, function()
	local intro = ui.dialog({
		{ text = "Hoo! Welcome to the Dreamsy engine v3 demo.", speaker = "Professor Owl", portrait = "asset:owl" },
		{ text = "Run with the stick, jump with A. Grab every coin and mind the slimes!", speaker = "Professor Owl", portrait = "asset:owl" },
	})
	intro.done:connect(function()
		ui.choice({ text = "Ready?", speaker = "Professor Owl", portrait = "asset:owl" }, { "Let's go!", "Shake the camera first" }, function(i)
			sfx.play("select")
			if i == 2 then camera.shake(6, 0.6) end
			ui.toast("GO!", 1.2)
		end)
	end)
end)

state.onCollect = function()
	state.coins += 1
	entity("hud_coins").text = "COINS " .. state.coins .. "/" .. state.total
	if state.coins > save.get("best", 0) then
		save.set("best", state.coins)
		entity("hud_runs").text = "RUN " .. runs .. "  BEST " .. state.coins
	end
	if state.coins == state.total then
		camera.shake(4, 0.5)
		ui.dialog({ { text = "All coins! You found everything.", speaker = "Professor Owl", portrait = "asset:owl" } })
	end
end
