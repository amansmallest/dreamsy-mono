--!strict
-- World map: one card per pack (stars gate the next one) + today's puzzle.
local App = require("../shared/app")
local Puzzle = require("@kit/puzzle")
local juice = require("@kit/juice")
juice.reveal("fade", { color = App.PAPER })
music.play("calm")

local total = Puzzle.progress.totalStars()
App.title("Paper Grid", "three packs · " .. total .. " stars · day streak " .. Puzzle.daily.streak())
local dailyDone = Puzzle.daily.solved()
Puzzle.ui.packList(App.packs, {
	icons = App.icons,
	onPick = function(p: any) App.levels(p.id) end,
	extra = { { "Daily", if dailyDone then "Solved today · back tomorrow" else "A fresh flow puzzle", function() App.daily() end, "asset:icon_sun" } },
})
