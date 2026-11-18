--!strict
-- Walks right at 60 px/s, jumps once, and reports landings, pickups and bumps by tick so both engines
-- can be compared line for line (engine/tests/conformance/run_compare.py).
local me = script.entity :: Entity
local ticks = 0
local grounded = true

onTick(function(dt: number)
	ticks += 1
	me.velocity = vec2(60, 0)
	if ticks == 50 then
		me.z_velocity = 380
		print(`jump at tick {ticks} (view {camera.view()})`)
	end
	local now = me.onGround
	if now and not grounded then
		print(`landed at tick {ticks} on ground {me.groundZ} (z {me.z})`)
	elseif grounded and not now and ticks ~= 50 then
		print(`left the ground at tick {ticks} (ground below {me.groundZ})`)
	end
	grounded = now
end)

me.bodyEntered:connect(function(other: Entity)
	if other.id ~= "coin" then print(`bumped {other.id} at tick {ticks}`) end
end)

entity("coin").bodyEntered:connect(function(other: Entity)
	print(`{other.id} took the coin at tick {ticks} (z {math.floor(other.z)})`)
	entity("coin"):destroy()
end)
