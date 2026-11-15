--!strict
-- Attached to each level's TileMap2D. Spikes kill, coins collect, bricks break when bumped
-- from below, the flag loads the next level (or the win scene).
local state = require("../shared/state")
local config = require("../shared/config")
local map = script.entity
local player = entitiesTagged("player")[1]
local hud = entitiesTagged("hud")[1]
local spawnPos = player.position
local level: number = sceneParams().level or table.find(config.levels, currentScene()) or 1
local lastDeath = -1
local finished = false

music.play("level", { fade = 0.5 }) -- same song across levels: keeps playing

local function refreshHud()
	hud.text = `LEVEL {level}   COINS {state.coins}   DEATHS {state.deaths}`
end
refreshHud()

local function die()
	if time() - lastDeath < 0.3 then return end
	lastDeath = time()
	state.deaths += 1
	player.position = spawnPos
	player.velocity = vec2(0, 0)
	ui.toast("Ouch!", 0.8)
	sfx.play("hurt")
	refreshHud()
end

local function has(list: { string }, tag: string): boolean
	return table.find(list, tag) ~= nil
end

map.tileTouched:connect(function(other, char: string, col: number, row: number)
	if not other:hasTag("player") or finished then return end
	local center = map:cellToWorld(col, row)
	local tags = map:tagsAt(center)
	if has(tags, "spike") then
		die()
	elseif has(tags, "coin") then
		map:setTile(col, row, nil)
		state.coins += 1
		sfx.play("coin", { pitch = 1 + (state.coins % 4) * 0.06 })
		refreshHud()
	elseif has(tags, "breakable") and other.position.y > center.y + map.tile_size / 2 then
		map:setTile(col, row, nil) -- bumped from below: the brick (and its collision) is gone
		sfx.play("brick")
		state.coins += 1
		refreshHud()
	elseif has(tags, "goal") then
		finished = true
		sfx.play("flag")
		if level < #config.levels then
			loadScene(config.levels[level + 1], { level = level + 1 })
		else
			loadScene("scenes/win.scene.json", { coins = state.coins, deaths = state.deaths })
		end
	end
end)

-- camera: follow the player horizontally, clamped to the map (view is 640×360 at zoom 2)
local camera = entitiesTagged("camera")[1]
local mapW, mapH = map.cols * map.tile_size, map.rows * map.tile_size
onTick(function()
	local p = player.position
	if p.y > mapH + 64 then die() end
	camera.position = vec2(math.clamp(p.x, 320, mapW - 320), mapH - 180)
end)
