--!nonstrict
-- farming view: binds a farm to a scene — TileMap2D soil + crop sprites, a joystick-driven farmer with tap-to-act
-- (walks over, then does the smart action), villagers walking their schedules, animals in pens, interactable props
-- (tags farm_bed / farm_bin / farm_shop / farm_craft / farm_coop / farm_barn / farm_museum / farm_festival),
-- a portrait HUD (date, clock, weather, gold, energy), a hotbar, a Menu button and the end-of-day summary.
local core = require("@kit/core")
local juice = require("@kit/juice")
local ai = require("@kit/ai")
local FarmM = require("./farm")

local M = {}
local key, unkey = FarmM.key, FarmM.unkey

local WEATHER = { sunny = "Sunny", rain = "Rain", storm = "Storm", snow = "Snow", windy = "Windy" }
local TASTE = { love = "loves this!", like = "likes this.", neutral = "thanks you.", dislike = "doesn't like this...", hate = "hates this!" }

local function dist(a, b) return math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2) end

-- bind(farm, opts) -> view { refresh(), select(item), selected(), openMenu(), sleep(), interact(entity), hud, stop() }
-- opts: { map = TileMap2D (required), player = Body2D (required), soilTag = "soil", tiles = { tilled = "t", watered = "w" },
--         solid? = "chars" (A* walking for tap-to-move; else straight line), speed = 240, reach = 1.6 (tiles),
--         wake = Vec2 (where the farmer wakes up; default player start), pens = { coop = {x, y, w, h}, barn = ... },
--         theme? = { panel, text, accent, good, bad }, hud = true, hotbar = true, menuButton = true,
--         anims? (player has "walk"/"idle" anims), onInteract? = fn(entity, tag) -> handled, onDay? = fn(report) }
function M.bind(farm, opts)
	opts = opts or {}
	local map, player = opts.map, opts.player
	assert(map and player, "farming.bind: opts.map (TileMap2D) and opts.player (Body2D) are required")
	local cfg = farm.cfg
	local T = opts.theme or {}
	local th = core.menus.theme()
	local PANEL, TEXT, ACCENT = T.panel or "#2b2135dd", T.text or th.text, T.accent or th.accent
	local tile = map.tile_size or 16
	local soilTag = opts.soilTag or "soil"
	local tiles = opts.tiles or { tilled = "t", watered = "w" }
	local speed = opts.speed or 240
	local reach = (opts.reach or 1.6) * tile
	local wake = opts.wake or player.position
	local view = { selectedItem = nil, alive = true }
	local art = cfg.art or {}

	-- original chars so un-tilled cells restore
	local orig = {}
	local function origChar(c, r)
		local k = key(c, r)
		if orig[k] == nil then orig[k] = map:getTile(c, r) or false end
		return orig[k] or nil
	end
	farm.isSoil = function(c, r)
		if c < 0 or r < 0 or c >= map.cols or r >= map.rows then return false end
		local ch = origChar(c, r)
		if not ch then return false end
		local d = map:tileDef(ch)
		return d ~= nil and d.tags ~= nil and table.find(d.tags, soilTag) ~= nil
	end

	local grid = if opts.solid then ai.grid(map, { solid = opts.solid, tileSize = tile, origin = { x = map.position.x, y = map.position.y } }) else nil

	-- ---------- field drawing ----------
	local cropSprites, objSprites = {}, {}
	local function cropTexture(p)
		local d = farm:cropDef(p.crop)
		local st = farm:stage(p)
		if p.dead then return art.dead, "#8a7a66" end
		if d.sprites then return d.sprites[math.min(st, #d.sprites)], nil end
		if st > #d.stages then return d.icon or art.ready, d.color end
		if st <= 1 then return art.sprout, "#7bc96f" end
		return art.growing, "#4fa35a"
	end
	local function syncCell(c, r)
		if map.destroyed then return end
		local k = key(c, r)
		local p = farm.plots[k]
		local want = origChar(c, r)
		if p then want = if p.watered then tiles.watered else tiles.tilled end
		if map:getTile(c, r) ~= want then map:setTile(c, r, want) end
		local spr = cropSprites[k]
		if p and p.crop then
			local tex, col = cropTexture(p)
			local ready = farm:isReady(p)
			local size = if ready then tile * 0.95 else tile * (0.45 + 0.2 * farm:stage(p))
			size = math.min(size, tile * 0.95)
			if not spr or spr.destroyed then
				spr = spawn("Sprite2D", { position = map:cellToWorld(c, r) + vec2(0, -tile * 0.08), size = vec2(size, size), z_index = 2 })
				cropSprites[k] = spr
			end
			if tex then spr.texture = tex spr.modulate = if p.dead then color("#a09080") else color("#ffffff") else spr.modulate = color(col or "#5aa05a") end
			spr.size = vec2(size, size)
		elseif spr then
			if not spr.destroyed then spr:destroy() end
			cropSprites[k] = nil
		end
		local o = farm.objects[k]
		local os = objSprites[k]
		if o then
			if not os or os.destroyed then
				local def = core.content.get("items", o.item)
				os = spawn("Sprite2D", { position = map:cellToWorld(c, r), size = vec2(tile * 0.9, tile * 0.9), texture = def and def.icon or nil, modulate = if def and def.icon then color("#ffffff") else color("#8899aa"), z_index = 2 })
				objSprites[k] = os
			end
		elseif os then
			if not os.destroyed then os:destroy() end
			objSprites[k] = nil
		end
	end
	local function syncAll()
		local seen = {}
		for k in farm.plots do seen[k] = true end
		for k in farm.objects do seen[k] = true end
		for k in cropSprites do seen[k] = true end
		for k in objSprites do seen[k] = true end
		for k in orig do seen[k] = true end
		for k in seen do local c, r = unkey(k) syncCell(c, r) end
	end
	view.refresh = syncAll

	-- ---------- feedback ----------
	local function say(text, at, col) juice.popup(text, at or (player.position + vec2(0, -tile)), { color = col or "#ffffff", size = 30 }) end
	local REASONS = { tired = "Too tired...", not_soil = "Can't dig here", bag_full = "Bag is full!", out_of_season = "Wrong season for that",
		no_seeds = "No seeds", gold = "Not enough gold", full = "No room", already = "Already done today", closed_today = "Closed today", hours = "Closed right now" }
	local function why(reason) if reason and REASONS[reason] then core.menus.toast(REASONS[reason], 1.4) end end

	-- ---------- tap-to-act ----------
	local walkTarget = nil -- { pos, done = fn(), t }
	local function walkTo(pos, done)
		if dist(player.position, pos) <= reach then done() return end
		local pts = nil
		if grid then
			pts = grid:findWorld(player.position.x, player.position.y, pos.x, pos.y, { nearest = true })
		end
		walkTarget = { pos = pos, done = done, t = 0, pts = pts, i = 1 }
	end
	local function doCell(c, r)
		local at = map:cellToWorld(c, r)
		local p = farm:plot(c, r)
		local ok, action, a, b = farm:smart(c, r, view.selectedItem)
		if not ok then
			if action == "none" then
				if p and p.crop then
					local d = farm:cropDef(p.crop)
					local left = d.growDays - p.days
					say(d.name .. ": " .. left .. (if left == 1 then " day" else " days"), at, "#e8f5d0")
				end
			else why(a) end
			return
		end
		if action == "till" then juice.dust(at, { color = "#7a5a3a" }) juice.sfx("till")
		elseif action == "water" then juice.sparkle(at, { color = "#7fc8ff", n = 8 }) juice.sfx("water")
		elseif action == "plant" then juice.sfx("plant")
		elseif action == "harvest" then
			local spr = cropSprites[key(c, r)]
			if a and a > 0 then
				local crop = (p and p.crop) or ""
				local qn = cfg.quality.names[b or 1]
				say("+" .. a .. " " .. (if qn ~= "" then qn .. " " else "") .. (core.content.get("items", crop) or { name = crop }).name, at, if (b or 1) > 1 then "#ffd34d" else "#ffffff")
				juice.sparkle(at, { color = "#ffe066", n = 10 })
				juice.sfx("harvest")
			end
			if spr then juice.squash(spr) end
		elseif action == "fertilize" then juice.sparkle(at, { color = "#b38bff", n = 8 }) juice.sfx("plant")
		elseif action == "place" or action == "pick_up" then juice.sfx("place") end
		syncCell(c, r)
		if action == "water" then
			for dc = -1, 1 do for dr = -1, 1 do syncCell(c + dc, r + dr) end end
		end
		view.refreshHotbar()
	end
	map.tileTapped:connect(function(c, r)
		if core.menus.isOpen() or core.pause.isPaused() then return end
		walkTo(map:cellToWorld(c, r), function() doCell(c, r) end)
	end)

	-- ---------- menus ----------
	local function itemName(id) local d = core.content.get("items", id) return (d and d.name) or id end
	local function shipMenu()
		local items = {}
		for _, row in core.bag:list() do
			local pr = farm:price(row.id)
			local cat = row.def and row.def.category
			if pr > 0 and cat ~= "seeds" and cat ~= "tool" then
				table.insert(items, { label = itemName(row.id) .. " x" .. row.count, detail = (pr * row.count) .. "g", onSelect = function(_, h)
					farm:ship(row.id, row.count)
					juice.sfx("ship")
					view.refreshHotbar()
					h.close()
					core.menus.toast("Shipped! Paid tonight: " .. farm:binValue() .. "g", 1.6)
				end })
			end
		end
		if #items == 0 then core.menus.toast("Nothing to ship. Bin: " .. farm:binValue() .. "g", 1.6) return end
		core.menus.list({ title = "Shipping bin (" .. farm:binValue() .. "g)", items = items, keepOpen = true })
	end
	local function shopMenu(shopId)
		local ok, reason = farm:shopOpen(shopId)
		if not ok then why(reason) return end
		local s = farm.C.shops[shopId]
		local items = {}
		for _, row in farm:stock(shopId) do
			table.insert(items, { label = row.name, detail = row.price .. "g", disabled = not row.available, onSelect = function(_, h)
				local bought, w = farm:buy(shopId, row.item or row.animal or row.upgrade, 1)
				if bought then
					juice.sfx("buy")
					core.menus.toast("Bought " .. row.name, 1.2)
					view.refreshHotbar()
					view.refreshAnimals()
				else why(w) end
			end })
		end
		core.menus.list({ title = s.name .. "  (" .. core.wallet.get(cfg.currency) .. "g)", items = items, keepOpen = true })
	end
	local function craftMenu()
		local items = {}
		for _, r in farm:recipes() do
			local parts = {}
			for it, n in r.def.inputs do table.insert(parts, n .. " " .. itemName(it)) end
			table.sort(parts)
			table.insert(items, { label = itemName(r.def.output), detail = table.concat(parts, ", "), disabled = not r.ok, fontSize = 24, onSelect = function()
				local ok, w = farm:craft(r.id)
				if ok then juice.sfx("craft") core.menus.toast("Crafted " .. itemName(r.def.output), 1.2) view.refreshHotbar() else why(w) end
			end })
		end
		if #items == 0 then core.menus.toast("No recipes yet", 1.2) return end
		core.menus.list({ title = "Crafting", items = items, keepOpen = false })
	end
	local function heartsText(id)
		local h = farm:hearts(id)
		return h .. "/" .. cfg.friendship.maxHearts .. " hearts"
	end
	local function friendsMenu()
		local items = {}
		for _, id in farm.C.villagersOrder do
			local d = farm.C.villagers[id]
			local f = farm:friend(id)
			local today = (if f.talked == farm.dayCount then "talked" else "") .. (if f.gifted == farm.dayCount then " gift" else "")
			table.insert(items, { label = d.name, detail = heartsText(id) .. (if today ~= "" then "  (" .. today .. ")" else ""), disabled = true })
		end
		core.menus.list({ title = "Friends", items = items, keepOpen = true })
	end
	local function collectionsMenu()
		local items = {}
		for _, id in farm.C.collectionsOrder do
			local col = farm.C.collections[id]
			local have, total = farm:collectionProgress(id)
			table.insert(items, { label = col.name, detail = have .. "/" .. total, onSelect = function()
				local rows = {}
				local _, _, list = farm:collectionProgress(id)
				for _, r in list do
					local can = not r.done and not col.auto and core.bag:has(r.item, 1)
					table.insert(rows, { label = (if r.done then "[x] " else "[ ] ") .. itemName(r.item), detail = if can then "donate" else nil, disabled = not can, onSelect = function(_, h)
						if farm:donate(id, r.item) then juice.sfx("donate") juice.confetti() h.close() end
					end })
				end
				core.menus.list({ title = col.name, items = rows, keepOpen = true })
			end })
		end
		core.menus.list({ title = "Collections", items = items })
	end
	local function bagMenu()
		local cells = { { label = "Hand", onSelect = function(_, h) view.select(nil) h.close() end } }
		for _, row in core.bag:list() do
			table.insert(cells, { label = if row.def and row.def.icon then nil else itemName(row.id), icon = row.def and row.def.icon, count = row.count, onSelect = function(_, h) view.select(row.id) h.close() end })
		end
		core.menus.grid({ title = "Bag", cells = cells, columns = 4, rows = 4 })
	end
	local function calendarMenu()
		local items = {}
		local sd = farm:seasonDef()
		for d = 1, sd.days do
			local fe = farm:festivalOn(sd.id, d)
			local bdays = {}
			for _, id in farm.C.villagersOrder do
				local b = farm.C.villagers[id].birthday
				if b and b.season == sd.id and b.day == d then table.insert(bdays, farm.C.villagers[id].name .. "'s birthday") end
			end
			if fe or #bdays > 0 or d == farm.day then
				local parts = {}
				if fe then table.insert(parts, fe.name) end
				for _, b in bdays do table.insert(parts, b) end
				table.insert(items, { label = sd.name .. " " .. d .. (if d == farm.day then " (today)" else ""), detail = table.concat(parts, ", "), disabled = d < farm.day, fontSize = 24 })
			end
		end
		core.menus.list({ title = "Calendar", items = items, keepOpen = true })
	end
	function view.openMenu()
		core.menus.list({ title = "Menu", items = {
			{ label = "Bag", onSelect = bagMenu },
			{ label = "Crafting", onSelect = craftMenu },
			{ label = "Friends", onSelect = friendsMenu },
			{ label = "Collections", onSelect = collectionsMenu },
			{ label = "Calendar", onSelect = calendarMenu },
		} })
	end

	-- ---------- sleep / day summary ----------
	local summaryDim = nil
	local function summary(rep)
		if map.destroyed then return end
		if summaryDim and not summaryDim.destroyed then summaryDim:destroy() core.pause.pop("summary") end
		local lines = {}
		if rep.passedOut then table.insert(lines, { "You passed out! (-" .. (rep.fine or 0) .. "g)", "#ff9a8a" }) end
		for i, s in rep.shipped do if i <= 5 then table.insert(lines, { itemName(s.item) .. " x" .. s.count .. "   " .. s.value .. "g" }) end end
		if #rep.shipped > 5 then table.insert(lines, { "... and " .. (#rep.shipped - 5) .. " more" }) end
		if #rep.shipped == 0 then table.insert(lines, { "Nothing shipped yesterday", "#bdb3c8" }) end
		table.insert(lines, { "Weather: " .. (WEATHER[farm.weather] or farm.weather) })
		if rep.festival then table.insert(lines, { "Today: " .. farm.C.festivals[rep.festival].name .. "!", ACCENT }) end
		if rep.died > 0 then table.insert(lines, { rep.died .. " crops withered with the season", "#ff9a8a" }) end
		local h = 300 + #lines * 50
		local dim = core.menus.panel(nil, { anchor = "center", size = vec2(2600, 2600), background = "#000000aa", z_index = 950 })
		summaryDim = dim
		local box = core.menus.panel(dim, { anchor = "center", size = vec2(620, h), z_index = 951 })
		local dt = farm:date()
		core.menus.text(box, dt.seasonName .. " " .. dt.day .. " - " .. dt.weekday, { offset = vec2(0, 24), font_size = 44, color = ACCENT, z_index = 952 })
		local earned = core.menus.text(box, "+0g", { offset = vec2(0, 84), size = vec2(560, 56), font_size = 40, color = "#ffd34d", z_index = 952 })
		if rep.earned > 0 then juice.rollup(earned, 0, rep.earned, { prefix = "+", suffix = "g", seconds = 0.8 }) juice.sfx("coins") end
		for i, l in lines do core.menus.text(box, l[1], { offset = vec2(0, 110 + i * 50), size = vec2(560, 46), font_size = 28, color = l[2], z_index = 952 }) end
		core.pause.push("summary", true)
		core.menus.button(box, "Good morning!", function() core.pause.pop("summary") dim:destroy() end, { anchor = "bottom", offset = vec2(0, -24), size = vec2(520, 96), z_index = 953 })
	end
	function view.sleep()
		juice.sfx("sleep")
		juice.transition("fade", { seconds = 0.5, onCovered = function() farm:sleep(false) end })
	end
	local function onDay(rep)
		if map.destroyed then return end
		player.position = wake
		player.velocity = vec2(0, 0)
		camera.snap()
		syncAll()
		view.refreshAnimals()
		view.refreshHotbar()
		if opts.onDay then opts.onDay(rep) end
		local function show() if map.destroyed then return end if ui.dialogOpen() then after(0.3, show) else summary(rep) end end
		show()
	end

	-- ---------- villagers ----------
	local vills = {}
	local function talkTo(id)
		local t = farm:talk(id)
		local def = farm.C.villagers[id]
		local function giftOffer()
			local sel = view.selectedItem
			local idef = sel and core.content.get("items", sel)
			if not sel or not idef or idef.category == "seeds" or idef.category == "tool" or not core.bag:has(sel, 1) then return end
			if farm:friend(id).gifted == farm.dayCount then return end
			ui.choice({ text = "Give " .. itemName(sel) .. " to " .. def.name .. "?", speaker = def.name, portrait = def.portrait }, { "Give", "Not now" }, function(i)
				if i ~= 1 then return end
				local ok, taste = farm:gift(id, sel)
				if ok then
					local e = vills[id]
					say(def.name .. " " .. TASTE[taste], e and e.position + vec2(0, -tile * 1.2), if taste == "love" or taste == "like" then "#ffb3c8" else "#cccccc")
					if taste == "love" or taste == "like" then juice.sfx("heart") end
					view.refreshHotbar()
				end
			end)
		end
		if t.heartEvent then
			local ev = t.heartEvent
			if ev.dialog and core.content.get("dialog", ev.dialog) then
				core.dialog.play(ev.dialog, { onEnd = function() farm:markHeartEvent(id, ev) giftOffer() end })
			else
				local d = ui.dialog(ev.lines or t.lines, { speaker = def.name, portrait = def.portrait })
				d.done:connect(function() farm:markHeartEvent(id, ev) giftOffer() end)
			end
		else
			local d = ui.dialog(t.lines, { speaker = def.name, portrait = def.portrait })
			d.done:connect(giftOffer)
		end
		if t.first then
			local e = vills[id]
			if e then juice.popup("+", e.position + vec2(0, -tile), { color = "#ffb3c8", size = 34 }) end
		end
	end
	for _, id in farm.C.villagersOrder do
		local def = farm.C.villagers[id]
		local e = spawn("Sprite2D", { position = vec2(0, 0), size = vec2(def.size or tile, def.size or tile), texture = def.sprite, modulate = if def.sprite then color("#ffffff") else color(def.color or "#d07a9a"), z_index = 4 })
		local label = spawn("Text2D", { position = vec2(0, -(def.size or tile) * 0.62), text = def.name, font_size = 20, color = "#ffffff", outline = "#00000099", outline_size = 3, z_index = 5 }, e)
		e.tapped:connect(function()
			if core.menus.isOpen() or ui.dialogOpen() then return end
			walkTo(e.position, function() talkTo(id) end)
		end)
		vills[id] = e
		local _ = label
	end
	local spread = {}
	for i, id in farm.C.villagersOrder do spread[id] = vec2(((i - 1) % 3 - 1) * tile * 0.7, (math.floor((i - 1) / 3) % 2) * tile * 0.5) end
	local function updateVillagers()
		for id, e in vills do
			if e.destroyed then continue end
			local w = farm:where(id)
			local loc = cfg.locations and cfg.locations[w.loc]
			e.visible = w.moving or not (loc and loc.hidden)
			local np = vec2(w.x, w.y) + (if w.moving then vec2(0, 0) else spread[id])
			if np.x < e.position.x - 0.01 then e.flip_h = true elseif np.x > e.position.x + 0.01 then e.flip_h = false end
			e.position = np
		end
	end

	-- ---------- animals ----------
	local animalSprites = {}
	function view.refreshAnimals()
		if map.destroyed then return end
		for uid, s in animalSprites do if not s.destroyed then s:destroy() end end
		animalSprites = {}
		local idx = {}
		for _, a in farm.animals do
			local d = farm:animalDef(a.kind)
			local pen = opts.pens and opts.pens[d.building]
			if not pen then continue end
			idx[d.building] = (idx[d.building] or 0) + 1
			local i = idx[d.building] - 1
			local cols = math.max(1, math.floor(pen.w / (tile * 1.1)))
			local pos = vec2(pen.x + tile * 0.6 + (i % cols) * tile * 1.1, pen.y + tile * 0.6 + math.floor(i / cols) * tile * 1.1)
			local s = spawn("Sprite2D", { position = pos, size = vec2(tile * 0.9, tile * 0.9), texture = d.sprite, modulate = if d.sprite then color("#ffffff") else color(d.color or "#f0e0c0"), z_index = 3 })
			if a.ready then
				local pdef = core.content.get("items", a.ready)
				spawn("Sprite2D", { position = vec2(tile * 0.3, -tile * 0.5), size = vec2(tile * 0.45, tile * 0.45), texture = pdef and pdef.icon or nil, z_index = 4 }, s)
			end
			local uid = a.uid
			s.tapped:connect(function()
				if core.menus.isOpen() then return end
				walkTo(s.position, function()
					local an = farm:animal(uid)
					if not an then return end
					local got = false
					if an.ready then local ok, item = farm:collect(uid) if ok then say("+1 " .. itemName(item), s.position + vec2(0, -tile), "#fff3b0") juice.sfx("collect") got = true end end
					if farm:pet(uid) then juice.popup("+", s.position + vec2(0, -tile * 0.8), { color = "#ffb3c8", size = 34 }) juice.squash(s) juice.sfx("pet") end
					local fed = farm:feed(uid)
					if not got and not fed and an.petted then say(an.name .. " is happy", s.position + vec2(0, -tile), "#ffffff") end
					view.refreshAnimals()
					view.refreshHotbar()
				end)
			end)
			animalSprites[uid] = s
		end
	end

	-- ---------- interactables ----------
	local function interact(e, tag)
		if opts.onInteract and opts.onInteract(e, tag) then return end
		if tag == "farm_bed" then
			core.menus.confirm("Go to bed and end the day?", function() view.sleep() end, nil, { yes = "Sleep", no = "Not yet" })
		elseif tag == "farm_bin" then shipMenu()
		elseif tag == "farm_shop" then shopMenu(if farm.C.shops[e.name] then e.name else farm.C.shopsOrder[1])
		elseif tag == "farm_craft" then craftMenu()
		elseif tag == "farm_museum" then collectionsMenu()
		elseif tag == "farm_coop" or tag == "farm_barn" then
			local n = farm:feedAll()
			local c = farm:collectAll()
			if n + c > 0 then juice.sfx("collect") end
			core.menus.toast("Fed " .. n .. ", collected " .. c, 1.4)
			view.refreshAnimals() view.refreshHotbar()
		elseif tag == "farm_festival" then
			local ok, fe = farm:attendFestival()
			if ok then
				juice.confetti() juice.sfx("festival")
				if fe.dialog and core.content.get("dialog", fe.dialog) then core.dialog.play(fe.dialog) else ui.dialog(fe.lines or { "Welcome to the " .. fe.name .. "!" }) end
			elseif fe then core.menus.toast("You already enjoyed the " .. fe.name, 1.4)
			else core.menus.toast("Nothing going on here today", 1.4) end
		end
	end
	view.interact = interact
	for _, tag in { "farm_bed", "farm_bin", "farm_shop", "farm_craft", "farm_museum", "farm_coop", "farm_barn", "farm_festival" } do
		for _, e in entitiesTagged(tag) do
			e.tapped:connect(function()
				if core.menus.isOpen() or ui.dialogOpen() then return end
				walkTo(e.position, function() interact(e, tag) end)
			end)
		end
	end

	-- ---------- HUD ----------
	local hud = {}
	view.hud = hud
	if opts.hud ~= false then
		local top = spawn("UIPanel", { anchor = "top_left", offset = vec2(12, 12), size = vec2(580, 112), background = PANEL, input_transparent = true, z_index = 100 })
		hud.panel = top
		hud.date = spawn("UIText", { anchor = "top_left", offset = vec2(18, 8), size = vec2(330, 44), font_size = 32, color = TEXT, text = "", z_index = 101 }, top)
		hud.clock = spawn("UIText", { anchor = "top_left", offset = vec2(18, 52), size = vec2(200, 40), font_size = 30, color = ACCENT, text = "", z_index = 101 }, top)
		hud.weather = spawn("UIText", { anchor = "top_left", offset = vec2(206, 54), size = vec2(150, 36), font_size = 24, color = TEXT, text = "", z_index = 101 }, top)
		hud.gold = spawn("UIText", { anchor = "top_right", offset = vec2(-16, 8), size = vec2(210, 44), font_size = 32, color = "#ffd34d", align = "right", text = "", z_index = 101 }, top)
		local eb = spawn("UIPanel", { anchor = "top_right", offset = vec2(-16, 60), size = vec2(200, 26), background = "#00000066", input_transparent = true, z_index = 101 }, top)
		hud.energy = spawn("UIPanel", { anchor = "left", offset = vec2(0, 0), size = vec2(200, 26), background = "#7bd96f", input_transparent = true, z_index = 102 }, eb)
		hud.energyText = spawn("UIText", { anchor = "center", size = vec2(200, 26), font_size = 18, align = "center", color = "#1c1c1c", text = "", z_index = 103 }, eb)
	end
	-- evening tint (opts.nightTint = false to disable): fades in from 18:00 to 24:00
	local tint = if opts.nightTint ~= false then spawn("UIPanel", { anchor = "center", size = vec2(2600, 2600), background = "#1a144000", input_transparent = true, z_index = 40 }) else nil
	local shownGold = core.wallet.get(cfg.currency)
	local function updateHud()
		if not hud.panel or hud.panel.destroyed then return end
		local dt = farm:date()
		hud.date.text = dt.seasonName .. " " .. dt.day .. "  " .. dt.weekday
		hud.clock.text = farm:clock()
		hud.weather.text = WEATHER[farm.weather] or farm.weather
		local g = core.wallet.get(cfg.currency)
		if g ~= shownGold then juice.rollup(hud.gold, shownGold, g, { suffix = "g", seconds = 0.5 }) juice.bounce(hud.gold) shownGold = g
		elseif hud.gold.text == "" then hud.gold.text = g .. "g" end
		local frac = math.clamp(farm.energy / math.max(1, farm:maxEnergy()), 0, 1)
		hud.energy.size = vec2(math.max(2, 200 * frac), 26)
		hud.energy.background = if frac < 0.25 then "#e86a5a" elseif frac < 0.5 then "#e8c25a" else "#7bd96f"
		hud.energyText.text = math.floor(farm.energy) .. " / " .. math.floor(farm:maxEnergy())
		if tint and not tint.destroyed then
			local a = math.clamp((farm.minute - 1080) / 360, 0, 1) * 0.42
			if farm:isWet() then a = math.max(a, 0.12) end
			tint.background = string.format("#1a1440%02x", math.floor(a * 255))
		end
	end

	-- hotbar: [Hand] + up to 4 usable stacks (seeds, fertilizer, placeables, giftables) + [Bag]
	local hotbar = {}
	local SLOT = 88
	function view.select(item)
		view.selectedItem = item
		view.refreshHotbar()
	end
	function view.selected() return view.selectedItem end
	function view.refreshHotbar()
		if opts.hotbar == false or map.destroyed then return end
		if view.selectedItem and not core.bag:has(view.selectedItem, 1) then view.selectedItem = nil end
		for _, b in hotbar do if not b.destroyed then b:destroy() end end
		hotbar = {}
		local stacks = {}
		local rank = { seeds = 1, fertilizer = 2, crafted = 3, crop = 4, product = 5 }
		for _, row in core.bag:list() do table.insert(stacks, row) end
		table.sort(stacks, function(a, b)
			local ra, rb = rank[a.def and a.def.category or ""] or 9, rank[b.def and b.def.category or ""] or 9
			if ra ~= rb then return ra < rb end
			return a.id < b.id
		end)
		local slots = { { id = nil, label = "Hand" } }
		if view.selectedItem then
			local found = false
			for i = 1, math.min(4, #stacks) do if stacks[i].id == view.selectedItem then found = true end end
			if not found then table.insert(slots, { id = view.selectedItem, count = core.bag:count(view.selectedItem), def = core.content.get("items", view.selectedItem) }) end
		end
		for _, row in stacks do
			if #slots >= 5 then break end
			if row.id ~= view.selectedItem or not table.find(slots, row) then
				local dup = false
				for _, s in slots do if s.id == row.id then dup = true end end
				if not dup then table.insert(slots, { id = row.id, count = row.count, def = row.def }) end
			end
		end
		table.insert(slots, { id = "__bag", label = "Bag" })
		local x0 = 12
		for i, s in slots do
			local sel = (s.id == view.selectedItem) or (s.id == nil and view.selectedItem == nil)
			local icon = s.def and s.def.icon
			local text = s.label or (if icon then tostring(s.count) else string.sub(itemName(s.id), 1, 5) .. "\n" .. s.count)
			local b = spawn("UIButton", { anchor = "top_left", offset = vec2(x0 + (i - 1) * (SLOT + 8), 136), size = vec2(SLOT, SLOT),
				text = text, font_size = if s.label then 24 else 22, icon = icon, icon_size = if icon then 56 else 0, icon_position = "top",
				background = if sel then ACCENT .. "ee" else PANEL, color = if sel then "#1c1c1c" else TEXT, z_index = 100 })
			b.pressed:connect(function()
				if s.id == "__bag" then bagMenu() else view.select(s.id) juice.bounce(b) end
				juice.sfx("select")
			end)
			table.insert(hotbar, b)
		end
	end
	view.refreshHotbar()
	if opts.menuButton ~= false then
		local mb = spawn("UIButton", { anchor = "top_right", offset = vec2(-12, 136), size = vec2(110, SLOT), text = "Menu", font_size = 26, background = th.primary, color = "#ffffff", z_index = 100 })
		mb.pressed:connect(function() juice.sfx("select") view.openMenu() end)
		hud.menu = mb
	end

	-- ---------- farm events ----------
	local conns = {}
	local function onFarm(name, fn) table.insert(conns, farm:on(name, function(d) if map.destroyed then return end fn(d) end)) end
	onFarm("day_started", onDay)
	onFarm("heart_up", function(d) local e = vills[d.villager] juice.sfx("heart") core.menus.toast(farm.C.villagers[d.villager].name .. ": " .. d.hearts .. " hearts!", 1.6) if e then juice.sparkle(e.position, { color = "#ff8fb0" }) end end)
	onFarm("too_tired", function() juice.sfx("tired") end)
	onFarm("festival_attended", function() end)
	function view.stop()
		view.alive = false
		for _, c in conns do c.disconnect() end
	end

	-- ---------- tick ----------
	local facing = vec2(0, 1)
	local hudT = 0
	syncAll()
	view.refreshAnimals()
	updateHud()
	updateVillagers()
	-- festival hello
	local fe = farm:festivalToday()
	if fe then after(0.8, function() if not map.destroyed then core.menus.toast("Today: " .. fe.name .. "!", 2.5) end end) end
	onTick(function(dt)
		if map.destroyed or player.destroyed then return end
		local blocked = core.pause.isPaused() or core.menus.isOpen() or ui.dialogOpen() or juice.stopped()
		local v = vec2(0, 0)
		if not blocked then
			farm:tick(dt)
			local ax, ay = input.axis("move_x"), input.axis("move_y")
			if math.abs(ax) > 0.1 or math.abs(ay) > 0.1 then
				walkTarget = nil
				v = vec2(ax, ay)
				if v:length() > 1 then v = v:normalized() end
				v = v * speed
				facing = v:normalized()
			elseif walkTarget then
				walkTarget.t += dt
				local goal = walkTarget.pos
				if walkTarget.pts and walkTarget.pts[walkTarget.i] then
					local pt = walkTarget.pts[walkTarget.i]
					goal = vec2(pt.x, pt.y)
					if dist(player.position, goal) < tile * 0.3 then walkTarget.i += 1 end
				end
				if dist(player.position, walkTarget.pos) <= reach then
					local done = walkTarget.done
					walkTarget = nil
					done()
				elseif walkTarget.t > 6 then
					walkTarget = nil
					core.menus.toast("Can't get there", 1)
				else
					v = (goal - player.position):normalized() * speed
					facing = v:normalized()
				end
			end
		end
		player.velocity = v
		if opts.anims then if v:length() > 1 then player:play("walk") else player:play("idle") end end
		updateVillagers()
		hudT += dt
		if hudT >= 0.2 then hudT = 0 updateHud() end
	end)
	local _ = facing
	return view
end

return M
