--!nonstrict
-- UI builders: list menu, grid menu, confirm, toast, tabbed panel, dialog box fallback.
-- Portrait-first (fit 720 wide), touch targets ≥ 96 px. Theme defaults to the game's [ui] theme (ui.theme());
-- menus.theme({...}) overrides fields.
-- Every builder returns a handle { root, close(), isOpen() }; modals dim the screen and swallow taps.
local S = require("./shared")
local M = {}
local theme = { primary = "#5e7ed6", accent = "#e8c27a", background = "#2a3170", text = "#f2ece6", dim = "#00000099", disabled = "#55586a", font = "default" }
do -- the game's resolved [ui] theme (dreamsy.toml) as the default look
	local ok, t = pcall(function() return ui.theme() end) -- ui is client-only
	if ok and type(t) == "table" then
		for _, k in { "primary", "accent", "background", "text", "font" } do if t[k] then theme[k] = t[k] end end
	end
end
local handles = {}
local Z = 900

function M.theme(t)
	if t then for k, v in t do theme[k] = v end end
	return table.clone(theme)
end
local function sceneNow() return if type(currentScene) == "function" then currentScene() else nil end
-- menus opened in a scene die with it (entities are torn down; handles are swept here)
local function sweep()
	local sc = sceneNow()
	for i = #handles, 1, -1 do
		local h = handles[i]
		if not h.open or h.scene ~= sc then h.open = false table.remove(handles, i) end
	end
end
function M.isOpen() sweep() return #handles > 0 end

local function hasUI() return type(spawn) == "function" end

-- low-level helpers (parent = UIPanel or nil for the screen)
function M.panel(parent, props)
	local p = { anchor = "center", size = vec2(640, 400), background = theme.background, z_index = Z }
	for k, v in props or {} do p[k] = v end
	return spawn("UIPanel", p, parent)
end
function M.text(parent, text, props)
	local p = { anchor = "top", size = vec2(600, 56), text = tostring(text), font_size = 32, color = theme.text, align = "center", z_index = Z + 1 }
	if theme.font ~= "default" then p.font = theme.font end
	for k, v in props or {} do p[k] = v end
	return spawn("UIText", p, parent)
end
function M.button(parent, label, onPress, props)
	local p = { anchor = "top", size = vec2(560, 96), text = tostring(label), font_size = 32, color = theme.text, background = theme.primary, z_index = Z + 2 }
	if theme.font ~= "default" then p.font = theme.font end
	for k, v in props or {} do p[k] = v end
	if p.size.y < 96 then p.size = vec2(p.size.x, 96) end
	local b = spawn("UIButton", p, parent)
	if onPress then
		b.pressed:connect(function()
			if S.events then S.events.emit("ui_pressed", { label = tostring(label) }) end
			onPress(b)
		end)
	end
	return b
end

-- modal(width, height, title?, opts) -> handle with .root (dim) .box (panel)
function M.modal(w: number, h: number, title: string?, opts)
	opts = opts or {}
	sweep()
	if opts.pause ~= false then S.pause.push("menu", true) end
	local dim = spawn("UIPanel", { anchor = "center", size = vec2(2600, 2600), background = theme.dim, z_index = Z - 1 })
	local box = M.panel(dim, { anchor = "center", size = vec2(w, h), offset = vec2(0, opts.offsetY or 0) })
	local handle = { root = dim, box = box, open = true, scene = sceneNow() }
	table.insert(handles, handle)
	if title then M.text(box, title, { offset = vec2(0, 20), size = vec2(w - 40, 60), font_size = 40, color = theme.accent }) end
	function handle.isOpen() return handle.open end
	function handle.close()
		if not handle.open then return end
		handle.open = false
		sweep()
		if opts.pause ~= false then S.pause.pop("menu") end
		if not dim.destroyed then dim:destroy() end
		if opts.onClose then opts.onClose() end
	end
	if opts.tapOutside then dim.tapped:connect(function() handle.close() end) end
	return handle
end

local function pages(n, per) return math.max(1, math.ceil(n / per)) end

-- list({ title?, items = { { label, detail?, disabled?, onSelect(item, handle) } }, closeLabel? ("Close"; false = none),
--        keepOpen? (default false: selecting closes), perPage? (6), onClose?, width? })
function M.list(opts)
	local items = opts.items or {}
	local per = opts.perPage or 6
	local w = opts.width or 640
	local np = pages(#items, per)
	local rows = math.min(per, math.max(1, #items))
	local h = 110 + rows * 112 + (if np > 1 then 112 else 0) + (if opts.closeLabel ~= false then 120 else 20)
	local handle = M.modal(w, h, opts.title, opts)
	local page = 1
	local holder
	local function render()
		if holder then holder:destroy() end
		holder = M.panel(handle.box, { anchor = "top", offset = vec2(0, 100), size = vec2(w, h - 100), background = "#00000000", z_index = Z })
		for i = (page - 1) * per + 1, math.min(#items, page * per) do
			local it = items[i]
			local y = ((i - 1) % per) * 112
			local label = it.label .. (if it.detail then "   " .. it.detail else "")
			M.button(holder, label, function()
				if it.disabled then return end
				if not opts.keepOpen then handle.close() end
				if it.onSelect then it.onSelect(it, handle) end
			end, { offset = vec2(0, y), size = vec2(w - 80, 96), background = if it.disabled then theme.disabled else theme.primary, font_size = it.fontSize or 30 })
		end
		if np > 1 then
			local y = rows * 112
			M.button(holder, "<", function() page = if page > 1 then page - 1 else np render() end, { anchor = "top_left", offset = vec2(40, y), size = vec2(120, 96) })
			M.text(holder, page .. " / " .. np, { offset = vec2(0, y + 20), size = vec2(200, 56) })
			M.button(holder, ">", function() page = if page < np then page + 1 else 1 render() end, { anchor = "top_right", offset = vec2(-40, y), size = vec2(120, 96) })
		end
	end
	render()
	if opts.closeLabel ~= false then
		M.button(handle.box, opts.closeLabel or "Close", function() handle.close() end, { anchor = "bottom", offset = vec2(0, -16), size = vec2(w - 80, 96), background = theme.disabled })
	end
	function handle.refresh(newItems) if newItems then items = newItems np = pages(#items, per) end render() end
	return handle
end

-- grid({ title?, cells = { { label?, icon? ("asset:<id>"), count?, locked?, onSelect(cell, handle) } }, columns? (4),
--        rows? (3), cellSize? (136), keepOpen? (default true), closeLabel?, onClose? })
function M.grid(opts)
	local cells = opts.cells or {}
	local cols = opts.columns or 4
	local rowsPer = opts.rows or 3
	local cs = math.max(96, opts.cellSize or 136)
	local gap = 16
	local per = cols * rowsPer
	local np = pages(#cells, per)
	local w = math.max(cols * (cs + gap) + 48, 400)
	local gridH = rowsPer * (cs + gap)
	local h = 110 + gridH + (if np > 1 then 112 else 0) + 120
	local handle = M.modal(w, h, opts.title, opts)
	local page = 1
	local holder
	local function render()
		if holder then holder:destroy() end
		holder = M.panel(handle.box, { anchor = "top", offset = vec2(0, 100), size = vec2(w, h - 220), background = "#00000000", z_index = Z })
		local x0 = (w - cols * (cs + gap) + gap) / 2
		for i = (page - 1) * per + 1, math.min(#cells, page * per) do
			local c = cells[i]
			local k = (i - 1) % per
			local cx, cy = x0 + (k % cols) * (cs + gap), math.floor(k / cols) * (cs + gap)
			local cell = M.panel(holder, { anchor = "top_left", offset = vec2(cx, cy), size = vec2(cs, cs), background = if c.locked then theme.disabled else theme.primary, z_index = Z + 1 })
			if c.icon then spawn("UIPanel", { anchor = "center", offset = vec2(0, -12), size = vec2(cs * 0.55, cs * 0.55), image = c.icon, background = "#00000000", z_index = Z + 2 }, cell) end
			if c.label then M.text(cell, c.label, { anchor = "bottom", offset = vec2(0, -4), size = vec2(cs, 32), font_size = 20 }) end
			if c.count and c.count ~= 1 then M.text(cell, "x" .. c.count, { anchor = "top_right", offset = vec2(-6, 4), size = vec2(cs, 30), font_size = 22, align = "right", color = theme.accent }) end
			cell.tapped:connect(function()
				if c.locked then return end
				if opts.keepOpen == false then handle.close() end
				if c.onSelect then c.onSelect(c, handle) end
			end)
		end
		if np > 1 then
			local y = gridH
			M.button(holder, "<", function() page = if page > 1 then page - 1 else np render() end, { anchor = "top_left", offset = vec2(24, y), size = vec2(120, 96) })
			M.text(holder, page .. " / " .. np, { offset = vec2(0, y + 20), size = vec2(200, 56) })
			M.button(holder, ">", function() page = if page < np then page + 1 else 1 render() end, { anchor = "top_right", offset = vec2(-24, y), size = vec2(120, 96) })
		end
	end
	render()
	M.button(handle.box, opts.closeLabel or "Close", function() handle.close() end, { anchor = "bottom", offset = vec2(0, -16), size = vec2(w - 80, 96), background = theme.disabled })
	function handle.refresh(newCells) if newCells then cells = newCells np = pages(#cells, per) end render() end
	return handle
end

-- confirm(text, onYes?, onNo?, { yes?, no?, title? })
function M.confirm(text: string, onYes, onNo, opts)
	opts = opts or {}
	local w, h = 600, 400
	local handle = M.modal(w, h, opts.title, opts)
	M.text(handle.box, text, { anchor = "center", offset = vec2(0, -50), size = vec2(w - 60, 140), font_size = 32 })
	M.button(handle.box, opts.no or "No", function() handle.close() if onNo then onNo() end end, { anchor = "bottom_left", offset = vec2(30, -30), size = vec2(255, 96), background = theme.disabled })
	M.button(handle.box, opts.yes or "Yes", function() handle.close() if onYes then onYes() end end, { anchor = "bottom_right", offset = vec2(-30, -30), size = vec2(255, 96) })
	return handle
end

-- toast(text, seconds?): engine ui.toast when available, else a fading kit label
function M.toast(text: string, seconds: number?)
	if type(ui) == "table" and type(ui.toast) == "function" then ui.toast(tostring(text), seconds) return end
	if not hasUI() then print("[toast] " .. tostring(text)) return end
	local t = M.text(nil, text, { anchor = "top", offset = vec2(0, 140), size = vec2(640, 64), z_index = Z + 50 })
	after(seconds or 2, function() if not t.destroyed then t:destroy() end end)
end

-- tabs({ title?, tabs = { { label, build(content: UIPanel, handle) } }, initial? (1), height? (900), onClose? })
-- handle.select(i) switches tab (rebuilds content).
function M.tabs(opts)
	local w, h = opts.width or 680, opts.height or 900
	local handle = M.modal(w, h, opts.title, opts)
	local n = #opts.tabs
	local tw = math.floor((w - 40) / n) - 8
	local content
	local buttons = {}
	function handle.select(i)
		handle.current = i
		if content then content:destroy() end
		for j, b in buttons do b.background = if j == i then theme.accent else theme.primary end
		content = M.panel(handle.box, { anchor = "top", offset = vec2(0, 210), size = vec2(w - 40, h - 340), background = "#00000033", z_index = Z + 1 })
		handle.content = content
		opts.tabs[i].build(content, handle)
	end
	for i, t in opts.tabs do
		buttons[i] = M.button(handle.box, t.label, function() handle.select(i) end, { anchor = "top_left", offset = vec2(20 + (i - 1) * (tw + 8), 100), size = vec2(tw, 96), font_size = 26 })
	end
	M.button(handle.box, opts.closeLabel or "Close", function() handle.close() end, { anchor = "bottom", offset = vec2(0, -16), size = vec2(w - 80, 96), background = theme.disabled })
	handle.select(opts.initial or 1)
	return handle
end

-- dialogBox(lines, choices?, cb): kit fallback renderer for core.dialog when ui.dialog isn't available.
-- Shows lines one per tap; with choices, the last line gets option buttons and cb(index).
function M.dialogBox(lines, choices, cb)
	local i = 1
	local h = M.modal(680, 360, nil, { pause = false, offsetY = 400 })
	local spk = M.text(h.box, "", { anchor = "top_left", offset = vec2(24, 12), size = vec2(600, 44), align = "left", color = theme.accent, font_size = 28 })
	local body = M.text(h.box, "", { anchor = "top_left", offset = vec2(24, 60), size = vec2(632, 170), align = "left", font_size = 30 })
	local function show()
		local l = lines[i]
		spk.text = l.speaker or ""
		body.text = l.text
		if i == #lines and choices then
			for k, label in choices do
				M.button(h.box, label, function() h.close() cb(k) end, { anchor = "bottom", offset = vec2(0, -16 - (#choices - k) * 104), size = vec2(600, 96) })
			end
		end
	end
	h.box.tapped:connect(function()
		if i == #lines and choices then return end
		if i < #lines then i += 1 show() else h.close() cb(nil) end
	end)
	show()
	return h
end

return M
