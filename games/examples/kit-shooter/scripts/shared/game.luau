--!nonstrict
-- Starling Drift session state: content + the current run survive scene changes (modules load once).
local S = require("@kit/shooter")
local G = {}

function G.setup()
	if G.C then return G.C end
	G.C = S.setup({ core = {
		save = { key = "starling_drift", version = 1 },
		theme = { primary = "#5b4bd6", accent = "#ffd34d", background = "#151a3d", text = "#f4f1ff", disabled = "#4a4f6e", font = "bold" },
	} })
	G.ship = G.C.config.startShip
	return G.C
end

-- campaign: stage after stage with the hangar shop in between
function G.startCampaign()
	G.setup()
	G.run = S.newRun({ ship = G.ship })
	G.mode = "campaign"
	loadScene("scenes/play.scene.json", { stage = G.run:nextStage() })
end

function G.startArena()
	G.setup()
	G.run = S.newRun({ ship = G.ship })
	G.mode = "arena"
	loadScene("scenes/play.scene.json", { stage = "the_ring" })
end

return G
