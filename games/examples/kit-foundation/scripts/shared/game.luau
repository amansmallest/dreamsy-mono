--!nonstrict
-- Shared game state: kit instances + helpers. Modules load once and survive loadScene.
local core = require("@kit/core")
local prog = require("@kit/progression")
local juice = require("@kit/juice")

local G = { core = core, prog = prog, juice = juice, started = false, playing = false }
G.TITLE = "scenes/title.scene.json"
G.GARDEN = "scenes/garden.scene.json"

function G.init()
	if G.started then return end
	G.started = true
	core.setup({
		currencies = { gold = { name = "Gold", icon = "asset:coin", max = 99999 } },
		bag = { slots = 12 },
		theme = { primary = "#4f8a5b", accent = "#ffd166", background = "#22333b", text = "#f7f3e9", font = "rounded" },
		save = {
			key = "owl_garden", version = 2,
			-- v1 saves didn't track popped slimes; seed the counter so dialog text works
			migrate = function(d, from)
				if from < 2 then d.flags = d.flags or {} d.flags.slimes_popped = d.flags.slimes_popped or 0 end
				return d
			end,
		},
	})
	G.level = prog.leveler({ name = "player", curve = { kind = "quadratic", base = 15, linear = 25, maxLevel = 20 } })
	G.skills = prog.tree({ points = 1 })
	G.level:onLevelUp(function(L, gained) G.skills:addPoints(gained) end)
	for _, ev in { "quest_completed", "level_up", "skill_unlocked", "achievement_unlocked" } do
		core.events.on(ev, function() if G.playing then core.save.save() end end)
	end
end

-- fresh(): new game state (after core.newGame())
function G.fresh()
	core.newGame()
	G.skills.points = 1
	core.flags.set("slimes_popped", 0)
end

function G.damage(): number return 1 + G.skills:rank("strong_arm") end
function G.go(scene: string) juice.transition("iris", { scene = scene, seconds = 0.35, color = "#22333b" }) end
return G
