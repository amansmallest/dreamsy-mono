-- platformer kit: world map / level select scene, driven by data/world.json + saved progress.
-- kit.worldmap.start({ art = {...}, sounds = {...} }) in the map scene's script builds nodes, paths,
-- labels, a cursor and an info panel; left/right (and up/down between worlds) move, jump/action enters,
-- tapping a node selects it (tap again to enter).
local U = require("./util")
local World = require("./world")
local Progress = require("./progress")

local WM = {}
WM.__index = WM
WM.current = nil

WM.DEFAULTS = {
	art = {}, -- node, node_done, node_locked, node_boss, cursor, path, background
	sounds = {}, -- move, enter, locked
	node_size = 24,
	spacing = 112, -- auto layout: px between levels
	row_gap = 150, -- auto layout: px between worlds
	origin = { 160, 170 },
	colors = { node = "#f0c040", done = "#60d070", locked = "#505868", path = "#e8e0c8", path_locked = "#6a6a7a", text = "#ffffff" },
	buttons = { enter = "jump", enter2 = "action" },
	camera_follow = true,
}

local function nodePos(self, l)
	if type(l.map_pos) == "table" then return l.map_pos[1], l.map_pos[2] end
	local o = self.o
	return o.origin[1] + (l.levelIndex - 1) * o.spacing, o.origin[2] + (l.worldIndex - 1) * o.row_gap
end

function WM.start(opts)
	opts = opts or {}
	local self = setmetatable({}, WM)
	self.o = U.merge(WM.DEFAULTS, opts)
	self.o.on_enter = opts.on_enter
	self.o.input = opts.input
	self.events = U.bus()
	WM.current = self
	self.root = spawn("Node2D", { z_index = 0 })
	self.nodes = {}
	local o, art = self.o, self.o.art
	local levels = World.levels()

	-- paths first (under nodes)
	for i = 1, #levels - 1 do
		local a, b = levels[i], levels[i + 1]
		if not b.secret or World.isUnlocked(b.id) then
			local ax, ay = nodePos(self, a)
			local bx, by = nodePos(self, b)
			local d = U.dist(ax, ay, bx, by)
			local n = math.max(1, math.floor(d / 14))
			local open = World.isUnlocked(b.id)
			for k = 1, n - 1 do
				local t = k / n
				spawn("Sprite2D", { position = vec2(ax + (bx - ax) * t, ay + (by - ay) * t), size = vec2(6, 6), texture = art.path, modulate = if open then o.colors.path else o.colors.path_locked, z_index = 1 }, self.root)
			end
		end
	end
	-- world titles
	for wi, w in World.worlds() do
		local first = w.levels and w.levels[1]
		if first then
			first.worldIndex = first.worldIndex or wi
			local x, y = nodePos(self, first)
			spawn("Text2D", { position = vec2(x - o.node_size, y - 44), text = string.upper(w.name or w.id), font_size = 16, color = o.colors.text, align = "left", outline = "#000000", outline_size = 2, z_index = 5 }, self.root)
		end
	end
	-- nodes
	for _, l in levels do
		local unlocked = World.isUnlocked(l.id)
		if not l.secret or unlocked then
			local x, y = nodePos(self, l)
			local done = Progress.isComplete(l.id)
			local tex = if not unlocked then (art.node_locked or art.node) elseif done then (art.node_done or art.node) elseif l.boss and art.node_boss then art.node_boss else art.node
			local col = if not unlocked then o.colors.locked elseif done then o.colors.done else o.colors.node
			local s = o.node_size * (if l.boss then 1.4 else 1)
			local e = spawn("Sprite2D", { position = vec2(x, y), size = vec2(s, s), texture = tex, modulate = if tex then (if unlocked then "#ffffff" else "#8890a0") else col, z_index = 2 }, self.root)
			spawn("Text2D", { position = vec2(x, y + s / 2 + 12), text = l.short or l.id, font_size = 12, color = o.colors.text, outline = "#000000", outline_size = 2, z_index = 5 }, self.root)
			local node = { level = l, e = e, x = x, y = y, unlocked = unlocked, done = done }
			table.insert(self.nodes, node)
			e.tapped:connect(function()
				if self.sel == node then self:enter() else self:select(node, true) end
			end)
		end
	end

	self.cursor = spawn("Sprite2D", { position = vec2(0, 0), size = vec2(o.node_size, o.node_size), texture = art.cursor, modulate = if art.cursor then "#ffffff" else "#ffffff", z_index = 6 }, self.root)
	local theme = ui.theme()
	self.info = spawn("UIPanel", { anchor = "bottom", offset = vec2(0, -20), size = vec2(760, 120), background = theme.background .. "d8", z_index = 40 })
	self.infoTitle = spawn("UIText", { anchor = "top_left", offset = vec2(20, 12), size = vec2(720, 40), text = "", font_size = 30, color = theme.accent, z_index = 41 }, self.info)
	self.infoBody = spawn("UIText", { anchor = "top_left", offset = vec2(20, 56), size = vec2(720, 56), text = "", font_size = 22, color = "#ffffff", z_index = 41 }, self.info)
	local sum = World.summary()
	self.header = spawn("UIText", { anchor = "top_left", offset = vec2(24, 18), size = vec2(700, 40), text = "CLEARED " .. sum.complete .. "/" .. sum.levels .. "    GEMS " .. sum.gems .. (if sum.gemsTotal > 0 then "/" .. sum.gemsTotal else ""), font_size = 26, color = "#ffffff", outline = "#000000", outline_size = 3, z_index = 40 })

	-- initial selection: just-completed level -> next one if open; else last played; else first open
	local params = sceneParams()
	local focus = params.completed or Progress.load().last
	local pick = nil
	if params.completed then
		local nxt = World.nextLevel(params.completed)
		if nxt and World.isUnlocked(nxt.id) then focus = nxt.id end
	end
	for _, n in self.nodes do
		if n.level.id == focus and n.unlocked then pick = n end
	end
	if not pick then
		for _, n in self.nodes do
			if n.unlocked and not n.done then pick = n break end
		end
	end
	pick = pick or self.nodes[1]
	self.prevX, self.prevY = 0, 0
	self.bob = 0
	self:select(pick, false)
	if params.completed then
		local nxt = World.nextLevel(params.completed)
		for _, n in self.nodes do
			if nxt and n.level.id == nxt.id and n.unlocked and not n.done then
				n.e.scale = vec2(0.2, 0.2)
				tween(n.e, { scale = vec2(1, 1) }, 0.5, "back_out")
			end
		end
	end
	local cam = opts.camera_entity or camera.current()
	self.cam = cam
	if cam and pick then cam.position = vec2(pick.x, pick.y) camera.snap() end
	onTick(function(dt) self:tick(dt) end)
	return self
end

function WM:select(node, sound: boolean)
	if not node then return end
	self.sel = node
	local l = node.level
	self.infoTitle.text = (l.short or l.id) .. "  " .. (l.name or "")
	if not node.unlocked then
		self.infoBody.text = World.lockReason(l.id) or "Locked"
	else
		local d = Progress.load()
		local parts = {}
		table.insert(parts, if node.done then "CLEAR  best " .. U.formatTime(d.best[l.id]) else "NEW")
		if l.coins then table.insert(parts, "coins " .. (d.coins[l.id] or 0) .. "/" .. l.coins) end
		if l.gems and l.gems > 0 then table.insert(parts, "gems " .. Progress.gemsFound(l.id) .. "/" .. l.gems) end
		self.infoBody.text = table.concat(parts, "   ") .. "\nJUMP to play"
	end
	if sound then U.play(self.o.sounds, "move") end
	self.events:emit("select", l)
end

function WM:enter()
	local node = self.sel
	if not node then return end
	if not node.unlocked then
		U.play(self.o.sounds, "locked")
		ui.toast(World.lockReason(node.level.id) or "Locked", 1.5)
		return
	end
	U.play(self.o.sounds, "enter")
	self.events:emit("enter", node.level)
	if self.o.on_enter then
		self.o.on_enter(node.level)
	else
		loadScene(node.level.scene, { level = node.level.id })
	end
end

-- step to the nearest unlocked node in a direction (+1 next, -1 previous in play order)
function WM:move(dir: number)
	local idx = table.find(self.nodes, self.sel) or 1
	local j = idx + dir
	while j >= 1 and j <= #self.nodes do
		if self.nodes[j].unlocked then
			self:select(self.nodes[j], true)
			return true
		end
		j += dir
	end
	return false
end

function WM:moveWorld(dir: number)
	local cur = self.sel.level.worldIndex
	for _, n in (if dir > 0 then self.nodes else (function() local r = {} for i = #self.nodes, 1, -1 do table.insert(r, self.nodes[i]) end return r end)()) do
		if n.unlocked and ((dir > 0 and n.level.worldIndex > cur) or (dir < 0 and n.level.worldIndex < cur)) then
			self:select(n, true)
			return true
		end
	end
	return false
end

function WM:tick(dt: number)
	local ix, iy = input.axis("move_x"), input.axis("move_y")
	local enter = input.pressed(self.o.buttons.enter) or input.pressed(self.o.buttons.enter2)
	if self.o.input then
		local r = self.o.input({ x = ix, y = iy, enter = enter })
		if r then ix, iy, enter = r.x, r.y, r.enter end
	end
	local sx = if ix > 0.5 then 1 elseif ix < -0.5 then -1 else 0
	local sy = if iy > 0.5 then 1 elseif iy < -0.5 then -1 else 0
	if sx ~= 0 and sx ~= self.prevX then self:move(sx) end
	if sy ~= 0 and sy ~= self.prevY then self:moveWorld(sy) end
	self.prevX, self.prevY = sx, sy
	if enter then self:enter() end
	self.bob += dt
	local n = self.sel
	if n then
		local target = vec2(n.x, n.y - self.o.node_size - 4 + math.sin(self.bob * 5) * 3)
		local cur = self.cursor.position
		self.cursor.position = cur:lerp(target, 1 - math.exp(-14 * dt))
		if self.cam and self.o.camera_follow then
			local c = self.cam.position
			self.cam.position = c:lerp(vec2(n.x, n.y), 1 - math.exp(-5 * dt))
		end
	end
end

return WM
