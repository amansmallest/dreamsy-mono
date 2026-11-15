--!strict
-- Level select for one pack: scrolling grid, stars per level, sequential unlocks.
local App = require("../shared/app")
local Puzzle = require("@kit/puzzle")
local juice = require("@kit/juice")
juice.reveal("fade", { color = App.PAPER })

local pack = Puzzle.packs.get(sceneParams().pack or "push")
App.title(pack.name, Puzzle.progress.packStars(pack.id) .. " / " .. pack:count() * 3 .. " stars")
Puzzle.ui.button(nil, "", function() App.menu() end, { anchor = "top_right", offset = vec2(-130, 60), size = vec2(96, 80), icon = App.icons.back, icon_size = 44, z_index = 6 })
Puzzle.ui.levelGrid(pack, { icons = App.icons, onPick = function(i: number) App.play(pack.id, i) end })
