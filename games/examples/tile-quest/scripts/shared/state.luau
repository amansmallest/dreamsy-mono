--!strict
-- Session state: modules load once per game and survive loadScene.
local state = { coins = 0, deaths = 0, scenesLoaded = 0 }
function state.reset()
	state.coins = 0
	state.deaths = 0
end
return state
