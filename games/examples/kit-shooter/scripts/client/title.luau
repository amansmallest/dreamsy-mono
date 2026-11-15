--!nonstrict
-- Title: start the campaign, the arena, or pick a ship.
local S = require("@kit/shooter")
local core = require("@kit/core")
local juice = require("@kit/juice")
local G = require("../shared/game")
local C = G.setup()
music.play("title")
juice.reveal("fade")

local ship = entity("title_ship")
juice.float(ship, { height = 14, seconds = 1.6 })

local function label(text, y, size, col)
	return spawn("UIText", { anchor = "top", offset = vec2(0, y), size = vec2(680, size + 20), text = text, font_size = size, align = "center",
		color = col or "#f4f1ff", outline = "#0b1020", outline_size = 5, font = "bold" })
end
label("STARLING", 150, 96, "#ffd34d")
label("DRIFT", 250, 96, "#7fd8ff")
local best = label("", 640, 28, "#c9c3ff")
local function refresh()
	local m = S.meta()
	ship.texture = C.ships[G.ship].sprite
	best.text = "High score " .. m.highScore .. "   ·   " .. core.wallet.get("credits") .. " credits"
end
refresh()

local function button(text, y, color_, fn)
	local b = spawn("UIButton", { anchor = "top", offset = vec2(0, y), size = vec2(440, 104), text = text, font_size = 40, background = color_, color = "#ffffff", font = "bold" })
	b.pressed:connect(function() juice.sfx("select") juice.bounce(b) fn() end)
	return b
end
button("START", 708, "#5b4bd6", function() G.startCampaign() end)
button("ARENA", 828, "#d6487a", function() G.startArena() end)
button("HANGAR", 948, "#2f8f83", function()
	S.ui.ships(C, function(id)
		if S.shipState(C, id) == "owned" then G.ship = id core.menus.toast(C.ships[id].name .. " ready", 1) end
		refresh()
	end)
end)
label("Move with the stick · auto-fire · B = bomb", 1076, 24, "#9aa3d6")
