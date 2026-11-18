local cfg = require("../shared/config")
local run = require("../shared/run")

local me = script.entity
local spr = entity("hero_sprite")

local vel = vec2(0, 0)
local lastGround = -10
local bufferT = -10
local jumped = false
local wasGround = true

local function squash(sx, sy)
	spr.scale = vec2(sx, sy)
	tween(spr, { scale = vec2(1, 1) }, 0.2, "quad_out")
end

onTick(function(dt)
	local t = time()
	if run.frozen then
		vel = vec2(0, 0)
		me.velocity = vel
		wasGround = me.onGround
		bufferT = -10
		return
	end

	-- planar movement with a little acceleration
	local d = vec2(input.axis("move_x"), input.axis("move_y"))
	if d:length() > 1 then d = d:normalized() end
	local k = math.min(1, (me.onGround and 16 or 9) * dt)
	vel = vel + (d * cfg.SPEED - vel) * k
	me.velocity = vel

	-- jump: buffered press + coyote time
	local ground = me.onGround
	if ground then
		lastGround = t
		jumped = false
	end
	if input.pressed("jump") then bufferT = t end
	if t - bufferT < 0.12 and not jumped and (ground or t - lastGround < 0.1) then
		bufferT = -10
		jumped = true
		me.z_velocity = cfg.JUMP
		run.jumps = (run.jumps or 0) + 1
		sfx.play("jump")
		squash(0.8, 1.2)
	end

	-- landing
	if ground and not wasGround and me.groundZ > 0 then
		sfx.play("land", { volume = 0.6 })
		run.fx("dust", me.position - vec2(0, me.z))
		squash(1.25, 0.8)
		if cfg.DEBUG then
			print("land col", math.floor(me.position.x / cfg.TILE), "row", math.floor(me.position.y / cfg.TILE), "z", math.floor(me.z), "groundZ", me.groundZ)
		end
	end
	wasGround = ground

	-- fell into the cloud sea
	if ground and me.groundZ <= 0.5 and me.z <= 0.5 and t > run.grace then
		if cfg.DEBUG then print("FELL at", math.floor(me.position.x), math.floor(me.position.y)) end
		run.fell()
		return
	end

	if not ground then
		spr:play("jump")
	elseif vel:length() > 25 then
		spr:play("run")
	else
		spr:play("idle")
	end
end)
