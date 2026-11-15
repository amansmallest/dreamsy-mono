-- Attached to every level's TileMap2D: one call builds the whole level from its tiles + data/.
local G = require("../shared/game")
local cave = string.find(currentScene(), "2_2") ~= nil or string.find(currentScene(), "2_b") ~= nil
if cave then music.play("cave", { fade = 0.5 }) else music.play("meadow", { fade = 0.5 }) end

local level = G.startLevel({ map = script.entity })
level.events:on("bossDefeated", function()
	ui.toast("The Toad of the Throne is beaten! Greenhollow is safe.", 3)
end)
