--!strict
-- Platformer controller: anims (idle/run/jump/hurt), dust particles, hit reaction with camera shake + tweened tint.
local p = script.entity
local spr = entity("player_sprite")
local dust = entity("dust")
local SPEED, JUMP = 80, 230
local wasFloor = true
local hurtUntil = 0

onTick(function(dt)
	local x = input.axis("move_x")
	local v = p.velocity
	p.velocity = vec2(x * SPEED, v.y)
	local floor = p.onFloor
	if input.pressed("jump") and floor then
		p.velocity = vec2(p.velocity.x, -JUMP)
		sfx.play("jump")
		dust:burst(6)
	end
	if time() >= hurtUntil then
		if not floor then p:play("jump")
		elseif math.abs(x) > 0.1 then p:play("run")
		else p:play("idle") end
	end
	dust.emitting = floor and math.abs(x) > 0.1
	if floor and not wasFloor then dust:burst(8) end
	wasFloor = floor
	-- fell off the world: back to start
	if p.position.y > 460 then p.position = vec2(56, 250) camera.snap() end
end)

p.bodyEntered:connect(function(other)
	if not other:hasTag("enemy") or time() < hurtUntil then return end
	hurtUntil = time() + 0.6
	p:play("hurt", true)
	sfx.play("hurt")
	camera.shake(5, 0.35)
	local dir = if p.position.x < other.position.x then -1 else 1
	p.velocity = vec2(dir * 120, -160)
	spr.modulate = color("#ff6060")
	tween(spr, { modulate = color("#ffffff") }, 0.5, "quad_in")
end)
