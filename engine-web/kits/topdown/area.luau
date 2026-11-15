-- topdown kit: area runner (an overworld or a dungeon scene). One call builds everything from the
-- scene's TileMap2D layers + data/: hero, rooms with a room-locked camera and slide transitions,
-- enemies/bosses per room, items & abilities, keys/locked doors, bombs/cracked walls, hookshot/gaps,
-- plates/switches/gates/pushable blocks, shutters, chests, NPCs/signs/shops (engine dialog), warps,
-- pickups, minimap, save. kit.area.start({ ... }) from the area scene's script.
local core = require("@kit/core")
local juice = require("@kit/juice")
local U = require("./util")
local Grid = require("./grid")
local Player = require("./player")
local Enemy = require("./enemies")
local Boss = require("./boss")
local Content = require("./content")
local Progress = require("./progress")
local Hud = require("./hud")

local Area = {}
Area.__index = Area
Area.current = nil

Area.DEFAULTS = {
	room = nil, -- { 15, 11 } tiles per room (screen-sized rooms); nil = the whole map is one room
	transition_time = 0.4,
	hearts = 3, -- starting max hearts (saved after that)
	start_items = {}, -- given on a fresh save, e.g. { "sword" }
	sword_item = "sword", -- item needed to swing (false = always)
	respawn_delay = 1.2,
	interact_reach = 10,
	push_time = 0.3,
	pickup_life = 8,
	boss_drop = "heart_container",
	buttons = { attack = "action", item = "action2" },
	player = {}, -- player.luau options (speed, size, sword = {...})
	player_offset = { 0, -4 }, -- entity position = feet box center + offset
	art = {}, -- heart, heart_half, heart_empty, chest, chest_open, bomb, arrow, hook, chain, rupee, heart_pickup, slash_*
	sounds = {}, -- sword, hit, hurt, die, enemy_die, pickup, rupee, key, door, chest, item, bomb, explode, secret, push, warp, shop, error, boss_hit, boss_defeat, hook
	anims = {}, -- down, up, side, attack_down, attack_up, attack_side (names in the player's anim set)
	hud = {},
	camera = { follow_lerp = 10 },
	drop_table = { { item = "rupee", chance = 0.35 }, { item = "heart", chance = 0.15 } },
	room_mask = "#141a24", -- cover what's outside the current room (portrait screens show more than a room); false = off
}

local MARKERS = { player_start = true, entry = true, enemy = true, boss = true, npc = true, chest = true, warp = true }
local SKIP = { enemy = true, boss = true, npc = true, chest = true, warp = true, entry = true, item = true, sign = true, solid = true, wall = true }

local function otherTag(list)
	for _, t in list do if not SKIP[t] then return t end end
	return nil
end

local function itemDef(id: string)
	if Content.has("items", id) then return Content.get("items", id) end
	return { id = id, name = id, kind = id }
end

function Area.start(opts)
	opts = opts or {}
	local self = setmetatable({}, Area)
	local o = U.merge(Area.DEFAULTS, opts)
	for _, k in { "maps", "map", "player_entity", "camera_entity", "on_death", "input", "on_warp" } do o[k] = opts[k] end
	self.o = o
	self.events = U.bus()
	Area.current = self
	self.id = o.id or sceneParams().area or currentScene()
	self.dungeon = o.dungeon or self.id

	local maps = o.maps or (o.map and { o.map }) or entitiesTagged("area_map")
	if #maps == 0 then error("topdown area: pass maps = { floor, objects } (TileMap2D) or tag them area_map", 2) end
	self.grid = Grid.new(maps)
	self.player = o.player_entity or entitiesTagged("player")[1]
	if not self.player then error("topdown area: pass player_entity or tag the hero entity player", 2) end
	self.sprite = if self.player.type == "Sprite2D" then self.player else nil
	if not self.sprite then for _, c in self.player:children() do if c.type == "Sprite2D" then self.sprite = c break end end end

	-- fresh save: starting items / hearts
	local d = Progress.load()
	if d.hearts == nil then
		d.hearts = o.hearts
		for _, it in o.start_items do Progress.giveItem(it) end
	end

	local pp = self.player.position
	self.hero = Player.new(o.player, pp.x - o.player_offset[1], pp.y - o.player_offset[2])
	self.hero.maxHp = d.hearts * 2
	self.hero.hp = self.hero.maxHp
	self.body = self.hero.body
	self:applyAbilities()

	self.enemies, self.bosses, self.projectiles, self.pickups, self.bombs = {}, {}, {}, {}, {}
	self.npcs, self.chests, self.entries, self.warps = {}, {}, {}, {}
	self.rooms = {}
	self.actors = spawn("Node2D", { z_index = 3 })
	self.pushT, self.dead, self.time = 0, false, 0

	self:restoreDone()
	self:scan()
	-- spawn position: entry from the warp that brought us, else player_start, else the entity
	local entry = sceneParams().entry
	local e = entry and self.entries[entry]
	if not e and not self.startPos then
		-- scene opened directly (no warp): use the first entry point
		local names = U.keys(self.entries)
		if #names > 0 then e = self.entries[names[1]] entry = names[1] end
	end
	if e then self.body.x, self.body.y = e.x, e.y
	elseif self.startPos then self.body.x, self.body.y = self.startPos.x, self.startPos.y end
	if e and e.facing then self.hero.facing = e.facing end
	self.entryName = entry
	self.arrivedOnWarp = true

	local camE = o.camera_entity or camera.current()
	self.camE = camE
	if camE then
		local c = camera.center()
		local tl = camera.screenToWorld(vec2(0, 0))
		self.hw, self.hh = math.abs(c.x - tl.x), math.abs(c.y - tl.y)
	end
	if o.hud ~= false then self.hud = Hud.new(o.hud, o.art) self.hud.item.pressed:connect(function() self:cycleItem() end) end
	self.room = nil
	self:enterRoom(self:roomOf(self.body.x, self.body.y), true)
	self.respawnX, self.respawnY = self.body.x, self.body.y
	Progress.load().last = { scene = currentScene(), entry = entry }
	Progress.save()
	self:sync(0)
	onTick(function(dt) self:tick(dt) end)
	return self
end

-- passive item effects: passes tags, speed, sword damage
function Area:applyAbilities()
	local passes, mult, sword = {}, 1, nil
	for _, id in Progress.items() do
		local def = itemDef(id)
		for _, t in def.passes or {} do passes[t] = true end
		if def.speed_mult then mult = math.max(mult, def.speed_mult) end
		if def.kind == "sword" and def.damage then sword = math.max(sword or 0, def.damage) end
	end
	self.body.passes = passes
	self.hero.speedMult = mult
	if sword then self.hero.o.sword.damage = sword end
end

-- ---------- rooms ----------
function Area:roomOf(x: number, y: number)
	local g = self.grid
	local c, r = g:cellOf(x, y)
	if not self.o.room then return self:roomAt(0, 0) end
	return self:roomAt(math.floor(c / self.o.room[1]), math.floor(r / self.o.room[2]))
end

function Area:roomAt(rx: number, ry: number)
	local k = rx .. "," .. ry
	local room = self.rooms[k]
	if room then return room end
	local g, rs = self.grid, self.o.room
	local w, h = if rs then rs[1] else g.cols, if rs then rs[2] else g.rows
	room = { key = k, rx = rx, ry = ry, c0 = rx * w, r0 = ry * h, c1 = rx * w + w - 1, r1 = ry * h + h - 1,
		spawns = {}, bossSpawns = {}, gates = {}, plates = {}, shutters = {}, switches = {}, live = {} }
	room.x0, room.y0 = g.ox + room.c0 * g.ts, g.oy + room.r0 * g.ts
	room.x1, room.y1 = g.ox + (room.c1 + 1) * g.ts, g.oy + (room.r1 + 1) * g.ts
	self.rooms[k] = room
	return room
end

local function cellKey(self, c, r) return self.id .. ":" .. c .. ":" .. r end

-- re-apply persistent changes (opened doors, broken walls, taken pickups)
function Area:restoreDone()
	local g = self.grid
	for _, tag in { "locked", "boss_locked", "cracked", "key", "heart_container", "item", "boss_key" } do
		for _, cell in g:find(tag) do
			if Progress.isDone(cellKey(self, cell.c, cell.r)) then g:setTile(cell.mi, cell.c, cell.r, nil) end
		end
	end
end

function Area:scan()
	local g = self.grid
	for mi, m in g.maps do
		for r = 0, m.rows - 1 do
			for c = 0, m.cols - 1 do
				local inf = g:cell(mi, c, r)
				if inf then
					local t = inf.tags
					local x, y = g:cellCenter(c, r)
					local room = self:roomOf(x, y)
					if t.player_start then
						self.startPos = { x = x, y = y }
						g:setTile(mi, c, r, nil)
					elseif t.entry then
						local id = otherTag(inf.list)
						local face = nil
						for _, f in { "up", "down", "left", "right" } do if t["face_" .. f] then face = f end end
						if id then self.entries[id] = { x = x, y = y, facing = face } end
						g:setTile(mi, c, r, nil)
					elseif t.enemy then
						local id = otherTag(inf.list)
						table.insert(room.spawns, { id = id, x = x, y = y })
						g:setTile(mi, c, r, nil)
					elseif t.boss then
						local id = otherTag(inf.list)
						room.boss = true
						if not Progress.bossDefeated(id) then table.insert(room.bossSpawns, { id = id, x = x, y = y }) end
						g:setTile(mi, c, r, nil)
					elseif t.npc then
						self:addNpc(otherTag(inf.list), x, y)
						g:setTile(mi, c, r, nil)
					elseif t.chest then
						self:addChest(otherTag(inf.list), c, r)
						g:setTile(mi, c, r, nil)
					else
						if t.warp then table.insert(self.warps, { c = c, r = r, id = otherTag(inf.list) }) end
						if t.gate then table.insert(room.gates, { c = c, r = r, mi = mi, char = inf.char }) end
						if t.plate then table.insert(room.plates, { c = c, r = r }) end
						if t.switch then table.insert(room.switches, { c = c, r = r }) end
						if t.shutter then
							table.insert(room.shutters, { c = c, r = r, mi = mi, char = inf.char })
							g:setTile(mi, c, r, nil) -- open until a fight starts
						end
					end
				end
			end
		end
	end
	-- rooms whose switch was hit earlier stay open
	for _, room in self.rooms do
		if #room.gates > 0 and Progress.isDone(self.id .. ":room:" .. room.key) then
			room.solved = true
			self:setGates(room, true)
		end
	end
end

function Area:setGates(room, open: boolean)
	if room.gatesOpen == open then return end
	room.gatesOpen = open
	for _, gt in room.gates do
		if open then
			self.grid:setTile(gt.mi, gt.c, gt.r, nil)
		else
			-- don't close on the hero
			local x, y = self.grid:cellCenter(gt.c, gt.r)
			if not U.overlap(self.body, { x = x, y = y, w = self.grid.ts, h = self.grid.ts }) then self.grid:setTile(gt.mi, gt.c, gt.r, gt.char) end
		end
	end
end

function Area:setShutters(room, closed: boolean)
	if room.shut == closed then return end
	room.shut = closed
	for _, s in room.shutters do
		local x, y = self.grid:cellCenter(s.c, s.r)
		if not closed then self.grid:setTile(s.mi, s.c, s.r, nil)
		elseif not U.overlap(self.body, { x = x, y = y, w = self.grid.ts, h = self.grid.ts }) then self.grid:setTile(s.mi, s.c, s.r, s.char) end
	end
	self:play(if closed then "door" else "secret")
end

function Area:enterRoom(room, instant: boolean?)
	local prev = self.room
	if prev then
		for _, en in prev.live do if en.e then en.e:destroy() en.e = nil end end
		prev.live = {}
		for i = #self.projectiles, 1, -1 do self:removeProjectile(i) end
	end
	self.room = room
	self.respawnX, self.respawnY = self.body.x, self.body.y
	local first = Progress.visit(self.id, room.rx, room.ry)
	if first and not instant then Progress.save() end
	for _, s in room.spawns do
		if s.id then self:addEnemy(s.id, s.x, s.y) end
	end
	for _, s in room.bossSpawns do
		if not Progress.bossDefeated(s.id) then self:addBoss(s.id, s.x, s.y) end
	end
	local fight = false
	for _, en in room.live do if en.alive and not en.def.passive then fight = true end end
	if #room.shutters > 0 then
		room.shut = nil
		self:setShutters(room, fight)
	end
	self:updateMinimap()
	self.events:emit("roomEnter", room, first)
	if instant then self:snapCamera() end
end

function Area:roomRect(room)
	return room.x0, room.y0, room.x1, room.y1
end

local function clampAxis(v, lo, hi, half)
	if hi - lo <= half * 2 then return (lo + hi) / 2 end
	return U.clamp(v, lo + half, hi - half)
end

function Area:cameraTarget(room)
	local x0, y0, x1, y1 = self:roomRect(room)
	return clampAxis(self.body.x, x0, x1, self.hw or 0), clampAxis(self.body.y, y0, y1, self.hh or 0)
end

function Area:snapCamera()
	if not self.camE then return end
	self.camX, self.camY = self:cameraTarget(self.room)
	self.camE.position = vec2(self.camX, self.camY)
	camera.snap()
end

function Area:updateMinimap()
	if not self.hud or not self.o.room then return end
	local g, rs = self.grid, self.o.room
	local cols, rows = math.ceil(g.cols / rs[1]), math.ceil(g.rows / rs[2])
	local vis = Progress.visited(self.id)
	local list = {}
	for ry = 0, rows - 1 do
		for rx = 0, cols - 1 do
			local k = rx .. "," .. ry
			local rm = self.rooms[k]
			table.insert(list, { rx = rx, ry = ry, visited = vis[k] == true, current = self.room and self.room.key == k, boss = rm and rm.boss })
		end
	end
	self.hud:setMap(list, cols, rows)
end

-- Move the hero instantly (cutscenes, debug, scripted tests); enters the room at (x, y) without a slide.
function Area:teleport(x: number, y: number, facing: string?)
	if self.hook then self:endHook() end
	self.body.x, self.body.y = x, y
	if facing then self.hero.facing = facing end
	self.transition = nil
	self.hero.frozen = false
	local room = self:roomOf(x, y)
	if room ~= self.room then self:enterRoom(room, true) else self:snapCamera() end
	self.respawnX, self.respawnY = x, y
	self:sync(0)
end

-- cell center of (col, row) in room (rx, ry) — handy for scripts
function Area:roomCell(rx: number, ry: number, c: number, r: number): (number, number)
	local rs = self.o.room or { self.grid.cols, self.grid.rows }
	return self.grid:cellCenter(rx * rs[1] + c, ry * rs[2] + r)
end

-- ---------- spawning ----------
function Area:addEnemy(id: string, x: number, y: number)
	local en = Enemy.new(Content.get("enemies", id), x, y)
	local d = en.def
	local ds = d.draw_size or d.size
	en.e = spawn("Sprite2D", { position = vec2(x, y), size = vec2(ds[1], ds[2]), texture = d.sprite, modulate = if d.sprite then "#ffffff" else (d.color or "#d04848"), z_index = 3, anims = d.animset or "", anim = (d.anims and d.anims.move) or "" }, self.actors)
	table.insert(self.enemies, en)
	if self.room then table.insert(self.room.live, en) end
	return en
end

function Area:addBoss(id: string, x: number, y: number)
	local b = Boss.new(Content.get("bosses", id), x, y)
	local ds = b.def.draw_size or b.def.size
	b.e = spawn("Sprite2D", { position = vec2(x, y), size = vec2(ds[1], ds[2]), texture = b.def.sprite, modulate = if b.def.sprite then "#ffffff" else "#a040c0", z_index = 3, anims = b.def.animset or "", anim = (b.def.anims and b.def.anims.move) or "" }, self.actors)
	table.insert(self.bosses, b)
	if self.room then table.insert(self.room.live, b) end
	if self.hud then self.hud:showBanner(string.upper(b.name), 2) end
	self.events:emit("bossStart", b)
	return b
end

function Area:addNpc(id: string, x: number, y: number)
	local def = Content.get("npcs", id)
	local s = def.size or { 14, 14 }
	local n = { id = id, def = def, x = x, y = y, w = s[1], h = s[2] }
	if def.sprite then
		local ds = def.draw_size or { 16, 16 }
		n.e = spawn("Sprite2D", { position = vec2(x, y - (ds[2] - s[2]) / 2), size = vec2(ds[1], ds[2]), texture = def.sprite, z_index = 3, anims = def.animset or "", anim = def.anim or "" }, self.actors)
	end
	self.grid:addSolid(n)
	table.insert(self.npcs, n)
	return n
end

function Area:addChest(item: string, c: number, r: number)
	local x, y = self.grid:cellCenter(c, r)
	local ch = { item = item, x = x, y = y, w = 14, h = 12, c = c, r = r, key = cellKey(self, c, r) }
	ch.opened = Progress.isDone(ch.key)
	local art = self.o.art
	ch.e = spawn("Sprite2D", { position = vec2(x, y), size = vec2(16, 16), texture = if ch.opened then (art.chest_open or art.chest) else art.chest, modulate = if art.chest then "#ffffff" elseif ch.opened then "#6a4a2a" else "#c08030", z_index = 2 }, self.actors)
	self.grid:addSolid(ch)
	table.insert(self.chests, ch)
	return ch
end

function Area:dropPickup(item: string, x: number, y: number)
	local def = itemDef(item)
	local p = { item = item, def = def, x = x, y = y, w = 10, h = 10, life = self.o.pickup_life }
	local art = def.sprite or (if def.kind == "heart" then self.o.art.heart_pickup elseif def.kind == "rupee" then self.o.art.rupee else nil)
	p.e = spawn("Sprite2D", { position = vec2(x, y), size = vec2(12, 12), texture = art, modulate = if art then "#ffffff" else "#60e070", z_index = 2 }, self.actors)
	table.insert(self.pickups, p)
	return p
end

-- ---------- effects ----------
function Area:play(key: string, opts)
	local id = self.o.sounds[key]
	if type(id) == "string" and id ~= "" then juice.sfx(id, opts) end
end

local BURST = { z_index = 30, lifetime = 0.4, speed = 70, spread = 360, start_size = 4, end_size = 1, end_color = "#ffffff00" }
function Area:burst(x: number, y: number, n: number, col: string?)
	local props = table.clone(BURST)
	props.start_color = col or "#ffffff"
	juice.emitter(vec2(x, y), props, n)
end

function Area:toast(msg: string, seconds: number?)
	if self.hud then self.hud:showBanner(msg, seconds or 2) else ui.toast(msg, seconds or 2) end
end

-- ---------- items ----------
-- Grant an item (chests, NPCs, pickups, shops). Applies its kind's effect.
function Area:give(id: string, quiet: boolean?)
	local def = itemDef(id)
	local kind = def.kind or id
	if kind == "rupee" then
		Progress.addRupees(def.amount or 1)
		self:play("rupee")
	elseif kind == "heart" then
		self.hero:heal(def.amount or 2)
		self:play("pickup")
	elseif kind == "key" then
		Progress.addKey(self.dungeon, 1)
		self:play("key")
		if not quiet then self:toast("SMALL KEY", 1.5) end
	elseif kind == "boss_key" then
		Progress.giveBossKey(self.dungeon)
		self:play("item")
		if not quiet then self:toast(string.upper(def.name or "BOSS KEY"), 2) end
	elseif kind == "heart_container" then
		local d = Progress.load()
		d.hearts = (d.hearts or self.o.hearts) + 1
		self.hero.maxHp = d.hearts * 2
		self.hero.hp = self.hero.maxHp
		self:play("item")
		if not quiet then self:toast("HEART CONTAINER!", 2) end
	elseif kind == "ammo" then
		local target = def.ammo_for or id
		local tdef = itemDef(target)
		Progress.addAmmo(target, def.amount or 5, tdef.max)
		self:play("pickup")
	else
		local first = Progress.giveItem(id)
		if def.ammo then Progress.addAmmo(id, if first then def.ammo else math.floor(def.ammo / 2), def.max) end
		if def.equip ~= false and def.kind ~= "sword" and def.kind ~= "passive" and def.kind ~= "boots" and (first or Progress.load().equipped == nil) then
			Progress.load().equipped = id
		end
		self:applyAbilities()
		self:play("item")
		if not quiet and first then self:toast(string.upper(def.name or id) .. (if def.message then "\n" .. def.message else ""), 3) end
	end
	Progress.save()
	self.events:emit("item", id, def)
end

function Area:usable()
	local list = {}
	for _, id in Progress.items() do
		local def = itemDef(id)
		if def.equip ~= false and (def.kind == "bow" or def.kind == "bomb" or def.kind == "hookshot" or def.kind == "custom" or def.kind == "wand") then table.insert(list, id) end
	end
	return list
end

function Area:cycleItem()
	local list = self:usable()
	if #list == 0 then return end
	local cur = table.find(list, Progress.load().equipped or "") or 0
	Progress.load().equipped = list[cur % #list + 1]
	self:play("select")
end

function Area:useItem()
	local id = Progress.load().equipped
	if not id or not Progress.has(id) then return false end
	local def = itemDef(id)
	local b, h = self.body, self.hero
	local dx, dy = h:dir()
	if def.ammo ~= nil and Progress.ammo(id) <= 0 then self:play("error") return false end
	if def.kind == "bomb" then
		if #self.bombs >= (def.max_out or 1) then return false end
		Progress.addAmmo(id, -1)
		local fx, fy = h:front(4)
		local bm = { x = fx, y = fy, t = def.fuse or 1.5, def = def }
		bm.e = spawn("Sprite2D", { position = vec2(fx, fy), size = vec2(12, 12), texture = def.bomb_sprite or self.o.art.bomb, modulate = if (def.bomb_sprite or self.o.art.bomb) then "#ffffff" else "#303040", z_index = 4 }, self.actors)
		tween(bm.e, { scale = vec2(1.15, 1.15) }, 0.25, { loop = true, yoyo = true })
		table.insert(self.bombs, bm)
		self:play("bomb")
	elseif def.kind == "bow" then
		Progress.addAmmo(id, -1)
		self:shoot({ x = b.x + dx * 8, y = b.y + dy * 8 - 2, vx = dx * (def.speed or 220), vy = dy * (def.speed or 220), w = if dx ~= 0 then 10 else 4, h = if dx ~= 0 then 4 else 10, life = 1.2, damage = def.damage or 2, owner = "player", sprite = def.projectile or self.o.art.arrow, kind = "arrow" })
		self:play("shoot")
	elseif def.kind == "hookshot" then
		if self.hook then return false end
		self.hook = { x = b.x, y = b.y, dx = dx, dy = dy, dist = 0, range = def.range or 96, speed = def.speed or 280, state = "out", def = def }
		self.hook.e = spawn("Sprite2D", { position = vec2(b.x, b.y), size = vec2(8, 8), texture = self.o.art.hook, modulate = if self.o.art.hook then "#ffffff" else "#c0c0d0", z_index = 6 }, self.actors)
		self.hero.frozen = true
		self:play("hook")
	elseif def.kind == "custom" or def.kind == "wand" then
		if def.ammo ~= nil then Progress.addAmmo(id, -1) end
		if def.kind == "wand" then
			self:shoot({ x = b.x + dx * 8, y = b.y + dy * 8, vx = dx * (def.speed or 180), vy = dy * (def.speed or 180), w = 8, h = 8, life = 1, damage = def.damage or 2, owner = "player", sprite = def.projectile, kind = "magic", breaks = def.breaks })
		end
		self.events:emit("useItem", id, def)
	else
		return false
	end
	self.events:emit("used", id)
	return true
end

-- break tiles with any of `tags` within radius px of (x, y)
function Area:breakTiles(x: number, y: number, radius: number, tags)
	local g = self.grid
	local c0, r0 = g:cellOf(x - radius, y - radius)
	local c1, r1 = g:cellOf(x + radius, y + radius)
	local broke = 0
	for r = r0, r1 do
		for c = c0, c1 do
			for _, tag in tags do
				local ok, mi = g:has(c, r, tag)
				if ok then
					local cx, cy = g:cellCenter(c, r)
					if U.dist(cx, cy, x, y) <= radius + g.ts * 0.5 then
						-- a cracked wall breaks as one piece (all connected cracked tiles)
						local stack, seen = { { c, r } }, {}
						while #stack > 0 do
							local p = table.remove(stack)
							local k = p[1] .. ":" .. p[2]
							local ok2, mi2 = g:has(p[1], p[2], tag)
							if ok2 and not seen[k] then
								seen[k] = true
								g:setTile(mi2, p[1], p[2], nil)
								if tag == "cracked" then
									Progress.markDone(cellKey(self, p[1], p[2]))
									for _, d in { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } } do table.insert(stack, { p[1] + d[1], p[2] + d[2] }) end
								end
								local bx, by = g:cellCenter(p[1], p[2])
								self:burst(bx, by, 10, "#c0a080")
							end
						end
						broke += 1
						self.events:emit("broke", tag, c, r)
					end
				end
			end
		end
	end
	if broke > 0 then self:play("secret") Progress.save() end
	return broke
end

function Area:explode(bm)
	local def = bm.def
	local radius = def.radius or 24
	self:play("explode")
	self:burst(bm.x, bm.y, 30, "#ffb040")
	juice.shake(5, 0.3)
	for _, en in self.enemies do
		if en.alive and U.dist(en.x, en.y, bm.x, bm.y) <= radius + en.w / 2 then self:damageEnemy(en, def.damage or 4, bm.x, bm.y) end
	end
	for _, bs in self.bosses do
		if bs.alive and U.dist(bs.x, bs.y, bm.x, bm.y) <= radius + bs.w / 2 then self:damageBoss(bs, def.damage or 4) end
	end
	if U.dist(self.body.x, self.body.y, bm.x, bm.y) <= radius * 0.8 then self:hurtHero(def.self_damage or 1, bm.x, bm.y) end
	self:breakTiles(bm.x, bm.y, radius, def.breaks or { "cracked" })
	self.events:emit("explode", bm.x, bm.y)
end

-- ---------- combat ----------
function Area:shoot(p)
	p.e = spawn("Sprite2D", { position = vec2(p.x, p.y), size = vec2(p.w, p.h), texture = p.sprite, modulate = if p.sprite then "#ffffff" else (if p.owner == "player" then "#f0e0a0" else "#ff5040"), z_index = 6, rotation = math.deg(math.atan2(p.vy, p.vx)) * (if p.sprite then 1 else 0) }, self.actors)
	table.insert(self.projectiles, p)
	return p
end

function Area:removeProjectile(i: number)
	local p = self.projectiles[i]
	if p.e then p.e:destroy() end
	table.remove(self.projectiles, i)
end

function Area:killEnemy(en)
	en.alive = false
	self:play("enemy_die")
	self:burst(en.x, en.y, 14, "#ffffff")
	self.events:emit("enemyKilled", en)
	core.emit("enemy_defeated", { enemy = en.id, area = self.id })
	local drops = en.def.drops or self.o.drop_table
	local roll = random(0, 1)
	local acc = 0
	for _, dr in drops do
		acc += dr.chance or 0
		if roll < acc then self:dropPickup(dr.item, en.x, en.y) break end
	end
	if en.e then
		local e = en.e
		en.e = nil
		tween(e, { scale = vec2(0.1, 0.1) }, 0.15)
		after(0.16, function() if not e.destroyed then e:destroy() end end)
	end
end

function Area:damageEnemy(en, n: number, fromX: number?, fromY: number?)
	if en.isBoss then return self:damageBoss(en, n) end
	if en:damage(n, fromX, fromY, 170) then self:killEnemy(en) return true end
	self:play("hit")
	return false
end

function Area:damageBoss(bs, n: number)
	local killed, phase = bs:damage(n)
	if killed then
		self:play("boss_defeat")
		self:burst(bs.x, bs.y, 40, "#ffe060")
		juice.shake(8, 0.6)
		Progress.defeatBoss(bs.id)
		if bs.e then
			local e = bs.e
			bs.e = nil
			tween(e, { scale = vec2(0.1, 0.1), rotation = 540 }, 0.8)
			after(0.85, function() if not e.destroyed then e:destroy() end end)
		end
		if self.o.boss_drop and Content.has("items", self.o.boss_drop) then
			local x, y = bs.x, bs.y
			after(0.9, function() if not self.actors.destroyed then self:dropPickup(self.o.boss_drop, x, y).life = 9999 end end)
		end
		Progress.save()
		self.events:emit("bossDefeated", bs)
		core.emit("boss_defeated", { boss = bs.id, area = self.id })
		if self.hud then self.hud:boss(nil) end
	elseif bs.iframes > 0 then
		self:play("boss_hit")
		if phase then self.events:emit("bossPhase", bs, bs.phase) juice.shake(4, 0.3) end
	end
	return killed
end

function Area:hurtHero(n: number, fromX: number?, fromY: number?)
	if self.dead or self.transition then return end
	if self.hero:hurt(n, fromX, fromY) then
		self:play("hurt")
		juice.shake(3, 0.15)
		self.events:emit("hurt", n, self.hero.hp)
		if self.hook then self:endHook() end
		if self.hero.hp <= 0 then self:die() end
	end
end

function Area:die()
	if self.dead then return end
	self.dead = true
	self.hero.frozen = true
	self:play("die")
	self:burst(self.body.x, self.body.y, 24, "#ffffff")
	local d = Progress.load()
	d.deaths += 1
	Progress.save()
	self.events:emit("death")
	if self.o.on_death then self.o.on_death(self) return end
	after(self.o.respawn_delay, function()
		-- back to where this area was entered, full hearts
		loadScene(currentScene(), { entry = self.entryName, area = sceneParams().area })
	end)
end

-- ---------- interaction ----------
-- NPC talk: def.dialog = lines, or a core dialog tree id (data/dialog/<id>.json, core.dialog.play);
-- dialog_if entries match on flag / not_flag / item / if (any core condition), first match wins.
function Area:talk(n)
	local def = n.def
	local lines = def.dialog or { "..." }
	for _, alt in def.dialog_if or {} do
		local cond = {}
		if alt.flag then table.insert(cond, { flag = alt.flag }) end
		if alt.not_flag then table.insert(cond, { ["not"] = { flag = alt.not_flag } }) end
		if alt.item then table.insert(cond, { item = alt.item }) end
		if alt["if"] then table.insert(cond, alt["if"]) end
		if core.check(cond) then lines = alt.lines break end
	end
	self.events:emit("talk", n.id)
	core.emit("talked", { npc = n.id })
	local function finish()
		if def.gives and not Progress.flag("gave:" .. n.id) then
			Progress.setFlag("gave:" .. n.id)
			self:give(def.gives)
		end
		if def.sets_flag then Progress.setFlag(def.sets_flag) Progress.save() end
		if def.shop then self:openShop(n) end
	end
	if type(lines) == "string" then return core.dialog.play(lines, { onEnd = finish, pause = false }) end
	local d = ui.dialog(lines, { speaker = def.name, portrait = def.portrait })
	d.done:connect(finish)
	return d
end

function Area:openShop(n)
	local stock = n.def.shop
	local labels = {}
	for _, s in stock do
		local def = itemDef(s.item)
		local sold = s.once and Progress.has(s.item)
		table.insert(labels, (def.name or s.item) .. "  " .. (if sold then "SOLD" else tostring(s.price)))
	end
	table.insert(labels, "Leave")
	ui.choice(n.def.shop_prompt or "What will it be?", labels, function(i)
		local s = stock[i]
		if not s then return end
		if s.once and Progress.has(s.item) then return end
		if Progress.rupees() < s.price then
			self:play("error")
			ui.dialog({ n.def.too_poor or "You can't afford that." }, { speaker = n.def.name })
			return
		end
		Progress.addRupees(-s.price)
		self:play("shop")
		self:give(s.item)
		self.events:emit("bought", s.item, s.price)
	end)
end

function Area:openChest(ch)
	if ch.opened then return end
	ch.opened = true
	Progress.markDone(ch.key)
	if self.o.art.chest_open then ch.e.texture = self.o.art.chest_open else ch.e.modulate = "#6a4a2a" end
	self:play("chest")
	self.events:emit("chest", ch.item)
	self:give(ch.item)
end

-- something to interact with in front of the hero? (NPC, sign tile, chest)
function Area:interact(): boolean
	local fx, fy = self.hero:front(self.o.interact_reach / 2)
	local probe = { x = fx, y = fy, w = 6, h = 6 }
	for _, n in self.npcs do
		if U.overlap(probe, { x = n.x, y = n.y, w = n.w + 6, h = n.h + 6 }) then self:talk(n) return true end
	end
	for _, ch in self.chests do
		if not ch.opened and U.overlap(probe, { x = ch.x, y = ch.y, w = ch.w + 6, h = ch.h + 6 }) then self:openChest(ch) return true end
	end
	local c, r = self.grid:cellOf(fx, fy)
	local ok, mi = self.grid:has(c, r, "sign")
	if ok then
		local inf = self.grid:cell(mi, c, r)
		local id = otherTag(inf.list)
		if id and Content.has("npcs", id) then self:talk({ id = id, def = Content.get("npcs", id) }) return true end
	end
	return false
end

-- bumping into door / block tiles
function Area:bump(cell, dt: number)
	local g = self.grid
	local c, r = cell[1], cell[2]
	local hx, hy = self.hero:dir()
	local function openDoor(tag)
		-- open the whole connected door
		local stack, seen = { { c, r } }, {}
		while #stack > 0 do
			local p = table.remove(stack)
			local k = p[1] .. ":" .. p[2]
			local ok, mi = g:has(p[1], p[2], tag)
			if ok and not seen[k] then
				seen[k] = true
				g:setTile(mi, p[1], p[2], nil)
				Progress.markDone(cellKey(self, p[1], p[2]))
				for _, d in { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } } do table.insert(stack, { p[1] + d[1], p[2] + d[2] }) end
			end
		end
		self:play("door")
		self.events:emit("doorOpened", tag, c, r)
		Progress.save()
	end
	if g:has(c, r, "locked") then
		if Progress.useKey(self.dungeon) then openDoor("locked")
		elseif not self.lockedMsg then self.lockedMsg = true self:toast("LOCKED - needs a small key", 1.5) after(1.6, function() self.lockedMsg = false end) end
		return
	end
	if g:has(c, r, "boss_locked") then
		if Progress.hasBossKey(self.dungeon) then openDoor("boss_locked")
		elseif not self.lockedMsg then self.lockedMsg = true self:toast("A great lock. Needs the boss key.", 1.5) after(1.6, function() self.lockedMsg = false end) end
		return
	end
	local isBlock, mi = g:has(c, r, "block")
	if isBlock then
		-- push only along the facing axis, into the block
		local bx, by = g:cellCenter(c, r)
		local along = (hx ~= 0 and U.sign(bx - self.body.x) == hx and math.abs(by - self.body.y) < g.ts * 0.6) or (hy ~= 0 and U.sign(by - self.body.y) == hy and math.abs(bx - self.body.x) < g.ts * 0.6)
		if not along then self.pushT = 0 return end
		self.pushT += dt
		if self.pushT >= self.o.push_time then
			self.pushT = 0
			local nc, nr = c + hx, r + hy
			local room = self.room
			local inside = nc >= room.c0 and nc <= room.c1 and nr >= room.r0 and nr <= room.r1
			if inside and not g:blockedAt(nc, nr, nil) and not g:has(nc, nr, "gap") then
				local ch = g.cells[mi][r * g.maps[mi].cols + c + 1]
				g:setTile(mi, c, r, nil)
				g:setTile(mi, nc, nr, ch)
				self:play("push")
				self.events:emit("blockPushed", nc, nr)
			end
		end
		return
	end
	self.pushT = 0
end

-- ---------- per tick ----------
function Area:readInput()
	local b = self.o.buttons
	local inp = { x = input.axis("move_x"), y = input.axis("move_y"), attack = input.pressed(b.attack), item = input.pressed(b.item) }
	if self.o.input then inp = self.o.input(inp) or inp end
	return inp
end

function Area:updateHook(dt: number)
	local hk = self.hook
	local g, b = self.grid, self.body
	if hk.state == "out" then
		local step = hk.speed * dt
		hk.x += hk.dx * step
		hk.y += hk.dy * step
		hk.dist += step
		local c, r = g:cellOf(hk.x, hk.y)
		if g:has(c, r, "hook") or g:has(c, r, "hookable") then
			hk.state = "pull"
			-- stop one cell short of the target
			hk.tx, hk.ty = g:cellCenter(c - hk.dx, r - hk.dy)
			self.events:emit("hooked", c, r)
		elseif g:blockedAt(c, r, { flying = true }) then
			hk.state = "back"
		else
			for _, en in self.enemies do
				if en.alive and U.overlap({ x = hk.x, y = hk.y, w = 6, h = 6 }, en) then
					en:stun(1.5)
					hk.state = "back"
					break
				end
			end
		end
		if hk.dist >= hk.range then hk.state = "back" end
	elseif hk.state == "back" then
		local dx, dy = b.x - hk.x, b.y - hk.y
		local l = math.sqrt(dx * dx + dy * dy)
		if l < hk.speed * dt + 2 then self:endHook() return end
		hk.x += dx / l * hk.speed * dt
		hk.y += dy / l * hk.speed * dt
	elseif hk.state == "pull" then
		local dx, dy = hk.tx - b.x, hk.ty - b.y
		local l = math.sqrt(dx * dx + dy * dy)
		local step = hk.speed * dt
		if l <= step then
			b.x, b.y = hk.tx, hk.ty
			self:endHook()
			self.events:emit("hookLanded")
			return
		end
		b.x += dx / l * step
		b.y += dy / l * step
	end
	if hk.e then hk.e.position = vec2(hk.x, hk.y) end
end

function Area:endHook()
	if self.hook and self.hook.e then self.hook.e:destroy() end
	self.hook = nil
	self.hero.frozen = false
end

function Area:updatePuzzles()
	local room, g = self.room, self.grid
	if not room then return end
	-- plates: pressed by a block tile or the hero
	if #room.plates > 0 and #room.gates > 0 and not room.solved then
		local all = true
		for _, p in room.plates do
			local x, y = g:cellCenter(p.c, p.r)
			local pressed = g:has(p.c, p.r, "block") or U.overlap(self.body, { x = x, y = y, w = g.ts - 6, h = g.ts - 6 })
			if not pressed then all = false end
		end
		if all ~= (room.gatesOpen == true) then
			self:setGates(room, all)
			if all then self:play("secret") self.events:emit("puzzleSolved", room) end
		end
	end
	-- shutters + gates that open when the room is cleared
	local fight = false
	for _, en in room.live do if en.alive and not en.def.passive then fight = true end end
	if #room.shutters > 0 and room.shut and not fight then self:setShutters(room, false) self.events:emit("roomCleared", room) end
	if room.shut and fight then
		-- close shutter cells the hero was standing in when the fight started
		for _, sh in room.shutters do
			if not g:has(sh.c, sh.r, "shutter") then
				local x, y = g:cellCenter(sh.c, sh.r)
				if not U.overlap(self.body, { x = x, y = y, w = g.ts, h = g.ts }) then g:setTile(sh.mi, sh.c, sh.r, sh.char) end
			end
		end
	end
	if #room.gates > 0 and #room.plates == 0 and #room.switches == 0 and not fight and not room.gatesOpen and #room.live > 0 then
		self:setGates(room, true)
		self:play("secret")
		self.events:emit("roomCleared", room)
	end
end

function Area:hitSwitch(c: number, r: number)
	local room = self.room
	if room.solved then return end
	room.solved = true
	Progress.markDone(self.id .. ":room:" .. room.key)
	Progress.save()
	self:setGates(room, true)
	self:play("secret")
	self.events:emit("switch", c, r)
end

function Area:swordHits()
	local box = self.hero:swordBox()
	if not box then return end
	local hl = self.hero.hitList
	local dmg = self.hero.o.sword.damage
	for _, en in self.enemies do
		if en.alive and not hl[en] and U.overlap(box, en) then
			hl[en] = true
			self:damageEnemy(en, dmg, self.body.x, self.body.y)
		end
	end
	for _, bs in self.bosses do
		if bs.alive and not hl[bs] and U.overlap(box, bs) then
			hl[bs] = true
			self:damageBoss(bs, dmg)
		end
	end
	-- bushes / switches
	local g = self.grid
	local c0, r0 = g:cellOf(box.x - box.w / 2, box.y - box.h / 2)
	local c1, r1 = g:cellOf(box.x + box.w / 2 - 0.01, box.y + box.h / 2 - 0.01)
	for r = r0, r1 do
		for c = c0, c1 do
			local ok, mi = g:has(c, r, "bush")
			if ok and not hl["t" .. c .. ":" .. r] then
				hl["t" .. c .. ":" .. r] = true
				g:setTile(mi, c, r, nil)
				local x, y = g:cellCenter(c, r)
				self:burst(x, y, 10, "#60c040")
				self:play("cut")
				if random(0, 1) < 0.3 then self:dropPickup(if random(0, 1) < 0.5 then "rupee" else "heart", x, y) end
			end
			if g:has(c, r, "switch") and not hl["s" .. c .. ":" .. r] then
				hl["s" .. c .. ":" .. r] = true
				self:hitSwitch(c, r)
			end
		end
	end
end

function Area:tick(dt: number)
	self.time += dt
	local hero, b, g = self.hero, self.body, self.grid
	-- room slide transition
	if self.transition then
		local tr = self.transition
		tr.t += dt
		local k = math.min(1, tr.t / self.o.transition_time)
		local e = k * k * (3 - 2 * k)
		self.camX, self.camY = tr.fx + (tr.tx - tr.fx) * e, tr.fy + (tr.ty - tr.fy) * e
		b.x, b.y = tr.px + (tr.qx - tr.px) * e, tr.py + (tr.qy - tr.py) * e
		if k >= 1 then
			self.transition = nil
			hero.frozen = false
			self:enterRoom(tr.room)
		end
		self:sync(dt)
		return
	end

	local inp = self:readInput()
	if not self.dead and not ui.dialogOpen() then
		if inp.attack and not self.hook then
			if self:interact() then inp.attack = false
			elseif self.o.sword_item and not Progress.has(self.o.sword_item) then inp.attack = false end
		end
		if inp.item and not self.hook then self:useItem() end
		hero:step(dt, inp, g)
		if hero.events.swing then self:play("sword") end
		if hero.events.bumped then self:bump(hero.events.bumped, dt) elseif hero.events.bumpedSolid == nil then self.pushT = 0 end
		if self.hook then self:updateHook(dt) end
		self:swordHits()
	end

	-- pickup tiles under the hero
	local cx, cy = g:cellOf(b.x, b.y)
	for mi = 1, #g.maps do
		local inf = g:cell(mi, cx, cy)
		if inf and not self.dead then
			local t = inf.tags
			if t.rupee or t.heart or t.key or t.heart_container or t.item or t.boss_key then
				local id = if t.item then otherTag(inf.list) elseif t.rupee then "rupee" elseif t.heart then "heart" elseif t.key then "key" elseif t.boss_key then "boss_key" else "heart_container"
				g:setTile(mi, cx, cy, nil)
				if t.key or t.heart_container or t.item or t.boss_key then Progress.markDone(cellKey(self, cx, cy)) end
				if id then self:give(id) end
			end
			if t.hazard or (t.gap and not (b.passes and b.passes.gap) and not self.hook) then
				-- pits / lava: hurt and return to the room entry point
				self:hurtHero(t.damage and 2 or 1, nil)
				b.x, b.y = self.respawnX, self.respawnY
			end
		end
	end
	-- warps (must step off the arrival warp first)
	local onWarp = nil
	for _, w in self.warps do if w.c == cx and w.r == cy then onWarp = w end end
	if not onWarp then self.arrivedOnWarp = false
	elseif not self.arrivedOnWarp and not self.dead then
		self.arrivedOnWarp = true
		self:warp(onWarp.id)
	end

	-- enemies & bosses (current room only)
	local ctx = {
		player = if self.dead then nil else b,
		shoot = function(p) self:shoot(p) end,
		summon = function(id, x, y) return self:addEnemy(id, x, y) end,
		random = function(a, c) return random(a, c) end,
		event = function(name, who) if name == "slam" then juice.shake(3, 0.15) end self.events:emit("enemy_" .. name, who) end,
	}
	for i = #self.enemies, 1, -1 do
		local en = self.enemies[i]
		if en.alive then
			en:update(dt, g, ctx)
			if en.def.touch ~= false and U.overlap(b, en, 1) and not self.dead then self:hurtHero(en.def.damage, en.x, en.y) end
		elseif not en.e then
			table.remove(self.enemies, i)
		end
	end
	for _, bs in self.bosses do
		if bs.alive then
			bs:update(dt, g, ctx)
			if U.overlap(b, bs, 2) and not self.dead then self:hurtHero(bs.def.damage, bs.x, bs.y) end
			if self.hud then self.hud:boss(bs.name, bs.hp / bs.maxHp) end
		end
	end

	-- projectiles
	for i = #self.projectiles, 1, -1 do
		local p = self.projectiles[i]
		p.life -= dt
		p.x += p.vx * dt
		p.y += p.vy * dt
		local c, r = g:cellOf(p.x, p.y)
		local remove = p.life <= 0 or g:blockedAt(c, r, { flying = true })
		if not remove and p.owner == "player" then
			if g:has(c, r, "switch") then self:hitSwitch(c, r) remove = true end
			for _, en in self.enemies do
				if not remove and en.alive and U.overlap(p, en) then self:damageEnemy(en, p.damage, p.x - p.vx, p.y - p.vy) remove = true end
			end
			for _, bs in self.bosses do
				if not remove and bs.alive and U.overlap(p, bs) then self:damageBoss(bs, p.damage) remove = true end
			end
		elseif not remove and U.overlap(p, b, 1) then
			self:hurtHero(p.damage, p.x - p.vx * 0.05, p.y - p.vy * 0.05)
			remove = true
		end
		if remove and p.breaks then self:breakTiles(p.x, p.y, 8, p.breaks) end
		if remove then self:removeProjectile(i) elseif p.e then p.e.position = vec2(p.x, p.y) end
	end

	-- bombs
	for i = #self.bombs, 1, -1 do
		local bm = self.bombs[i]
		bm.t -= dt
		if bm.t <= 0 then
			if bm.e then bm.e:destroy() end
			table.remove(self.bombs, i)
			self:explode(bm)
		end
	end

	-- dropped pickups
	for i = #self.pickups, 1, -1 do
		local p = self.pickups[i]
		p.life -= dt
		if U.overlap(p, b) and not self.dead then
			self:give(p.item)
			if p.e then p.e:destroy() end
			table.remove(self.pickups, i)
		elseif p.life <= 0 then
			if p.e then p.e:destroy() end
			table.remove(self.pickups, i)
		elseif p.life < 2 and p.e then
			p.e.visible = math.floor(p.life * 10) % 2 == 0
		end
	end

	self:updatePuzzles()

	-- leaving the room: slide to the next one
	if self.o.room and not self.dead and not self.hook then
		local room = self.room
		local nx, ny = 0, 0
		if b.x > room.x1 then nx = 1 elseif b.x < room.x0 then nx = -1 elseif b.y > room.y1 then ny = 1 elseif b.y < room.y0 then ny = -1 end
		if nx ~= 0 or ny ~= 0 then
			local nr = self:roomAt(room.rx + nx, room.ry + ny)
			local tx, ty = self:cameraTarget(nr)
			-- predicted camera target uses the hero's position after the nudge
			local qx, qy = b.x + nx * (b.w + 4), b.y + ny * (b.h + 4)
			self.transition = { t = 0, room = nr, fx = self.camX or tx, fy = self.camY or ty, px = b.x, py = b.y, qx = qx, qy = qy }
			local saveX, saveY = b.x, b.y
			b.x, b.y = qx, qy
			self.transition.tx, self.transition.ty = self:cameraTarget(nr)
			b.x, b.y = saveX, saveY
			hero.frozen = true
			for i2 = #self.projectiles, 1, -1 do self:removeProjectile(i2) end
			self.events:emit("roomLeave", room, nr)
		end
	end
	self:sync(dt)
end

function Area:warp(id: string?)
	if not id then return end
	local w = Content.get("warps", id)
	self:play("warp")
	self.events:emit("warp", id, w)
	Progress.save()
	if self.o.on_warp then self.o.on_warp(id, w) return end
	self.hero.frozen = true
	loadScene(w.scene, { entry = w.entry, area = w.area })
end

-- screen-space panels hiding everything outside the current room
function Area:updateMask()
	local col = self.o.room_mask
	if not col or not self.o.room or not self.camE or not self.room then return end
	if not self.masks then
		self.masks = {}
		for i = 1, 4 do self.masks[i] = spawn("UIPanel", { anchor = "top_left", offset = vec2(0, 0), size = vec2(1, 1), background = col, z_index = 30 }) end
	end
	local show = self.transition == nil
	local tl = camera.worldToScreen(vec2(self.room.x0, self.room.y0))
	local br = camera.worldToScreen(vec2(self.room.x1, self.room.y1))
	local W, H = 4000, 4000
	local rects = {
		{ -W, -H, W * 2 + br.x, H + tl.y }, -- above
		{ -W, br.y, W * 2 + br.x, H }, -- below
		{ -W, tl.y, W + tl.x, br.y - tl.y }, -- left
		{ br.x, tl.y, W, br.y - tl.y }, -- right
	}
	for i, m in self.masks do
		local r = rects[i]
		m.visible = show and r[3] > 0 and r[4] > 0
		if m.visible then
			m.offset = vec2(r[1], r[2])
			m.size = vec2(r[3], r[4])
		end
	end
end

local function playAnim(self, name)
	if name and self.sprite then pcall(self.player.play, self.player, name) end
end

function Area:sync(dt: number)
	local b, hero = self.body, self.hero
	local off = self.o.player_offset
	self.player.position = vec2(b.x + off[1], b.y + off[2])
	if not self.dead then self.player.visible = hero.iframes <= 0 or math.floor(hero.iframes * 14) % 2 == 0 else self.player.visible = false end
	-- animation by facing
	local f = hero.facing
	local key = if f == "left" or f == "right" then "side" else f
	if hero.swingT > 0 then key = "attack_" .. key end
	local animKey = key .. (if hero.moving then ":m" else "")
	if animKey ~= self.animKey then
		self.animKey = animKey
		local a = self.o.anims
		local name = (not hero.moving and a["idle_" .. key]) or a[key] or a[(string.gsub(key, "attack_", ""))]
		playAnim(self, name)
		-- no idle animation: hold the first frame of the walk cycle
		if not hero.moving and hero.swingT <= 0 and not a["idle_" .. key] and name and self.sprite then
			pcall(self.player.play, self.player, name, true)
			pcall(self.player.stop, self.player)
		end
	end
	if self.sprite then
		local flip = f == "left"
		if self.sprite.flip_h ~= flip then self.sprite.flip_h = flip end
	end
	-- sword slash visual
	local box = hero:swordBox()
	if box then
		if not self.slash then self.slash = spawn("Sprite2D", { z_index = 6, size = vec2(box.w, box.h), texture = self.o.art.slash, modulate = if self.o.art.slash then "#ffffff" else "#ffffffcc" }, self.actors) end
		self.slash.position = vec2(box.x, box.y)
		self.slash.size = vec2(box.w, box.h)
		self.slash.rotation = if f == "up" then -90 elseif f == "down" then 90 elseif f == "left" then 180 else 0
		if self.o.art.slash then self.slash.size = vec2(16, 16) end
		self.slash.visible = true
	elseif self.slash then
		self.slash.visible = false
	end
	for _, en in self.enemies do
		if en.e then
			en.e.position = vec2(en.x, en.y)
			local flip = (en.fx or en.dx or 0) < 0
			if en.def.faces == "left" then flip = not flip end
			if en.e.flip_h ~= flip then en.e.flip_h = flip end
			en.e.modulate = if en.iframes > 0 and en.def.sprite then "#ff8080" elseif en.stunT > 0 and en.def.sprite then "#a0a0ff" elseif en.def.sprite then "#ffffff" else (en.def.color or "#d04848")
		end
	end
	for _, bs in self.bosses do
		if bs.e then
			bs.e.position = vec2(bs.x, bs.y)
			bs.e.visible = bs.iframes <= 0 or math.floor(bs.iframes * 14) % 2 == 0
		end
	end
	-- camera: room-locked (follows inside rooms bigger than the view)
	if self.camE and not self.transition and self.room then
		local tx, ty = self:cameraTarget(self.room)
		local k = 1 - math.exp(-self.o.camera.follow_lerp * dt)
		self.camX = (self.camX or tx) + (tx - (self.camX or tx)) * k
		self.camY = (self.camY or ty) + (ty - (self.camY or ty)) * k
	end
	if self.camE and self.camX then self.camE.position = vec2(math.floor(self.camX * 4 + 0.5) / 4, math.floor(self.camY * 4 + 0.5) / 4) end
	self:updateMask()
	if self.hud then
		self.hud:setHearts(hero.hp, hero.maxHp)
		local parts = { "RUPEES " .. Progress.rupees() }
		if self.o.room then table.insert(parts, "KEYS " .. Progress.keys(self.dungeon)) end
		if Progress.hasBossKey(self.dungeon) then table.insert(parts, "BOSS KEY") end
		self.hud:setLine(table.concat(parts, "   "))
		local eq = Progress.load().equipped
		if eq ~= self.shownItem or (eq and Progress.ammo(eq) ~= self.shownAmmo) then
			self.shownItem = eq
			self.shownAmmo = eq and Progress.ammo(eq)
			local def = eq and itemDef(eq)
			self.hud:setItem(def, if def and def.ammo ~= nil then Progress.ammo(eq) else nil)
		end
	end
end

return Area
