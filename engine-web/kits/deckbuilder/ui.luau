--!nonstrict
-- Portrait (720×1280) UI for deckbuilder games. One call runs the whole game loop from run state:
--   DB.ui.play(opts)   title → map → battle → rewards / shop / rest / event → … → victory / defeat
-- Builders are exposed too (UI.card, UI.battle, UI.map, UI.rewards, UI.shop, UI.rest, UI.event, UI.deck, UI.title, UI.ending)
-- for games that want their own flow. Call from a scene script; entities die with the scene.
local Core = require("@kit/core")
local juice = require("@kit/juice")
local E = require("./effects")
local Battle = require("./battle")
local Run = require("./run")

local UI = {}
UI.W, UI.H = 720, 1280
UI.TYPE_COLORS = { attack = "#a5462f", skill = "#2f6aa5", power = "#7b46a8", status = "#5a5a5a", curse = "#3a2a3a" }
UI.RARITY_COLORS = { basic = "#9a9a9a", common = "#c9c2b0", uncommon = "#58b6e8", rare = "#f2c14e", special = "#777777", starter = "#9a9a9a", boss = "#ff7a59", shop = "#7fd38a" }
UI.NODE_LETTERS = { fight = "⚔", elite = "☠", rest = "☾", shop = "$", event = "?", treasure = "◆", boss = "♛" }
UI.NODE_NAMES = { fight = "Fight", elite = "Elite", rest = "Rest", shop = "Shop", event = "Unknown", treasure = "Treasure", boss = "Boss" }
UI.sfx = { card = "card", hit = "hit", hurt = "hurt", block = "block", buy = "buy", win = "win", lose = "lose", select = "select", heal = "heal", power = "power", deny = "deny" }

local opts = {}
local function sound(k) juice.sfx(UI.sfx[k] or k) end
local function theme()
	local t = (type(ui) == "table" and type(ui.theme) == "function") and ui.theme() or {}
	return { primary = t.primary or "#c8743a", accent = t.accent or "#ffd27a", background = t.background or "#1d2433", text = t.text or "#f6efe2",
		font = if t.font and t.font ~= "default" then t.font else nil }
end

-- ---------- building blocks ----------
local function panel(parent, p)
	local props = { anchor = "top_left", size = vec2(100, 100), background = "#00000000", z_index = 100 }
	for k, v in p do props[k] = v end
	return spawn("UIPanel", props, parent)
end
local function text(parent, s, p)
	local t = theme()
	local props = { anchor = "top_left", size = vec2(300, 40), font_size = 26, color = t.text, text = s, z_index = 105, font = t.font }
	for k, v in p do props[k] = v end
	return spawn("UIText", props, parent)
end
local function button(parent, label, onPress, p)
	local t = theme()
	local props = { anchor = "top_left", size = vec2(240, 88), text = label, font_size = 28, color = t.text, background = t.primary, z_index = 106, font = t.font }
	for k, v in p do props[k] = v end
	local b = spawn("UIButton", props, parent)
	if onPress then b.pressed:connect(function() sound("select") onPress(b) end) end
	return b
end
UI.panel, UI.text, UI.button = panel, text, button

local function alive(e) return e ~= nil and isEntity(e) and not e.destroyed end
local function kill(e) if alive(e) then e:destroy() end end

-- card view: UI.card(parent, def, x, y, { w = 150, z, onTap(view), price?, dim? }) -> panel
function UI.card(parent, def, x, y, o)
	o = o or {}
	local w = o.w or 150
	local s = w / 150
	local h = math.floor(210 * s)
	local z = o.z or 300
	local frame = panel(parent, { offset = vec2(x, y), size = vec2(w, h), background = UI.TYPE_COLORS[def.type] or "#444444", z_index = z })
	local inner = panel(frame, { offset = vec2(5 * s, 5 * s), size = vec2(w - 10 * s, h - 10 * s), background = "#f3e9d6", z_index = z + 1, input_transparent = true })
	-- name band
	panel(inner, { offset = vec2(0, 0), size = vec2(w - 10 * s, 34 * s), background = (UI.TYPE_COLORS[def.type] or "#444444") .. "dd", z_index = z + 2, input_transparent = true })
	text(inner, def.name, { offset = vec2(30 * s, 0), size = vec2(w - 44 * s, 34 * s), font_size = math.floor((if #def.name > 11 then 14 elseif #def.name > 9 then 16 else 18) * s), align = "center",
		color = if def.upgraded then "#b8ff9a" else "#fff6e6", z_index = z + 3, font = "bold" })
	-- art
	if def.art then
		panel(inner, { offset = vec2(8 * s, 38 * s), size = vec2(w - 26 * s, 62 * s), image = def.art, background = "#00000000", z_index = z + 2, input_transparent = true })
	else
		panel(inner, { offset = vec2(8 * s, 38 * s), size = vec2(w - 26 * s, 62 * s), background = (UI.TYPE_COLORS[def.type] or "#444") .. "55", z_index = z + 2, input_transparent = true })
	end
	text(inner, string.upper(def.type), { offset = vec2(0, 100 * s), size = vec2(w - 10 * s, 18 * s), font_size = math.floor(12 * s), align = "center", color = "#7a6a55", z_index = z + 3 })
	text(inner, def.text or "", { offset = vec2(6 * s, 118 * s), size = vec2(w - 22 * s, 80 * s), font_size = math.floor(15 * s), align = "center", color = "#2a2018", z_index = z + 3 })
	-- rarity pip
	panel(inner, { offset = vec2((w - 10 * s) / 2 - 6 * s, 196 * s - 10 * s), size = vec2(12 * s, 6 * s), background = UI.RARITY_COLORS[def.rarity] or "#999999", z_index = z + 3, input_transparent = true })
	-- cost orb
	if def.cost ~= -1 then
		local orb = panel(frame, { offset = vec2(-8 * s, -8 * s), size = vec2(40 * s, 40 * s), background = "#ffcf5a", z_index = z + 4, input_transparent = true })
		text(orb, tostring(def.cost), { offset = vec2(0, 0), size = vec2(40 * s, 40 * s), font_size = math.floor(24 * s), align = "center", color = "#3a2410", z_index = z + 5, font = "bold" })
	end
	if o.price then
		local pt = panel(frame, { offset = vec2(w / 2 - 44, h + 4), size = vec2(88, 34), background = "#000000aa", z_index = z + 4, input_transparent = true })
		text(pt, o.price .. "g", { offset = vec2(0, 0), size = vec2(88, 34), font_size = 22, align = "center", color = o.priceColor or "#ffd27a", z_index = z + 5 })
	end
	if o.dim then frame.background = "#333333" inner.background = "#9a9387" end
	if o.onTap then frame.tapped:connect(function() o.onTap(frame) end) end
	return frame
end

local function cardText(def) return def.name .. " — " .. (def.text or "") end

-- ---------- screen root ----------
local screen = { root = nil, world = nil }
local function clear()
	kill(screen.root)
	kill(screen.world)
	screen.root = panel(nil, { offset = vec2(0, 0), size = vec2(UI.W, UI.H), background = "#00000000", z_index = 50, input_transparent = true })
	screen.world = spawn("Node2D", { position = vec2(0, 0) })
	return screen.root, screen.world
end
UI.clear = clear

local function background(world, img, tint)
	local t = theme()
	spawn("Sprite2D", { position = vec2(360, 640), size = vec2(720, 1280), modulate = tint or t.background, z_index = -30 }, world)
	if img then spawn("Sprite2D", { position = vec2(360, 640), size = vec2(720, 1280), texture = img, z_index = -29 }, world) end
end

-- ---------- HUD ----------
function UI.hud(root, run)
	local t = theme()
	local bar = panel(root, { offset = vec2(0, 0), size = vec2(UI.W, 112), background = t.background .. "e6", z_index = 400 })
	local hpCol = if run.hp / run.maxHp < 0.35 then "#ff6b5a" else "#ff9b8a"
	text(bar, "♥ " .. run.hp .. "/" .. run.maxHp, { offset = vec2(20, 8), size = vec2(200, 44), font_size = 30, color = hpCol, z_index = 402, font = "bold" })
	text(bar, "● " .. run.gold, { offset = vec2(220, 8), size = vec2(150, 44), font_size = 30, color = t.accent, z_index = 402, font = "bold" })
	local act = run:act()
	text(bar, "Floor " .. run.floor .. (if act then "  ·  Act " .. run.actIndex else ""), { offset = vec2(370, 8), size = vec2(230, 44), font_size = 24, color = t.text, z_index = 402 })
	-- relics row (left of the pause button area)
	local x = 20
	for i, rid in run.relics do
		if x > 560 then break end
		local r = run.C.relics[rid]
		local slot = panel(bar, { offset = vec2(x, 58), size = vec2(44, 44), background = if r.icon then "#00000000" else "#ffffff22", image = r.icon, z_index = 402 })
		if not r.icon then text(slot, string.sub(r.name, 1, 1), { offset = vec2(0, 0), size = vec2(44, 44), align = "center", font_size = 22, z_index = 403 }) end
		slot.tapped:connect(function() Core.menus.toast(r.name .. ": " .. (r.text or ""), 2.5) end)
		x += 50
	end
	local deckBtn = button(bar, "Deck " .. #run.deck, function() UI.deck(run, { title = "Your deck" }) end,
		{ offset = vec2(470, 58), size = vec2(130, 46), font_size = 20, background = "#ffffff22", z_index = 402 })
	return bar
end

-- ---------- deck viewer / picker ----------
-- UI.deck(run, { title, filter?(card) -> bool, onPick?(deckIndex), preview? ("upgrade"), closeLabel? })
function UI.deck(run, o)
	o = o or {}
	local t = theme()
	local modal = panel(nil, { offset = vec2(0, 0), size = vec2(UI.W, UI.H), background = "#000000d8", z_index = 2000 })
	text(modal, o.title or "Deck", { offset = vec2(0, 120), size = vec2(UI.W, 60), align = "center", font_size = 36, z_index = 2002, font = "bold", color = t.accent })
	local list = panel(modal, { offset = vec2(30, 190), size = vec2(660, 900), background = "#00000000", scroll = true, z_index = 2001 })
	local idx = {}
	for i, c in run.deck do if o.filter == nil or o.filter(c) then table.insert(idx, i) end end
	local cw, gap = 200, 20
	for n, i in idx do
		local c = run.deck[i]
		local col, row = (n - 1) % 3, (n - 1) // 3
		local def = E.card(run.C, c.id, if o.preview == "upgrade" then true else c.up)
		UI.card(list, def, col * (cw + gap) + 10, row * 300 + 14, { w = cw, z = 2010, onTap = if o.onPick then function()
			modal:destroy()
			o.onPick(i)
		end else nil })
	end
	if #idx == 0 then text(list, "Nothing here.", { offset = vec2(0, 40), size = vec2(660, 40), align = "center", z_index = 2011 }) end
	button(modal, o.closeLabel or "Close", function() modal:destroy() if o.onClose then o.onClose() end end,
		{ offset = vec2(240, 1110), size = vec2(240, 88), z_index = 2005, background = "#ffffff33" })
	return modal
end

-- ---------- battle ----------
local function intentLabel(it)
	if not it then return "" end
	if it.damage then return tostring(it.damage) .. (if (it.hits or 1) > 1 then "×" .. it.hits else "") end
	return ""
end
local INTENT_GLYPH = { attack = "⚔", attack_defend = "⚔⛨", attack_debuff = "⚔☣", attack_buff = "⚔▲", defend = "⛨", buff = "▲", debuff = "☣", unknown = "?" }
local INTENT_COLOR = { attack = "#ff6b5a", attack_defend = "#ff9b5a", attack_debuff = "#ff6bd0", attack_buff = "#ff6b5a", defend = "#6bb6ff", buff = "#7dff8a", debuff = "#c58aff", unknown = "#dddddd" }

local function statusLine(u)
	local parts = {}
	local names = {}
	for k in u.statuses do table.insert(names, k) end
	table.sort(names)
	for _, k in names do table.insert(parts, string.upper(string.sub(k, 1, 1)) .. string.sub(k, 2, 4) .. " " .. u.statuses[k]) end
	return table.concat(parts, "  ")
end

-- UI.battle(run, b, { onDone(), background?, heroSprite? })
function UI.battle(run, b, o)
	o = o or {}
	local t = theme()
	local root, world = clear()
	background(world, o.background)
	local st = { selected = nil, busyUntil = 0, sprites = {}, dynamic = nil, drag = nil }
	-- enemy layout
	local alive0 = #b.enemies
	local function enemyX(i)
		local n = #b.enemies
		return 360 + (i - (n + 1) / 2) * math.min(220, 640 / n)
	end
	local ENEMY_Y = 450
	for i, e in b.enemies do
		local size = if e.def.tier == "boss" then 280 elseif e.def.tier == "elite" then 220 else 170
		local sp = spawn("Sprite2D", { position = vec2(enemyX(i), ENEMY_Y - size / 2 + 90), size = vec2(size, size), texture = e.def.sprite,
			modulate = if e.def.sprite then "#ffffff" else "#8a5a5a", z_index = 5 }, world)
		st.sprites[e.id] = sp
		st.tops = st.tops or {}
		st.tops[e.id] = ENEMY_Y - size + 90
		juice.float(sp, { height = 6, seconds = 1.4 + i * 0.2 })
	end
	local hero = spawn("Sprite2D", { position = vec2(110, 720), size = vec2(150, 150), texture = o.heroSprite or run.char.sprite,
		modulate = if (o.heroSprite or run.char.sprite) then "#ffffff" else "#d0a060", z_index = 5 }, world)
	st.sprites.player = hero
	local function posOf(u)
		local sp = st.sprites[u.id]
		if alive(sp) then return sp.position end
		return vec2(360, 600)
	end

	local function act(fn)
		if time() < st.busyUntil or b.state ~= "player" then return end
		fn()
	end

	local refresh
	local function finish()
		if b.state == "won" then
			sound("win")
			if run.node and run.node.type == "boss" then juice.confetti() end
		else sound("lose") end
		after(0.9, function() if o.onDone then o.onDone() end end)
	end

	local function play(i, target)
		local ok, why = b:play(i, target)
		if not ok then
			sound("deny")
			Core.menus.toast(if why == "energy" then "Not enough energy" elseif why == "unplayable" then "Unplayable" else why, 1.2)
		end
		st.selected = nil
		refresh()
		if b.state == "won" or b.state == "lost" then finish() end
	end

	-- event feedback
	local delay = 0
	b:on("enemy_move", function(d)
		delay += 0.4
		local sp = st.sprites[d.enemy.id]
		after(delay - 0.2, function() if alive(sp) then juice.punch(sp, 0.15) end end)
	end)
	b:on("damage", function(d)
		local tgt = d.tgt
		local p = posOf(tgt) + vec2(0, -80)
		local sp = st.sprites[tgt.id]
		local fx = function()
			if d.amount > 0 then
				juice.damage(d.amount, p, {})
				juice.flash(sp, "#ff8080")
				juice.shake(if tgt.side == "player" then "medium" elseif d.amount >= 15 then "medium" else "light")
				sound(if tgt.side == "player" then "hurt" else "hit")
			elseif d.blocked > 0 then
				juice.popup("blocked", p, { color = "#9cd2ff", size = 26 })
			end
		end
		if delay > 0 then after(delay, fx) else fx() end
	end)
	b:on("block", function(d)
		if d.amount <= 0 then return end
		local fx = function() juice.popup("+" .. d.amount .. " ⛨", posOf(d.unit) + vec2(0, -40), { color = "#9cd2ff", size = 28 }) sound("block") end
		if delay > 0 then after(delay, fx) else fx() end
	end)
	b:on("status", function(d)
		if d.amount == 0 or d.unit.dead then return end
		local s = d.status
		local label = (if d.amount > 0 then "+" else "") .. d.amount .. " " .. s
		if d.negated then label = "negated " .. d.negated end
		local fx = function() juice.popup(label, posOf(d.unit) + vec2(0, -130), { color = "#e6c3ff", size = 22 }) end
		if delay > 0 then after(delay, fx) else fx() end
	end)
	b:on("enemy_killed", function(d)
		local sp = st.sprites[d.enemy.id]
		local fx = function() juice.hitstop(0.06) juice.fadeOut(sp, 0.4) juice.dust(posOf(d.enemy), { n = 12 }) end
		if delay > 0 then after(delay, fx) else fx() end
	end)
	b:on("relic", function(d)
		local r = b.C.relics[d.relic]
		juice.popup(r.name, vec2(360, 160), { color = "#ffd27a", size = 26 })
	end)
	b:on("card_played", function(d)
		sound(if d.def.type == "power" then "power" else "card")
		juice.popup(d.def.name, vec2(360, 820), { color = "#ffe9b0", size = 30, rise = 50 })
	end)

	refresh = function()
		kill(st.dynamic)
		local dyn = panel(root, { offset = vec2(0, 0), size = vec2(UI.W, UI.H), background = "#00000000", z_index = 60, input_transparent = true })
		st.dynamic = dyn
		UI.hud(dyn, setmetatable({ hp = b.player.hp, maxHp = b.player.maxHp }, { __index = run }))
		-- enemies: tap zones, hp bars, intents, statuses
		for i, e in b.enemies do
			if not e.dead then
				local x = enemyX(i)
				local w = if e.def.tier == "boss" then 260 else 190
				local zone = panel(dyn, { offset = vec2(x - w / 2, 230), size = vec2(w, 380), background = if st.selected and b:def(b.hand[st.selected]).target == "enemy" then "#ffffff14" else "#00000000", z_index = 70 })
				zone.tapped:connect(function()
					act(function()
						if st.selected then
							local d = b:def(b.hand[st.selected])
							play(st.selected, if d.target == "enemy" then i else nil)
						else
							Core.menus.toast(e.name .. (if e.intent then " — intends " .. (e.intent.name or e.intent.kind) else ""), 1.5)
						end
					end)
				end)
				-- intent
				local it = e.intent
				if it then
					local ip = panel(dyn, { offset = vec2(x - 60, math.max(124, st.tops[e.id] - 58)), size = vec2(120, 50), background = "#00000088", z_index = 75, input_transparent = true })
					local icon = opts.intentIcons and opts.intentIcons[it.kind]
					if icon then panel(ip, { offset = vec2(4, 3), size = vec2(44, 44), image = icon, background = "#00000000", z_index = 76, input_transparent = true }) end
					text(ip, (if icon then "" else (INTENT_GLYPH[it.kind] or "?") .. " ") .. intentLabel(it), { offset = vec2(if icon then 50 else 0, 0), size = vec2(if icon then 70 else 120, 50),
						align = if icon then "left" else "center", font_size = 26, color = INTENT_COLOR[it.kind] or "#fff", z_index = 77, font = "bold" })
				end
				-- hp bar
				local by = 618
				panel(dyn, { offset = vec2(x - 80, by), size = vec2(160, 22), background = "#000000aa", z_index = 75, input_transparent = true })
				panel(dyn, { offset = vec2(x - 78, by + 2), size = vec2(math.max(2, 156 * e.hp / e.maxHp), 18), background = "#d8443a", z_index = 76, input_transparent = true })
				text(dyn, e.hp .. "/" .. e.maxHp .. (if e.block > 0 then "  ⛨" .. e.block else ""), { offset = vec2(x - 100, by - 2), size = vec2(200, 26), align = "center", font_size = 18, z_index = 77, font = "bold", outline = "#000000", outline_size = 3 })
				text(dyn, e.name, { offset = vec2(x - 110, by + 24), size = vec2(220, 26), align = "center", font_size = 18, z_index = 77, color = "#f0e0c8" })
				local sl = statusLine(e)
				if sl ~= "" then text(dyn, sl, { offset = vec2(x - 110, by + 48), size = vec2(220, 24), align = "center", font_size = 16, z_index = 77, color = "#e6c3ff" }) end
			end
		end
		-- player panel
		local p = b.player
		panel(dyn, { offset = vec2(30, 806), size = vec2(160, 20), background = "#000000aa", z_index = 75, input_transparent = true })
		panel(dyn, { offset = vec2(32, 808), size = vec2(math.max(2, 156 * p.hp / p.maxHp), 16), background = "#4fbf6a", z_index = 76, input_transparent = true })
		text(dyn, p.hp .. "/" .. p.maxHp, { offset = vec2(30, 803), size = vec2(160, 26), align = "center", font_size = 18, z_index = 77, font = "bold", outline = "#000000", outline_size = 3 })
		if p.block > 0 then
			local bp = panel(dyn, { offset = vec2(170, 640), size = vec2(64, 64), background = "#3a7bd5", z_index = 77, input_transparent = true })
			text(bp, tostring(p.block), { offset = vec2(0, 0), size = vec2(64, 64), align = "center", font_size = 28, z_index = 78, font = "bold" })
		end
		local psl = statusLine(p)
		if psl ~= "" then text(dyn, psl, { offset = vec2(200, 800), size = vec2(330, 30), font_size = 18, z_index = 77, color = "#e6c3ff" }) end
		-- energy orb + piles
		local orb = panel(dyn, { offset = vec2(24, 846), size = vec2(96, 96), background = "#e8892f", z_index = 80, input_transparent = true })
		text(orb, b.energy .. "/" .. b.maxEnergy, { offset = vec2(0, 0), size = vec2(96, 96), align = "center", font_size = 32, z_index = 81, font = "bold", color = "#2a1405" })
		text(dyn, "Draw " .. #b.drawPile .. "   Discard " .. #b.discard .. (if #b.exhausted > 0 then "   Exhaust " .. #b.exhausted else ""),
			{ offset = vec2(134, 880), size = vec2(380, 30), font_size = 18, z_index = 80, color = "#d8ccb8" })
		local hint = ""
		if st.selected then
			local d = b:def(b.hand[st.selected])
			hint = if d.target == "enemy" then "Tap an enemy" else "Tap the card again to play"
		end
		text(dyn, hint, { offset = vec2(134, 846), size = vec2(380, 32), font_size = 22, z_index = 80, color = t.accent, font = "bold" })
		button(dyn, "End Turn", function()
			act(function()
				st.selected = nil
				delay = 0
				b:endTurn()
				st.busyUntil = time() + delay + 0.2
				local d = delay
				delay = 0
				after(d + 0.05, function()
					refresh()
					if b.state == "won" or b.state == "lost" then finish() end
				end)
				if b.state == "won" or b.state == "lost" then return end
			end)
		end, { offset = vec2(540, 852), size = vec2(160, 80), font_size = 26, background = if b.energy == 0 then t.accent else t.primary,
			color = if b.energy == 0 then "#2a1405" else t.text, z_index = 82 })
		-- hand
		local n = #b.hand
		local cw = 150
		local span = 690 - cw
		local step = if n <= 1 then 0 else math.min(cw + 8, span / (n - 1))
		local x0 = 360 - (step * (n - 1) + cw) / 2
		for i, c in b.hand do
			local d = b:def(c)
			local sel = st.selected == i
			local can = b:canPlay(i)
			local y = if sel then 990 else 1040
			local view = UI.card(dyn, d, x0 + (i - 1) * step, y, { w = cw, z = 300 + i * 10 + (if sel then 200 else 0), dim = not can and d.cost ~= -1 and b.energy < (b:costOf(c)),
				onTap = function()
					act(function()
						if st.selected == i then
							if d.target ~= "enemy" then play(i, nil) else st.selected = nil refresh() end
						else
							st.selected = i
							st.drag = { i = i, start = input.pointer() }
							refresh()
						end
					end)
				end })
			if sel then juice.bounce(view, { amount = 0.06, seconds = 0.2 }) end
		end
	end
	-- best-effort drag: hold a selected card, move up past y 800 and release over an enemy (or anywhere for untargeted cards)
	onTick(function()
		local dr = st.drag
		if not dr then return end
		local p = input.pointer()
		if p then dr.last = p if dr.start and (p - dr.start):length() > 50 then dr.moved = true end return end
		st.drag = nil
		if dr.moved and dr.last and dr.last.y < 800 and st.selected == dr.i and b.state == "player" then
			local d = b:def(b.hand[dr.i])
			local target = nil
			if d.target == "enemy" then
				local best = math.huge
				for j, e in b.enemies do
					if not e.dead then local dx = math.abs(enemyX(j) - dr.last.x) if dx < best then best, target = dx, j end end
				end
			end
			play(dr.i, target)
		end
	end)
	refresh()
	return { refresh = refresh }
end

-- ---------- map ----------
function UI.map(run, o)
	o = o or {}
	local t = theme()
	local root, world = clear()
	background(world, o.background, "#141a26")
	UI.hud(root, run)
	local m = run.map
	local act = run:act()
	text(root, (act and act.name or "Map"), { offset = vec2(0, 116), size = vec2(UI.W, 40), align = "center", font_size = 26, font = "bold", color = t.accent, z_index = 110 })
	local top, bottom = 300, 1180
	local function pos(n)
		if n.type == "boss" then return vec2(360, 210) end
		local y = bottom - (n.row - 1) * (bottom - top) / math.max(1, m.rows - 1)
		local x = 90 + (n.col - 1) * 540 / math.max(1, m.cols - 1)
		-- small deterministic jitter so the grid feels hand-drawn
		x += ((n.row * 37 + n.col * 11) % 17) - 8
		return vec2(x, y)
	end
	local choices = run:choices()
	local visited = {}
	for _, id in run.path do visited[id] = true end
	-- paths
	for _, id in m.order do
		local n = m.nodes[id]
		for _, nx in n.next do
			local a, b2 = pos(n), pos(m.nodes[nx])
			local d = b2 - a
			local len = d:length()
			local walked = visited[id] and visited[nx]
			spawn("Sprite2D", { position = (a + b2) / 2, size = vec2(len - 50, if walked then 6 else 4), rotation = math.deg(math.atan2(d.y, d.x)),
				modulate = if walked then t.accent else "#5d6478", z_index = -5 }, world)
		end
	end
	-- nodes
	for _, id in m.order do
		local n = m.nodes[id]
		local p = pos(n)
		local isChoice = table.find(choices, id) ~= nil
		local size = if n.type == "boss" then 96 else 64
		local icon = opts.nodeIcons and opts.nodeIcons[n.type]
		local bg = if isChoice then t.primary elseif visited[id] then "#6b5a3a" else "#2c3346"
		local btn = button(root, if icon then "" else (UI.NODE_LETTERS[n.type] or "?"), function()
			if isChoice then
				run:go(id)
				if o.onChange then o.onChange() end
			else Core.menus.toast(UI.NODE_NAMES[n.type] or n.type, 1) end
		end, { offset = p - vec2(size / 2, size / 2), size = vec2(size, size), icon = icon, icon_size = math.floor(size * 0.72), background = bg,
			font_size = math.floor(size * 0.45), z_index = 120 })
		if isChoice then juice.pulse(btn, { amount = 0.1, seconds = 0.7 }) end
		if run.pos == id then
			panel(root, { offset = p - vec2(size / 2 + 6, size / 2 + 6), size = vec2(size + 12, size + 12), background = t.accent .. "66", z_index = 115, input_transparent = true })
		end
	end
	-- legend
	local lx = 20
	for _, k in { "fight", "elite", "event", "rest", "shop", "treasure" } do
		local icon = opts.nodeIcons and opts.nodeIcons[k]
		if icon then panel(root, { offset = vec2(lx, 1222), size = vec2(30, 30), image = icon, background = "#00000000", z_index = 110 }) end
		text(root, UI.NODE_NAMES[k], { offset = vec2(lx + 32, 1220), size = vec2(90, 34), font_size = 16, color = "#b8b0a0", z_index = 110 })
		lx += 117
	end
end

-- ---------- rewards ----------
function UI.rewards(run, o)
	o = o or {}
	local t = theme()
	local root, world = clear()
	background(world, o.background, "#141a26")
	UI.hud(root, run)
	local rw = run.rewards
	local title = if rw.kind == "treasure" then "Treasure" elseif rw.kind == "boss" then "The boss falls!" else "Victory"
	text(root, title, { offset = vec2(0, 140), size = vec2(UI.W, 60), align = "center", font_size = 44, font = "bold", color = t.accent, z_index = 110 })
	local y = 230
	local function row(label, icon, onPress, done)
		local b = button(root, (if done then "✓ " else "") .. label, onPress, { offset = vec2(110, y), size = vec2(500, 84), icon = icon, background = if done then "#3a3f4a" else t.primary .. "dd", font_size = 26, z_index = 120 })
		y += 100
		return b
	end
	if (rw.gold or 0) > 0 then
		row(rw.gold .. " Gold", opts.goldIcon, function() if run:takeGold() then juice.coinBurst(vec2(360, 270), { n = 10 }) sound("buy") end UI.rewards(run, o) end, rw.taken.gold)
	end
	if rw.relic then
		local r = run.C.relics[rw.relic]
		row(r.name .. " — " .. (r.text or ""), r.icon, function() if run:takeRelic() then sound("power") end UI.rewards(run, o) end, rw.taken.relic)
	end
	if rw.bossRelics and #rw.bossRelics > 0 then
		text(root, "Choose a boss relic", { offset = vec2(0, y), size = vec2(UI.W, 40), align = "center", font_size = 26, z_index = 110 })
		y += 46
		for i, rid in rw.bossRelics do
			local r = run.C.relics[rid]
			row(r.name .. " — " .. (r.text or ""), r.icon, function() if not rw.taken.relic then run:takeRelic(i) end UI.rewards(run, o) end, rw.taken.relic == rid)
		end
	end
	if rw.cards and #rw.cards > 0 then
		if not rw.taken.card then
			text(root, "Choose a card", { offset = vec2(0, y + 10), size = vec2(UI.W, 40), align = "center", font_size = 28, z_index = 110, font = "bold" })
			local n = #rw.cards
			local cw = 200
			local x0 = 360 - (n * cw + (n - 1) * 20) / 2
			for i, id in rw.cards do
				UI.card(root, E.card(run.C, id, false), x0 + (i - 1) * (cw + 20), y + 64, { w = cw, z = 300, onTap = function()
					run:takeCard(i)
					sound("card")
					UI.rewards(run, o)
				end })
			end
			button(root, "Skip", function() run:skipCards() UI.rewards(run, o) end, { offset = vec2(260, y + 64 + 290), size = vec2(200, 70), background = "#ffffff22", font_size = 24, z_index = 120 })
		else
			local took = rw.taken.card
			row(if took == "skip" then "Card skipped" else ("Added " .. E.card(run.C, took, false).name), nil, function() end, true)
		end
	end
	button(root, "Continue", function()
		run:leave()
		if o.onChange then o.onChange() end
	end, { offset = vec2(220, 1130), size = vec2(280, 90), background = t.accent, color = "#2a1405", font_size = 30, z_index = 130 })
end

-- ---------- shop ----------
function UI.shop(run, o)
	o = o or {}
	local t = theme()
	local root, world = clear()
	background(world, o.background, "#1d1a14")
	UI.hud(root, run)
	local s = run.shop
	text(root, o.shopTitle or "Shop", { offset = vec2(0, 124), size = vec2(UI.W, 50), align = "center", font_size = 38, font = "bold", color = t.accent, z_index = 110 })
	local cw = 190
	for i, it in s.cards do
		local col, rowi = (i - 1) % 3, (i - 1) // 3
		local x = 360 - (3 * cw + 2 * 26) / 2 + col * (cw + 26)
		if rowi == 1 then x += (cw + 26) / 2 end
		local y = 190 + rowi * 320
		if not it.sold then
			UI.card(root, E.card(run.C, it.id, false), x, y, { w = cw, z = 300, price = it.price, priceColor = if run.gold >= it.price then "#ffd27a" else "#ff6b5a",
				onTap = function()
					if run:buyCard(i) then sound("buy") juice.coinBurst(vec2(x + cw / 2, y + 100), { n = 6 }) UI.shop(run, o) else sound("deny") Core.menus.toast("Not enough gold", 1) end
				end })
		else
			text(root, "SOLD", { offset = vec2(x, y + 100), size = vec2(cw, 40), align = "center", font_size = 28, color = "#777", z_index = 110 })
		end
	end
	for i, it in s.relics do
		local r = run.C.relics[it.id]
		local y = 850 + (i - 1) * 132
		button(root, (if it.sold then "SOLD  " else it.price .. "g  ") .. r.name, function()
			if run:buyRelic(i) then sound("buy") UI.shop(run, o) else sound("deny") Core.menus.toast(r.text or "", 2) end
		end, { offset = vec2(30, y), size = vec2(330, 78), icon = r.icon, font_size = 20, background = if it.sold then "#333333" else "#4a3a26", z_index = 120 })
		text(root, r.text or "", { offset = vec2(34, y + 78), size = vec2(330, 46), font_size = 16, color = "#c8bca8", z_index = 120 })
	end
	button(root, if s.removed then "Removal used" else ("Remove a card  " .. s.removePrice .. "g"), function()
		if s.removed or run.gold < s.removePrice then sound("deny") return end
		UI.deck(run, { title = "Remove which card?", onPick = function(i) run:buyRemoval(i) sound("buy") UI.shop(run, o) end })
	end, { offset = vec2(380, 850), size = vec2(310, 78), font_size = 22, background = if s.removed then "#333333" else "#5a2a2a", z_index = 120 })
	button(root, "Leave", function() run:leave() if o.onChange then o.onChange() end end,
		{ offset = vec2(220, 1130), size = vec2(280, 90), background = t.accent, color = "#2a1405", font_size = 30, z_index = 130 })
end

-- ---------- rest ----------
function UI.rest(run, o)
	o = o or {}
	local t = theme()
	local root, world = clear()
	background(world, o.restBackground or o.background, "#1a1410")
	UI.hud(root, run)
	text(root, o.restTitle or "Rest site", { offset = vec2(0, 200), size = vec2(UI.W, 50), align = "center", font_size = 34, font = "bold", color = t.accent, z_index = 110 })
	if o.restArt then spawn("Sprite2D", { position = vec2(360, 470), size = vec2(300, 300), texture = o.restArt, z_index = 2 }, world) end
	local heal = math.floor(run.maxHp * Run.cfg(run.C, "restHeal") + 0.5)
	button(root, "Rest  (+" .. heal .. " HP)", function()
		run:rest("heal")
		sound("heal")
		if o.onChange then o.onChange() end
	end, { offset = vec2(110, 720), size = vec2(500, 100), font_size = 30, z_index = 120 })
	button(root, "Smith  (upgrade a card)", function()
		UI.deck(run, { title = "Upgrade which card?", preview = "upgrade", filter = function(c) return E.canUpgrade(run.C, c.id, c.up) end,
			onPick = function(i) run:rest("upgrade", i) sound("power") if o.onChange then o.onChange() end end })
	end, { offset = vec2(110, 840), size = vec2(500, 100), font_size = 30, background = "#5a4a2a", z_index = 120 })
end

-- ---------- event ----------
function UI.event(run, o)
	o = o or {}
	local t = theme()
	local root, world = clear()
	background(world, o.background, "#141a26")
	UI.hud(root, run)
	local ev = run.event.def
	text(root, ev.name or run.event.id, { offset = vec2(0, 140), size = vec2(UI.W, 50), align = "center", font_size = 38, font = "bold", color = t.accent, z_index = 110 })
	if ev.image then panel(root, { offset = vec2(185, 210), size = vec2(350, 350), image = ev.image, background = "#00000000", z_index = 105 }) end
	text(root, ev.text or "", { offset = vec2(60, 580), size = vec2(600, 140), align = "center", font_size = 24, z_index = 110 })
	local y = 760
	for _, ch in run:eventChoices() do
		button(root, ch.text, function()
			if ch.locked then sound("deny") return end
			local result = ch.result
			run:eventChoose(ch.index)
			if result and run.state ~= "battle" then
				Core.menus.toast(result, 2.5)
			end
			if o.onChange then o.onChange() end
		end, { offset = vec2(60, y), size = vec2(600, 88), font_size = 22, background = if ch.locked then "#333333" else t.primary, z_index = 120 })
		y += 104
	end
end

-- ---------- title / ending ----------
function UI.title(o)
	o = o or {}
	local t = theme()
	local root, world = clear()
	background(world, o.titleBackground or o.background, "#10141e")
	if o.logo then spawn("Sprite2D", { position = vec2(360, 360), size = vec2(420, 420), texture = o.logo, z_index = 2 }, world) end
	text(root, o.title or "Deckbuilder", { offset = vec2(0, 600), size = vec2(UI.W, 90), align = "center", font_size = 64, font = "bold", color = t.accent, z_index = 110, outline = "#000000", outline_size = 4 })
	if o.subtitle then text(root, o.subtitle, { offset = vec2(60, 690), size = vec2(600, 80), align = "center", font_size = 24, z_index = 110 }) end
	local y = 820
	if o.canContinue then
		button(root, "Continue run", o.onContinue, { offset = vec2(160, y), size = vec2(400, 96), font_size = 32, z_index = 120 })
		y += 116
	end
	button(root, "New run", o.onStart, { offset = vec2(160, y), size = vec2(400, 96), font_size = 32, background = if o.canContinue then "#ffffff22" else t.primary, z_index = 120 })
	if o.meta then
		text(root, o.meta, { offset = vec2(0, 1180), size = vec2(UI.W, 40), align = "center", font_size = 20, color = "#a8a090", z_index = 110 })
	end
end

function UI.ending(run, o)
	o = o or {}
	local t = theme()
	local root, world = clear()
	background(world, o.background, "#10141e")
	local won = run.state == "won"
	if won then juice.confetti() end
	text(root, if won then "The lamps burn on." else "Your light goes out.", { offset = vec2(0, 300), size = vec2(UI.W, 80), align = "center", font_size = 46, font = "bold", color = if won then t.accent else "#ff8a7a", z_index = 110 })
	local s = run.stats
	local lines = {
		"Floor reached: " .. run.floor,
		"Fights won: " .. (s.fights + s.elites + s.bosses) .. "  (elites " .. s.elites .. ")",
		"Cards played: " .. s.cardsPlayed,
		"Deck size: " .. #run.deck,
		"Score: " .. run:score(),
	}
	if s.killedBy and run.C.enemies[s.killedBy] then table.insert(lines, 1, "Defeated by " .. run.C.enemies[s.killedBy].name) end
	text(root, table.concat(lines, "\n"), { offset = vec2(100, 420), size = vec2(520, 300), align = "center", font_size = 28, z_index = 110 })
	button(root, "Again", o.onAgain, { offset = vec2(180, 900), size = vec2(360, 96), font_size = 32, z_index = 120 })
end

-- ---------- the whole loop ----------
-- play({ character?, title?, subtitle?, logo?, background?, battleBackground?, heroSprite?, nodeIcons?, intentIcons?, goldIcon?,
--        music? = { title, map, battle, boss }, restArt?, shopTitle?, autosave? (true) })
function UI.play(o)
	opts = o or {}
	local DB = UI.DB
	local function music_(id) if id and type(music) == "table" then pcall(music.play, id) end end
	local show
	local function save_() if opts.autosave ~= false then pcall(Core.save.save) end end
	show = function()
		local run = DB.current
		if run == nil then return UI.title(opts) end
		local st = run.state
		if st ~= "battle" then save_() end
		if st == "map" then music_(opts.music and opts.music.map) UI.map(run, { background = opts.background, onChange = show })
		elseif st == "battle" then
			local boss = run.node and run.node.type == "boss"
			music_(opts.music and (if boss then opts.music.boss or opts.music.battle else opts.music.battle))
			UI.battle(run, run.battle, { background = opts.battleBackground or opts.background, heroSprite = opts.heroSprite, onDone = function()
				run:afterBattle()
				show()
			end })
		elseif st == "reward" then UI.rewards(run, { background = opts.background, onChange = show })
		elseif st == "shop" then UI.shop(run, { background = opts.shopBackground or opts.background, shopTitle = opts.shopTitle, onChange = show })
		elseif st == "rest" then UI.rest(run, { background = opts.background, restArt = opts.restArt, restTitle = opts.restTitle, onChange = show })
		elseif st == "event" then UI.event(run, { background = opts.background, onChange = show })
		else
			pcall(Core.save.delete)
			UI.ending(run, { background = opts.background, onAgain = function() DB.current = nil show() end })
		end
	end
	local function title()
		music_(opts.music and opts.music.title)
		local m = DB.meta.get()
		UI.title({ title = opts.title, subtitle = opts.subtitle, logo = opts.logo, titleBackground = opts.titleBackground, background = opts.background,
			canContinue = Core.save.exists(),
			meta = "Runs " .. m.runs .. "  ·  Wins " .. m.wins .. "  ·  Meta level " .. DB.meta.level(),
			onContinue = function() Core.save.load() show() end,
			onStart = function() DB.newRun({ character = opts.character, locked = opts.locked }) show() end })
	end
	UI.show = show
	if opts.noStart then return end
	if DB.current then show() else title() end
end

return UI
