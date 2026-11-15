--!strict
local net = require("../shared/net")
local goal = script.entity
local winners: { [string]: boolean } = {}

goal.bodyEntered:connect(function(other)
	local player = players.fromEntity(other)
	if player and not winners[player.id] then
		winners[player.id] = true
		net.announce:fireAll(`{player.name} reached the top!`)
	end
end)
