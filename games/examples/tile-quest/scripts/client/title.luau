--!strict
local state = require("../shared/state")
local config = require("../shared/config")

music.play("title")

script.entity.pressed:connect(function()
	sfx.play("select")
	state.reset()
	loadScene(config.levels[1], { level = 1 })
end)
