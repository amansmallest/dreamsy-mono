-- Bramble Watch: shared setup (content, campaign progress, theme). Modules survive loadScene.
local TD = require("@kit/tower-defense")

local G = {}
G.TD = TD
G.content = TD.content() -- data/{enemies,towers,waves,levels}/*.json + data/campaign.json
G.campaign = TD.Campaign.load(G.content)

G.SCENE = { meadow = "scenes/meadow.scene.json", creek = "scenes/creek.scene.json", stump = "scenes/stump.scene.json" }
G.LEVEL_OF = {}
for id, path in G.SCENE do
	G.LEVEL_OF[path] = id
end

G.theme = {
	buttonTexture = "asset:ui_ring",
	rangeTexture = "asset:range_circle",
	button = "#2d3a2a",
	selected = "#ffd166",
	sellIcon = "asset:icon_sell",
	targetIcon = "asset:icon_target",
	font = "rounded",
}
G.hudTheme = {
	panel = "#1d2b1dee", -- button / text / font default to [ui] in dreamsy.toml
	buttonAlt = "#40513d",
	icons = { money = "asset:icon_seed", lives = "asset:icon_heart", wave = "asset:icon_wave", star = "asset:icon_star" },
}
G.sfx = {
	build = "build", upgrade = "upgrade", sell = "sell", kill = "kill", leak = "leak", wave = "wave", deny = "deny",
	select = "select",
	shoot = { thorn = "shoot_thorn", acorn = "shoot_acorn", frost = "shoot_frost", spark = "shoot_spark" },
}

return G
