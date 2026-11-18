--!strict
-- Walks right at 60 px/s and reports what it bumps into or crosses (tick numbers, so both engines can be compared).
local me = script.entity
local ticks = 0

onTick(function(dt: number)
	ticks += 1
	me.velocity = vec2(60, 0)
end)

me.bodyEntered:connect(function(other)
	print(`bumped {other.id} at tick {ticks}`)
end)

entity("pad").bodyEntered:connect(function(other)
	print(`{other.id} crossed the pad at tick {ticks}`)
end)
