--!strict
local p = sceneParams()
entity("win_stats").text = `COINS {p.coins or 0}    DEATHS {p.deaths or 0}`
music.play("title", { fade = 1 })
entity("again_button").pressed:connect(function()
	sfx.play("select")
	loadScene("scenes/title.scene.json")
end)
