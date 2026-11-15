--!strict
-- The local player's square. room.replicate sends it to the other device at 15 Hz, where it shows up as a
-- puppet in this player's team color (white sprites become exactly red / blue; the dark visor keeps its color).
local net = require("../shared/net")
local me = script.entity
room.replicate(me)

local team = players["local"].team
me.position = if team == "blue" then vec2(560, 650) else vec2(160, 650)

local info = entity("info")
if room.active then
	info.text = "YOU ARE " .. string.upper(tostring(team)) .. " - first to " .. net.WIN
	info.color = room.teamColor(team or "red")
end

local SPEED = 280
onTick(function(dt: number)
	local v = vec2(input.axis("move_x"), input.axis("move_y"))
	if v:length() > 1 then v = v:normalized() end
	me.velocity = v * SPEED
end)
