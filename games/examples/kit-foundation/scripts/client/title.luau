--!nonstrict
local G = require("../shared/game")
G.init()
local core, juice = G.core, G.juice
G.playing = false
juice.reveal("fade", { color = "#22333b" })

local cont, new = entity("btn_continue"), entity("btn_new")
cont.visible = core.save.exists()
juice.float(entity("title_owl"), { height = 14, seconds = 1.2 })
juice.pulse(if cont.visible then cont else new, { amount = 0.05, seconds = 0.8 })

cont.pressed:connect(function()
	if core.menus.isOpen() then return end
	if core.save.load() then
		G.playing = true
		G.go(G.GARDEN)
	end
end)
new.pressed:connect(function()
	if core.menus.isOpen() then return end
	local function start()
		G.fresh()
		G.playing = true
		G.go(G.GARDEN)
	end
	if core.save.exists() then
		core.menus.confirm("Start over? Your saved garden will be replaced.", start, nil, { yes = "Start over", no = "Back" })
	else
		start()
	end
end)
