--!nonstrict
-- view.race(opts): one call turns a race into a playable scene — TileMap2D track, car sprites + shadows, camera,
-- touch/keyboard input, AI rivals, ghost, countdown, HUD + mini-map, juice (shake, sparks, popups), sfx, ghost
-- recording and the results podium. Call from a scene script; everything dies with the scene.
local U = require("./util")
local TrackM = require("./track")
local CarM = require("./car")
local RaceM = require("./race")
local Driver = require("./driver")
local Ghost = require("./ghost")
local Hud = require("./hud")
local okJ, juice = pcall(require, "@kit/juice")
if not okJ then juice = nil end
local okC, core = pcall(require, "@kit/core")
if not okC then core = nil end
local M = {}

M.SFX = { countdown = "beep", go = "go", lap = "lap", finish = "finish", wall = "crash", bump = "bump", boost = "boost",
	oil = "oil", nitro = "nitro", missed = "deny", item = "pickup", ramp = "jump" }

local function playSfx(map, key, opts)
	local id = map[key]
	if not id then return end
	if juice then juice.sfx(id, opts) else pcall(sfx.play, id, opts) end
end

-- default input: stick/arrows steer, auto-throttle, down = brake, action (A) = nitro, action2 (B) = item
function M.readInput()
	local steer = input.axis("move_x")
	local down = input.axis("move_y")
	local brake = if down > 0.5 then 1 else 0
	return { steer = steer, throttle = if brake > 0 then 0 else 1, brake = brake, nitro = input.held("action"), item = input.pressed("action2") }
end

-- race(opts) -> handle { race, track, hud, player, stop() }
-- opts: track (def | built track), tileset ("data/tilesets/x.json" for the TileMap2D), tileSize?,
--   player = { id? = "you", name?, sprite, size? = {w,h}, stats | car (def) }, rivals = { {id, name, sprite, stats | car, preset?, color?} },
--   mode = "race"|"time_trial"|"elimination", laps?, countdown = 3, difficulty? (preset for rivals), rubber? (false | bounds),
--   ghost? = ghost table to race against, ghostSprite?, recordGhost? = trackId (saves the best-lap ghost when beaten),
--   zoom = 1, sfx? = {key = id} (M.SFX), music?, theme?, minimap = true, finishDelay = 3 (s to wait for rivals),
--   input? = fn() -> input, autopilot? = true | preset (the player car drives itself: attract mode, tests), onEvent?(name, data, handle), onFinish(results, handle) (default: podium with opts.buttons),
--   buttons? = { {label, onPress} }, names? = {id = display name}, extra? = fn(row) -> string (results column),
--   board? = platform leaderboard name (default "track_<track id>"; false = no leaderboard): timed from GO to the player's finish
--   versus? = multiplayer race (default: on in a room, room.active): no AI rivals, one grid slot per room player (red, blue, ...),
--     the player's car replicates to the others (team-tinted), the first to cross the line wins (room.finish)
function M.race(o)
	local tr = if o.track.gates then o.track else TrackM.new(o.track)
	local sfxMap = setmetatable(o.sfx or {}, { __index = M.SFX })
	local h = { track = tr, sprites = {}, done = false }
	local layer = spawn("Node2D", { position = vec2(0, 0) })
	spawn("TileMap2D", { position = vec2(tr.ox, tr.oy), tile_size = tr.ts, tileset = o.tileset, data = tr.gridText, collision = false, z_index = -20 }, layer)
	if o.decor then o.decor(tr, layer) end
	local race = RaceM.new(tr, { laps = o.laps, mode = o.mode, countdown = o.countdown, onEvent = nil })
	h.race = race
	local function size(spec) local s = spec.size or { 34, 54 } return vec2(s[1] or s.x, s[2] or s.y) end
	local function addCar(spec, k, isPlayer)
		local x, y, a = tr:gridSlot(k, o.grid)
		local stats = spec.stats or CarM.stats(spec.car)
		local car = CarM.new(stats, x, y, a, { nitro = 0.4 })
		local drv = nil
		if not isPlayer then drv = Driver.new({ preset = spec.preset or o.difficulty or "normal", rubber = o.rubber, seed = k * 7919 })
		elseif o.autopilot then drv = Driver.new({ preset = if type(o.autopilot) == "string" then o.autopilot else "hard", rubber = false, seed = 4242 }) end
		local r = race:add(spec.id or (if isPlayer then "you" else "cpu" .. k), car, { player = isPlayer, name = spec.name, driver = drv })
		r.color = spec.color
		local sz = size(spec)
		local sh = spawn("Sprite2D", { texture = spec.sprite, size = sz, modulate = "#00000055", position = vec2(x + 4, y + 6), rotation = math.deg(a), z_index = 4 }, layer)
		local e = spawn("Sprite2D", { texture = spec.sprite, size = sz, position = vec2(x, y), rotation = math.deg(a), z_index = 6 }, layer)
		h.sprites[r.id] = { e = e, sh = sh, sz = sz, r = r }
		return r
	end
	local n = #(o.rivals or {})
	if o.mode == "time_trial" then n = 0 end
	-- versus (multiplayer room): the other players' cars are puppets replicated by the engine, so no AI and one slot each
	local versus = o.versus ~= false and room ~= nil and room.active
	h.versus = versus
	local slot = n + 1
	if versus then
		n = 0
		slot = 1
		for i, p in players.all() do if p.isLocal then slot = i end end
	end
	-- player starts at the back of the grid in races (overtaking is the fun), front in time trials
	for i = 1, n do addCar(o.rivals[i], i, false) end
	local player = addCar(o.player, slot, true)
	h.player = player
	if versus then room.replicate(h.sprites[player.id].e) end
	-- ghost
	local ghostE, ghost = nil, o.ghost
	if ghost then
		ghostE = spawn("Sprite2D", { texture = o.ghostSprite or o.player.sprite, size = size(o.player), modulate = "#ffffff66", z_index = 5, visible = false }, layer)
	end
	local rec = if o.recordGhost then Ghost.recorder(0.1) else nil
	local bestGhost = nil
	-- camera
	local x0, y0, x1, y1 = tr:bounds()
	local cam = spawn("Camera2D", { position = vec2(player.car.x, player.car.y), zoom = o.zoom or 1, current = true,
		limit_min = vec2(x0, y0 - (o.hudTop or 140)), limit_max = vec2(x1, y1 + (o.hudBottom or 0)) })
	h.camera = cam
	local hud = Hud.new(race, tr, { theme = o.theme, minimap = o.minimap })
	h.hud = hud
	if o.music then pcall(music.play, o.music) end
	local oilE = {}
	local finishT = nil
	-- platform leaderboard (engine timer + ghost + results card): GO → player finish; eliminated = cancelled
	local board = if o.board == false or not leaderboard then nil else (o.board or ("track_" .. string.sub((string.gsub(string.lower(tostring(tr.id or o.recordGhost or "race")), "[^%w_]", "_")), 1, 34)))
	h.board = board
	local function onEvent(name, d)
		local mine = d.id == player.id
		if name == "countdown" then hud:banner(tostring(d.n), 0.9) playSfx(sfxMap, "countdown")
		elseif name == "go" then
			hud:banner("GO!", 0.8) playSfx(sfxMap, "go", { pitch = 1.5 })
			if board then leaderboard.start(board, { track = h.sprites[player.id].e }) end
		elseif name == "checkpoint" and mine then hud:splitText(d.delta)
		elseif name == "missed" and mine then hud:banner("MISSED", 1.2, "checkpoint skipped - lap not counted") playSfx(sfxMap, "missed")
		elseif name == "lap" and mine then
			if rec then
				if d.best then bestGhost = rec:finish(d.time, { car = o.player.id }) end
				rec = Ghost.recorder(0.1)
			end
			if player.lap < race.laps then
				hud:banner(if player.lap == race.laps - 1 then "FINAL LAP" else "LAP " .. (player.lap + 1), 1.2, U.time(d.time) .. (if d.best then "  BEST!" else ""))
				playSfx(sfxMap, "lap")
			end
		elseif name == "finish" and mine then
			finishT = 0
			if versus then room.finish(players["local"]) end -- first across the line wins; later finishes are ignored
			if board and leaderboard.running(board) then leaderboard.finish(board) end
			hud:banner(if race.mode == "time_trial" then "FINISH" else U.ordinal(d.place) .. "!", 2)
			playSfx(sfxMap, "finish")
			if juice and (race.mode == "time_trial" or d.place <= 3) then pcall(juice.confetti) end
		elseif name == "eliminated" then
			hud:banner(if d.id == player.id then "ELIMINATED" else "OUT: " .. (race.byId[d.id].name or d.id), 1.4)
			if d.id == player.id then finishT = 0 if board then leaderboard.cancel(board) end end
		elseif name == "wall" and mine then
			playSfx(sfxMap, "wall", { volume = math.min(1, (d.v or 100) / 300) })
			if juice then juice.shake(math.min(10, (d.v or 100) / 40), 0.2) end
		elseif name == "bump" and (d.a == player.id or d.b == player.id) then
			playSfx(sfxMap, "bump")
			if juice then
				juice.shake("light")
				local a, b = race.byId[d.a].car, race.byId[d.b].car
				juice.sparkle(vec2((a.x + b.x) / 2, (a.y + b.y) / 2), { n = 6, color = "#ffe28a" })
			end
		elseif (name == "boost" or name == "oil" or name == "ramp" or name == "item") and mine then
			playSfx(sfxMap, name)
			if name == "oil" then hud:banner("SPIN!", 0.8) end
			if name == "boost" and juice then juice.zoomPunch(-0.05, 0.3) end
		elseif name == "oil_dropped" then
			table.insert(oilE, spawn("Sprite2D", { texture = o.oilSprite, size = vec2(52, 40), modulate = if o.oilSprite then "#ffffff" else "#201a2a", position = vec2(d.x, d.y), z_index = 2 }, layer))
		end
		if o.onEvent then o.onEvent(name, d, h) end
	end
	local nitroWas = false
	local camX, camY = player.car.x, player.car.y
	local function render(dt)
		for _, s in h.sprites do
			local c = s.r.car
			local air = c.air > 0
			local sc = if air then 1.25 else 1
			s.e.position = vec2(c.x, c.y)
			s.e.rotation = math.deg(c.a)
			s.e.scale = vec2(sc, sc)
			s.sh.position = vec2(c.x + (if air then 14 else 4), c.y + (if air then 18 else 6))
			s.sh.rotation = math.deg(c.a)
			s.e.modulate = if s.r.out then "#ffffff55" else "#ffffff"
		end
		if ghostE then
			local gx, gy, ga = nil, nil, nil
			if race.phase == "racing" and not player.finished then gx, gy, ga = Ghost.at(ghost, race.t - player.lapStart) end
			ghostE.visible = gx ~= nil
			if gx then ghostE.position = vec2(gx, gy) ghostE.rotation = math.deg(ga) end
		end
		for i = #oilE, 1, -1 do
			if i > #race.oils then oilE[i]:destroy() table.remove(oilE, i) end
		end
		-- camera leads the car (portrait: see further ahead)
		local c = player.car
		local fx, fy = U.fwd(c.a)
		local lead = math.clamp(c:speed() * 0.45, 0, 260)
		local k = 1 - math.exp(-6 * dt)
		camX += (c.x + fx * lead - camX) * k
		camY += (c.y + fy * lead - camY) * k
		cam.position = vec2(camX, camY)
	end
	local tickConn = onTick(function(dt)
		if h.done then return end
		if (core and core.pause.isPaused()) or (juice and juice.stopped()) then return end
		local inputs = {}
		if not o.autopilot and not player.finished and not player.out and race.phase == "racing" then inputs[player.id] = (o.input or M.readInput)() end
		local ev = race:step(dt, inputs)
		for _, e in ev do onEvent(e.name, e.data) end
		if rec and race.phase == "racing" and not player.finished then rec:add(race.t - player.lapStart, player.car) end
		if player.car.usingNitro and not nitroWas then playSfx(sfxMap, "nitro") end
		nitroWas = player.car.usingNitro
		render(dt)
		hud:update(dt, player)
		if finishT then
			finishT += dt
			if finishT >= (o.finishDelay or 3) or race.done then
				if not race.done then race:finishAll() end
				h.done = true
				if bestGhost and o.recordGhost then h.newRecord = Ghost.submit(o.recordGhost, bestGhost) end
				hud.acc = 1
				hud:update(0, player)
				local results = race:results()
				h.results = results
				if o.onFinish then o.onFinish(results, h)
				else hud:results(results, { buttons = o.buttons, names = o.names, extra = o.extra,
					title = if race.mode == "time_trial" then "TIME TRIAL" else "RESULTS",
					note = if race.mode == "time_trial" then "Best lap " .. U.time(player.best) .. (if h.newRecord then "  NEW RECORD!" else "") else nil }) end
			end
		end
	end)
	render(0)
	function h.stop() h.done = true if board then leaderboard.cancel(board) end end
	return h
end
return M
