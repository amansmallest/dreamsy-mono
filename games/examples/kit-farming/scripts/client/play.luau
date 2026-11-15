--!nonstrict
-- Mossbell Farm: every rule lives in data/*.json; the farming kit runs the farm and draws it.
local Farming = require("@kit/farming")
local core = require("@kit/core")
local juice = require("@kit/juice")

local farm, loaded = Farming.start({
	core = {
		save = { key = "mossbell", version = 1 },
		theme = { primary = "#4f8a5b", accent = "#ffd166", background = "#2b2135", text = "#fdf6e3", disabled = "#6b5f78", font = "rounded" },
	},
})
music.play("meadow")
juice.reveal("fade")

local view = Farming.bind(farm, {
	map = entity("map"),
	player = entity("player"),
	solid = "TfWVB",
	wake = vec2(216, 464),
	pens = { coop = { x = 14 * 48, y = 11 * 48, w = 4 * 48, h = 2 * 48 }, barn = { x = 14 * 48, y = 13 * 48, w = 4 * 48, h = 2 * 48 } },
	theme = { panel = "#2b2135dd" },
})

if not loaded then
	after(0.6, function()
		ui.dialog({
			{ text = "Welcome to Mossbell! Grandpa's old farm is yours now.", speaker = "Juniper", portrait = "asset:juniper" },
			{ text = "Tap a grassy field tile to till it, pick seeds in the hotbar, tap again to plant, then water.", speaker = "Juniper", portrait = "asset:juniper" },
			{ text = "Put crops in the shipping bin by the house - I pay out every night. Tap your house to sleep.", speaker = "Juniper", portrait = "asset:juniper" },
			{ text = "The Blossom Fair is on Spring 10. Don't miss it!", speaker = "Juniper", portrait = "asset:juniper" },
		})
	end)
end

core.events.onScene("quest_completed", function() juice.sfx("festival") end)
core.events.onScene("achievement_unlocked", function(d)
	local a = core.content.get("achievements", d.achievement)
	core.menus.toast("Achievement: " .. (a and a.name or d.achievement), 2)
	juice.confetti()
end)
-- the season finale: after day 20 the year wraps; show a wrap-up once
farm:on("season_changed", function()
	if entity("map") == nil then return end
	local h = farm:incomeHistory()
	local total = 0
	for _, s in h.seasons do total += s.total end
	ui.dialog({ { text = "Spring is over! You shipped " .. total .. "g of goods this season.", speaker = "Odessa", portrait = "asset:odessa" },
		{ text = "The valley will remember this spring. Keep farming as long as you like!", speaker = "Odessa", portrait = "asset:odessa" } })
end)
local _ = view
