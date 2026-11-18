--!strict
-- A kinematic pusher drives into the stack after one second (the only scripted motion).
local pusher = entity("pusher")
after(1, function() pusher.velocity = vec2(40, 0) end)
after(3, function() pusher.velocity = vec2(0, 0) end)
