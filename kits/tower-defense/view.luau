-- tower-defense kit: presentation. Draws a running Sim with engine entities (enemies, towers, shots, hp bars,
-- floating bounties) and handles placement: tap a build tile → radial build menu, tap a tower → radial
-- upgrade/sell/targeting menu, with a range preview. Two-tap confirm (first tap previews, second buys).
-- Uses engine globals (spawn, tween, camera, sfx) + the juice kit — client scripts only.
-- Sim speed (1x/2x/3x, 0 = pause) drives game.timeScale, so tweens/particles fast-forward with the sim.
local Content = require("@kit/tower-defense/content")
local U = require("@kit/tower-defense/util")
local juice = require("@kit/juice")

local View = {}
local ViewM = {}
ViewM.__index = ViewM

-- The view that set game.timeScale; reset to 1 when it is destroyed or its scene is gone.
local scaledBy = nil
local function resetTimeScale(view)
	if scaledBy ~= nil and (view == nil or scaledBy == view) then
		scaledBy = nil
		game.timeScale = 1
	end
end
game.session(function()
	game.sceneLoaded:connect(function()
		if scaledBy and scaledBy.root.destroyed then
			resetTimeScale()
		end
	end)
end)

local DEFAULT_THEME = {
	button = "#2b2d42", -- radial button fill (or buttonTexture)
	buttonTexture = nil, -- e.g. "asset:ui_ring"
	selected = "#ffd166",
	ok = "#ffffff",
	poor = "#8d99ae", -- can't afford
	locked = "#5c5f73",
	text = "#ffffff",
	outline = "#1b1b2a",
	range = "#ffffff",
	rangeTexture = nil, -- e.g. "asset:range_circle" (one sprite) — else a dotted ring
	hpBack = "#1b1b2a",
	hp = "#5ad16b",
	hpBoss = "#e05a5a",
	bounty = "#ffd166",
	font = "default",
	sellIcon = nil, -- "asset:..." icons for the tower menu (text labels otherwise)
	targetIcon = nil,
}

-- opts: { root: Node2D (parent of spawned visuals), map: TileMap2D? (origin + tile size), origin: Vec2?, tile: number?,
--         theme: {...} (see DEFAULT_THEME), sfx = { build, upgrade, sell, kill, leak, wave, deny, select, shoot = { [towerId] = id } },
--         input: bool (default true: tap handling + menus; uses map.tileTapped when a map is given),
--         stepSim: bool (default true: update() also steps the sim), timeScale: bool (default true: sim speed → game.timeScale),
--         names = { first = "First", last = "Last", strong = "Strong", close = "Close" } }
function View.new(sim, opts)
	opts = opts or {}
	local self = setmetatable({}, ViewM)
	self.sim = sim
	self.root = opts.root or spawn("Node2D", {})
	self.tile = opts.tile or (opts.map and opts.map.tile_size) or sim.layout.tile_size or 64
	self.origin = opts.origin or (opts.map and opts.map.position) or vec2(0, 0)
	self.theme = table.clone(DEFAULT_THEME)
	self.theme.font = ui.theme().font
	for k, v in opts.theme or {} do
		self.theme[k] = v
	end
	self.sfxIds = opts.sfx or {}
	self.names = opts.names or { first = "FIRST", last = "LAST", strong = "STRONG", close = "CLOSE" }
	self.stepSim = opts.stepSim ~= false
	self.timeScale = opts.timeScale ~= false
	self.enemies = {}
	self.towers = {}
	self.fx = {}
	self.menu = nil
	self.events = U.events()
	self.conns = {}
	local function on(name, fn)
		table.insert(self.conns, sim:on(name, fn))
	end
	on("enemySpawned", function(e) self:addEnemy(e) end)
	on("enemyKilled", function(e, bounty) self:removeEnemy(e, true, bounty) end)
	on("enemyLeaked", function(e) self:removeEnemy(e, false) self:sfx("leak") juice.shake(6, 0.25) end)
	on("towerBuilt", function(t) self:addTower(t) self:sfx("build") end)
	on("towerUpgraded", function(t) self:refreshTower(t) self:sfx("upgrade") self:pop(self.towers[t.uid] and self.towers[t.uid].root) end)
	on("speedChanged", function(s) self:applySpeed(s) end)
	on("towerSold", function(t) self:removeTower(t) self:sfx("sell") end)
	on("shot", function(t, target) self:shot(t, target) end)
	on("splash", function(t, x, y, r) self:burst(x, y, 10, t.def.projectile and t.def.projectile.color or "#ffb347") end)
	on("chain", function(t, x, y, e) self:beam(x, y, e.x, e.y, t.def.projectile and t.def.projectile.color or "#9ad7ff") end)
	on("waveStarted", function() self:sfx("wave") end)
	on("heal", function(e, list) if #list > 0 then self:burst(e.x, e.y, 6, "#7dff9a") end end)
	for _, e in sim:enemyList() do
		self:addEnemy(e)
	end
	for _, t in sim:towerList() do
		self:addTower(t)
	end
	if opts.input ~= false and opts.map and not opts.origin and not opts.tile then
		-- tap-to-build straight from the TileMap (cells = sim cells)
		self.tapConn = opts.map.tileTapped:connect(function(c, r)
			self:tapCell(c, r)
		end)
	elseif opts.input ~= false then
		local lay = sim.layout
		self.catcher = spawn("Sprite2D", {
			position = self:toWorld(lay.cols / 2, lay.rows / 2),
			size = vec2(lay.cols * self.tile, lay.rows * self.tile),
			modulate = "#00000000", z_index = -1,
		}, self.root)
		self.catcher.tapped:connect(function()
			local p = input.pointer()
			if p then
				local w = camera.screenToWorld(p)
				self:tapWorld(w)
			end
		end)
	end
	return self
end

function ViewM:on(name, fn)
	return self.events.on(name, fn)
end

function ViewM:sfx(name, opts)
	local id = self.sfxIds[name]
	if type(id) == "string" then
		juice.sfx(id, opts)
	end
end

-- Sim speed → game.timeScale (visuals fast-forward / pause with the sim). update() divides it back out.
function ViewM:applySpeed(s)
	if self.timeScale then
		scaledBy = self
		game.timeScale = s
	end
end

function ViewM:toWorld(x, y)
	return vec2(self.origin.x + x * self.tile, self.origin.y + y * self.tile)
end

function ViewM:toCell(w)
	return math.floor((w.x - self.origin.x) / self.tile), math.floor((w.y - self.origin.y) / self.tile)
end

-- ---------- enemies ----------

function ViewM:addEnemy(e)
	local T = self.tile
	local def = e.def
	local size = (def.size or 0.6) * T
	local root = spawn("Node2D", { position = self:toWorld(e.x, e.y), z_index = if e.flying then 30 else 20 }, self.root)
	if e.flying then
		spawn("Sprite2D", { position = vec2(0, size * 0.55), size = vec2(size * 0.7, size * 0.22), modulate = "#00000044", z_index = -1 }, root)
	end
	local body = spawn("Sprite2D", {
		size = vec2(size, size), texture = def.sprite, modulate = if def.sprite then "#ffffff" else (def.color or "#d94f4f"),
		anims = def.anims or "", anim = def.anim or "",
	}, root)
	if e.flying then
		juice.float(body, { height = 4, seconds = 0.5 })
	end
	local bw = math.max(size, if e.boss then T * 1.4 else 0)
	local bh = if e.boss then 8 else 5
	local by = -size / 2 - 8
	local back = spawn("Sprite2D", { position = vec2(0, by), size = vec2(bw + 2, bh + 2), modulate = self.theme.hpBack, z_index = 2, visible = e.boss }, root)
	local bar = spawn("Sprite2D", { position = vec2(0, by), size = vec2(bw, bh), modulate = if e.boss then self.theme.hpBoss else self.theme.hp, z_index = 3, visible = e.boss }, root)
	self.enemies[e.uid] = { e = e, root = root, body = body, back = back, bar = bar, bw = bw, by = by, hp = e.hp, x = e.x, slowed = false }
end

function ViewM:removeEnemy(e, killed, bounty)
	local v = self.enemies[e.uid]
	if not v then
		return
	end
	self.enemies[e.uid] = nil
	if killed then
		self:burst(e.x, e.y, if e.boss then 30 else 8, e.def.color or "#ffffff")
		if bounty and bounty > 0 then
			self:floatText("+" .. bounty, e.x, e.y - 0.3, self.theme.bounty)
		end
		self:sfx("kill", { pitch = 0.9 + (e.uid % 5) * 0.05 })
	end
	v.root:destroy()
end

-- ---------- towers ----------

local function tierLabel(t)
	if t.up.branch then
		return string.upper(t.up.branch) .. tostring(t.up.tier or 0)
	elseif (t.up.common or 0) > 0 then
		return string.rep("|", t.up.common)
	end
	return ""
end

function ViewM:towerSprite(t)
	local def = t.def
	if t.up.branch then
		for _, b in def.branches do
			if b.id == t.up.branch and b.sprite then
				return b.sprite
			end
		end
	end
	return def.sprite
end

function ViewM:addTower(t)
	local T = self.tile
	local root = spawn("Node2D", { position = self:toWorld(t.x, t.y), z_index = 10 }, self.root)
	local tex = self:towerSprite(t)
	local body = spawn("Sprite2D", {
		size = vec2(T * 0.9, T * 0.9), texture = tex, modulate = if tex then "#ffffff" else (t.def.color or "#4f7bd9"),
	}, root)
	local label = spawn("Text2D", {
		position = vec2(T * 0.28, T * 0.3), text = tierLabel(t), font_size = math.max(10, math.floor(T * 0.26)),
		color = self.theme.text, outline = self.theme.outline, outline_size = 3, font = self.theme.font, z_index = 5,
	}, root)
	self.towers[t.uid] = { t = t, root = root, body = body, label = label }
	self:pop(root)
end

function ViewM:refreshTower(t)
	local v = self.towers[t.uid]
	if not v then
		return
	end
	local tex = self:towerSprite(t)
	if tex then
		v.body.texture = tex
	end
	v.label.text = tierLabel(t)
end

function ViewM:removeTower(t)
	local v = self.towers[t.uid]
	if v then
		self:burst(t.x, t.y, 12, "#d9c08a")
		v.root:destroy()
		self.towers[t.uid] = nil
	end
	if self.menu and self.menu.tower == t then
		self:closeMenu()
	end
end

-- ---------- fx ----------

function ViewM:pop(e)
	juice.punch(e, -0.4, 0.25) -- grow in from 60%
end

function ViewM:burst(x, y, n, col)
	juice.emitter(self:toWorld(x, y), {
		speed = 140, spread = 360, lifetime = 0.35, start_size = 7, end_size = 0, start_color = color(col or "#ffffff"),
		end_color = color("#ffffff00"), z_index = 45,
	}, n)
end

function ViewM:floatText(text, x, y, col)
	juice.popup(text, self:toWorld(x, y), {
		color = col or "#ffffff", size = math.max(14, math.floor(self.tile * 0.32)), rise = self.tile * 0.6, seconds = 0.7,
		outline = self.theme.outline, font = self.theme.font, drift = 0, z = 65,
	})
end

function ViewM:shot(t, target)
	local pr = t.def.projectile or {}
	local from = self:toWorld(t.x, t.y)
	local to = self:toWorld(target.x, target.y)
	local tv = self.towers[t.uid]
	if tv then
		-- recoil + face the target
		tv.body.flip_h = to.x < from.x
		juice.squash(tv.body, { amount = 0.08, seconds = 0.12, easing = "quad_out" })
	end
	if pr.beam then
		self:beam(t.x, t.y, target.x, target.y, pr.color or "#9ad7ff")
	else
		local size = (pr.size or 0.14) * self.tile
		local b = spawn("Sprite2D", {
			position = from, size = vec2(size, size), texture = pr.sprite, modulate = if pr.sprite then "#ffffff" else (pr.color or "#ffffff"),
			z_index = 35,
		}, self.root)
		local dist = (to - from):length()
		local dur = math.clamp(dist / ((pr.speed or 10) * self.tile), 0.04, 0.4)
		tween(b, { position = to }, dur, "linear").done:connect(function()
			b:destroy()
		end)
	end
	local s = self.sfxIds.shoot
	if type(s) == "table" and s[t.id] then
		juice.sfx(s[t.id], { volume = 0.5 })
	end
end

function ViewM:beam(x1, y1, x2, y2, col)
	local a, b = self:toWorld(x1, y1), self:toWorld(x2, y2)
	local d = b - a
	local len = d:length()
	local line = spawn("Sprite2D", {
		position = (a + b) / 2, size = vec2(len, 4), rotation = math.deg(math.atan2(d.y, d.x)), modulate = col, z_index = 36,
	}, self.root)
	juice.fadeOut(line, 0.15, true)
end

-- ---------- per-frame ----------

-- Call every frame from onTick. Steps the sim (unless stepSim = false) and syncs visuals.
function ViewM:update(dt)
	if self.stepSim then
		-- dt is already scaled by game.timeScale (= sim.speed); the sim applies its own speed
		local s = self.sim.speed
		self.sim:step(if not self.timeScale then dt elseif s > 0 then dt / s else 0)
	end
	for uid, v in self.enemies do
		local e = v.e
		v.root.position = self:toWorld(e.x, e.y)
		if math.abs(e.x - v.x) > 0.001 then
			v.body.flip_h = e.x < v.x
			v.x = e.x
		end
		if e.hp ~= v.hp then
			v.hp = e.hp
			local f = math.clamp(e.hp / e.maxHp, 0, 1)
			v.back.visible = true
			v.bar.visible = true
			v.bar.size = vec2(math.max(1, v.bw * f), v.bar.size.y)
			v.bar.position = vec2(-v.bw * (1 - f) / 2, v.by)
		end
		local slowed = e.slow < 1
		if slowed ~= v.slowed then
			v.slowed = slowed
			v.body.modulate = if slowed then "#9fd8ff" elseif e.def.sprite then "#ffffff" else (e.def.color or "#d94f4f")
		end
	end
	if self.menu and self.menu.refresh then
		self.menu.refreshT = (self.menu.refreshT or 0) + dt
		if self.menu.refreshT > 0.25 then
			self.menu.refreshT = 0
			self:refreshMenu()
		end
	end
end

-- ---------- range preview ----------

function ViewM:showRange(x, y, range, col)
	self:hideRange()
	local center = self:toWorld(x, y)
	local r = range * self.tile
	if self.theme.rangeTexture then
		local s = spawn("Sprite2D", {
			position = center, size = vec2(r * 2, r * 2), texture = self.theme.rangeTexture, modulate = (col or self.theme.range) .. "88", z_index = 45,
		}, self.root)
		self.range = { s }
	else
		self.range = {}
		local n = math.clamp(math.floor(r / 6), 16, 64)
		for i = 1, n do
			local a = (i / n) * math.pi * 2
			table.insert(self.range, spawn("Sprite2D", {
				position = center + vec2(math.cos(a) * r, math.sin(a) * r), size = vec2(5, 5), modulate = (col or self.theme.range) .. "cc", z_index = 45,
			}, self.root))
		end
	end
end

function ViewM:hideRange()
	for _, s in self.range or {} do
		s:destroy()
	end
	self.range = nil
end

-- ---------- radial menus ----------

function ViewM:closeMenu()
	if self.menu then
		for _, it in self.menu.items do
			it.root:destroy()
		end
		if self.menu.marker then
			self.menu.marker:destroy()
		end
		self.menu = nil
		self.events.emit("menuClosed")
	end
	self:hideRange()
end

-- Radial positions (tile units) for n items around (cx, cy), kept inside the map.
function ViewM:radialSlots(cx, cy, n)
	local lay = self.sim.layout
	local R = if n <= 4 then 1.15 else 1.35
	local slots = {}
	-- shift the ring center so every button stays on the map
	local mx = math.clamp(cx, R + 0.5, math.max(R + 0.5, lay.cols - R - 0.5))
	local my = math.clamp(cy, R + 0.5, math.max(R + 0.5, lay.rows - R - 0.5))
	for i = 1, n do
		local a = -math.pi / 2 + (i - 1) * (2 * math.pi / n)
		table.insert(slots, { mx + math.cos(a) * R, my + math.sin(a) * R })
	end
	return slots
end

-- items: { { icon, label, sub, state = "ok"|"poor"|"locked", onConfirm, onSelect?, confirm = bool (default true) } }
function ViewM:openMenu(kind, c, r, items, extra)
	self:closeMenu()
	local T = self.tile
	local th = self.theme
	local menu = { kind = kind, c = c, r = r, items = {}, selected = nil }
	for k, v in extra or {} do
		menu[k] = v
	end
	menu.marker = spawn("Sprite2D", {
		position = self:toWorld(c + 0.5, r + 0.5), size = vec2(T, T), texture = th.buttonTexture, modulate = th.selected .. "66", z_index = 46,
	}, self.root)
	local slots = self:radialSlots(c + 0.5, r + 0.5, #items)
	for i, spec in items do
		local pos = self:toWorld(slots[i][1], slots[i][2])
		local size = T * 0.86
		local root = spawn("Node2D", { position = pos, z_index = 50 }, self.root)
		local bg = spawn("Sprite2D", { size = vec2(size, size), texture = th.buttonTexture, modulate = th.button }, root)
		local icon = nil
		if spec.icon then
			icon = spawn("Sprite2D", { size = vec2(size * 0.62, size * 0.62), position = vec2(0, -size * 0.08), texture = spec.icon, z_index = 1 }, root)
		end
		local label = spawn("Text2D", {
			position = vec2(0, if spec.icon then size * 0.36 else 0), text = spec.label or "", font_size = math.max(11, math.floor(T * (if spec.icon then 0.24 else 0.26))),
			color = th.text, outline = th.outline, outline_size = 3, font = th.font, z_index = 2,
		}, root)
		local item = { root = root, bg = bg, icon = icon, label = label, spec = spec }
		table.insert(menu.items, item)
		bg.tapped:connect(function()
			self:tapItem(item)
		end)
		self:styleItem(item)
		juice.punch(root, -0.7, 0.18)
	end
	self.menu = menu
	self.events.emit("menuOpened", kind, c, r)
	return menu
end

function ViewM:styleItem(item)
	local th = self.theme
	local st = item.spec.state or "ok"
	local sel = self.menu and self.menu.selected == item
	item.bg.modulate = if sel then th.selected elseif st == "locked" then th.locked else th.button
	if item.icon then
		item.icon.modulate = if st == "ok" then "#ffffff" else "#ffffff77"
	end
	item.label.color = if st == "ok" then th.text elseif st == "poor" then th.poor else th.poor
	item.label.text = if sel and item.spec.confirm ~= false and st == "ok" then "OK?" else (item.spec.label or "")
end

function ViewM:tapItem(item)
	local spec = item.spec
	local menu = self.menu
	if not menu then
		return
	end
	if spec.state == "locked" or spec.state == "poor" then
		self:sfx("deny")
		juice.squash(item.root, { amount = 0.15, seconds = 0.2, easing = "elastic_out" })
		if spec.onSelect then
			spec.onSelect()
		end
		return
	end
	if spec.confirm == false or menu.selected == item then
		spec.onConfirm()
		return
	end
	menu.selected = item
	self:sfx("select")
	for _, it in menu.items do
		self:styleItem(it)
	end
	if spec.onSelect then
		spec.onSelect()
	end
end

function ViewM:refreshMenu()
	local m = self.menu
	if not m then
		return
	end
	if m.kind == "build" then
		for _, it in m.items do
			local def = it.spec.def
			if def then
				it.spec.state = if self.sim.money >= def.cost then "ok" else "poor"
				self:styleItem(it)
			end
		end
	elseif m.kind == "tower" then
		for _, it in m.items do
			local o = it.spec.option
			if o then
				it.spec.state = if o.locked then "locked" elseif self.sim.money >= o.cost then "ok" else "poor"
				self:styleItem(it)
			end
		end
	end
end

function ViewM:openBuildMenu(c, r)
	local sim = self.sim
	local items = {}
	for _, def in sim:availableTowers() do
		table.insert(items, {
			def = def, icon = def.icon or def.sprite, label = tostring(def.cost),
			state = if sim.money >= def.cost then "ok" else "poor",
			onSelect = function()
				self:showRange(c + 0.5, r + 0.5, def.range)
				self.events.emit("previewTower", def, c, r)
			end,
			onConfirm = function()
				if sim:build(def.id, c, r) then
					self:closeMenu()
				else
					self:sfx("deny")
				end
			end,
		})
	end
	if #items == 0 then
		return
	end
	self:openMenu("build", c, r, items, { refresh = true })
end

function ViewM:openTowerMenu(t)
	local sim = self.sim
	local items = {}
	for _, o in sim:upgradeOptions(t) do
		local icon = nil
		if o.kind == "branch" then
			for _, b in t.def.branches do
				if b.id == o.branch then
					icon = b.icon
				end
			end
		end
		table.insert(items, {
			option = o, icon = icon or t.def.icon or t.def.sprite,
			label = if o.locked then "LOCK" else tostring(o.cost),
			state = if o.locked then "locked" elseif sim.money >= o.cost then "ok" else "poor",
			onSelect = function()
				local up = table.clone(t.up)
				if o.kind == "common" then
					up.common = o.tier
				else
					up.branch, up.tier = o.branch, o.tier
				end
				local st = Content.towerStats(t.def, up)
				self:showRange(t.x, t.y, st.range, self.theme.selected)
				self.events.emit("previewUpgrade", t, o)
			end,
			onConfirm = function()
				if sim:upgrade(t, o.branch) then
					self:openTowerMenu(t)
				else
					self:sfx("deny")
				end
			end,
		})
	end
	if (t.def.damage or 0) > 0 then
		table.insert(items, {
			icon = self.theme.targetIcon, label = self.names[t.targeting] or t.targeting, confirm = false, state = "ok",
			onConfirm = function()
				sim:cycleTargeting(t)
				self:sfx("select")
				for _, it in self.menu.items do
					if it.spec.target then
						it.spec.label = self.names[t.targeting] or t.targeting
						self:styleItem(it)
					end
				end
			end,
			target = true,
		})
	end
	table.insert(items, {
		icon = self.theme.sellIcon, label = "$" .. sim:sellValue(t), state = "ok",
		onConfirm = function()
			sim:sell(t)
			self:closeMenu()
		end,
	})
	self:openMenu("tower", t.c, t.r, items, { tower = t, refresh = true })
	self:showRange(t.x, t.y, (t.stats or t.base).range)
end

-- Route a world-space tap: menu item taps arrive through their own `tapped`; this handles the map.
function ViewM:tapWorld(w)
	self:tapCell(self:toCell(w))
end

function ViewM:tapCell(c, r)
	local sim = self.sim
	if self.menu and self.menu.c == c and self.menu.r == r then
		self:closeMenu()
		return
	end
	local t = sim:towerAtCell(c, r)
	if t then
		self:openTowerMenu(t)
		self:sfx("select")
	elseif sim:isBuildable(c, r) then
		self:openBuildMenu(c, r)
		self:sfx("select")
	else
		self:closeMenu()
	end
	self.events.emit("tileTapped", c, r)
end

-- Remove everything this view spawned and stop listening to the sim.
function ViewM:destroy()
	self:closeMenu()
	resetTimeScale(self)
	for _, c in self.conns do
		c.disconnect()
	end
	if self.tapConn then
		self.tapConn:disconnect()
	end
	local function kill(e)
		if e and not e.destroyed then
			e:destroy()
		end
	end
	for _, v in self.enemies do
		kill(v.root)
	end
	for _, v in self.towers do
		kill(v.root)
	end
	kill(self.catcher)
	self.enemies, self.towers = {}, {}
end

View.resetTimeScale = resetTimeScale

return View
