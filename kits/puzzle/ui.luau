--!nonstrict
-- Portrait puzzle UI on engine UI entities, themed by dreamsy.toml [ui] (ui.theme()): game HUD (level, moves/par,
-- status, live star meter, undo/redo/restart/hint buttons), win/lose panels, scrolling level grid, pack (world) list.
-- Buttons ≥ 112 px. Icons: opts.icons = { star, starEmpty, undo, redo, restart, hint, lock, back } ("asset:<id>").
local juice = require("@kit/juice")
local Progress = require("./progress")
local M = {}

local function theme()
	local t = (type(ui) == "table" and ui.theme and ui.theme()) or {}
	return { primary = t.primary or "#2e86ab", accent = t.accent or "#f3a712", background = t.background or "#1d2433", text = t.text or "#fdf5df", font = t.font or "bold" }
end
M.theme = theme

local function alive(e) return e ~= nil and pcall(function() return e.id end) end
function M.panel(parent, props) return spawn("UIPanel", props, parent) end
function M.text(parent, text, props)
	props = table.clone(props or {})
	props.text = text
	props.color = props.color or theme().text
	props.font = props.font or "bold"
	return spawn("UIText", props, parent)
end
function M.button(parent, label, onPress, props)
	props = table.clone(props or {})
	local th = theme()
	props.text = label
	props.size = props.size or vec2(140, 112)
	props.background = props.background or th.primary
	props.color = props.color or th.text
	props.font_size = props.font_size or 30
	props.font = props.font or "bold"
	local b = spawn("UIButton", props, parent)
	b.pressed:connect(function() juice.bounce(b) juice.sfx("select") onPress(b) end)
	return b
end

-- three stars in a row; returns { set(n) }
function M.stars(parent, props, icons)
	local size = props.starSize or 56
	local row = M.panel(parent, { offset = props.offset, anchor = props.anchor, size = vec2(size * 3 + 16, size), background = "#00000000", input_transparent = true, z_index = props.z_index })
	local cells = {}
	for k = 1, 3 do
		cells[k] = M.panel(row, { offset = vec2((k - 1) * (size + 8), 0), size = vec2(size, size), image = icons.starEmpty or icons.star, background = "#00000000", z_index = props.z_index })
	end
	local h = {}
	function h.set(n, pop)
		for k = 1, 3 do
			if alive(cells[k]) then
				cells[k].image = if k <= n then icons.star else (icons.starEmpty or icons.star)
				if not icons.starEmpty then cells[k].scale = if k <= n then vec2(1, 1) else vec2(0.6, 0.6) end
				if pop and k <= n then after(0.25 * k, function() juice.bounce(cells[k], { amount = 0.4 }) juice.sfx("star", { pitch = 1 + k * 0.12 }) end) end
			end
		end
	end
	h.root = row
	return h
end

-- live stars if the level were won now (par-based mechanics)
local function projected(s)
	if s.mech.stars then return 3 end
	local par = s.par or 0
	local t = s.level.stars or { par, math.ceil(par * 1.5) }
	return if s.moves <= t[1] then 3 elseif s.moves <= t[2] then 2 else 1
end

--[[ hud(session, opts) -> { refresh(), setSession(s), destroy(), buttons }
  opts: title, icons, onUndo/onRestart/onHint/onRedo (default: session methods; onHint should call view:hint()),
        onBack?, redo? (false), textColor? (labels over the scene; default theme text), statusColor? ]]
function M.hud(session, opts)
	opts = opts or {}
	local th = theme()
	local icons = opts.icons or {}
	local h = { session = session, buttons = {} }
	local top = M.panel(nil, { anchor = "top", offset = vec2(0, 0), size = vec2(720, 210), background = "#00000000", input_transparent = true, z_index = 20 })
	local ink = opts.textColor or th.text
	local title = M.text(top, opts.title or "", { offset = vec2(130, 18), size = vec2(440, 64), font_size = 46, align = "center", color = ink, z_index = 21 })
	local moves = M.text(top, "", { offset = vec2(40, 104), size = vec2(420, 44), font_size = 32, color = ink, z_index = 21 })
	local status = M.text(top, "", { offset = vec2(40, 150), size = vec2(420, 40), font_size = 26, color = opts.statusColor or ink, font = "serif", z_index = 21 })
	local meter = M.stars(top, { offset = vec2(500, 104), starSize = 52, z_index = 21 }, icons)
	if opts.onBack then
		M.button(top, if icons.back then "" else "<", opts.onBack, { offset = vec2(24, 16), size = vec2(96, 72), icon = icons.back, icon_size = 44, z_index = 22 })
	end
	local bar = M.panel(nil, { anchor = "bottom", offset = vec2(0, -40), size = vec2(720, 128), background = "#00000000", input_transparent = true, z_index = 20 })
	local defs = {
		{ "undo", "Undo", opts.onUndo or function() h.session:undo() end },
		{ "restart", "Retry", opts.onRestart or function() h.session:restart() end },
		{ "hint", "Hint", opts.onHint or function() h.session:step() end },
	}
	if opts.redo then table.insert(defs, 2, { "redo", "Redo", opts.onRedo or function() h.session:redo() end }) end
	local n = #defs
	local bw = 150
	local gap = (720 - n * bw) / (n + 1)
	for k, d in defs do
		local b = M.button(bar, if icons[d[1]] then "" else d[2], function() d[3]() h.refresh() end,
			{ offset = vec2(gap + (k - 1) * (bw + gap), 0), size = vec2(bw, 120), icon = icons[d[1]], icon_size = 64, z_index = 21 })
		h.buttons[d[1]] = b
	end
	local shownStars = -1
	function h.refresh()
		local s = h.session
		if not alive(moves) then return end
		if s.mech.stochastic then
			moves.text = "Moves left " .. s.state.movesLeft
		else
			moves.text = "Moves " .. s.moves .. (if s.par then "  ·  par " .. s.par else "")
		end
		status.text = s:status()
		local st = projected(s)
		if st ~= shownStars then meter.set(st) shownStars = st end
		if h.buttons.undo then h.buttons.undo.background = if s:canUndo() then th.primary else "#8a8a8a" end
	end
	function h.setTitle(t) title.text = t end
	function h.setSession(s) h.session = s shownStars = -1 h.refresh() end
	function h.destroy() if alive(top) then top:destroy() end if alive(bar) then bar:destroy() end end
	h.top, h.bar = top, bar
	every(0.2, function() h.refresh() end)
	h.refresh()
	return h
end

-- modal result card. kind = "win" | "lose"; buttons = { {label, fn} }
function M.result(session, kind, buttons, opts)
	opts = opts or {}
	local th = theme()
	local dim = M.panel(nil, { anchor = "top_left", offset = vec2(0, 0), size = vec2(720, 1280), background = "#000000aa", z_index = 50 })
	local card = M.panel(dim, { anchor = "center", offset = vec2(0, 0), size = vec2(600, 600), background = th.background, z_index = 51 })
	M.text(card, if kind == "win" then (opts.title or "Solved!") else (opts.title or "Out of moves"), { offset = vec2(0, 40), size = vec2(600, 80), font_size = 64, align = "center", color = th.text, z_index = 52 })
	local stars = nil
	if kind == "win" then
		stars = M.stars(card, { offset = vec2(165, 150), starSize = 80, z_index = 52 }, opts.icons or {})
		stars.set(0)
		after(0.15, function() stars.set(session:stars(), true) end)
		local line = "Moves " .. session.moves .. (if session.par and not session.mech.stochastic then "  ·  par " .. session.par else "")
		if session.mech.stochastic then line = "Score " .. session.state.score end
		M.text(card, line, { offset = vec2(0, 260), size = vec2(600, 50), font_size = 34, align = "center", color = th.accent, z_index = 52 })
	end
	local n = #buttons
	local bw = math.min(240, (560 - (n - 1) * 20) / n)
	local same = string.lower(th.primary) == string.lower(th.background)
	local btnBg, btnFg = if same then th.text else th.primary, if same then th.background else th.text
	for k, b in buttons do
		M.button(card, b[1], function() if alive(dim) then dim:destroy() end b[2]() end,
			{ offset = vec2(20 + (k - 1) * (bw + 20) + (560 - n * bw - (n - 1) * 20) / 2, 440), size = vec2(bw, 120), z_index = 53,
				background = if k == n then th.accent else btnBg, color = if k == n then th.background else btnFg })
	end
	juice.bounce(card, { amount = 0.08 })
	return { root = dim, stars = stars, close = function() if alive(dim) then dim:destroy() end end }
end

--[[ levelGrid(pack, opts) -> root. Scrolling grid of level buttons (number, stars, lock). Hundreds of levels are fine.
  opts: onPick(i), columns? (4), top? (220), bottom? (40), icons?, title? ]]
function M.levelGrid(pack, opts)
	opts = opts or {}
	local th = theme()
	local icons = opts.icons or {}
	local cols = opts.columns or 4
	local top = opts.top or 220
	local h = 1280 - top - (opts.bottom or 40)
	local scroll = M.panel(nil, { anchor = "top", offset = vec2(0, top), size = vec2(680, h), background = "#00000000", scroll = true, z_index = 10 })
	local cw = 680 / cols
	local rowsN = math.ceil(pack:count() / cols)
	for r = 0, rowsN - 1 do
		local row = M.panel(scroll, { offset = vec2(0, r * (cw + 26)), size = vec2(680, cw + 26), background = "#00000000", z_index = 10 })
		for c = 0, cols - 1 do
			local i = r * cols + c + 1
			if i <= pack:count() then
				local unlocked = Progress.levelUnlocked(pack, i)
				local stars = Progress.stars(pack.id, i)
				local b = M.button(row, if unlocked then tostring(i) else "", function() if unlocked then opts.onPick(i) else juice.sfx("bump") end end, {
					offset = vec2(c * cw + 10, 6), size = vec2(cw - 20, cw - 20), font_size = 44, z_index = 11,
					background = if not unlocked then "#00000033" elseif stars > 0 then th.primary else th.accent,
					color = if stars > 0 then th.text else th.background, icon = if unlocked then nil else icons.lock, icon_size = 54 })
				if unlocked and stars > 0 then
					M.stars(row, { offset = vec2(c * cw + (cw - 3 * 30 - 16) / 2, cw - 30), starSize = 30, z_index = 12 }, icons).set(stars)
				end
				b.name = "level_" .. i
			end
		end
	end
	return scroll
end

--[[ packList(packs, opts) -> root. One card per pack (world map): name, description, stars earned / possible, lock + stars
  needed. opts: onPick(pack), extra? = { {label, detail, fn} } cards on top (daily), top? (220), icons? ]]
function M.packList(packs, opts)
	opts = opts or {}
	local th = theme()
	local icons = opts.icons or {}
	local top = opts.top or 220
	local scroll = M.panel(nil, { anchor = "top", offset = vec2(0, top), size = vec2(660, 1280 - top - 40), background = "#00000000", scroll = true, z_index = 10 })
	local nCards = 0
	local function card(label, detail, fn, locked, image, starsText)
		local row = M.panel(scroll, { offset = vec2(0, nCards * 184), size = vec2(660, 184), background = "#00000000", z_index = 10 })
		nCards += 1
		local b = M.button(row, "", function() if locked then juice.sfx("bump") else fn() end end,
			{ offset = vec2(0, 0), size = vec2(660, 164), background = if locked then th.primary .. "88" else th.primary, z_index = 11 })
		if image then M.panel(row, { offset = vec2(24, 22), size = vec2(120, 120), image = image, background = "#00000000", input_transparent = true, z_index = 12 }) end
		M.text(row, label, { offset = vec2(170, 22), size = vec2(300, 60), font_size = 44, color = th.text, z_index = 12 })
		M.text(row, detail, { offset = vec2(170, 92), size = vec2(470, 50), font_size = 28, color = th.accent, z_index = 12 })
		if starsText then
			if icons.star then M.panel(row, { offset = vec2(596, 32), size = vec2(40, 40), image = if locked then (icons.lock or icons.star) else icons.star, background = "#00000000", input_transparent = true, z_index = 12 }) end
			M.text(row, starsText, { offset = vec2(440, 32), size = vec2(150, 40), font_size = 28, align = "right", color = th.text, z_index = 12 })
		end
		return b
	end
	for _, e in opts.extra or {} do card(e[1], e[2], e[3], false, e[4]) end
	for _, p in packs do
		local locked = not Progress.isUnlocked(p)
		local need = Progress.starsNeeded(p)
		local detail = if locked and need then ("Need " .. need .. " more stars") else (p.def.description or (p:count() .. " levels"))
		local b = card(p.name, detail, function() opts.onPick(p) end, locked, p.def.icon, Progress.packStars(p.id) .. "/" .. p:count() * 3)
		b.name = "pack_" .. p.id
	end
	return scroll
end

return M
