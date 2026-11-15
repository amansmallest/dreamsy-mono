-- Session setup shared by both scenes (modules load once and survive loadScene).
local core = require("@kit/core")
local R = require("@kit/runner")
local G = { ready = false, stageIndex = 1 }
function G.init()
	if G.ready then return end
	G.ready = true
	core.setup({ save = { key = "pebble_dash", version = 1 }, theme = { primary = "#3f5bd9", accent = "#ffd23f", background = "#23202e", text = "#ffffff", font = "rounded", disabled = "#5a5470" } })
	R.setup({ load = true })
end
return G
