-- Bramble Watch: one level scene (meadow / creek / stump; stump also hosts endless mode).
local G = require("../shared/game")
local TD = G.TD
local juice = require("@kit/juice")

local root = script.entity
local params = sceneParams()
local levelId = G.LEVEL_OF[currentScene()] or "meadow"
local endless = params.endless == true
local prefix = root.id:gsub("_world$", "")
local map = entity(prefix .. "_map")
local layer = entity(prefix .. "_layer")

music.play("garden")

local game
local function toTitle()
	loadScene("scenes/title.scene.json")
end
local function retry()
	loadScene(currentScene(), { endless = endless })
end

local function nextLevel()
	local list = G.campaign:levels()
	for i, l in list do
		if l.id == levelId and list[i + 1] and list[i + 1].unlocked then
			loadScene(G.SCENE[list[i + 1].id])
			return
		end
	end
	toTitle()
end

local function unlockText(res)
	local parts = {}
	local p = res.progress
	if p then
		for _, t in p.unlocked.towers do
			table.insert(parts, G.content.towers[t].name)
		end
		for _, b in p.unlocked.branches do
			local tid, bid = b:match("^(.-)%.(.+)$")
			local def = G.content.towers[tid]
			for _, br in def.branches do
				if br.id == bid then
					table.insert(parts, br.name)
				end
			end
		end
	end
	if #parts == 0 then
		return nil
	end
	return "New: " .. table.concat(parts, ", ")
end

game = TD.play(G.content, levelId, {
	map = map,
	root = layer,
	campaign = G.campaign,
	endless = endless,
	theme = G.theme,
	hudTheme = G.hudTheme,
	sfx = G.sfx,
	onWin = function(res)
		sfx.play("win")
		game.hud:banner({
			title = "VAULT SAFE!",
			subtitle = unlockText(res) or (res.lives .. " lives left"),
			stars = res.stars,
			buttons = {
				{ text = "MAP", onPress = toTitle },
				{ text = "RETRY", onPress = retry },
				{ text = "NEXT", onPress = nextLevel, primary = true },
			},
		})
	end,
	onLose = function(res)
		sfx.play("lose")
		game.hud:banner({
			title = if endless then "WAVE " .. res.wave else "OVERRUN!",
			subtitle = if endless then "Best: wave " .. G.campaign:endlessBest() else "Wave " .. res.wave .. " of " .. res.waves,
			buttons = {
				{ text = "MAP", onPress = toTitle },
				{ text = "RETRY", onPress = retry, primary = true },
			},
		})
	end,
})

-- toast tower unlocks the first time a level starts with them
if levelId == "creek" and not endless then
	ui.toast("New tower: Dewdrop Chiller slows bugs!", 3)
elseif levelId == "stump" and not endless then
	ui.toast("Boss incoming on the last wave!", 3)
end
game.sim:on("bossSpawned", function()
	ui.toast("The Stag King approaches!", 2.5)
	juice.shake(10, 0.5)
end)
