--!strict
-- NOTE: scripting API is provisional (DREAMSY.MD §4.1).
local step = script.entity
local origin = step.position
local t = 0

onTick(function(dt: number)
	t += dt
	step.position = origin + vec3(math.sin(t) * 3, 0, 0)
end)
