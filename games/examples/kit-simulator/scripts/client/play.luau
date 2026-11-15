--!nonstrict
-- Pebble Pals: everything on screen. Rules live in data/*.json; the simulator kit runs the economy + UI pieces.
local Sim = require("@kit/simulator")
local core = require("@kit/core")
local juice = require("@kit/juice")
local G = require("../shared/game")
local UI, F = Sim.ui, Sim.format

local s, offline = G.get()
music.play("meadow")
juice.reveal("fade")

local hud = UI.hud(s, { coinIcon = "asset:coin", bagIcon = "asset:bag" })
local field = UI.field(s, { area = { 40, 230, 640, 770 }, count = 6, size = 140, ground = entity("ground"), shadow = "asset:shadow", ring = "asset:ring" })

-- current quest strip under the HUD
local quest = UI.text(nil, { offset = vec2(24, 162), size = vec2(560, 40), font_size = 24, text = "", z_index = 40, color = "#3a2f4a" })
local function questLine()
	for _, def in core.quests.list("active") do
		local id = def.id
		local p = core.quests.progress(id)[1]
		if p then return (def.title or id) .. ": " .. (p.text or "") .. "  " .. F.num(math.min(p.count, p.target)) .. "/" .. F.num(p.target) end
	end
	return "All quests done! Keep rebirthing for bigger multipliers."
end
every(0.5, function() quest.text = questLine() end)
quest.text = questLine()
core.events.onScene("quest_completed", function(d)
	local def = core.content.get("quests", d.quest)
	core.menus.toast("Quest complete: " .. (def and def.title or d.quest), 2)
	juice.sfx("unlock")
end)

local HUD_COINS = vec2(60, 50)
local function sell()
	local coins = s:sell()
	if coins > 0 then
		UI.sellFx(s, coins, vec2(360, 860), camera.screenToWorld(HUD_COINS))
	else
		core.menus.toast("Your bag is empty — tap some rocks!", 1.5)
	end
end

-- secondary row: rebirth / daily / quests / stats
local rebirthBtn
local row2 = UI.bar({
	{ label = "Rebirth", color = "#9a5fd6", onPress = function() UI.rebirth(s) end },
	{ label = "Daily", color = "#3f9b5a", onPress = function() UI.daily(s.daily, { label = function(r, i) return "Day " .. i end }) end },
	{ label = "Quests", color = "#d6874f", onPress = function() UI.quests() end },
	{ label = "Stats", color = "#6b6f8a", onPress = function() UI.stats(s) end },
}, { y = 1010, height = 96 })
rebirthBtn = row2.buttons[1]

UI.bar({
	{ label = "SELL", wide = true, color = "#e8a020", onPress = sell },
	{ label = "Gear", onPress = function()
		core.menus.list({ title = "Gear", items = {
			{ label = "Tools", detail = "(" .. (s:toolDef().name or s.tool) .. ")", onSelect = function() UI.shop(s, "tools") end },
			{ label = "Backpacks", detail = "(" .. F.num(s:capacity()) .. ")", onSelect = function() UI.shop(s, "backpacks") end },
		} })
	end },
	{ label = "Eggs", onPress = function() UI.eggs(s) end },
	{ label = "Pets", onPress = function() UI.pets(s) end },
	{ label = "Map", onPress = function() UI.zones(s) end },
}, { y = 1116, height = 120 })

-- glow buttons that have something to do
every(0.5, function()
	local g = s:rebirthGain()
	rebirthBtn.text = if s:canRebirth() then "Rebirth +" .. g else "Rebirth"
	local st = s.daily:status()
	row2.buttons[2].text = if st.canClaim then "Daily!" else "Daily"
end)

if offline then UI.offline(s, offline) end
core.events.onScene("zone_unlocked", function() juice.sfx("unlock") end)
