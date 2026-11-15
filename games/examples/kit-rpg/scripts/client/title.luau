--!strict
-- Title screen: New Game / Continue (Continue is dimmed when there is no save).
local rpg = require("@kit/rpg")
music.play("title", { fade = 0.5 })
local btnNew = entity("btn_new")
local btnContinue = entity("btn_continue")
local hasSave = rpg.hasSave()
if not hasSave then
	btnContinue.background = "#566c86"
	btnContinue.text = "NO SAVE"
end
btnNew.pressed:connect(function()
	sfx.play("select")
	rpg.newGame()
end)
btnContinue.pressed:connect(function()
	if hasSave then
		sfx.play("select")
		rpg.continueGame()
	end
end)
-- gentle bob on the hero creature
tween(entity("title_hero"), { position = vec2(0, 100) }, 1.6, { easing = "sine_in_out", loop = true, yoyo = true })
