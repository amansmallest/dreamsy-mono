--!nonstrict
-- Pebble Pals session state: one simulator for the whole session (survives scene reloads / restart).
local Sim = require("@kit/simulator")
local G = {}

function G.get()
	if G.s then return G.s, nil end
	local s, offline = Sim.start({
		core = {
			save = { key = "pebble_pals", version = 1 },
			theme = { primary = "#4f8fd6", accent = "#ffcf3f", background = "#3a2f4a", text = "#fffaf0", disabled = "#7a7088", font = "rounded" },
		},
		-- daily login streak (progression kit). Rewards are core effects, in-game coins only.
		daily = { name = "daily", rewards = {
			{ { earn = "coins", amount = 100 } }, { { earn = "coins", amount = 300 } }, { { earn = "coins", amount = 800 } },
			{ { hatch = "meadow_egg" } }, { { earn = "coins", amount = 3000 } }, { { earn = "coins", amount = 8000 } }, { { hatch = "creek_egg" } },
		} },
	})
	G.s = s
	return s, offline
end

return G
