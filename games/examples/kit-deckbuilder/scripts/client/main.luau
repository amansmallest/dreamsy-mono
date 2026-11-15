-- Lanternfall: the whole game is the deckbuilder kit's UI loop over data/ content.
local Core = require("@kit/core")
local DB = require("@kit/deckbuilder")

Core.setup({ save = { key = "lanternfall", version = 1 } })
DB.setup()

local icons = {}
for _, k in { "fight", "elite", "rest", "shop", "event", "treasure", "boss" } do icons[k] = "asset:nd_" .. k end
local intents = {}
for _, k in { "attack", "defend", "buff", "debuff", "attack_defend", "attack_debuff", "attack_buff", "unknown" } do intents[k] = "asset:in_" .. k end

DB.ui.play({
	title = "Lanternfall",
	subtitle = "The Undertow Bazaar has drowned. Your lantern is the last light.",
	logo = "asset:logo",
	background = "asset:bg_undertow",
	heroSprite = "asset:hero_wick",
	nodeIcons = icons,
	intentIcons = intents,
	goldIcon = "asset:gold",
	restArt = "asset:rest_fire",
	shopTitle = "Gill Market",
	restTitle = "A quiet lamp-lit alcove",
	music = { title = "map", map = "map", battle = "battle", boss = "boss" },
})
