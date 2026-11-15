--!strict
-- Session script (not attached to an entity): it survives every loadScene, so the kit lives here.
local rpg = require("@kit/rpg")

-- loads data/rpg.json, data/types.json and data/<kind>/*.json
rpg.setup()

-- example hooks: a toast when the trial is cleared, and a custom quest objective helper
rpg.events.trainerDefeated:connect(function(id: string)
	if id == "warden_vela" then
		rpg.ui.fade(0, 0.01)
		ui.toast("You earned the Starfall Sigil!", 3)
	end
end)
rpg.events.creatureCaught:connect(function(mon)
	print("caught", mon.id, mon.level)
end)
