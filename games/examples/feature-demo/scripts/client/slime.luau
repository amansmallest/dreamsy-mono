--!strict
-- Patrolling slime (collision layer "enemy": slimes pass through each other, collide with world + player).
local s = script.entity
local dir = if s.id == "slime" then -1 else 1
every(1.6, function() dir = -dir end)
onTick(function()
	local v = s.velocity
	s.velocity = vec2(dir * 22, v.y)
end)
