--!nonstrict
-- One stage: the shooter kit runs it; this script only wires the flow (results -> hangar shop -> next stage / title).
local S = require("@kit/shooter")
local juice = require("@kit/juice")
local G = require("../shared/game")
G.setup()
juice.reveal("fade")
if G.run == nil then G.run = S.newRun({ ship = G.ship }) G.mode = "campaign" end
local run = G.run
local stageId = sceneParams().stage or run:nextStage() or "nebula_run"

local function toTitle() juice.transition("fade", { scene = "scenes/title.scene.json" }) end

S.play(run, stageId, {
	onClear = function(res)
		S.ui.results(res, function()
			local nxt = if G.mode == "campaign" then run:nextStage() else nil
			if nxt then
				S.ui.shop(run, function() juice.transition("fade", { scene = "scenes/play.scene.json", params = { stage = nxt } }) end)
			else
				juice.confetti()
				toTitle()
			end
		end, { nextLabel = if G.mode == "campaign" and run:nextStage() then "To the hangar" else "Finish" })
	end,
	onGameOver = function(res)
		S.ui.results(res, toTitle, { nextLabel = "Title" })
	end,
})
