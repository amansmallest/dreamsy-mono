--!nonstrict
-- Portrait (720×1280) UI for simulator games, built on core.menus + juice. Every builder is optional: games can
-- draw their own UI from the sim's state. Call these from a scene script (entities die with the scene).
--   UI.hud(s, opts)        top bar: coins (roll-up), backpack fill bar, zone, rebirth multiplier
--   UI.field(s, opts)      tappable nodes in a world rect + auto-swing + popups/sparkles + respawn + "bag full"
--   UI.bar(buttons, opts)  bottom row of big buttons (SELL, Shop, Pets, …)
--   UI.shop(s, kind) UI.zones(s) UI.eggs(s) UI.pets(s) UI.rebirth(s) UI.daily(streak) UI.quests() UI.stats(s)
--   UI.sheet(title, rowsFn) generic scrolling card sheet;  UI.sellFx(s, coins, from)  UI.offline(s, report)
local Core = require("@kit/core")
local juice = require("@kit/juice")
local F = require("./format")

local UI = {}
local Z = 900
UI.sfx = { hit = "hit", pop = "pop", sell = "sell", full = "deny", buy = "buy", hatch = "hatch", rebirth = "rebirth", unlock = "unlock", deny = "deny" }

local function theme() return Core.menus.theme() end
local function fontOf(t) return if t.font and t.font ~= "default" then t.font else nil end
local function txt(parent, props)
	local t = theme()
	local p = { anchor = "top_left", size = vec2(300, 40), font_size = 28, color = t.text, z_index = Z + 3 }
	p.font = fontOf(t)
	for k, v in props do p[k] = v end
	return spawn("UIText", p, parent)
end
local function panel(parent, props)
	local p = { anchor = "top_left", size = vec2(100, 100), background = "#00000000", z_index = Z + 1 }
	for k, v in props do p[k] = v end
	return spawn("UIPanel", p, parent)
end
local function btn(parent, label, onPress, props)
	local t = theme()
	local p = { anchor = "top_left", size = vec2(200, 96), text = label, font_size = 30, color = t.text, background = t.primary, z_index = Z + 4 }
	p.font = fontOf(t)
	for k, v in props do p[k] = v end
	local b = spawn("UIButton", p, parent)
	if onPress then b.pressed:connect(function() onPress(b) end) end
	return b
end
UI.text, UI.panel, UI.button = txt, panel, btn

local function rarityColor(s, rid) local r = s.C.rarity[rid] return if r then r.color else "#ffffff" end
local function sound(k) juice.sfx(UI.sfx[k] or k) end

-- ---------- HUD ----------
-- hud(s, { coinIcon?, bagIcon?, y? (0), height? (150), background? }) -> { root, refresh() }
function UI.hud(s, opts)
	opts = opts or {}
	local t = theme()
	local root = panel(nil, { offset = vec2(0, opts.y or 0), size = vec2(720, opts.height or 150), background = opts.background or (t.background .. "e6"), z_index = 50 })
	if opts.coinIcon then panel(root, { offset = vec2(24, 22), size = vec2(56, 56), background = "#00000000", image = opts.coinIcon, z_index = 52 }) end
	local cx = if opts.coinIcon then 92 else 24
	local coins = txt(root, { offset = vec2(cx, 14), size = vec2(330, 70), font_size = 54, color = t.accent, text = "0", z_index = 52, outline = "#00000088", outline_size = 3 })
	local mult = txt(root, { offset = vec2(cx + 2, 80), size = vec2(330, 34), font_size = 24, text = "", z_index = 52 })
	-- backpack bar (right column; the top-right 100 px stay free for the pause button)
	local bx = 380
	if opts.bagIcon then panel(root, { offset = vec2(bx, 70), size = vec2(44, 44), background = "#00000000", image = opts.bagIcon, z_index = 52 }) end
	local barX = if opts.bagIcon then bx + 52 else bx
	local barW = 600 - barX
	local zone = txt(root, { offset = vec2(bx, 18), size = vec2(600 - bx, 40), font_size = 28, text = "", z_index = 52 })
	panel(root, { offset = vec2(barX, 74), size = vec2(barW, 36), background = "#00000066", z_index = 51 })
	local fill = panel(root, { offset = vec2(barX, 74), size = vec2(2, 36), background = t.primary, z_index = 52 })
	local bagText = txt(root, { offset = vec2(barX, 74), size = vec2(barW, 36), font_size = 22, align = "center", text = "", z_index = 53 })
	local shown = s:coins()
	coins.text = F.num(shown)
	local h = { root = root, coinsText = coins, bagText = bagText }
	local wasFull = false
	function h.refresh()
		local c = s:coins()
		if math.abs(c - shown) >= 1 then
			coins.text = F.num(c)
			if c > shown then juice.bounce(coins, { amount = 0.08, seconds = 0.2 }) end
			shown = c
		end
		local cap = s:capacity()
		bagText.text = F.num(s.load) .. " / " .. F.num(cap)
		local f = s:fill()
		fill.size = vec2(math.max(2, math.floor(barW * f)), 36)
		local full = f >= 1
		fill.background = if full then "#ff5a5a" elseif f > 0.8 then "#ffb020" else t.primary
		if full and not wasFull then juice.bounce(bagText, { amount = 0.15 }) end
		wasFull = full
		local z = s:zoneDef()
		zone.text = z.name or z.id
		local m = s:coinMultiplier()
		mult.text = (if s.layer.count > 0 then "Rebirth " .. s.layer.count .. "  " else "") .. "Coin bonus x" .. string.format("%.2f", m)
	end
	h.refresh()
	every(0.1, function() if root.parent ~= nil or true then h.refresh() end end)
	return h
end

-- ---------- field (tappable nodes) ----------
-- field(s, { area = {x, y, w, h} (world), count? (6), size? (110), sprite? (fn(nodeDef, zoneDef) -> "asset:x"),
--            ground? (Sprite2D entity tinted per zone: zone.color), onBreak?(node, res, pos), onFull?(), respawn? (0.6 s),
--            popups? (true), auto? (true) }) -> { slots, reset(), target(i), hitAt(i, mult?) }
function UI.field(s, opts)
	local area = opts.area or { 40, 300, 640, 620 }
	local count = opts.count or 6
	local size = opts.size or 110
	local cols = opts.columns or 3
	local rows = math.ceil(count / cols)
	local holder = spawn("Node2D", { position = vec2(0, 0), z_index = 2 })
	local f = { slots = {}, targetIdx = 1, holder = holder }
	local fullT = -10
	local function slotPos(i)
		local c, r = (i - 1) % cols, (i - 1) // cols
		local cw, rh = area[3] / cols, area[4] / rows
		local jx = ((i * 37) % 21 - 10) * cw / 80
		local jy = ((i * 53) % 21 - 10) * rh / 80
		return vec2(area[1] + cw * (c + 0.5) + jx, area[2] + rh * (r + 0.5) + jy)
	end
	local function spriteFor(def)
		if opts.sprite then return opts.sprite(def, s:zoneDef()) end
		return def.sprite
	end
	local function draw(slot)
		local n = slot.node
		local frac = math.clamp(n.hp / n.maxHp, 0, 1)
		slot.bar.size = vec2(math.max(1, (size - 8) * frac), 10)
		slot.bar.position = vec2(-(size - 8) * (1 - frac) / 2, size / 2 + 14)
		slot.barBg.visible = frac < 1
		slot.bar.visible = frac < 1
		slot.ring.visible = opts.ring ~= nil and f.slots[f.targetIdx] == slot
	end
	local function spawnSlot(i)
		local slot = f.slots[i]
		local n = s:spawnNode()
		slot.node = n
		local scale = n.def.scale or 1
		local sz = size * scale
		slot.art.size = vec2(sz, sz)
		local tex = spriteFor(n.def)
		if tex then slot.art.texture = tex else slot.art.modulate = n.def.color or "#cccccc" end
		slot.art.visible = true
		slot.art.scale = vec2(0.2, 0.2)
		tween(slot.art, { scale = vec2(1, 1) }, 0.25, "back_out")
		slot.dead = false
		draw(slot)
	end
	for i = 1, count do
		local root = spawn("Node2D", { position = slotPos(i) }, holder)
		-- optional art: opts.shadow (under every node) and opts.ring (under the auto-swing target), e.g. ellipse SVGs
		local ring = spawn("Sprite2D", { size = vec2(size * 1.1, size * 0.4), position = vec2(0, size * 0.42), texture = opts.ring, modulate = "#ffffffaa", z_index = 1, visible = false }, root)
		local shadow = spawn("Sprite2D", { size = vec2(size * 0.9, size * 0.3), position = vec2(0, size * 0.44), texture = opts.shadow, modulate = "#00000040", z_index = 1, visible = opts.shadow ~= nil }, root)
		local art = spawn("Sprite2D", { size = vec2(size, size), z_index = 3 }, root)
		local barBg = spawn("Sprite2D", { size = vec2(size, 14), position = vec2(0, size / 2 + 14), modulate = "#000000a0", z_index = 4, visible = false }, root)
		local bar = spawn("Sprite2D", { size = vec2(size - 8, 10), position = vec2(0, size / 2 + 14), modulate = "#6ee36e", z_index = 5, visible = false }, root)
		local slot = { root = root, art = art, bar = bar, barBg = barBg, ring = ring, shadow = shadow, index = i }
		f.slots[i] = slot
		art.tapped:connect(function() f.target(i) f.hitAt(i) end)
	end
	function f.target(i) f.targetIdx = i for _, sl in f.slots do if sl.node then draw(sl) end end end
	function f.hitAt(i, mult)
		local slot = f.slots[i]
		if not slot or slot.dead or Core.pause.isPaused() then return nil end
		local res = s:hit(slot.node, mult)
		local pos = slot.root.position
		if res.full and res.damage == 0 then
			if time() - fullT > 1.2 then
				fullT = time()
				sound("full")
				Core.menus.toast("Backpack full! Sell your haul", 1.4)
				juice.shake("tiny")
				if opts.onFull then opts.onFull() end
			end
			return res
		end
		juice.punch(slot.art, 0.12, 0.12)
		if opts.popups ~= false then juice.damage(math.floor(res.damage + 0.5), pos + vec2(random(-20, 20), -size * 0.6), { color = "#ffffff" }) end
		if res.broken then
			slot.dead = true
			sound("pop")
			juice.sparkle(pos, { color = slot.node.def.color or "#ffe066", n = 10 })
			juice.popup("+" .. F.num(res.value), pos + vec2(0, -size * 0.8), { color = "#ffe066", size = 34 })
			slot.art.visible = false
			slot.bar.visible = false
			slot.barBg.visible = false
			if opts.onBreak then opts.onBreak(slot.node, res, pos) end
			after(opts.respawn or 0.6, function() if slot.root and f.alive then spawnSlot(i) end end)
		else
			sound("hit")
			draw(slot)
		end
		return res
	end
	function f.reset()
		for i = 1, count do spawnSlot(i) end
		f.target(1)
		if opts.ground then opts.ground.modulate = s:zoneDef().color or "#ffffff" end
	end
	f.alive = true
	f.reset()
	local c1 = s:on("zone_entered", function() f.reset() end)
	local c2 = s:on("zone_unlocked", function() f.reset() end)
	local c3 = s:on("rebirth", function() f.reset() end)
	-- auto swing on the targeted node (or the next live one)
	onTick(function(dt)
		if not f.alive or Core.pause.isPaused() or juice.stopped() then return end
		local slot = f.slots[f.targetIdx]
		if slot.dead then
			for i, sl in f.slots do if not sl.dead then f.target(i) slot = sl break end end
		end
		if slot.dead or s:speed() <= 0 or opts.auto == false then return end
		if s:isFull() then return end
		local acc = (f.acc or 0) + dt * s:speed()
		if acc >= 1 then
			acc -= 1
			f.hitAt(f.targetIdx)
		end
		f.acc = acc
	end)
	game.sceneLoaded:connect(function() f.alive = false c1.disconnect() c2.disconnect() c3.disconnect() end)
	return f
end

-- ---------- bottom button bar ----------
-- bar({ {label, onPress, color?, icon?, wide?} }, { y? (1100), height? (120) }) -> { buttons }
function UI.bar(buttons, opts)
	opts = opts or {}
	local h = opts.height or 120
	local y = opts.y or (1280 - h - 40)
	local units = 0
	for _, b in buttons do units += if b.wide then 2 else 1 end
	local gap = 10
	local unitW = (720 - 32 - gap * (#buttons - 1)) / units
	local x = 16
	local out = {}
	for _, b in buttons do
		local w = unitW * (if b.wide then 2 else 1)
		local props: any = { offset = vec2(x, y), size = vec2(w, h), font_size = if b.wide then 36 else 26, z_index = 60 }
		if b.color then props.background = b.color end
		if b.icon then props.icon = b.icon props.icon_size = 44 props.icon_position = "top" end
		local e = btn(nil, b.label, function(e) sound("buy") juice.bounce(e, { amount = 0.06, seconds = 0.15 }) b.onPress(e) end, props)
		table.insert(out, e)
		x += w + gap
	end
	return { buttons = out }
end

-- ---------- sheets (scrolling card lists) ----------
-- sheet(title, build(add) , opts?) where add({ icon?, title, sub?, color?, button? = {label, onPress, enabled?, color?}, height? })
-- -> handle (core.menus modal handle; handle.reopen() rebuilds it)
function UI.sheet(title, build, opts)
	opts = opts or {}
	local t = theme()
	local W, H = 680, opts.height or 1040
	local handle = Core.menus.modal(W, H, title, { offsetY = opts.offsetY or 0 })
	local list = panel(handle.box, { anchor = "top_left", offset = vec2(16, 96), size = vec2(W - 32, H - 96 - 128), scroll = true, background = "#00000022" })
	local y = 8
	local function add(row)
		local rh = row.height or 128
		local card = panel(list, { offset = vec2(8, y), size = vec2(W - 48, rh), background = row.background or "#ffffff14" })
		local x = 16
		if row.icon then
			panel(card, { offset = vec2(12, (rh - 96) / 2), size = vec2(96, 96), image = row.icon, background = "#00000000", z_index = Z + 2 })
			x = 120
		end
		local bw = if row.button then 200 elseif row.badge then 130 else 0
		txt(card, { offset = vec2(x, 12), size = vec2(W - 48 - x - bw - 20, 44), text = row.title, font_size = 30, color = row.color or t.text })
		if row.sub then
			txt(card, { offset = vec2(x, 56), size = vec2(W - 48 - x - bw - 20, rh - 60), text = row.sub, font_size = 22, color = row.subColor or (t.text .. "cc") })
		end
		if row.badge then
			txt(card, { offset = vec2(W - 48 - bw - 12, (rh - 40) / 2), size = vec2(bw, 40), text = row.badge, font_size = 30, align = "right", color = row.badgeColor or row.color or t.accent })
		end
		if row.button then
			local b = row.button
			local enabled = b.enabled ~= false
			btn(card, b.label, function(e)
				if not enabled then sound("deny") juice.bounce(e, { amount = 0.1 }) return end
				b.onPress(e)
			end, { offset = vec2(W - 48 - bw - 12, (rh - 88) / 2), size = vec2(bw, 88), font_size = if #b.label > 10 then 22 else 26,
				background = if enabled then (b.color or t.primary) else t.disabled })
		end
		y += rh + 10
		return card
	end
	build(add, handle)
	btn(handle.box, "Close", function() handle.close() end, { anchor = "bottom", offset = vec2(0, -16), size = vec2(W - 80, 96), background = t.disabled })
	return handle
end

local function reopen(handle, fn) handle.close() fn() end

-- shop(s, kind = "tools" | "backpacks", opts?)
function UI.shop(s, kind, opts)
	opts = opts or {}
	local title = if kind == "tools" then (opts.title or "Tools") else (opts.title or "Backpacks")
	local function open()
		local h
		h = UI.sheet(title, function(add)
			for _, g in s:gear(kind) do
				local d = g.def
				local stat = if kind == "tools"
					then "Power " .. F.num(d.power) .. (if (d.speed or 0) > 0 then "  ·  auto " .. d.speed .. "/s" else "  ·  tap only")
					else "Holds " .. F.num(d.capacity)
				local b
				if g.state == "equipped" then b = { label = "Equipped", enabled = false }
				elseif g.state == "owned" then b = { label = "Equip", onPress = function() s:equipGear(kind, d.id) sound("buy") reopen(h, open) end }
				elseif g.state == "next" then
					local ok = s:canBuy(kind, d.id)
					b = { label = F.num(g.cost), enabled = ok, onPress = function()
						if s:buy(kind, d.id) then sound("buy") juice.confetti(nil, { n = 30 }) reopen(h, open) end
					end }
				else
					local why = if g.reason == "zone" then "Find it in " .. (s:zoneDef(d.zone).name or d.zone) elseif g.reason == "order" then "Buy the previous one first" else "Locked"
					b = { label = F.num(g.cost), enabled = false }
					stat ..= "\n" .. why
				end
				add({ icon = d.icon, title = d.name or d.id, sub = stat .. (if d.desc then "\n" .. d.desc else ""), button = b,
					background = if g.state == "equipped" then "#ffffff2a" else nil })
			end
		end)
	end
	open()
end

-- zones(s): travel / unlock list
function UI.zones(s, opts)
	local function open()
		local h
		h = UI.sheet((opts and opts.title) or "Zones", function(add)
			for _, z in s:zoneList() do
				local d = z.def
				local b, sub
				local u = d.unlock or {}
				if z.state == "current" then b = { label = "Here", enabled = false } sub = d.desc
				elseif z.state == "unlocked" then b = { label = "Travel", onPress = function() s:travel(d.id) sound("buy") h.close() end } sub = d.desc
				elseif z.state == "available" then
					b = { label = "Unlock " .. F.num(z.cost), color = "#3f9b5a", onPress = function()
						if s:unlockZone(d.id) then sound("unlock") juice.confetti() Core.menus.toast("Welcome to " .. (d.name or d.id) .. "!", 2) h.close() end
					end }
					sub = d.desc
				else
					local why = if z.reason == "rebirths" then "Needs " .. u.rebirths .. " rebirth" .. (if u.rebirths > 1 then "s" else "")
						elseif z.reason == "order" then "Unlock the previous zone first"
						elseif z.reason == "condition" then (u.hint or "Locked")
						else "Costs " .. F.num(z.cost)
					b = { label = if z.reason == "coins" then F.num(z.cost) else "Locked", enabled = false }
					sub = why
				end
				add({ icon = d.icon, title = d.name or d.id, sub = sub, button = b, background = if z.state == "current" then "#ffffff2a" else nil })
			end
		end)
	end
	open()
end

-- eggs(s): odds always visible (kids platform rule: random rewards only for in-game coins, odds shown)
function UI.eggs(s, opts)
	opts = opts or {}
	local function open()
		local h
		h = UI.sheet(opts.title or "Eggs", function(add)
			for _, e in s.C.eggs do
				local ok, why = s:canHatch(e.id)
				local odds = s:eggOdds(e.id)
				local lines = {}
				for _, o in odds do table.insert(lines, o.name .. " (" .. (s.C.rarity[o.rarity].name or o.rarity) .. ")  " .. o.percent) end
				local locked = why == "zone"
				add({ icon = e.icon, title = (e.name or e.id) .. (if locked then "  [locked]" else ""),
					sub = (if locked then "Unlock " .. (s:zoneDef(e.zone).name or e.zone) .. " first\n" else "") .. "Odds per hatch:",
					button = { label = "Hatch " .. F.num(e.cost.coins or e.cost.amount or e.cost), enabled = ok, onPress = function()
						local pid = s:hatch(e.id)
						if pid then
							h.close()
							UI.hatchReveal(s, pid, function() open() end)
						end
					end }, height = 112 })
				for _, o in odds do
					add({ title = o.name, sub = s.C.rarity[o.rarity].name .. "  ·  " .. UI.bonusText(s.C.petsById[o.pet]),
						color = rarityColor(s, o.rarity), badge = o.percent, height = 100,
						background = "#00000022", icon = s.C.petsById[o.pet].icon })
				end
			end
		end)
	end
	open()
end

function UI.bonusText(def)
	local parts = {}
	for _, k in { "power", "coins", "capacity", "speed", "luck" } do
		local v = def.bonus[k]
		if v and v ~= 0 then table.insert(parts, F.pct(v) .. " " .. k) end
	end
	return table.concat(parts, "  ")
end

-- hatchReveal(s, petId, onDone?): egg wobble → pet + rarity banner
function UI.hatchReveal(s, pid, onDone)
	local d = s.C.petsById[pid]
	local r = s.C.rarity[d.rarity]
	local h = Core.menus.modal(560, 640, nil, {})
	local icon = panel(h.box, { anchor = "top", offset = vec2(0, 70), size = vec2(260, 260), image = d.icon, background = "#00000000", z_index = Z + 3 })
	icon.scale = vec2(0.1, 0.1)
	tween(icon, { scale = vec2(1, 1) }, 0.45, "back_out")
	txt(h.box, { anchor = "top", offset = vec2(0, 350), size = vec2(520, 60), align = "center", font_size = 44, text = d.name or pid, color = r.color })
	txt(h.box, { anchor = "top", offset = vec2(0, 410), size = vec2(520, 40), align = "center", font_size = 28, text = r.name .. "  ·  " .. UI.bonusText(d) })
	btn(h.box, "Nice!", function() h.close() if onDone then onDone() end end, { anchor = "bottom", offset = vec2(0, -24), size = vec2(400, 96) })
	sound("hatch")
	if r.rank >= 4 then juice.confetti() juice.shake("light") end
	return h
end

-- pets(s): equip slots, equip best, release duplicates
function UI.pets(s, opts)
	local function open()
		local h
		h = UI.sheet((opts and opts.title) or "Pets", function(add)
			add({ title = "Equipped " .. s:equippedCount() .. " / " .. s:slots(), sub = "Total: " .. UI.bonusText({ bonus = s:petBonus() }),
				button = { label = "Equip best", onPress = function() s:equipBest() sound("buy") reopen(h, open) end }, height = 112 })
			local list = s:petList()
			if #list == 0 then add({ title = "No pets yet", sub = "Hatch eggs with coins to find companions." }) end
			for _, p in list do
				local d = p.def
				local b
				if p.equipped > 0 then b = { label = "Unequip", color = "#8a5a5a", onPress = function() s:unequip(d.id) reopen(h, open) end }
				else b = { label = "Equip", enabled = s:equippedCount() < s:slots(), onPress = function() s:equip(d.id) sound("buy") reopen(h, open) end } end
				add({ icon = d.icon, title = (d.name or d.id) .. (if p.count > 1 then "  x" .. p.count else "") .. (if p.equipped > 0 then "  (" .. p.equipped .. " on)" else ""),
					sub = p.rarity.name .. "  ·  " .. UI.bonusText(d), color = p.rarity.color, button = b })
			end
		end)
	end
	open()
end

-- rebirth(s): confirm with what's kept / reset
function UI.rebirth(s, opts)
	opts = opts or {}
	local g = s:rebirthGain()
	if not s:canRebirth() then
		local need = s:rebirthNext()
		local z = s.cfg.rebirth.zone
		local msg = if z and not s.zones[z] then "Reach " .. (s:zoneDef(z).name or z) .. " to rebirth."
			else "Earn " .. F.num(math.max(0, need - s.runCoins)) .. " more coins this run to rebirth."
		local bonus = string.format("%d%%", math.floor(s.cfg.rebirth.bonus * 100 + 0.5))
		Core.menus.confirm(msg .. "\nEach rebirth point: +" .. bonus .. " coins forever.", nil, nil, { title = "Rebirth", yes = "Got it", no = "Close" })
		return
	end
	local now = s.layer:multiplier()
	local after = s.layer:multiplier(s.layer.points + g)
	Core.menus.confirm("+" .. g .. " rebirth point" .. (if g > 1 then "s" else "") .. ": coins x" .. string.format("%.2f", now) .. " → x" .. string.format("%.2f", after) ..
		".\nResets coins, tools, backpacks, zones.\nKeeps pets and stats.", function()
		local got = s:rebirth()
		if got > 0 then
			sound("rebirth")
			juice.confetti(nil, { n = 90 })
			juice.shake("medium")
			Core.menus.toast("Reborn! Coins x" .. string.format("%.2f", s:coinMultiplier()), 2.5)
			if opts.onDone then opts.onDone(got) end
		end
	end, nil, { title = "Rebirth?", yes = "Rebirth", no = "Not yet" })
end

-- daily(streak): progression streak (rewards = core effect lists like {{"earn":"coins","amount":500}})
function UI.daily(streak, opts)
	opts = opts or {}
	local st = streak:status()
	local h
	h = UI.sheet(opts.title or "Daily Rewards", function(add)
		for i, r in streak.rewards do
			local label = opts.label and opts.label(r, i) or ("Day " .. i)
			local isNext = st.canClaim and st.index == i
			local claimed = (not st.canClaim and st.index == i)
			add({ title = label, sub = if claimed then "Claimed today · next in " .. F.time(st.nextIn) else (if isNext then "Ready!" else nil),
				button = if isNext then { label = "Claim", color = "#3f9b5a", onPress = function()
					streak:claim()
					sound("buy")
					juice.confetti()
					h.close()
				end } else nil, height = 100, background = if isNext then "#3f9b5a40" else nil })
		end
	end)
end

-- quests(): active core quests with progress
function UI.quests(opts)
	UI.sheet((opts and opts.title) or "Quests", function(add)
		local any = false
		for _, def in Core.quests.list("active") do
			any = true
			local id = def.id
			local lines = {}
			for _, p in Core.quests.progress(id) do table.insert(lines, (if p.done then "[x] " else "[ ] ") .. (p.text or p.id) .. "  " .. F.num(math.min(p.count, p.target)) .. "/" .. F.num(p.target)) end
			add({ title = def and def.title or id, sub = table.concat(lines, "\n"), height = 140 })
		end
		for _, def in Core.quests.list("done") do
			any = true
			local id = def.id
			add({ title = (def and def.title or id), sub = "Complete!", color = "#8be08b", height = 96 })
		end
		if not any then add({ title = "No quests yet", sub = "Keep collecting!" }) end
	end)
end

-- stats(s): leaderboard-ready stats + local bests
function UI.stats(s, opts)
	local row = s:leaderboard()
	UI.sheet((opts and opts.title) or "Stats", function(add)
		local names = { { "coins", "Coins earned" }, { "bestRun", "Best run" }, { "rebirths", "Rebirths" }, { "nodes", "Things collected" },
			{ "hatched", "Eggs hatched" }, { "pets", "Pets owned" }, { "zones", "Zones open" }, { "playTime", "Play time" } }
		for _, n in names do
			local v = row[n[1]]
			local best = s.best[n[1]] or v
			local f = if n[1] == "playTime" then F.time else F.num
			add({ title = n[2] .. ": " .. f(v), sub = "Best: " .. f(best), height = 96 })
		end
	end)
end

-- sellFx(s, coins, fromWorld, hudWorld?): coin burst flying to the HUD + popup
function UI.sellFx(s, coins, from, to)
	if coins <= 0 then return end
	sound("sell")
	juice.coinBurst(from, { n = math.clamp(math.floor(math.log10(coins + 1) * 4), 6, 18), collectTo = to })
	juice.popup("+" .. F.num(coins), from + vec2(0, -60), { color = "#ffe066", size = 44 })
end

-- offline(s, report): welcome-back panel
function UI.offline(s, r)
	if not r then return end
	Core.menus.confirm("While you were away (" .. F.time(r.seconds) .. ") your gear earned " .. F.num(r.coins) .. " coins!", nil, nil,
		{ title = "Welcome back", yes = "Collect", no = "OK" })
end

return UI
