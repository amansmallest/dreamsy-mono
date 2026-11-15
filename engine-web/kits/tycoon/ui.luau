--!strict
-- tycoon kit: presentation helpers (engine UI entities). Everything here only touches the engine when
-- called, so requiring it headless is fine. Coordinates are reference-screen pixels (portrait 720×1280).
local Format = require("./format")
local juice: any = require("@kit/juice")

local UI = {}
local G: any = _G

-- the game's resolved [ui] theme color (ui.theme()), or fallback
local function theme(k: string, fallback: string): string
	local u = G.ui
	if type(u) == "table" and type(u.theme) == "function" then
		return u.theme()[k] or fallback
	end
	return fallback
end
local function alive(e: any): boolean
	return G.isEntity(e) and not e.destroyed
end

UI.format = Format.format
UI.duration = Format.duration

local function props(base: { [string]: any }, extra: { [string]: any }?): { [string]: any }
	local p = table.clone(base)
	for k, v in extra or {} do
		p[k] = v
	end
	return p
end

-- ---------- primitives ----------
-- UI.panel(parent, { offset, size, background, image, anchor, z_index })
function UI.panel(parent: any, p: { [string]: any }?): any
	return G.spawn("UIPanel", props({ anchor = "top_left", background = "#00000000" }, p), parent)
end

function UI.text(parent: any, p: { [string]: any }?): any
	return G.spawn("UIText", props({ anchor = "top_left", font_size = 28, color = theme("text", "#ffffff") }, p), parent)
end

-- big tap target: UI.button(parent, { text, offset, size (default 200×88) … }, onPress)
function UI.button(parent: any, p: { [string]: any }?, onPress: (() -> ())?): any
	local b = G.spawn("UIButton", props({ anchor = "top_left", size = G.vec2(200, 88), font_size = 30 }, p), parent)
	if onPress then
		b.pressed:connect(onPress)
	end
	return b
end

-- tappable image/panel (UIPanel `tapped`) — e.g. the big "tap to earn" object
function UI.tapTarget(parent: any, p: { [string]: any }?, onTap: () -> ()): any
	local e = UI.panel(parent, p)
	e.tapped:connect(onTap)
	return e
end

-- horizontal progress bar: returns { root, fill, set(frac) }
function UI.progress(parent: any, p: { [string]: any }?, fillColor: string?): any
	local root = UI.panel(parent, props({ background = "#00000055", size = G.vec2(200, 14) }, p))
	local w, h = root.size.x, root.size.y
	local fill = UI.panel(root, { offset = G.vec2(0, 0), size = G.vec2(0, h), background = fillColor or theme("accent", "#ffd25a") })
	local last = -1
	return {
		root = root,
		fill = fill,
		set = function(frac: number)
			frac = math.clamp(frac, 0, 1)
			if math.abs(frac - last) > 0.002 then
				last = frac
				fill.size = G.vec2(math.max(0, w * frac), h)
			end
		end,
	}
end

-- ---------- feedback ("juice") ----------
-- floating "+12K" text that rises and fades: UI.floatText("+12K", vec2(360, 400), { color, size, rise, seconds })
function UI.floatText(text: string, at: any, o: any?): any
	o = o or {}
	local size = o.size or 34
	local t = G.spawn("UIText", {
		anchor = "top_left",
		offset = G.vec2(at.x - 150, at.y - size / 2),
		size = G.vec2(300, size + 8),
		text = text,
		align = "center",
		font_size = size,
		color = o.color or "#fff3b0",
		outline = "#00000099",
		outline_size = 3,
		z_index = o.z_index or 50,
	})
	local secs = o.seconds or 1
	G.tween(t, { offset = t.offset + G.vec2(0, -(o.rise or 90)) }, secs, "quad_out")
	-- fade fill and outline together in the second half
	G.tween(t, { color = G.color("#ffffff00"), outline = G.color("#00000000") }, secs * 0.5, { easing = "quad_in", delay = secs * 0.5 })
	G.after(secs, function()
		if alive(t) then
			t:destroy()
		end
	end)
	return t
end

-- quick "pop": grows font_size (text/button) and returns
local popBase: { [string]: number } = {}
function UI.pop(e: any, amount: number?)
	if not alive(e) then
		return
	end
	local fs = popBase[e.id] or e.font_size
	if fs then
		popBase[e.id] = fs
		G.tween(e, { font_size = math.floor(fs * (amount or 1.25)) }, 0.07, "quad_out").done:connect(function()
			if alive(e) then
				G.tween(e, { font_size = fs }, 0.12, "back_out")
			end
		end)
	end
end

-- flash a panel/button background to a color and back (juice.flash)
function UI.flash(e: any, hex: string?, seconds: number?)
	juice.flash(e, hex or "#ffffff", seconds or 0.25)
end

-- particle burst at a WORLD position (coins, sparkles). Self-destroys (juice.emitter).
function UI.burst(worldPos: any, o: any?): any
	o = o or {}
	return juice.emitter(worldPos, {
		speed = o.speed or 260,
		spread = 360,
		lifetime = o.lifetime or 0.6,
		gravity = G.vec2(0, o.gravity or 500),
		start_color = G.color(o.color or "#ffd25a"),
		end_color = G.color(o.end_color or "#ffffff00"),
		start_size = o.size or 12,
		end_size = 2,
		z_index = o.z_index or 40,
	}, o.count or 14)
end

-- play a sound if the id is set (content may leave sfx ids out; juice.sfx ignores unknown ids)
function UI.sfx(id: string?, opts: any?)
	if id then
		juice.sfx(id, opts)
	end
end

-- ---------- scrolling list (portrait shops) ----------
-- No clip container in the engine yet: rows that are not fully inside the viewport are hidden.
-- UI.list({ rect = {x, y, w, h} (screen px), rowHeight = 120, gap = 10, count = n,
--           build = function(i, row) -> state? end, update = function(i, row, state) end?, background? })
--           arrows = {x, y, w, h}? (adds ▲/▼ page buttons in that rect — the reliable way to scroll today:
--           the browser engine doesn't report input.pointer() while a finger is on a UI element) })
-- returns list with :refresh(), :setCount(n), :scrollTo(y), :page(dir), :dragging(), :row(i), :destroy()
-- Row press handlers should ignore presses while list:dragging() (a drag also lands on a button).
-- Scrolling snaps to whole rows (rows partly outside the viewport are hidden).
function UI.list(o: any): any
	local rect = o.rect
	local rowH, gap = o.rowHeight or 120, o.gap or 10
	local root = UI.panel(o.parent, {
		offset = G.vec2(rect[1], rect[2]),
		size = G.vec2(rect[3], rect[4]),
		background = o.background or "#00000000",
		z_index = o.z_index or 0,
	})
	local list: any = { root = root, rows = {}, states = {}, scroll = 0, count = 0 }
	local drag: any = nil
	local vel, lastDragEnd = 0, -1

	local function contentH(): number
		return math.max(0, list.count * (rowH + gap) - gap)
	end
	local function maxScroll(): number
		return math.max(0, contentH() - rect[4])
	end
	local function layout()
		for i, row in list.rows do
			local y = (i - 1) * (rowH + gap) - list.scroll
			row.offset = G.vec2(0, y)
			row.visible = y >= -1 and y + rowH <= rect[4] + 1
		end
	end
	function list.setCount(_, n: number)
		for _, r in list.rows do
			if alive(r) then
				r:destroy()
			end
		end
		list.rows, list.states, list.count = {}, {}, n
		for i = 1, n do
			local row = UI.panel(root, { size = G.vec2(rect[3], rowH), background = o.rowBackground or "#00000000", z_index = o.z_index or 0 })
			list.rows[i] = row
			list.states[i] = if o.build then o.build(i, row) else nil
		end
		list.scroll = math.clamp(list.scroll, 0, maxScroll())
		layout()
	end
	function list.refresh(_)
		if o.update then
			for i, row in list.rows do
				if row.visible then
					o.update(i, row, list.states[i])
				end
			end
		end
	end
	function list.scrollTo(_, y: number)
		list.scroll = math.clamp(y, 0, maxScroll())
		layout()
	end
	local step = rowH + gap
	local perPage = math.max(1, math.floor((rect[4] + gap) / step))
	local function snap()
		list.scroll = math.clamp(math.floor(list.scroll / step + 0.5) * step, 0, maxScroll())
		layout()
	end
	function list.page(_, dir: number)
		list.scroll = math.clamp(list.scroll + dir * perPage * step, 0, maxScroll())
		snap()
		if list.onScroll then
			list.onScroll()
		end
	end
	function list.dragging(_): boolean
		return (drag ~= nil and drag.moved) or (G.time() - lastDragEnd < 0.2)
	end
	function list.row(_, i: number): any
		return list.rows[i]
	end
	function list.destroy(_)
		if alive(root) then
			root:destroy()
		end
		list.dead = true
	end
	list.setCount(list, o.count or 0)
	if o.arrows then
		local a = o.arrows
		local w = (a[3] - 10) / 2
		local style = { size = G.vec2(w, a[4]), font_size = 26, background = o.arrowBackground or "#00000044", z_index = o.z_index or 0 }
		local up = UI.button(nil, table.clone(style), function()
			list:page(-1)
		end)
		up.offset, up.text = G.vec2(a[1], a[2]), "▲  UP"
		local down = UI.button(nil, table.clone(style), function()
			list:page(1)
		end)
		down.offset, down.text = G.vec2(a[1] + w + 10, a[2]), "▼  MORE"
		list.arrowButtons = { up, down }
		local oldDestroy = list.destroy
		function list.destroy(self)
			for _, b in list.arrowButtons do
				if alive(b) then
					b:destroy()
				end
			end
			oldDestroy(self)
		end
		local function arrowsState()
			if not (alive(up) and alive(down)) then
				return
			end
			up.visible = list.scroll > 0
			down.visible = list.scroll < maxScroll()
		end
		list.onScroll = arrowsState
		arrowsState()
	end

	G.onTick(function(dt: number)
		if list.dead or root.destroyed or not root.visible then
			drag = nil
			return
		end
		local p = G.input.pointer()
		if p then
			if drag == nil then
				if p.x >= rect[1] and p.x <= rect[1] + rect[3] and p.y >= rect[2] and p.y <= rect[2] + rect[4] then
					drag = { y0 = p.y, s0 = list.scroll, last = p.y, moved = false }
					vel = 0
				end
			else
				if math.abs(p.y - drag.y0) > 12 then
					drag.moved = true
				end
				if drag.moved then
					vel = (drag.last - p.y) / math.max(dt, 1e-3)
					if vel == 0 then
						vel = 1e-3 -- remember to snap on release
					end
					list.scroll = math.clamp(drag.s0 - (p.y - drag.y0), 0, maxScroll())
					layout()
					if list.onScroll then
						list.onScroll()
					end
				end
				drag.last = p.y
			end
		else
			if drag and drag.moved then
				lastDragEnd = G.time()
			end
			drag = nil
			if math.abs(vel) > 20 then -- momentum, then snap to a whole row
				list.scroll = math.clamp(list.scroll + vel * dt, 0, maxScroll())
				vel *= 0.9
				layout()
				if math.abs(vel) <= 20 then
					snap()
				end
				if list.onScroll then
					list.onScroll()
				end
			elseif vel ~= 0 then
				vel = 0
				snap()
			end
		end
	end)
	return list
end

-- ---------- buy-mode toggle (×1 / ×10 / MAX) ----------
-- UI.buyModes(parent, { offset, modes = {1, 10, "max"} }, onChange) → { get = fn() -> mode }
function UI.buyModes(parent: any, o: any, onChange: ((any) -> ())?): any
	local modes = o.modes or { 1, 10, "max" }
	local idx = 1
	local label = function(m: any): string
		return if m == "max" then "MAX" elseif m == "next" then "NEXT" else "×" .. tostring(m)
	end
	local btn = UI.button(parent, { offset = o.offset, size = o.size or G.vec2(150, 72), text = "BUY " .. label(modes[1]), font_size = o.font_size or 26, background = o.background or theme("primary", "#2d3a5a"), color = o.color or "#ffffff", anchor = o.anchor or "top_left", z_index = o.z_index or 0 })
	btn.pressed:connect(function()
		idx = idx % #modes + 1
		btn.text = "BUY " .. label(modes[idx])
		UI.pop(btn)
		if onChange then
			onChange(modes[idx])
		end
	end)
	return {
		button = btn,
		get = function(): any
			return modes[idx]
		end,
	}
end

return UI
