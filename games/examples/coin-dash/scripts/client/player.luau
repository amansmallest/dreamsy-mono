--!strict
local config = require("../shared/config")
local player = script.entity

onTick(function(dt: number)
	local v = player.velocity
	local x = input.axis("move_x") * config.moveSpeed
	local y = v.y
	if input.pressed("jump") and player.onFloor then
		y = -config.jumpVelocity
	end
	player.velocity = vec2(x, y)
end)
