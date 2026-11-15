-- Attached to each area's objects TileMap2D: the kit builds rooms, enemies, items, doors and NPCs from tiles + data/.
local G = require("../shared/game")
local inGrotto = currentScene() == "scenes/grotto.scene.json"
if inGrotto then music.play("grotto", { fade = 0.6 }) else music.play("village", { fade = 0.6 }) end

local area = G.start({ id = if inGrotto then "grotto" else "overworld", dungeon = if inGrotto then "grotto" else "overworld" })

area.events:on("bossDefeated", function()
	G.kit.progress.setFlag("grotto_cleared")
	G.kit.progress.save()
	ui.dialog({ "The Mire Warden dissolves into frogspawn and song.", "Grab the heart, then take the stairs up to Granny Wick." }, { speaker = "" })
end)
area.events:on("roomEnter", function(room, first)
	if inGrotto and first and room.key == "1,1" then ui.toast("A small key opens the east door", 2) end
end)
