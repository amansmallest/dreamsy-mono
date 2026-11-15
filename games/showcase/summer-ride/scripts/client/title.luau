--!strict
local Backdrop = require("../shared/backdrop")
local S = require("../shared/state")
local C = require("../shared/config")

music.play("summer")

local bd = Backdrop.build(entity("title_bg"), false)
local bike = entity("title_bike") :: any
local logo = entity("title_logo") :: any
local startBtn = entity("start_button") :: any

local started = false
local function start()
	if started then return end
	started = true
	sfx.play("select")
	S.reset()
	loadScene("scenes/ride.scene.json", { stage = 1 })
end
startBtn.pressed:connect(start)

local HX = C.HALF_W
local scroll = 0
local dist = 0
local frame = 1
bd.update(HX, HX)
onTick(function(dt)
	scroll += 70 * dt
	bd.update(HX, HX + scroll)
	dist += 70 * dt
	if dist > 6 then
		dist -= 6
		frame = 3 - frame
		bike.texture = if frame == 1 then "asset:bike_1" else "asset:bike_2"
		bike.position = vec2(190, if frame == 2 then 163 else 164)
	end
	logo.position = vec2(HX, 32 + math.floor(math.sin(time() * 1.5) * 1.5 + 0.5))
	if input.pressed("jump") then
		start()
	end
end)
