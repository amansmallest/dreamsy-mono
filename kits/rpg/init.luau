-- rpg kit: require("@kit/rpg"). A data-driven RPG / creature-collector framework. See KIT.md.
--
--   -- scripts/client/main.luau (an UNATTACHED session script: it survives loadScene)
--   local rpg = require("@kit/rpg")
--   rpg.setup()                  -- reads data/rpg.json, data/types.json, data/<kind>/*.json
--   -- title scene buttons call rpg.newGame() / rpg.continueGame()
local U = require("./util")
local Content = require("./content")
local Events = require("./events")
local State = require("./state")
local Creatures = require("./creatures")
local Logic = require("./logic")
local Quests = require("./quests")
local Dialog = require("./dialog")
local Inventory = require("./inventory")
local Save = require("./save")
local W = require("./widgets")
local Overworld = require("./overworld")
local Battle = require("./battle")
local Menus = require("./menus")
local R = require("./runtime")

local rpg = {}
rpg.VERSION = "0.1.0"

rpg.content = Content
rpg.events = Events
rpg.hooks = Events.hooks
rpg.state = State
rpg.creatures = Creatures
rpg.quests = Quests
rpg.dialog = Dialog
rpg.inventory = Inventory
rpg.savefile = Save
rpg.world = Overworld
rpg.battle = Battle
rpg.menu = Menus
rpg.ui = W
rpg.util = U
rpg.runtime = R

local pendingEnter = nil
local ready = false

local function worldScene(mapId: string): string
	local m = Content.maps[mapId]
	return (m and m.scene) or Content.config.world_scene or currentScene()
end

-- go to a map (loads its scene first when needed). `at` = spawn id or { x, y, facing }
function rpg.enterMap(mapId: string, at)
	assert(Content.maps[mapId], "rpg.enterMap: unknown map \"" .. tostring(mapId) .. "\"")
	local scene = worldScene(mapId)
	if scene ~= currentScene() then
		pendingEnter = { map = mapId, at = at }
		Overworld.clear()
		Menus.root = nil
		loadScene(scene)
		return
	end
	Overworld.build(mapId, at)
end

local function restoreMusic()
	if Overworld.map then U.music(Overworld.map.music, { fade = 0.5 }) end
end

local function setHud(v: boolean)
	if W.alive(Overworld.hud) then Overworld.hud.visible = v end
end

local function battleWrap(opts, done)
	Overworld.lock()
	setHud(false)
	if opts.battle == nil and Overworld.map then opts.battle = Overworld.map.battle end
	Battle.start(opts, function(result)
		Overworld.unlock()
		setHud(true)
		restoreMusic()
		Overworld.refresh()
		if done then done(result) end
	end)
end

-- ---------------------------------------------------------------- runtime services
R.enterMap = rpg.enterMap
R.warp = function(mapId, spawn) Overworld.warp(mapId, spawn) end
R.startTrainerBattle = function(id, done) battleWrap({ trainer = id }, done) end
R.startWildBattle = function(spec, done) battleWrap(spec, done) end
R.dialog = function(id, opts, done) Dialog.run(id, opts, done) end
R.save = function() return Save.write() end
R.openMenu = function()
	if Menus.isOpen() then return end
	Overworld.lock()
	Menus.open(function() Overworld.unlock() end)
end
R.openShop = function(id, done)
	Overworld.lock()
	Menus.shop(id, "buy", 1, function()
		Overworld.unlock()
		if done then done() end
	end)
end
R.openStorage = function(done)
	Overworld.lock()
	Menus.storage(1, function()
		Overworld.unlock()
		if done then done() end
	end)
end

-- ---------------------------------------------------------------- setup

-- opts: { data = path-keyed table (optional: tests/tools; by default data/ files are read with data.read),
--         theme = { primary, ... } (optional overrides of the dreamsy.toml [ui] colors) }
function rpg.setup(opts)
	opts = opts or {}
	Content.load(opts.data)
	if opts.theme then
		Content.config.ui = Content.config.ui or {}
		for k, v in opts.theme do Content.config.ui[k] = v end
	end
	for _, msg in Content.issues do print("[rpg] content: " .. msg) end
	Quests.wire()
	if ready then return rpg end
	ready = true
	local function install()
		Events.flagSet:connect(function() Overworld.refresh() end)
		onTick(function(dt: number)
			U.stepTimers(dt)
			if Overworld.map and State.data then State.data.playtime = (State.data.playtime or 0) + dt end
			Battle.update()
			if Overworld.map then Overworld.update(dt) end
		end)
		game.sceneLoaded:connect(function(path: string)
			U.clearTimers()
			W._fade = nil
			Menus.root = nil
			Battle.current = nil
			local p = pendingEnter
			pendingEnter = nil
			if p then
				Overworld.locks = 0
				Overworld.build(p.map, p.at)
			elseif Overworld.root and Overworld.root.destroyed then
				Overworld.clear() -- the map's entities went with the old scene
			end
		end)
	end
	-- the kit's tick/connections survive scene changes even if setup ran in an attached script
	game.session(install)
	return rpg
end

-- ---------------------------------------------------------------- game flow

function rpg.hasSave(): boolean
	return Save.exists()
end

function rpg.newGame()
	State.reset()
	Quests.autoStart()
	Events.newGame:fire()
	local st = Content.config.start or {}
	assert(st.map, "rpg.newGame: set \"start\": { \"map\": ..., \"spawn\": ... } in data/rpg.json")
	rpg.enterMap(st.map, st.spawn)
end

function rpg.continueGame(): boolean
	if not Save.load() then return false end
	local p = State.get().player
	rpg.enterMap(p.map, { x = p.x, y = p.y, facing = p.facing })
	return true
end

function rpg.save(): boolean
	return Save.write()
end

-- ---------------------------------------------------------------- shortcuts for game scripts
rpg.check = Logic.check
rpg.apply = Logic.run
rpg.text = Logic.text
function rpg.flag(name: string): boolean return State.flag(name) end
function rpg.setFlag(name: string, v: boolean?) State.setFlag(name, v) end
function rpg.give(itemId: string, n: number?) State.give(itemId, n) end
function rpg.take(itemId: string, n: number?): boolean return State.take(itemId, n) end
function rpg.count(itemId: string): number return State.count(itemId) end
function rpg.money(): number return State.money() end
function rpg.addMoney(n: number) State.addMoney(n) end
function rpg.party() return State.party() end
function rpg.giveCreature(id: string, level: number) return State.giveCreature(id, level) end
function rpg.heal() State.healAll() end
function rpg.startBattle(trainerId: string, done) R.startTrainerBattle(trainerId, done) end
function rpg.wildBattle(spec, done) R.startWildBattle(spec, done) end
function rpg.say(lines, opts, done) Dialog.say(lines, opts, done) end
function rpg.runDialog(id, opts, done) Dialog.run(id, opts, done) end
function rpg.openMenu() R.openMenu() end
function rpg.openShop(id: string, done) R.openShop(id, done) end
function rpg.warp(mapId: string, spawn) Overworld.warp(mapId, spawn) end

return rpg
