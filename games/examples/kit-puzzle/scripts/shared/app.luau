--!strict
-- Paper Grid: shared setup (packs, skins, icons, navigation). All puzzle rules live in the puzzle kit; content in data/.
local Puzzle = require("@kit/puzzle")
local juice = require("@kit/juice")
local App = {}

App.INK, App.PAPER, App.TAN = "#111111", "#fdf5df", "#efe4c6"
-- poster inks for gem/pipe colours (index = colour id)
App.palette = { "#e4572e", "#2e5eaa", "#f2a541", "#3a7d44", "#7b3f8c", "#4fb3bf" }
App.icons = {
	star = "asset:icon_star", starEmpty = "asset:icon_star_empty", undo = "asset:icon_undo", restart = "asset:icon_restart",
	hint = "asset:icon_hint", lock = "asset:icon_lock", back = "asset:icon_back",
}
local GEMS = { "asset:gem_1", "asset:gem_2", "asset:gem_3", "asset:gem_4", "asset:gem_5", "asset:gem_1" }
App.skins = {
	push = {
		floor = { color = App.TAN }, wall = { color = App.INK },
		goal = { sprite = "asset:goal", size = 0.62 },
		box = { sprite = "asset:crate", onSprite = "asset:crate_on", size = 0.86 },
		player = { sprite = "asset:walker", size = 0.84 },
		hint = { color = "#f2a54199", size = 0.96 },
	},
	flow = {
		cell = { color = App.TAN }, wall = { color = App.INK },
		["end"] = { sprite = "asset:dot", color = "tint", size = 0.74 },
		pipe = { color = "tint", size = 0.38 },
		link_h = { color = "tint", size = { 1, 0.38 } }, link_v = { color = "tint", size = { 0.38, 1 } },
		hint = { color = "#11111133", size = 0.9 },
	},
	match3 = {
		slot = { color = App.TAN }, jelly = { sprite = "asset:jelly", size = 0.98 },
		gem = function(item: any)
			return { sprite = GEMS[item.tint] or GEMS[1], color = "tint", size = 0.84,
				specials = { line_h = "asset:sp_line_h", line_v = "asset:sp_line_v", bomb = "asset:sp_bomb" } }
		end,
		orb = { sprite = "asset:orb", size = 0.86 },
		select = { color = "#11111144", size = 1.0 },
		hint = { color = "#f2a54188", size = 1.0 },
	},
}
-- daily: flow, harder later in the week (Mon 0 … Sun 6)
App.DAILY = { mechanic = "flow", curve = { { at = 0, params = { w = 5, pairs = 5 } }, { at = 3, params = { w = 6, pairs = 5 } }, { at = 6, params = { w = 7, pairs = 6 } } } }

App.packs = Puzzle.setup()          -- data/packs/*.json + load the save
App.current = nil :: any            -- play scene state (bots, debugging)

function App.go(scene: string, params: any?)
	juice.transition("fade", { scene = scene, params = params, seconds = 0.2, color = App.PAPER })
end
function App.menu() App.go("scenes/menu.scene.json") end
function App.levels(packId: string) App.go("scenes/levels.scene.json", { pack = packId }) end
function App.play(packId: string, i: number) App.go("scenes/play.scene.json", { pack = packId, level = i }) end
function App.daily() App.go("scenes/play.scene.json", { daily = true }) end

-- big poster title (top-left, tight)
function App.title(text: string, sub: string?)
	Puzzle.ui.text(nil, text, { anchor = "top_left", offset = vec2(40, 40), size = vec2(560, 110), font_size = 92, color = App.INK, font = "bold", z_index = 5 })
	if sub then Puzzle.ui.text(nil, sub, { anchor = "top_left", offset = vec2(44, 150), size = vec2(600, 44), font_size = 28, color = App.INK, font = "serif", z_index = 5 }) end
end

return App
