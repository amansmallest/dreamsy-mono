-- rpg kit: the overworld — grid movement, collision, NPCs, interactables, warps, encounters.
-- A map is data/maps/<id>.json; the kit spawns its TileMap2D layers, the player, NPCs and pickups
-- into the current scene (the world scene from data/rpg.json "world_scene", or the map's own "scene").
local U = require("./util")
local Content = require("./content")
local State = require("./state")
local Events = require("./events")
local Logic = require("./logic")
local Dialog = require("./dialog")
local R = require("./runtime")
local W = require("./widgets")

local O = {}
O.map = nil
O.root = nil
O.layers = {}
O.player = nil
O.npcs = {}
O.objects = {}
O.locks = 0 -- > 0 while a menu / battle / cutscene owns the screen
O.stepCount = 0
O.encounterGrace = 0
O.rng = U.defaultRng

local function cfg()
	return Content.config
end
local function playerCfg()
	return cfg().player or {}
end

function O.lock()
	O.locks += 1
end
function O.unlock()
	O.locks = math.max(0, O.locks - 1)
end
function O.busy(): boolean
	return O.locks > 0 or Dialog.active or ui.dialogOpen()
end

-- ---------------------------------------------------------------- grid queries

function O.inBounds(x: number, y: number): boolean
	local m = O.map
	return m ~= nil and x >= 0 and y >= 0 and x < O.cols and y < O.rows
end

-- tile info of every layer at (x, y): solid, tags (from each layer's tileset via map:tileDef)
function O.tileAt(x: number, y: number)
	local solid = false
	local tags = {}
	for _, layer in O.layers do
		local ch = layer.e:getTile(x, y)
		if ch then
			local info = layer.e:tileDef(ch)
			if info then
				if info.solid then solid = true end
				for _, t in info.tags or {} do table.insert(tags, t) end
			end
		end
	end
	return solid, tags
end

function O.tagsAt(x: number, y: number): { string }
	local _, tags = O.tileAt(x, y)
	return tags
end

function O.solidAt(x: number, y: number): boolean
	if not O.inBounds(x, y) then return true end
	local solid = O.tileAt(x, y)
	return solid
end

function O.npcAt(x: number, y: number, except)
	for _, n in O.npcs do
		if n ~= except and n.shown and ((n.x == x and n.y == y) or (n.moving and n.tx == x and n.ty == y)) then return n end
	end
	return nil
end

function O.objectAt(x: number, y: number)
	for _, o in O.objects do
		if o.shown and o.x == x and o.y == y then return o end
	end
	return nil
end

function O.blocked(x: number, y: number, mover): boolean
	if O.solidAt(x, y) then return true end
	if O.npcAt(x, y, mover) then return true end
	local o = O.objectAt(x, y)
	if o and o.solid then return true end
	local p = O.player
	if p and mover ~= p and ((p.x == x and p.y == y) or (p.moving and p.tx == x and p.ty == y)) then return true end
	return false
end

function O.cellCenter(x: number, y: number): Vec2
	local ts = O.map.tile_size
	return vec2((x + 0.5) * ts, (y + 0.5) * ts)
end

-- ---------------------------------------------------------------- actors (player + NPCs)

local function spriteFor(def, facing: string): string?
	local s = def.sprite
	if type(s) == "string" then return s end
	if type(s) == "table" then return s[facing] or (facing == "left" and s.right) or s.down or s.front end
	return nil
end

local function makeActor(def, x: number, y: number, facing: string, z: number)
	local ts = O.map.tile_size
	local e = spawn("Node2D", { position = O.cellCenter(x, y), z_index = z }, O.root)
	local size = def.size or { ts, ts }
	local sp = spawn("Sprite2D", {
		position = vec2(0, (def.offset_y or -2)),
		size = vec2(size[1], size[2]),
		texture = spriteFor(def, facing),
		modulate = if spriteFor(def, facing) then "#ffffff" else (def.color or "#e06c75"),
	}, e)
	if def.anims then sp.anims = def.anims end
	local a = { def = def, e = e, sprite = sp, x = x, y = y, tx = x, ty = y, facing = facing, moving = false, t = 0, step = 0, hop = false }
	return a
end

local function faceActor(a, facing: string)
	a.facing = facing
	if a.def.anims then
		pcall(function() a.e:play((if a.moving then "walk_" else "idle_") .. facing) end)
	else
		local tex = spriteFor(a.def, facing)
		if tex then a.sprite.texture = tex end
		local sd = a.def.sprite
		a.sprite.flip_h = facing == "left" and (type(sd) == "string" or (type(sd) == "table" and sd.left == nil and sd.right ~= nil))
	end
end
O.faceActor = faceActor

local function zFor(y: number): number
	return 100 + y * 2
end

-- start a one-cell step (or a two-cell ledge hop)
local function beginStep(a, dx: number, dy: number, seconds: number, hop: boolean?)
	a.moving = true
	a.fx, a.fy = a.x, a.y
	a.tx, a.ty = a.x + dx, a.y + dy
	a.t = 0
	a.dur = seconds
	a.hop = hop == true
	a.step += 1
	if a.def.anims then pcall(function() a.e:play("walk_" .. a.facing) end) end
	a.e.z_index = zFor(math.max(a.y, a.ty))
end

-- advance a moving actor; returns true on arrival
local function advanceActor(a, dt: number): boolean
	if not a.moving then return false end
	a.t += dt / a.dur
	local k = math.min(1, a.t)
	local from, to = O.cellCenter(a.fx, a.fy), O.cellCenter(a.tx, a.ty)
	local p = from:lerp(to, k)
	a.e.position = p
	-- walk bob (no anims) / hop arc
	local bob = 0
	if a.hop then bob = -math.sin(k * math.pi) * O.map.tile_size * 0.6
	elseif not a.def.anims then bob = -math.abs(math.sin(k * math.pi)) * 1.5 end
	a.sprite.position = vec2(0, (a.def.offset_y or -2) + bob)
	if k >= 1 then
		a.moving = false
		a.x, a.y = a.tx, a.ty
		a.e.z_index = zFor(a.y)
		a.hop = false
		if a.def.anims then pcall(function() a.e:play("idle_" .. a.facing) end) end
		return true
	end
	return false
end

-- ---------------------------------------------------------------- building a map

local function clearMap()
	if O.root then W.destroy(O.root) end
	O.root = nil
	O.layers = {}
	O.player = nil
	O.npcs = {}
	O.objects = {}
	if O.hud then W.destroy(O.hud) O.hud = nil end
end

local function itemFlag(mapId: string, it): string
	return it.flag or ("item_" .. mapId .. "_" .. it.at[1] .. "_" .. it.at[2])
end

-- re-evaluate "if" conditions of NPCs / objects (after flags change)
function O.refresh()
	for _, n in O.npcs do
		local show = n.def["if"] == nil or Logic.check(n.def["if"])
		if n.shown ~= show then
			n.shown = show
			n.e.visible = show
		end
	end
	for _, o in O.objects do
		local show = true
		if o.kind == "item" then show = not State.flag(o.flag) end
		if o.def["if"] ~= nil and not Logic.check(o.def["if"]) then show = false end
		if o.shown ~= show then
			o.shown = show
			if o.e then o.e.visible = show end
		end
	end
end

local function buildHud()
	local t = W.theme()
	local hud = W.panel(nil, { anchor = "top_left", offset = vec2(20, 20), size = vec2(150, 72), bg = "#00000000", z = 50 })
	W.button(hud, {
		text = (cfg().text and cfg().text.menu_button) or "MENU",
		anchor = "top_left", offset = vec2(0, 0), size = vec2(150, 72), font_size = 26,
		bg = W.alpha(t.background, 0.85), color = t.text,
		onPress = function()
			if not O.busy() and R.openMenu then R.openMenu() end
		end,
	})
	O.hud = hud
end

-- map name banner (slides down, then up)
local function banner(name: string)
	local t = W.theme()
	local p = W.panel(nil, { anchor = "top", offset = vec2(0, -120), size = vec2(420, 84), bg = W.alpha(t.background, 0.92), z = 60 })
	W.text(p, { text = name, anchor = "center", size = vec2(400, 70), align = "center", font_size = 30, color = t.accent })
	tween(p, { offset = vec2(0, 24) }, 0.35, "back_out")
	U.after(2.0, function()
		if W.alive(p) then tween(p, { offset = vec2(0, -120) }, 0.3, "quad_in") end
		U.after(0.35, function() W.destroy(p) end)
	end)
end

-- Build `mapId` into the current scene and put the player at a spawn id or { x, y, facing }.
function O.build(mapId: string, at)
	local m = Content.maps[mapId]
	if not m then error("rpg: unknown map \"" .. tostring(mapId) .. "\" (add data/maps/" .. tostring(mapId) .. ".json)") end
	clearMap()
	O.map = m
	O.root = spawn("Node2D", {})
	for i, l in m.layers do
		local e = spawn("TileMap2D", {
			tileset = l.tileset,
		}, O.root)
		-- spawn() needs the tileset; the grid loads when `data` is set
		e.data = l.data
		e.tile_size = m.tile_size
		e.collision = false
		e.z_index = l.z or (if i == 1 then 0 else (if l.above then 4000 else i))
		table.insert(O.layers, { e = e })
	end
	O.cols, O.rows = O.layers[1].e.cols, O.layers[1].e.rows
	for i = 2, #O.layers do
		O.cols = math.max(O.cols, O.layers[i].e.cols)
		O.rows = math.max(O.rows, O.layers[i].e.rows)
	end
	-- spawn point
	local x, y, facing
	if type(at) == "table" then
		x, y, facing = at.x, at.y, at.facing
	else
		local sp = m.spawns[at or "default"] or m.spawns.default
		if not sp then
			for _, v in m.spawns do sp = v break end
		end
		sp = sp or { 1, 1 }
		x, y, facing = sp[1], sp[2], sp[3]
	end
	facing = facing or "down"
	-- objects
	for _, s in m.signs do
		table.insert(O.objects, { kind = "sign", def = s, x = s.at[1], y = s.at[2], solid = s.solid ~= false, shown = true })
		if s.sprite then
			local e = spawn("Sprite2D", { position = O.cellCenter(s.at[1], s.at[2]), size = vec2(m.tile_size, m.tile_size), texture = s.sprite, z_index = zFor(s.at[2]) }, O.root)
			O.objects[#O.objects].e = e
		end
	end
	for _, it in m.items do
		local o = { kind = "item", def = it, x = it.at[1], y = it.at[2], solid = it.hidden ~= true, flag = itemFlag(m.id, it), shown = true }
		if not it.hidden then
			local tex = it.sprite or (cfg().item_sprite)
			o.e = spawn("Sprite2D", {
				position = O.cellCenter(o.x, o.y), size = vec2(m.tile_size * 0.75, m.tile_size * 0.75),
				texture = tex, modulate = if tex then "#ffffff" else "#ffcd75", z_index = zFor(o.y),
			}, O.root)
		end
		table.insert(O.objects, o)
	end
	for i, nd in m.npcs do
		local a = makeActor(nd, nd.at[1], nd.at[2], nd.facing or "down", zFor(nd.at[2]))
		a.id = nd.id or ("npc_" .. i)
		a.home = { nd.at[1], nd.at[2] }
		a.wait = 0.5 + O.rng() * 1.5
		a.pathIndex = 1
		a.shown = true
		faceActor(a, a.facing)
		table.insert(O.npcs, a)
	end
	-- player
	local pdef = playerCfg()
	local p = makeActor(pdef, x, y, facing, zFor(y))
	faceActor(p, facing)
	O.player = p
	O.holdTicks = 0
	-- camera
	-- zoom: the map's / game's zoom, raised to fill the screen for maps smaller than the view
	-- (up to "camera_fill" × zoom, default 2.1; small interiors stay letterboxed)
	local zoom = m.zoom or cfg().zoom or 3
	local scr = W.screen()
	local fill = math.max(scr.x / (O.cols * m.tile_size), scr.y / (O.rows * m.tile_size))
	local maxFill = cfg().camera_fill or 2.1
	if fill > zoom and fill <= zoom * maxFill then zoom = fill end
	O.camera = spawn("Camera2D", { follow = p.e, zoom = zoom, current = true, smoothing = 0 }, O.root)
	local ts = m.tile_size
	O.camera.limit_min = vec2(0, 0)
	O.camera.limit_max = vec2(O.cols * ts, O.rows * ts)
	camera.snap()
	O.refresh()
	buildHud()
	-- state
	local d = State.get()
	d.player.map, d.player.x, d.player.y, d.player.facing = m.id, x, y, facing
	O.stepCount = 0
	O.encounterGrace = 3
	U.music(m.music, { fade = 0.6 })
	Events.mapEntered:fire(m.id, if type(at) == "string" then at else nil)
	if m.name and not m.hide_name then banner(m.name) end
	-- enter triggers / trainers that can already see you
	U.after(0.05, function()
		if O.map == m then O.checkSight() end
	end)
end

-- ---------------------------------------------------------------- interaction

local function npcFacePlayer(n)
	if n.def.fixed then return end
	local p = O.player
	local dx, dy = p.x - n.x, p.y - n.y
	local f
	if math.abs(dx) > math.abs(dy) then f = if dx > 0 then "right" else "left" else f = if dy > 0 then "down" else "up" end
	faceActor(n, f)
end

local function runInteraction(def, kind: string, after: (() -> ())?)
	O.lock()
	local finished = false
	local function done()
		if finished then return end
		finished = true
		O.unlock()
		O.refresh()
		if after then after() end
	end
	if def.dialog then
		Dialog.run(def.dialog, { speaker = def.name, portrait = def.portrait }, function() done() end)
	elseif def.lines or def.text then
		Dialog.run({ speaker = def.name, portrait = def.portrait, lines = def.lines or def.text, effects = def.effects, choices = def.choices }, nil, function() done() end)
	elseif def.effects then
		Logic.run(def.effects, function() done() end)
	else
		done()
	end
end

-- trainer encounter: walk up, talk, battle, then the after-lines
function O.trainerBattle(n, walk: boolean)
	local tid = n.def.trainer
	local t = Content.trainers[tid]
	if not t then return end
	O.lock()
	n.alert = true
	local function talkAndFight()
		npcFacePlayer(n)
		local p = O.player
		local f = U.OPPOSITE[n.facing]
		if f then faceActor(p, f) end
		local intro = n.def.dialog or { speaker = t.name or n.def.name, portrait = t.portrait or n.def.portrait, lines = t.intro or { "Let's battle!" } }
		Dialog.run(intro, nil, function(ok)
			if not ok then O.unlock() return end
			R.startTrainerBattle(tid, function(result)
				O.unlock()
				n.alert = false
				if result == "win" then
					local after = n.def.after_dialog or (t.after and { speaker = t.name or n.def.name, lines = t.after })
					if after then runInteraction({ dialog = if type(after) == "string" then after else nil, lines = if type(after) == "table" then after.lines else nil, name = t.name or n.def.name }, "npc") end
				end
			end)
		end)
	end
	-- "!" over the trainer
	local mark = spawn("Text2D", { text = "!", position = vec2(0, -O.map.tile_size), font_size = 14, color = "#ffcd75", outline = "#1a1c2c", outline_size = 2, z_index = 5000 }, n.e)
	U.sfx(cfg().sfx and cfg().sfx.alert)
	U.after(0.6, function()
		W.destroy(mark)
		if not walk then return talkAndFight() end
		-- walk until adjacent
		local function walkStep()
			local p = O.player
			local dist = math.abs(p.x - n.x) + math.abs(p.y - n.y)
			if dist <= 1 then return talkAndFight() end
			local d = U.DIRS[n.facing]
			if O.blocked(n.x + d[1], n.y + d[2], n) then return talkAndFight() end
			beginStep(n, d[1], d[2], 0.22)
			n.onArrive = walkStep
		end
		walkStep()
	end)
end

function O.trainerBeaten(tid: string): boolean
	return State.flag("beat_" .. tid)
end

-- trainers with "sight": N spot the player along their facing line
function O.checkSight()
	if O.busy() or not O.player then return end
	local p = O.player
	for _, n in O.npcs do
		local sight = n.def.sight or 0
		if n.shown and n.def.trainer and sight > 0 and not n.moving and not O.trainerBeaten(n.def.trainer) and not n.alert then
			local d = U.DIRS[n.facing]
			for k = 1, sight do
				local cx, cy = n.x + d[1] * k, n.y + d[2] * k
				if cx == p.x and cy == p.y then
					if #State.party() > 0 and State.firstAlive() then
						O.trainerBattle(n, true)
					end
					return
				end
				if O.solidAt(cx, cy) or O.npcAt(cx, cy, n) then break end
			end
		end
	end
end

function O.interact()
	local p = O.player
	if not p or p.moving then return end
	local d = U.DIRS[p.facing]
	local x, y = p.x + d[1], p.y + d[2]
	local n = O.npcAt(x, y)
	-- talk over counters: tiles tagged "counter" pass interaction through
	if not n then
		local tags = O.tagsAt(x, y)
		if table.find(tags, "counter") then
			n = O.npcAt(x + d[1], y + d[2])
			if n then x, y = x + d[1], y + d[2] end
		end
	end
	if n and not n.moving then
		if Events.hooks.interact and Events.hooks.interact("npc", n.def) then return end
		Events.interacted:fire("npc", n.def)
		npcFacePlayer(n)
		if n.def.trainer and not O.trainerBeaten(n.def.trainer) then
			if #State.party() > 0 and State.firstAlive() then return O.trainerBattle(n, false) end
		end
		local def = n.def
		if def.trainer and O.trainerBeaten(def.trainer) then
			local t = Content.trainers[def.trainer]
			if def.after_dialog then return runInteraction({ dialog = def.after_dialog, name = def.name }, "npc") end
			if t and t.after then return runInteraction({ lines = t.after, name = t.name or def.name }, "npc") end
		end
		return runInteraction(def, "npc")
	end
	local o = O.objectAt(x, y)
	if o and o.shown then
		if o.kind == "sign" then
			if Events.hooks.interact and Events.hooks.interact("sign", o.def) then return end
			Events.interacted:fire("sign", o.def)
			if o.def.facing and o.def.facing ~= p.facing then return end
			return runInteraction(o.def, "sign")
		elseif o.kind == "item" then
			if Events.hooks.interact and Events.hooks.interact("item", o.def) then return end
			Events.interacted:fire("item", o.def)
			O.pickup(o)
			return
		end
	end
	-- objects defined as signs on any facing (e.g. a heal machine)
end

function O.pickup(o)
	State.setFlag(o.flag, true)
	o.shown = false
	if o.e then o.e.visible = false end
	O.lock()
	local name = Content.item(o.def.item).name
	local n = o.def.count or 1
	State.give(o.def.item, n)
	U.sfx(cfg().sfx and cfg().sfx.item)
	local text = U.format((cfg().text and cfg().text.found_item) or "You found {item}!", { item = (if n > 1 then (n .. "× ") else "") .. name })
	Dialog.say({ text }, nil, function()
		O.unlock()
		O.refresh()
	end)
end

-- ---------------------------------------------------------------- arriving on a cell

local function warpAt(x: number, y: number, on: string, dir: string?)
	for _, w in O.map.warps do
		if w.at[1] == x and w.at[2] == y and (w.on or "step") == on and (w.dir == nil or w.dir == dir) then
			if w["if"] == nil or Logic.check(w["if"]) then return w end
		end
	end
	return nil
end

function O.rollEncounter(x: number, y: number): boolean
	if O.encounterGrace > 0 then return false end
	if not State.firstAlive() then return false end
	local tags = O.tagsAt(x, y)
	if #tags == 0 then return false end
	for _, tag in tags do
		local zone = O.map.encounters[tag]
		if zone then
			local hook = Events.hooks.encounter
			local spec = nil
			if hook then
				spec = hook(O.map.id, tag, x, y)
				if spec == false then return false end
			end
			if not spec then
				if zone["if"] ~= nil and not Logic.check(zone["if"]) then return false end
				if O.rng() >= (zone.rate or 0.1) then return false end
				local e = U.weighted(O.rng, zone.table or {})
				if not e then return false end
				spec = { creature = e.creature, level = U.randInt(O.rng, e.min or e.level or 2, e.max or e.level or e.min or 4), battle = zone.battle }
			end
			O.encounterGrace = 2
			O.lock()
			R.startWildBattle(spec, function()
				O.unlock()
			end)
			return true
		end
	end
	return false
end

local function triggerAt(x: number, y: number)
	for i, t in O.map.triggers do
		local w, h = t.w or 1, t.h or 1
		if x >= t.at[1] and y >= t.at[2] and x < t.at[1] + w and y < t.at[2] + h then
			local flag = t.flag or (if t.once ~= false then ("trigger_" .. O.map.id .. "_" .. i) else nil)
			if (not flag or not State.flag(flag)) and (t["if"] == nil or Logic.check(t["if"])) then
				return t, flag
			end
		end
	end
	return nil
end

local function arrive(p)
	local d = State.get()
	d.player.x, d.player.y, d.player.facing = p.x, p.y, p.facing
	O.stepCount += 1
	if O.encounterGrace > 0 then O.encounterGrace -= 1 end
	Events.stepped:fire(p.x, p.y, O.map.id)
	local w = warpAt(p.x, p.y, "step", p.facing)
	if w then
		O.warp(w.to, w.spawn)
		return
	end
	local t, flag = triggerAt(p.x, p.y)
	if t then
		if flag then State.setFlag(flag, true) end
		runInteraction(t, "trigger")
		return
	end
	if O.rollEncounter(p.x, p.y) then return end
	O.checkSight()
end

-- ---------------------------------------------------------------- warps & per-frame update

function O.warp(mapId: string, spawnId)
	local target = Content.maps[mapId]
	if not target then
		print("[rpg] warp to unknown map " .. tostring(mapId))
		return
	end
	O.lock()
	U.sfx(cfg().sfx and cfg().sfx.door)
	W.fade(1, 0.18, function()
		O.unlock()
		R.enterMap(mapId, spawnId)
		W.fade(0, 0.22)
	end)
end

local function readDir(): string?
	local ax, ay = input.axis("move_x"), input.axis("move_y")
	if math.abs(ax) < 0.35 and math.abs(ay) < 0.35 then return nil end
	if math.abs(ax) > math.abs(ay) then return if ax > 0 then "right" else "left" end
	return if ay > 0 then "down" else "up"
end

local function updateNpc(n, dt: number)
	if not n.shown then return end
	if n.moving then
		if advanceActor(n, dt) then
			local cb = n.onArrive
			n.onArrive = nil
			if cb then cb() end
		end
		return
	end
	if O.busy() or n.alert then return end
	local mode = n.def.move or "static"
	n.wait -= dt
	if n.wait > 0 then return end
	n.wait = 1.2 + O.rng() * 2.2
	if mode == "wander" then
		local dirs = { "up", "down", "left", "right" }
		local dir = dirs[1 + math.floor(O.rng() * 4)]
		local d = U.DIRS[dir]
		local r = n.def.radius or 2
		local nx, ny = n.x + d[1], n.y + d[2]
		faceActor(n, dir)
		if math.abs(nx - n.home[1]) <= r and math.abs(ny - n.home[2]) <= r and not O.blocked(nx, ny, n) then
			beginStep(n, d[1], d[2], 0.3)
		end
	elseif mode == "patrol" and n.def.path and #n.def.path > 0 then
		local target = n.def.path[n.pathIndex]
		if n.x == target[1] and n.y == target[2] then
			n.pathIndex = (n.pathIndex % #n.def.path) + 1
			target = n.def.path[n.pathIndex]
		end
		local dx, dy = math.sign(target[1] - n.x), math.sign(target[2] - n.y)
		if dx ~= 0 then dy = 0 end
		if dx ~= 0 or dy ~= 0 then
			local dir = if dx > 0 then "right" elseif dx < 0 then "left" elseif dy > 0 then "down" else "up"
			faceActor(n, dir)
			if not O.blocked(n.x + dx, n.y + dy, n) then beginStep(n, dx, dy, 0.3) end
			n.wait = 0.05
		end
	elseif mode == "look" or n.def.look == "random" then
		local dirs = { "up", "down", "left", "right" }
		faceActor(n, dirs[1 + math.floor(O.rng() * 4)])
	end
end

function O.update(dt: number)
	local p = O.player
	if not p or not O.map then return end
	for _, n in O.npcs do updateNpc(n, dt) end
	if p.moving then
		if advanceActor(p, dt) then arrive(p) end
		if p.moving then return end
	end
	if O.busy() then
		O.holdTicks = 0
		return
	end
	if input.pressed("jump") then
		O.interact()
		return
	end
	if input.pressed("action2") and R.openMenu then
		R.openMenu()
		return
	end
	local dir = readDir()
	if not dir then
		O.holdTicks = 0
		O.wasMoving = false
		return
	end
	O.holdTicks += 1
	if dir ~= p.facing and O.holdTicks < 4 and not O.wasMoving then
		faceActor(p, dir)
		return
	end
	faceActor(p, dir)
	local d = U.DIRS[dir]
	local nx, ny = p.x + d[1], p.y + d[2]
	local running = input.held("action") and (cfg().run ~= false)
	local dur = if running then (playerCfg().run_time or 0.11) else (playerCfg().step_time or 0.2)
	-- ledges: a tile tagged "ledge_<dir>" can be hopped over in that direction only
	local tags = if O.inBounds(nx, ny) then O.tagsAt(nx, ny) else {}
	if table.find(tags, "ledge_" .. dir) then
		local lx, ly = nx + d[1], ny + d[2]
		if not O.blocked(lx, ly, p) then
			beginStep(p, d[1] * 2, d[2] * 2, dur * 1.8, true)
			U.sfx(cfg().sfx and cfg().sfx.hop)
			O.wasMoving = true
			return
		end
	end
	local bumpWarp = warpAt(nx, ny, "bump", dir)
	if bumpWarp then
		O.warp(bumpWarp.to, bumpWarp.spawn)
		return
	end
	local hasLedge = false
	for _, t in tags do if string.sub(t, 1, 6) == "ledge_" then hasLedge = true end end
	if hasLedge or O.blocked(nx, ny, p) then
		O.wasMoving = false
		if not O.bumpCooldown or time() - O.bumpCooldown > 0.35 then
			O.bumpCooldown = time()
			U.sfx(cfg().sfx and cfg().sfx.bump)
		end
		return
	end
	beginStep(p, d[1], d[2], dur)
	O.wasMoving = true
end

-- teleport without a transition (scripts, tests)
function O.place(x: number, y: number, facing: string?)
	local p = O.player
	p.moving = false
	p.x, p.y, p.tx, p.ty = x, y, x, y
	p.e.position = O.cellCenter(x, y)
	p.e.z_index = zFor(y)
	if facing then faceActor(p, facing) end
	local d = State.get()
	d.player.x, d.player.y, d.player.facing = x, y, p.facing
	camera.snap()
end

function O.clear()
	clearMap()
	O.map = nil
	O.locks = 0
end

return O
