--!strict
local config = require("../shared/config")
local score = 0
local timeLeft = config.roundSeconds
local hudScore = entity("hud_score")
local hudTimer = entity("hud_timer")

for _, coin in entitiesTagged("coin") do
	coin.bodyEntered:connect(function(other)
		if other:hasTag("player") then
			coin:destroy()
			score += 1
			hudScore.text = `Coins: {score}`
		end
	end)
end

onTick(function(dt: number)
	timeLeft = math.max(0, timeLeft - dt)
	hudTimer.text = tostring(math.ceil(timeLeft))
end)
