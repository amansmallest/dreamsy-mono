-- World map / level select (driven by data/world.json + save data).
local G = require("../shared/game")
music.play("meadow", { fade = 0.5 })
G.kit.worldmap.start({
	art = { node = "asset:node", node_done = "asset:node_done", node_locked = "asset:node_locked", node_boss = "asset:node", cursor = "asset:moss_idle" },
	sounds = { move = "select", enter = "enter", locked = "locked" },
})
