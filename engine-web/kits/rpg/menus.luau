-- rpg kit: overworld menus (portrait-first, touch): main menu, team + summary, bag, quest log,
-- shop, storage box, save. Built from UIPanel/UIText/UIButton with the data/rpg.json "ui" colors.
local U = require("./util")
local Content = require("./content")
local State = require("./state")
local Creatures = require("./creatures")
local Inventory = require("./inventory")
local Quests = require("./quests")
local Logic = require("./logic")
local Core = require("./battle_core")
local W = require("./widgets")
local R = require("./runtime")

local M = {}
M.root = nil
M.onClose = nil
M.page = 1

local PAGE = 7 -- rows per page

local function txt(key: string, default: string): string
	local t = Content.config.text
	return (t and t[key]) or default
end

function M.isOpen(): boolean
	return M.root ~= nil
end

function M.close()
	if M.root then W.destroy(M.root) end
	M.root = nil
	local cb = M.onClose
	M.onClose = nil
	if cb then cb() end
end

-- a fresh full-screen sheet: { root, body, y } with a title and a close/back button
local function sheet(title: string, back: (() -> ())?)
	local t = W.theme()
	local scr = W.screen()
	if M.root then W.destroy(M.root) end
	local root = W.panel(nil, { anchor = "top_left", offset = vec2(0, 0), size = scr, bg = W.alpha(t.background, 0.8), z = 200 })
	M.root = root
	local body = W.panel(root, { anchor = "top", offset = vec2(0, 100), size = vec2(scr.x - 40, scr.y - 160), bg = t.surface, z = 1 })
	W.text(body, { text = title, anchor = "top_left", offset = vec2(28, 22), size = vec2(scr.x - 300, 50), font_size = 34, color = t.accent })
	W.button(body, {
		text = if back then txt("back", "BACK") else txt("close", "CLOSE"),
		anchor = "top_right", offset = vec2(-20, 16), size = vec2(170, 70), font_size = 24,
		bg = W.alpha(t.muted, 0.85), color = t.background,
		onPress = function()
			if back then back() else M.close() end
		end,
	})
	M.sheet = { root = root, body = body, w = scr.x - 40, h = scr.y - 160 }
	return M.sheet
end

-- footer message line inside a sheet
local function footer(s, text: string)
	local t = W.theme()
	if s.footer then
		s.footer.text = text
		return
	end
	s.footer = W.text(s.body, { text = text, anchor = "bottom_left", offset = vec2(28, -20), size = vec2(s.w - 56, 60), font_size = 22, color = t.text })
end

-- a list of tappable rows with paging. rows = { { label, sub, right, icon, hp, enabled, onTap } }
local function rows(s, list, top: number, rowH: number?, page: number?, onPage: ((number) -> ())?)
	local t = W.theme()
	rowH = rowH or 112
	local per = math.max(1, math.floor((s.h - top - 110) / (rowH + 10)))
	page = page or 1
	local pages = math.max(1, math.ceil(#list / per))
	page = math.clamp(page, 1, pages)
	for k = 1, per do
		local r = list[(page - 1) * per + k]
		if not r then break end
		local p = W.row(s.body, {
			anchor = "top_left", offset = vec2(20, top + (k - 1) * (rowH + 10)), size = vec2(s.w - 40, rowH),
			bg = if r.selected then t.primary elseif r.enabled == false then W.alpha(t.surface2, 0.5) else t.surface2, z = 2,
			onTap = function() if r.onTap then r.onTap() end end,
		})
		local x = 18
		if r.icon then
			W.image(p, { image = r.icon, anchor = "left", offset = vec2(10, 0), size = vec2(rowH - 20, rowH - 20) })
			x = rowH + 4
		end
		W.text(p, { text = r.label, anchor = "top_left", offset = vec2(x, 10), size = vec2(s.w - x - 230, 42), font_size = 26, color = if r.enabled == false then t.muted else t.text })
		if r.sub then W.text(p, { text = r.sub, anchor = "bottom_left", offset = vec2(x, -10), size = vec2(s.w - x - 60, 36), font_size = 19, color = t.muted }) end
		if r.right then W.text(p, { text = r.right, anchor = "top_right", offset = vec2(-18, 12), size = vec2(200, 40), font_size = 24, align = "right", color = t.accent }) end
		if r.hp then
			local bar = W.bar(p, { anchor = "top_right", offset = vec2(-18, if r.right then 58 else 22), size = vec2(180, 16), value = r.hp })
			bar.color(W.hpColor(r.hp))
		end
	end
	if pages > 1 and onPage then
		local y = top + per * (rowH + 10)
		W.button(s.body, { text = "◀", anchor = "top_left", offset = vec2(20, y), size = vec2(120, 64), bg = t.surface2, onPress = function() onPage(if page > 1 then page - 1 else pages) end })
		W.text(s.body, { text = page .. " / " .. pages, anchor = "top", offset = vec2(0, y + 10), size = vec2(200, 44), align = "center", font_size = 24 })
		W.button(s.body, { text = "▶", anchor = "top_right", offset = vec2(-20, y), size = vec2(120, 64), bg = t.surface2, onPress = function() onPage(if page < pages then page + 1 else 1) end })
	end
end

local function fmtTime(sec: number): string
	sec = math.floor(sec)
	return string.format("%d:%02d", math.floor(sec / 3600), math.floor(sec / 60) % 60)
end

-- ---------------------------------------------------------------- main menu

function M.open(onClose: (() -> ())?)
	if onClose then M.onClose = onClose end
	local t = W.theme()
	local s = sheet(txt("menu_title", "MENU"))
	local d = State.get()
	W.text(s.body, { text = d.player.name, anchor = "top_left", offset = vec2(28, 100), size = vec2(s.w - 56, 44), font_size = 28 })
	W.text(s.body, { text = "$" .. d.money .. "    " .. txt("time", "Time") .. " " .. fmtTime(d.playtime or 0) .. "    " .. txt("caught_label", "Caught") .. " " .. U.count(d.caught), anchor = "top_left", offset = vec2(28, 146), size = vec2(s.w - 56, 40), font_size = 22, color = t.muted })
	local entries = {
		{ txt("team", "TEAM"), t.good, function() M.team() end },
		{ txt("bag", "BAG"), t.accent, function() M.bag() end },
		{ txt("quests", "QUESTS"), t.primary, function() M.quests() end },
		{ txt("save", "SAVE"), t.surface2, function()
			local ok = R.save and R.save()
			M.open()
			if M.root then footer(M.sheet, if ok then txt("saved", "Game saved.") else "Could not save.") end
		end },
	}
	for _, e in Content.config.menu_extra or {} do
		table.insert(entries, { e.label, t.surface2, function() M.close() Logic.run(e.effects) end })
	end
	for i, e in entries do
		W.button(s.body, {
			text = e[1], anchor = "top", offset = vec2(0, 210 + (i - 1) * 124), size = vec2(s.w - 80, 106), font_size = 34,
			bg = e[2], color = if e[2] == t.accent then t.background else t.text, onPress = e[3],
		})
	end
end

-- ---------------------------------------------------------------- team & summary

local swapFrom = nil

function M.team(useItem: string?, page: number?)
	local s = sheet(if useItem then ("Use " .. Content.item(useItem).name .. " on?") else txt("team", "TEAM"), function()
		swapFrom = nil
		if useItem then M.bag() else M.open() end
	end)
	local list = {}
	for i, mon in State.party() do
		local sp = Creatures.species(mon)
		table.insert(list, {
			label = Creatures.name(mon),
			right = "Lv" .. mon.level,
			sub = table.concat((function()
				local ts = {}
				for _, ty in sp.types do table.insert(ts, string.upper(Content.typeName(ty))) end
				return ts
			end)(), " / ") .. "   HP " .. mon.hp .. "/" .. mon.maxhp .. (if mon.status then "   " .. (Core.STATUS_LABEL[mon.status] or mon.status) else "") .. (if mon.held then "   @" .. (Content.items[mon.held] or {}).name else ""),
			icon = Creatures.sprite(mon, "icon"),
			hp = mon.hp / math.max(1, mon.maxhp),
			selected = swapFrom == i,
			enabled = if useItem then Inventory.canUseOn(useItem, mon) else true,
			onTap = function()
				if useItem then
					local ok, msg = Inventory.useOn(useItem, mon)
					M.team(if State.count(useItem) > 0 then useItem else nil)
					footer(M.sheet, msg or "")
					return
				end
				if swapFrom then
					if swapFrom ~= i then State.swap(swapFrom, i) end
					swapFrom = nil
					return M.team()
				end
				M.summary(i)
			end,
		})
	end
	rows(s, list, 100, 112, page, function(p) M.team(useItem, p) end)
	if not useItem then
		footer(s, if swapFrom then "Tap where it should go." else "Tap a creature for details.")
	end
end

function M.summary(i: number)
	local t = W.theme()
	local mon = State.party()[i]
	if not mon then return M.team() end
	local sp = Creatures.species(mon)
	local s = sheet(Creatures.name(mon), function() M.team() end)
	W.image(s.body, { image = Creatures.sprite(mon, "front"), anchor = "top_left", offset = vec2(28, 96), size = vec2(220, 220) })
	local types = {}
	for _, ty in sp.types do table.insert(types, string.upper(Content.typeName(ty))) end
	local x = 270
	W.text(s.body, { text = sp.name .. "   Lv" .. mon.level, anchor = "top_left", offset = vec2(x, 100), size = vec2(s.w - x - 20, 40), font_size = 28 })
	W.text(s.body, { text = table.concat(types, " / "), anchor = "top_left", offset = vec2(x, 144), size = vec2(s.w - x - 20, 34), font_size = 22, color = t.accent })
	W.text(s.body, { text = "HP " .. mon.hp .. " / " .. mon.maxhp .. (if mon.status then "   " .. string.upper(mon.status) else ""), anchor = "top_left", offset = vec2(x, 184), size = vec2(s.w - x - 20, 34), font_size = 22 })
	local nextXp = Creatures.xpForLevel(sp.xp_curve, mon.level + 1) - mon.xp
	W.text(s.body, { text = "XP to next: " .. math.max(0, nextXp), anchor = "top_left", offset = vec2(x, 222), size = vec2(s.w - x - 20, 34), font_size = 20, color = t.muted })
	local xb = W.bar(s.body, { anchor = "top_left", offset = vec2(x, 262), size = vec2(s.w - x - 40, 14), inset = 2, color = t.primary })
	xb.set(Creatures.xpProgress(mon))
	-- stats
	local y = 330
	for k, st in Content.STATS do
		if st ~= "hp" then
			local col, row = (k - 2) % 2, math.floor((k - 2) / 2)
			W.text(s.body, { text = (Content.STAT_NAMES[st] or st) .. "  " .. mon.stats[st], anchor = "top_left", offset = vec2(28 + col * (s.w / 2 - 14), y + row * 40), size = vec2(s.w / 2 - 40, 38), font_size = 22 })
		end
	end
	y += 130
	if sp.description then
		W.text(s.body, { text = sp.description, anchor = "top_left", offset = vec2(28, y), size = vec2(s.w - 56, 80), font_size = 19, color = t.muted })
		y += 90
	end
	for k, mv in mon.moves do
		local def = Content.moves[mv.id] or Core.STRUGGLE
		local p = W.panel(s.body, { anchor = "top_left", offset = vec2(20, y + (k - 1) * 84), size = vec2(s.w - 40, 74), bg = Content.typeColor(def.type), z = 2 })
		W.text(p, { text = def.name, anchor = "left", offset = vec2(16, 0), size = vec2(s.w / 2, 40), font_size = 24, outline = "#00000088", outline_size = 2 })
		W.text(p, { text = string.upper(Content.typeName(def.type)) .. "  " .. (if def.power > 0 then "PWR " .. def.power else "STATUS") .. "  PP " .. mv.pp .. "/" .. def.pp, anchor = "right", offset = vec2(-16, 0), size = vec2(s.w / 2, 40), font_size = 18, align = "right", outline = "#00000088", outline_size = 2 })
	end
	local by = y + 4 * 84 + 8
	if i > 1 then
		W.button(s.body, { text = "MAKE LEAD", anchor = "top_left", offset = vec2(20, by), size = vec2(s.w / 2 - 30, 70), font_size = 22, bg = t.primary, onPress = function()
			State.swap(1, i)
			M.summary(1)
		end })
	end
	W.button(s.body, { text = "MOVE", anchor = "top_right", offset = vec2(-20, by), size = vec2(s.w / 2 - 30, 70), font_size = 22, bg = t.surface2, onPress = function()
		swapFrom = i
		M.team()
	end })
end

-- ---------------------------------------------------------------- bag

local BAG_TABS = { { "items", "ITEMS" }, { "capture", "ORBS" }, { "key", "KEY" } }
local function tabOf(def): string
	if def.kind == "capture" then return "capture" end
	if def.kind == "key" then return "key" end
	return "items"
end

function M.bag(tab: string?, page: number?)
	tab = tab or M.bagTab or "items"
	M.bagTab = tab
	local t = W.theme()
	local s = sheet(txt("bag", "BAG"), function() M.open() end)
	local tw = (s.w - 40 - 20) / 3
	for k, tb in BAG_TABS do
		W.button(s.body, {
			text = (Content.config.text and Content.config.text["tab_" .. tb[1]]) or tb[2], anchor = "top_left", offset = vec2(20 + (k - 1) * (tw + 10), 96), size = vec2(tw, 64), font_size = 22,
			bg = if tab == tb[1] then t.primary else t.surface2, onPress = function() M.bag(tb[1]) end,
		})
	end
	local list = {}
	for _, e in State.bagList(function(def) return tabOf(def) == tab end) do
		local def = e.def
		table.insert(list, {
			label = def.name, right = "×" .. e.count, sub = def.description, icon = def.icon,
			onTap = function()
				if Inventory.targets(e.id) then return M.team(e.id) end
				if def.use then
					M.close()
					Inventory.useKey(e.id)
					return
				end
				footer(s, def.description ~= "" and def.description or "Can't use that here.")
			end,
		})
	end
	if #list == 0 then table.insert(list, { label = "Empty", enabled = false }) end
	rows(s, list, 180, 104, page, function(p) M.bag(tab, p) end)
	footer(s, "$" .. State.money())
end

-- ---------------------------------------------------------------- quest log

function M.quests(page: number?)
	local t = W.theme()
	local s = sheet(txt("quests", "QUESTS"), function() M.open() end)
	local log = Quests.log()
	local list = {}
	for _, q in log do
		local cur = q.steps[#q.steps]
		local sub
		if q.state == "done" then sub = "Complete"
		elseif cur then
			sub = cur.text
			for _, o in cur.objectives do
				if o.need > 1 then sub ..= "  (" .. o.have .. "/" .. o.need .. ")" end
			end
		end
		table.insert(list, {
			label = q.name, sub = sub, right = if q.state == "done" then "✓" else nil, enabled = q.state ~= "done",
			onTap = function() M.quest(q.id) end,
		})
	end
	if #list == 0 then table.insert(list, { label = "No quests yet.", enabled = false }) end
	rows(s, list, 100, 112, page, function(p) M.quests(p) end)
end

function M.quest(id: string)
	local t = W.theme()
	local q
	for _, x in Quests.log() do if x.id == id then q = x end end
	if not q then return M.quests() end
	local s = sheet(q.name, function() M.quests() end)
	W.text(s.body, { text = Logic.text(q.description), anchor = "top_left", offset = vec2(28, 100), size = vec2(s.w - 56, 120), font_size = 22, color = t.muted })
	local y = 240
	for _, st in q.steps do
		W.text(s.body, { text = (if st.done then "✓ " else "▶ ") .. st.text, anchor = "top_left", offset = vec2(28, y), size = vec2(s.w - 56, 44), font_size = 24, color = if st.done then t.muted else t.text })
		y += 48
		if not st.done then
			for _, o in st.objectives do
				if o.text then
					W.text(s.body, { text = "   " .. Logic.text(o.text) .. (if o.need > 1 then "  " .. o.have .. "/" .. o.need else ""), anchor = "top_left", offset = vec2(28, y), size = vec2(s.w - 56, 40), font_size = 20, color = if o.have >= o.need then t.good else t.accent })
					y += 42
				end
			end
		end
	end
end

-- ---------------------------------------------------------------- shop

function M.shop(shopId: string, mode: string?, page: number?, onClose: (() -> ())?)
	if onClose then M.onClose = onClose end
	mode = mode or "buy"
	local t = W.theme()
	local def = Content.shops[shopId] or {}
	local s = sheet(def.name or "SHOP")
	local tw = (s.w - 50) / 2
	W.button(s.body, { text = "BUY", anchor = "top_left", offset = vec2(20, 96), size = vec2(tw, 64), font_size = 24, bg = if mode == "buy" then t.primary else t.surface2, onPress = function() M.shop(shopId, "buy") end })
	if def.sell ~= false then
		W.button(s.body, { text = "SELL", anchor = "top_right", offset = vec2(-20, 96), size = vec2(tw, 64), font_size = 24, bg = if mode == "sell" then t.primary else t.surface2, onPress = function() M.shop(shopId, "sell") end })
	end
	local list = {}
	local function report(msg)
		M.shop(shopId, mode, page)
		footer(M.sheet, msg .. "   ($" .. State.money() .. ")")
	end
	if mode == "buy" then
		for _, e in Inventory.shopItems(shopId) do
			table.insert(list, {
				label = e.def.name, right = "$" .. e.price, sub = e.def.description .. (if State.count(e.id) > 0 then "  (have " .. State.count(e.id) .. ")" else ""), icon = e.def.icon,
				enabled = State.money() >= e.price,
				onTap = function()
					local max = math.max(1, math.min(10, math.floor(State.money() / math.max(1, e.price))))
					local opts = { "×1  $" .. e.price }
					local qtys = { 1 }
					if max >= 5 then table.insert(opts, "×5  $" .. e.price * 5) table.insert(qtys, 5) end
					if max >= 10 then table.insert(opts, "×10  $" .. e.price * 10) table.insert(qtys, 10) end
					table.insert(opts, "Cancel")
					ui.choice("Buy " .. e.def.name .. "?", opts, function(k: number)
						if qtys[k] then
							local _, msg = Inventory.buy(shopId, e.id, qtys[k])
							U.sfx(Content.config.sfx and Content.config.sfx.buy)
							report(msg)
						end
					end)
				end,
			})
		end
	else
		for _, e in State.bagList() do
			local p = Inventory.sellPrice(shopId, e.id)
			table.insert(list, {
				label = e.def.name, right = if p > 0 then "$" .. p else "—", sub = "×" .. e.count, icon = e.def.icon, enabled = p > 0,
				onTap = function()
					if p <= 0 then return end
					local _, msg = Inventory.sell(shopId, e.id, 1)
					report(msg)
				end,
			})
		end
	end
	if #list == 0 then table.insert(list, { label = "Nothing here.", enabled = false }) end
	rows(s, list, 180, 104, page, function(pg) M.shop(shopId, mode, pg) end)
	footer(s, "$" .. State.money())
end

-- ---------------------------------------------------------------- storage

function M.storage(page: number?, onClose: (() -> ())?)
	if onClose then M.onClose = onClose end
	local s = sheet(txt("storage", "STORAGE"))
	local list = {}
	for i, mon in State.party() do
		table.insert(list, {
			label = Creatures.name(mon) .. "  (team)", right = "Lv" .. mon.level, icon = Creatures.sprite(mon, "icon"),
			sub = "Tap to store", enabled = #State.party() > 1,
			onTap = function()
				local ok = State.deposit(i)
				M.storage(page)
				if not ok then footer(M.sheet, "You need at least one healthy creature with you.") end
			end,
		})
	end
	for i, mon in State.box() do
		table.insert(list, {
			label = Creatures.name(mon), right = "Lv" .. mon.level, icon = Creatures.sprite(mon, "icon"),
			sub = "Tap to take", enabled = #State.party() < State.PARTY_MAX,
			onTap = function()
				State.withdraw(i)
				M.storage(page)
			end,
		})
	end
	rows(s, list, 100, 104, page, function(p) M.storage(p) end)
	footer(s, "Team " .. #State.party() .. "/" .. State.PARTY_MAX .. "   Stored " .. #State.box())
end

return M
