--!strict
local C = require("../shared/config")
local S = require("../shared/state")
local Backdrop = require("../shared/backdrop")

music.play("summer")

local bd = Backdrop.build(entity("end_bg"), true)
local train = entity("end_train") :: any
local body = entity("end_body") :: any
local again = entity("again_button") :: any

local total = C.totalPeaches()
local line3 = "Mochi gets the juiciest one. Purr..."
if S.peaches >= total then
	line3 = "Every single peach! Mochi is one happy cat."
elseif S.peaches == 0 then
	line3 = "No peaches this time... Mochi naps anyway."
end
body.text = string.format("Mio and Mochi caught the evening train home.\nPeaches picked: %d of %d\n%s", S.peaches, total, line3)

local function restart()
	sfx.play("select")
	S.reset()
	loadScene("scenes/main.scene.json")
end
again.pressed:connect(restart)

local HX = C.HALF_W
local scroll = 0
local bobT = 0
local up = false
local t = 0
bd.update(HX, HX)
onTick(function(dt)
	t += dt
	scroll += 110 * dt
	bd.update(HX, HX + scroll)
	bobT += dt
	if bobT > 0.22 then
		bobT = 0
		up = not up
		train.position = vec2(HX, if up then 156 else 157)
	end
	if t > 2 and input.pressed("jump") then
		restart()
	end
end)
