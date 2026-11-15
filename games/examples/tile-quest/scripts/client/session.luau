--!strict
-- Not attached to any entity: runs once at game start and keeps running across scene changes.
local state = require("../shared/state")

game.sceneLoaded:connect(function(path: string)
	state.scenesLoaded += 1
	local level = sceneParams().level
	if level then
		ui.toast(`LEVEL {level}`, 1.5)
	end
	print(`scene {path} (#{state.scenesLoaded}) coins={state.coins} deaths={state.deaths}`)
end)
