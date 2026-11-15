-- Mossling: shared setup for every scene (art, sounds, level options). Content comes from data/.
local kit = require("@kit/platformer")

local G = { kit = kit }

G.ART = {
	checkpoint = "asset:checkpoint", checkpoint_on = "asset:checkpoint_on", goal = "asset:goal",
	platform = "asset:platform", shot = "asset:shot", enemy_shot = "asset:spit",
	heart = "asset:heart_full", heart_empty = "asset:heart_empty",
}
G.SOUNDS = {
	jump = "jump", coin = "coin", gem = "gem", stomp = "stomp", hurt = "hurt", die = "die",
	checkpoint = "checkpoint", powerup = "powerup", shoot = "shoot", dash = "dash", spring = "spring",
	["break"] = "break", clear = "clear", boss_hit = "boss_hit", boss_defeat = "boss_defeat",
}

-- the per-level script calls this; `extra` overrides any option
function G.startLevel(extra)
	local opts = {
		art = G.ART,
		sounds = G.SOUNDS,
		anims = { idle = "idle", run = "run", jump = "jump", fall = "fall" },
		player_size = { 12, 14 },
		health = 3,
		camera = { look_ahead = 36 },
	}
	for k, v in extra or {} do opts[k] = v end
	return kit.level.start(opts)
end

return G
