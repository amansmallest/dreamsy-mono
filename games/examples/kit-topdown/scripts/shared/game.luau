-- Tamsin of Wickhollow: shared setup (art, sounds, hero options). Content comes from data/ (kit.setup reads it).
local kit = require("@kit/topdown").setup()

local G = { kit = kit }

G.ART = {
	heart = "asset:hud_heart", heart_half = "asset:hud_heart_half", heart_empty = "asset:hud_heart_empty",
	chest = "asset:chest", chest_open = "asset:chest_open", bomb = "asset:bomb", hook = "asset:hook",
	rupee = "asset:rupee", heart_pickup = "asset:heart_pickup", slash = "asset:slash",
}
G.SOUNDS = {
	sword = "sword", hit = "hit", hurt = "hurt", die = "die", enemy_die = "enemy_die", pickup = "pickup",
	rupee = "rupee", key = "key", door = "door", chest = "chest", item = "item", bomb = "bomb", explode = "explode",
	secret = "secret", push = "push", warp = "warp", shop = "shop", error = "error", boss_hit = "boss_hit",
	boss_defeat = "boss_defeat", hook = "hook", select = "select", cut = "cut",
}

function G.start(extra)
	local opts = {
		room = { 15, 13 },
		hearts = 3,
		art = G.ART,
		sounds = G.SOUNDS,
		anims = { down = "down", up = "up", side = "side" },
		player = { speed = 78 },
	}
	for k, v in extra or {} do opts[k] = v end
	return kit.area.start(opts)
end

return G
