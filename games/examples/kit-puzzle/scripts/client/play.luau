--!strict
-- One level: board view + HUD + result card. Rules, hints, stars and saving come from the puzzle kit.
local App = require("../shared/app")
local Puzzle = require("@kit/puzzle")
local juice = require("@kit/juice")
juice.reveal("fade", { color = App.PAPER })
music.play("calm")

local params = sceneParams()
local pack: any = nil
local level: any
local title: string
if params.daily then
	level = Puzzle.daily.level(App.DAILY.mechanic, App.DAILY)
	title = "Daily"
else
	pack = Puzzle.packs.get(params.pack or "push")
	level = pack:level(params.level or 1)
	title = pack.name .. " " .. (params.level or 1)
end
local session = Puzzle.session(level, { pack = level.pack, index = level.index })

-- fit the board between the HUD (top 240) and the buttons (bottom 190)
local b = session.state.board
local cell = math.floor(math.min(640 / b.w, 780 / b.h, 112))
local gap = math.max(4, math.floor(cell * 0.07))
local size = vec2(b.w * (cell + gap) - gap, b.h * (cell + gap) - gap)
local origin = vec2(math.floor((720 - size.x) / 2), math.floor(250 + (840 - size.y) / 2))
-- ink frame behind the board
spawn("Sprite2D", { position = origin + size / 2, size = size + vec2(28, 28), modulate = App.INK, z_index = -2 })
spawn("Sprite2D", { position = origin + size / 2, size = size + vec2(16, 16), modulate = App.PAPER, z_index = -1 })

local view = Puzzle.view.new(session, { origin = origin, cell = cell, gap = gap, skin = App.skins[level.mechanic], palette = App.palette })

local function back() if pack then App.levels(pack.id) else App.menu() end end
local hud = Puzzle.ui.hud(session, { title = title, icons = App.icons, onBack = back, onHint = function() view:hint() end, textColor = App.INK })

local function nextLevel()
	if pack and level.index < pack:count() then App.play(pack.id, level.index + 1) else back() end
end
session:on("won", function()
	Puzzle.record(session)
	after(0.9, function()
		Puzzle.ui.result(session, "win", { { "Map", back }, { "Retry", function() session:restart() end }, { "Next", nextLevel } }, { icons = App.icons })
	end)
end)
session:on("lost", function()
	after(0.6, function()
		Puzzle.ui.result(session, "lose", { { "Map", back }, { "Retry", function() session:restart() end } }, { icons = App.icons })
	end)
end)

App.current = { session = session, view = view, hud = hud, level = level, pack = pack, nextLevel = nextLevel, back = back }
