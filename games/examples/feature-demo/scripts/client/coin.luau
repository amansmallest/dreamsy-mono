--!strict
-- Coin pickup: bobbing tween (loop + yoyo), sparkle burst, pop-and-fade tween, then destroy.
local state = require("../shared/state")
local c = script.entity
local spr = c:children()[1]
local base = c.position
local bob = tween(c, { position = base + vec2(0, -3) }, 0.7, { easing = "sine_in_out", loop = true, yoyo = true, delay = random(0, 0.6) })
local taken = false

c.bodyEntered:connect(function(other)
	if taken or not other:hasTag("player") then return end
	taken = true
	bob:cancel()
	sfx.play("coin", { pitch = 1 + random(0, 0.2) })
	local fx = entity("sparkle")
	fx.position = c.position
	fx:burst(14)
	local t = tween(spr, { scale = vec2(2.2, 2.2), modulate = color("#ffffff00") }, 0.35, "back_out")
	tween(c, { position = c.position + vec2(0, -10) }, 0.35, "quad_out")
	t.done:connect(function() c:destroy() end)
	state.onCollect()
end)
