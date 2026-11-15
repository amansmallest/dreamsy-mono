--!nonstrict
-- Title screen → reader. Everything else lives in data/story/*.
local Story = require("@kit/story")
local UI = require("@kit/story/ui")
local juice = require("@kit/juice")
local G = require("../shared/game")

G.init()
juice.reveal("fade")
UI.title(Story, {
	title = "Lanternlight",
	subtitle = "A Saltreach Light mystery",
	background = "harbor",
	music = "tide",
	onStart = function(slot) Story.play({ resume = slot }) end,
})
