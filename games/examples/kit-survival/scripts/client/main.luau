--!nonstrict
-- Ember Isle: a short survival run. All rules live in data/*.json; the survival kit runs world, needs,
-- crafting, building, nights and saving. This script only wires setup, intro and the win moment.
local core = require("@kit/core")
local juice = require("@kit/juice")
local S = require("@kit/survival")

core.setup({
	bag = { slots = 24 },
	save = { key = "ember_isle", version = 1 },
	theme = { primary = "#c46b2e", accent = "#ffd166", background = "#1d2430", text = "#f7f3e9", disabled = "#5b6270", font = "rounded" },
})
local C = S.content.load()
local s = S.new(C)
S.bind(s)
local loaded = core.save.load()

music.play("isle")
juice.reveal("fade")

local game = S.play(s, {
	objects = entity("objects"),
	glow = "asset:glow",
	stashSprite = "asset:stash",
	sfx = { hit = "hit", ["break"] = "break", craft = "craft", build = "build", hurt = "hurt", swing = "swing", pickup = "pickup", night = "night", dawn = "dawn" },
	doneText = "The isle is yours. Keep building!",
})

local cam = camera.current()
if cam then cam.limit_max = vec2(C.config.world.w * C.config.world.tile, C.config.world.h * C.config.world.tile) end

if not loaded then
	ui.dialog({
		{ text = "Washed up on Ember Isle… Night falls fast here.", speaker = "You" },
		{ text = "Punch trees and bushes for wood and fiber, then tap Craft for a Crude Pick.", speaker = "You" },
		{ text = "Light a campfire before dark. Shadows come at night.", speaker = "You" },
	}, { block = false })
end

core.events.onScene("milestone_reached", function(d)
	local m = nil
	for _, x in C.config.milestones do if x.id == d.milestone then m = x end end
	if m then
		core.menus.toast("Done: " .. (m.label or m.id), 1.8)
		juice.sfx("craft")
		if d.milestone == "night3" then juice.confetti() end
	end
end)
