--!nonstrict
-- Board view: draws mechanic.render(state) items as Sprite2D/Text2D (pooled, keyed by item id so pieces tween when they
-- move), turns taps / swipes / drags on cells into moves, and plays juice + sfx feedback on session events.
local juice = require("@kit/juice")
local M = {}
local View = {}
View.__index = View
M.View = View

M.DEFAULT_PALETTE = { "#e4572e", "#2e86ab", "#f3a712", "#4c956c", "#a23b72", "#5f4bb6", "#ff8fab", "#33658a", "#8d6a9f", "#3e2f5b" }
M.DEFAULT_SFX = { move = "move", push = "push", invalid = "bump", win = "win", lose = "lose", undo = "undo", hint = "hint", match = "match",
	special = "special", connect = "connect", select = "select" }

local function alive(e) return e ~= nil and pcall(function() return e.id end) end

--[[ new(session, opts)
  opts: origin (Vec2, world top-left of cell 0,0) · cell (px, 96) · gap (px between cells, 0) · skin = { [kind] = spec | fn(item) -> spec }
        spec = { sprite? "asset:x", color? "#hex" | "tint" (palette[item.tint]), size? (fraction of cell, 1; or {w, h}),
                 text? = { size, color, font }, z?, onColor? (color when item.on) , onSprite? }
        palette? · input? (true) · sfx? (id map; false = silent) · juice? (true) · swipeMin? (0.45 cells) ]]
function M.new(session, opts)
	opts = opts or {}
	local v = setmetatable({
		session = session, opts = opts, origin = opts.origin or vec2(0, 0), cell = opts.cell or 96, gap = opts.gap or 0,
		skin = opts.skin or {}, palette = opts.palette or M.DEFAULT_PALETTE, pool = {}, conns = {}, hits = {}, marks = {},
		sfxIds = if opts.sfx == false then {} else opts.sfx or M.DEFAULT_SFX, selected = nil, gesture = nil, inputOn = opts.input ~= false,
	}, View)
	v.root = spawn("Node2D", { position = v.origin, z_index = opts.z or 0 })
	v:_bind(session)
	v:_buildHits()
	v:refresh(false)
	onTick(function() v:_tick() end)
	return v
end

function View:_sfx(key, o) local id = self.sfxIds[key] if id then juice.sfx(id, o) end end

function View:_bind(session)
	for _, c in self.conns do c.disconnect() end
	self.conns = {}
	self.session = session
	local function on(name, fn) table.insert(self.conns, session:on(name, fn)) end
	on("moved", function(d) self:_onMoved(d) end)
	on("invalid", function(d)
		self:_sfx("invalid")
		juice.shake("tiny")
	end)
	on("undone", function() self:_sfx("undo") self:refresh(true) end)
	on("redone", function() self:_sfx("undo", { pitch = 1.2 }) self:refresh(true) end)
	on("restarted", function() self.selected = nil self:refresh(false) end)
	on("won", function()
		self:_sfx("win")
		juice.confetti(nil, { n = 50 })
		for _, p in self.pool do if p.item.z and p.item.z >= 2 then juice.squash(p.e, { amount = 0.2 }) end end
	end)
	on("lost", function() self:_sfx("lose") juice.shake("light") end)
end

-- swap the session (next level) keeping the view
function View:setSession(session)
	self:_bind(session)
	for _, p in self.pool do if alive(p.e) then p.e:destroy() end end
	self.pool = {}
	self.selected = nil
	self:_buildHits()
	self:refresh(false)
end

function View:cellSize(): number return self.cell + self.gap end
-- local (relative to origin) centre of fractional cell coords
function View:_local(x, y) local s = self:cellSize() return vec2(x * s + self.cell / 2, y * s + self.cell / 2) end
function View:cellCenter(x: number, y: number) return self.origin + self:_local(x, y) end
function View:cellAt(world): (number?, number?)
	local s = self:cellSize()
	local lx, ly = world.x - self.origin.x, world.y - self.origin.y
	local x, y = math.floor(lx / s), math.floor(ly / s)
	local b = self.session.state.board
	if x < 0 or y < 0 or x >= b.w or y >= b.h then return nil, nil end
	return x, y
end
-- board size in px
function View:size() local b = self.session.state.board local s = self:cellSize() return vec2(b.w * s - self.gap, b.h * s - self.gap) end

function View:_spec(item)
	local s = self.skin[item.kind]
	if type(s) == "function" then s = s(item, self) end
	return s or {}
end

local function colorOf(self, spec, item)
	local c = if item.on and spec.onColor then spec.onColor else spec.color
	if c == "tint" then c = self.palette[((item.tint or 1) - 1) % #self.palette + 1] end
	return c
end

function View:_props(item, spec)
	local sz = spec.size or 1
	local w, h
	if type(sz) == "table" then w, h = sz[1] * self.cell, sz[2] * self.cell else w, h = sz * self.cell, sz * self.cell end
	local props = { position = self:_local(item.x, item.y), z_index = (spec.z or item.z or 1) }
	if item.text and spec.text ~= false then
		local t = spec.text or {}
		props.text = item.text
		props.font_size = t.size or math.floor(self.cell * 0.42)
		props.color = t.color or colorOf(self, spec, item) or "#222222"
		props.align = "center"
		props.font = t.font or "bold"
		return "Text2D", props
	end
	props.size = vec2(w, h)
	local sprite = if item.on and spec.onSprite then spec.onSprite else spec.sprite
	if item.special and spec.specials and spec.specials[item.special] then sprite = spec.specials[item.special] end
	if sprite then props.texture = sprite end
	local c = colorOf(self, spec, item)
	if c then props.modulate = c end
	return "Sprite2D", props
end

function View:_buildHits()
	for _, h in self.hits do if alive(h) then h:destroy() end end
	self.hits = {}
	if not self.inputOn then return end
	local b = self.session.state.board
	for y = 0, b.h - 1 do
		for x = 0, b.w - 1 do
			local h = spawn("Sprite2D", { position = self:_local(x, y), size = vec2(self:cellSize(), self:cellSize()), modulate = "#ffffff00", z_index = -5 }, self.root)
			h.tapped:connect(function() self:_down(x, y) end)
			table.insert(self.hits, h)
		end
	end
end

-- sync entities with the mechanic's render items (animate = tween moved pieces, drop new ones in, pop removed ones)
function View:refresh(animate: boolean?)
	local items = self.session:render()
	local seen = {}
	local rows = self.session.state.board.h
	for _, item in items do
		local key = item.id or (item.kind .. ":" .. item.x .. ":" .. item.y)
		seen[key] = true
		local spec = self:_spec(item)
		local typ, props = self:_props(item, spec)
		local p = self.pool[key]
		if p and alive(p.e) and p.typ == typ then
			local target = props.position
			props.position = nil
			for k, val in props do
				local cur = p.props[k]
				if cur == nil or tostring(cur) ~= tostring(val) then pcall(function() p.e[k] = val end) end
			end
			if tostring(p.props.position) ~= tostring(target) then
				if animate then tween(p.e, { position = target }, 0.14, "quad_out") else p.e.position = target end
			end
			props.position = target
			p.props, p.item = props, item
		else
			if p and alive(p.e) then p.e:destroy() end
			local target = props.position
			if animate and item.enter == "drop" then props.position = target - vec2(0, self:cellSize() * (rows * 0.5 + 1)) end
			local e = spawn(typ, props, self.root)
			if animate and item.enter == "drop" then tween(e, { position = target }, 0.32, "quad_in") end
			props.position = target
			self.pool[key] = { e = e, typ = typ, props = props, item = item }
		end
	end
	for key, p in self.pool do
		if not seen[key] then
			self.pool[key] = nil
			if alive(p.e) then
				if animate and p.typ == "Sprite2D" then
					tween(p.e, { scale = vec2(0.01, 0.01) }, 0.12, "quad_in")
					after(0.13, function() if alive(p.e) then p.e:destroy() end end)
				else p.e:destroy() end
			end
		end
	end
	self:_drawSelection()
end

function View:_drawSelection()
	if self.selRing and alive(self.selRing) then self.selRing:destroy() end
	self.selRing = nil
	if self.selected then
		local x, y = self.session.state.board:xy(self.selected)
		local spec = self.skin.select or { color = "#ffffff88", size = 1.06 }
		local _, props = self:_props({ x = x, y = y, kind = "select", z = 1.5 }, spec)
		props.z_index = 1
		self.selRing = spawn("Sprite2D", props, self.root)
		juice.pulse(self.selRing, { amount = 0.06, seconds = 0.5 })
	end
end

function View:_onMoved(d)
	local info = d.info or {}
	local mech = self.session.mech
	if mech.id == "match3" then
		self:_sfx("match")
		local st = self.session.state
		for _, step in info.steps or {} do
			for k, c in step.cleared do
				if k % 3 == 1 then
					local x, y = st.board:xy(c.i)
					juice.sparkle(self:cellCenter(x, y), { color = self.palette[((c.gem or 1) - 1) % #self.palette + 1], n = 4 })
				end
			end
			if #step.fired > 0 then self:_sfx("special") juice.shake("light") end
			if step.cascade > 1 then
				juice.popup("x" .. step.cascade, self.origin + self:size() / 2, { color = "#ffffff", size = 54, outline = "#000000" })
			end
		end
		if (info.gained or 0) > 0 then
			local x, y = st.board:xy(info.swap[1])
			juice.popup("+" .. info.gained, self:cellCenter(x, y), { size = 34 })
		end
	elseif info.push then
		self:_sfx("push")
	elseif info.connected then
		self:_sfx("connect")
	else
		self:_sfx("move")
	end
	self:refresh(true)
	if info.onGoal or info.connected then
		for _, p in self.pool do if p.item.on and p.item.z and p.item.z >= 2 then juice.punch(p.e, 0.15) break end end
	end
end

-- show the next hint (pulsing markers on its cells); returns the move
function View:hint()
	local mv = self.session:hint()
	if mv == nil then return nil end
	self:_sfx("hint")
	for _, m in self.marks do if alive(m) then m:destroy() end end
	self.marks = {}
	local cells = if self.session.mech.hintCells then self.session.mech.hintCells(self.session.state, mv) else {}
	local spec = self.skin.hint or { color = "#ffe06688", size = 0.9 }
	for _, c in cells do
		local _, props = self:_props({ x = c.x, y = c.y, kind = "hint" }, spec)
		props.z_index = 6
		local m = spawn("Sprite2D", props, self.root)
		juice.pulse(m, { amount = 0.12, seconds = 0.45 })
		table.insert(self.marks, m)
		after(1.6, function() if alive(m) then m:destroy() end end)
	end
	return mv
end

-- apply a move through the session (feedback comes from session events)
function View:play(move) if move == nil then return false end return (self.session:apply(move)) end

------------------------------------------------------------------ gestures
function View:_down(x, y)
	if not self.inputOn or self.session.won or self.session.lost then return end
	local b = self.session.state.board
	local p = input.pointer()
	local w = if p then (if camera.current() then camera.screenToWorld(p) else p) else self:cellCenter(x, y)
	self.gesture = { cells = { b:index(x, y) }, x = x, y = y, start = w, last = w, ticks = 0 }
end

function View:_tick()
	local g = self.gesture
	if not g then return end
	g.ticks += 1
	local p = input.pointer()
	local b = self.session.state.board
	if p and g.ticks < 600 then
		local w = if camera.current() then camera.screenToWorld(p) else p
		g.last = w
		local x, y = self:cellAt(w)
		if x then
			local i = b:index(x, y)
			local lastI = g.cells[#g.cells]
			if i ~= lastI then
				-- fill gaps with straight steps (fast drags skip cells)
				local lx, ly = b:xy(lastI)
				while lx ~= x or ly ~= y do
					if math.abs(x - lx) >= math.abs(y - ly) then lx += math.sign(x - lx) else ly += math.sign(y - ly) end
					table.insert(g.cells, b:index(lx, ly))
				end
			end
		end
		return
	end
	self.gesture = nil
	self:_resolve(g)
end

function View:_resolve(g)
	local mech, st = self.session.mech, self.session.state
	local move
	local d = g.last - g.start
	local swipeMin = (self.opts.swipeMin or 0.45) * self.cell
	if #g.cells > 1 and mech.drag then
		move = mech.drag(st, g.cells, self)
	elseif mech.swipe and (#g.cells > 1 or d:length() >= swipeMin) then
		local dir
		if math.abs(d.x) >= math.abs(d.y) then dir = if d.x > 0 then "r" else "l" else dir = if d.y > 0 then "d" else "u" end
		move = mech.swipe(st, g.x, g.y, dir, self)
		self.selected = nil
	elseif mech.tap then
		move = mech.tap(st, g.x, g.y, self)
		if move == nil then self:_sfx("select") self:_drawSelection() end
	end
	if move ~= nil then self:play(move) end
end

function View:destroy()
	for _, c in self.conns do c.disconnect() end
	self.conns = {}
	if alive(self.root) then self.root:destroy() end
	self.pool, self.hits = {}, {}
	self.gesture = nil
end

return M
