--!strict
local config = require("../shared/config")
local player = script.entity
local sprite = player:children()[1]

onTick(function(dt: number)
	local v = player.velocity
	local mx = input.axis("move_x")
	local y = v.y
	if input.pressed("jump") and player.onFloor then
		y = -config.jumpVelocity
		sfx.play("jump")
	end
	player.velocity = vec2(mx * config.moveSpeed, y)
	if mx < 0 then sprite.flip_h = true elseif mx > 0 then sprite.flip_h = false end
end)
