--!strict
-- Crumbtown Bakery: an idle bakery built on the tycoon kit (session script, portrait 720×1280).
-- All economy rules live in data/*.json (the kit reads them). This script is UI only.
local Tycoon = require("@kit/tycoon")
local UI = Tycoon.ui
local fmt = Tycoon.format

local SAVE_KEY = "bakery"
local t, offline = Tycoon.restore(SAVE_KEY, { seed = 7 })
local C = t.content

local theme = ui.theme() -- dreamsy.toml [ui]
local DARK, CREAM, GOLD, PINK = theme.background, theme.text, theme.accent, theme.primary
local BROWN, ROW, INK = "#7a3e2b", "#fbe3cf", "#4a2a1f"
local OK_BG, NO_BG, DONE_BG = "#3f9b5a", "#b9a597", "#8c7a6e"

music.play("bakery")
local refreshNow = true

-- ---------- HUD ----------
local hud = UI.panel(nil, { offset = vec2(0, 0), size = vec2(720, 150), background = DARK, z_index = 5 })
UI.panel(hud, { offset = vec2(24, 24), size = vec2(64, 64), image = "asset:icon_coin", z_index = 6 })
local coinsText = UI.text(hud, { offset = vec2(100, 14), size = vec2(400, 70), font_size = 60, text = "0", color = CREAM, font = "bold", z_index = 6 })
local rateText = UI.text(hud, { offset = vec2(102, 88), size = vec2(360, 40), font_size = 28, text = "+0 /s", color = GOLD, z_index = 6 })
UI.panel(hud, { offset = vec2(470, 88), size = vec2(40, 40), image = "asset:icon_whisk", z_index = 6 })
local whiskText = UI.text(hud, { offset = vec2(516, 88), size = vec2(190, 40), font_size = 28, text = "0", color = CREAM, z_index = 6 })

-- ---------- tap area ----------
local cupcake = UI.tapTarget(nil, { offset = vec2(250, 166), size = vec2(220, 220), image = "asset:cupcake", z_index = 2 }, function() end)
local tapLabel = UI.text(nil, { offset = vec2(200, 376), size = vec2(320, 36), font_size = 24, align = "center", color = BROWN, text = "TAP TO BAKE", z_index = 2 })
local boostText = UI.text(nil, { offset = vec2(16, 340), size = vec2(220, 60), font_size = 22, color = PINK, text = "", z_index = 2 })
local golden = UI.tapTarget(nil, { offset = vec2(40, 190), size = vec2(130, 130), image = "asset:event_golden", z_index = 3, visible = false }, function() end)
local goldenLabel = UI.text(nil, { offset = vec2(10, 318), size = vec2(190, 30), font_size = 20, align = "center", color = BROWN, text = "", z_index = 3, visible = false })

local buyMode = UI.buyModes(nil, { offset = vec2(548, 196), size = vec2(150, 76), modes = { 1, 10, "max" }, background = BROWN, z_index = 2 }, function()
	refreshNow = true
end)

-- ---------- tabs ----------
local TABS = { { id = "bakery", label = "Bakery" }, { id = "upgrades", label = "Upgrades" }, { id = "reopen", label = "Reopen" }, { id = "awards", label = "Awards" } }
local tabButtons = {}
local currentTab = ""
local list: any = nil
local prestigePanel: any = nil

local function isLocked(gid: string): boolean
	return not t:isUnlocked(gid)
end

local function unlockHint(gid: string): string
	local u = C.generators[gid].unlock
	for og, n in u.owned or {} do
		return "Own " .. n .. " " .. C.generators[og].name .. "s to unlock"
	end
	return "Keep baking to unlock"
end

local function requiresHint(u: any): string
	for og, n in u.requires.owned or {} do
		return "Needs " .. n .. " " .. C.generators[og].name .. "s"
	end
	return "Locked"
end

-- prices: whole coins below 1000 (5.35 → 6)
local function price(n: number): string
	return fmt(if n < 1000 then math.ceil(n - 1e-9) else n)
end

local function costLabel(cur: string, n: number): string
	return price(n) .. (if cur == "whisks" then " whisks" else "")
end

-- ---------- bakery list ----------
local function buildBakery()
	list = UI.list({
		rect = { 16, 424, 688, 676 },
		arrows = { 16, 1108, 688, 54 },
		arrowBackground = "#c98a6b",
		rowHeight = 160,
		gap = 10,
		count = #C.genOrder,
		build = function(i: number, row: any)
			local gid = C.genOrder[i]
			row.background = ROW
			local s: any = { gid = gid }
			s.icon = UI.tapTarget(row, { offset = vec2(10, 22), size = vec2(116, 116), background = "#00000000", image = C.generators[gid].icon }, function()
				if list:dragging() then
					return
				end
				if t:run(gid) then
					UI.sfx("tap")
				end
			end)
			s.name = UI.text(row, { offset = vec2(136, 8), size = vec2(330, 40), font_size = 30, color = INK, font = "bold" })
			s.owned = UI.text(row, { offset = vec2(136, 50), size = vec2(120, 32), font_size = 24, color = BROWN })
			s.rate = UI.text(row, { offset = vec2(250, 50), size = vec2(220, 32), font_size = 24, color = PINK })
			s.bar = UI.progress(row, { offset = vec2(136, 88), size = vec2(330, 16) }, "#e8a23c")
			s.status = UI.text(row, { offset = vec2(136, 112), size = vec2(330, 34), font_size = 20, color = BROWN })
			s.hire = UI.button(row, { offset = vec2(136, 108), size = vec2(330, 46), font_size = 22, background = PINK, visible = false }, function()
				if list:dragging() then
					return
				end
				if t:hireManager(gid) then
					UI.sfx("upgrade")
					UI.floatText("Chef hired!", vec2(320, 470 + (i - 1) * 50))
				end
			end)
			s.buy = UI.button(row, { offset = vec2(480, 14), size = vec2(196, 132), font_size = 32, background = OK_BG }, function()
				if list:dragging() then
					return
				end
				local mode = buyMode.get()
				local n = t:buyCount(gid, mode)
				if t:buy(gid, mode) then
					UI.sfx("buy", { pitch = 1 + math.min(t.owned[gid], 100) / 200 })
					UI.pop(s.buy, 1.15)
					local r = row.offset
					UI.floatText("+" .. n, vec2(16 + 578, 424 + r.y + 30), { color = GOLD })
				else
					UI.sfx("deny")
				end
			end)
			s.buyLabel = UI.text(row, { offset = vec2(480, 22), size = vec2(196, 30), font_size = 22, align = "center", color = "#e9ffe9", z_index = 1 })
			return s
		end,
		update = function(i: number, row: any, s: any)
			local gid = s.gid
			local g = C.generators[gid]
			if isLocked(gid) then
				s.name.text = "???"
				s.owned.text = ""
				s.rate.text = ""
				s.status.text = unlockHint(gid)
				s.icon.visible = false
				s.bar.root.visible = false
				s.hire.visible = false
				s.buy.background = NO_BG
				s.buy.text = "LOCKED"
				s.buyLabel.text = ""
				return
			end
			s.icon.visible = true
			s.bar.root.visible = true
			s.name.text = g.name
			s.owned.text = "×" .. t.owned[gid]
			s.rate.text = if t.owned[gid] > 0 then fmt(t:rate(gid)) .. "/s" else ""
			s.bar.set(t:cycleProgress(gid))
			local hireable = g.manager ~= nil and not t.managers[gid] and t.owned[gid] > 0
			s.hire.visible = hireable
			if hireable then
				s.hire.text = "HIRE CHEF  " .. price(g.manager.cost)
				s.hire.background = if t:canHire(gid) then PINK else NO_BG
				s.status.text = ""
			elseif t.owned[gid] == 0 then
				s.status.text = "Buy one to start baking"
			elseif t:isAuto(gid) then
				local nm = t:nextMilestone(gid)
				s.status.text = if nm then "Chef on duty · ×2 at " .. nm else "Chef on duty · max level"
			else
				s.status.text = if t.running[gid] then "Baking…" else "Tap the oven to bake!"
			end
			local mode = buyMode.get()
			local n = math.max(1, t:buyCount(gid, mode))
			local cost = t:costOf(gid, n)
			s.buy.text = price(cost)
			s.buyLabel.text = "BUY ×" .. n
			s.buy.background = if t:canAfford(g.cost.currency, cost) and t:buyCount(gid, mode) > 0 then OK_BG else NO_BG
		end,
	})
end

-- ---------- upgrades list ----------
local function buildUpgrades()
	-- buyable first, then locked, then owned (order fixed while the tab is open)
	local order = {}
	local function rank(id: string): number
		return if t:hasUpgrade(id) then 3 elseif t:upgradeAvailable(id) then 1 else 2
	end
	for _, id in C.upgradeOrder do
		table.insert(order, id)
	end
	local pos = {}
	for i, id in order do
		pos[id] = i
	end
	table.sort(order, function(a, b)
		local ra, rb = rank(a), rank(b)
		if ra ~= rb then
			return ra < rb
		end
		return pos[a] < pos[b]
	end)
	list = UI.list({
		rect = { 16, 424, 688, 676 },
		arrows = { 16, 1108, 688, 54 },
		arrowBackground = "#c98a6b",
		rowHeight = 120,
		gap = 10,
		count = #order,
		build = function(i: number, row: any)
			local id = order[i]
			local u = C.upgrades[id]
			row.background = ROW
			local s: any = { id = id }
			UI.panel(row, { offset = vec2(12, 12), size = vec2(96, 96), image = u.icon })
			s.name = UI.text(row, { offset = vec2(120, 10), size = vec2(350, 40), font_size = 28, color = INK, font = "bold", text = u.name })
			s.desc = UI.text(row, { offset = vec2(120, 56), size = vec2(350, 56), font_size = 22, color = BROWN, text = u.desc or "" })
			s.buy = UI.button(row, { offset = vec2(480, 14), size = vec2(196, 92), font_size = 28 }, function()
				if list:dragging() then
					return
				end
				if t:buyUpgrade(id) then
					UI.sfx("upgrade")
					UI.pop(s.buy)
					UI.burst(vec2(578, 424 + row.offset.y + 60), { color = GOLD })
				else
					UI.sfx("deny")
				end
			end)
			return s
		end,
		update = function(i: number, row: any, s: any)
			local u = C.upgrades[s.id]
			if t:hasUpgrade(s.id) then
				s.buy.text = "OWNED"
				s.buy.background = DONE_BG
				s.desc.text = u.desc or ""
			elseif not t:upgradeAvailable(s.id) then
				s.buy.text = "LOCKED"
				s.buy.background = NO_BG
				s.desc.text = requiresHint(u)
			else
				s.buy.text = costLabel(u.cost.currency, u.cost.amount)
				s.buy.background = if t:canAfford(u.cost.currency, u.cost.amount) then OK_BG else NO_BG
				s.desc.text = u.desc or ""
			end
		end,
	})
end

-- ---------- awards list ----------
local function buildAwards()
	list = UI.list({
		rect = { 16, 424, 688, 676 },
		arrows = { 16, 1108, 688, 54 },
		arrowBackground = "#c98a6b",
		rowHeight = 100,
		gap = 8,
		count = #C.achievementOrder,
		build = function(i: number, row: any)
			local a = C.achievements[C.achievementOrder[i]]
			row.background = ROW
			local s: any = { id = a.id }
			s.icon = UI.panel(row, { offset = vec2(14, 14), size = vec2(72, 72), image = "asset:icon_star" })
			s.name = UI.text(row, { offset = vec2(100, 8), size = vec2(440, 40), font_size = 28, color = INK, font = "bold", text = a.name })
			UI.text(row, { offset = vec2(100, 52), size = vec2(440, 36), font_size = 22, color = BROWN, text = (a.desc or "") .. "  (+5% bakes)" })
			s.check = UI.text(row, { offset = vec2(560, 24), size = vec2(110, 50), font_size = 30, align = "center", color = OK_BG, text = "" })
			return s
		end,
		update = function(i: number, row: any, s: any)
			local done = t.ach[s.id] == true
			s.check.text = if done then "DONE" else ""
			s.icon.visible = done
			row.background = if done then "#fff1c9" else ROW
		end,
	})
end

-- ---------- reopen (prestige) panel ----------
local function buildReopen()
	local l = C.layers[C.layerOrder[1]]
	local p = UI.panel(nil, { offset = vec2(16, 424), size = vec2(688, 730), background = ROW })
	UI.panel(p, { offset = vec2(274, 24), size = vec2(140, 140), image = "asset:icon_whisk" })
	UI.text(p, { offset = vec2(24, 176), size = vec2(640, 50), font_size = 36, align = "center", color = INK, font = "bold", text = l.name })
	UI.text(p, { offset = vec2(24, 232), size = vec2(640, 40), font_size = 22, align = "center", color = BROWN, text = "Start over with Golden Whisks." })
	UI.text(p, { offset = vec2(24, 266), size = vec2(640, 40), font_size = 22, align = "center", color = BROWN, text = "Each whisk ever earned: +" .. math.floor(l.bonus * 100) .. "% to every bake, forever." })
	local have = UI.text(p, { offset = vec2(24, 330), size = vec2(640, 44), font_size = 30, align = "center", color = INK })
	local gain = UI.text(p, { offset = vec2(24, 384), size = vec2(640, 44), font_size = 30, align = "center", color = PINK })
	local nextT = UI.text(p, { offset = vec2(24, 436), size = vec2(640, 40), font_size = 22, align = "center", color = BROWN })
	local btn = UI.button(p, { offset = vec2(134, 520), size = vec2(420, 120), font_size = 34, background = PINK, text = "REOPEN" }, function()
		local g = t:doPrestige()
		if g > 0 then
			UI.sfx("prestige")
			camera.shake(10, 0.5)
			UI.burst(vec2(360, 700), { color = GOLD, count = 40, speed = 420 })
			UI.floatText("+" .. fmt(g) .. " Golden Whisks!", vec2(360, 640), { size = 44, color = GOLD, seconds = 1.4 })
			Tycoon.persist(t, SAVE_KEY)
		else
			UI.sfx("deny")
		end
	end)
	prestigePanel = {
		root = p,
		update = function()
			have.text = "Whisks: " .. fmt(t:get(l.currency)) .. "   ·   bonus ×" .. string.format("%.2f", t:prestigeBonus(l.id))
			local g = t:prestigeGain(l.id)
			gain.text = "Reopen now: +" .. fmt(g) .. " whisks"
			nextT.text = "Next whisk at " .. fmt(t:prestigeNeeded(l.id, g + 1)) .. " coins baked (all time: " .. fmt(t.allTime[l.from]) .. ")"
			btn.background = if t:canPrestige(l.id) then PINK else NO_BG
			btn.text = if t:canPrestige(l.id) then "REOPEN  +" .. fmt(g) else "NOT YET"
		end,
	}
end

local function showTab(id: string)
	if id == currentTab then
		return
	end
	currentTab = id
	if list then
		list:destroy()
		list = nil
	end
	if prestigePanel then
		prestigePanel.root:destroy()
		prestigePanel = nil
	end
	if id == "bakery" then
		buildBakery()
	elseif id == "upgrades" then
		buildUpgrades()
	elseif id == "reopen" then
		buildReopen()
	else
		buildAwards()
	end
	for _, b in tabButtons do
		b.btn.background = if b.id == id then PINK else BROWN
	end
	refreshNow = true
end

for i, tab in TABS do
	local b = UI.button(nil, { offset = vec2(8 + (i - 1) * 178, 1172), size = vec2(170, 96), text = tab.label, font_size = 26, background = BROWN, z_index = 5 }, function()
		UI.sfx("tap")
		showTab(tab.id)
	end)
	table.insert(tabButtons, { id = tab.id, btn = b })
end

-- ---------- interactions ----------
cupcake.tapped:connect(function()
	local v = t:tap()
	UI.sfx("tap", { pitch = 0.9 + random(0, 0.3) })
	UI.floatText("+" .. fmt(v), vec2(360 + random(-60, 60), 230), { color = BROWN, size = 36 })
	tween(cupcake, { size = vec2(236, 236), offset = vec2(242, 158) }, 0.05, "quad_out").done:connect(function()
		tween(cupcake, { size = vec2(220, 220), offset = vec2(250, 166) }, 0.15, "back_out")
	end)
end)

golden.tapped:connect(function()
	local id = t:claimEvent()
	if id then
		local e = C.events[id]
		UI.sfx("event")
		UI.burst(vec2(105, 255), { color = GOLD, count = 30 })
		UI.floatText(e.name .. "!", vec2(200, 260), { size = 34, color = PINK, seconds = 1.2 })
	end
end)

t.on.eventSpawned:connect(function(id: string)
	golden.visible = true
	goldenLabel.visible = true
	goldenLabel.text = C.events[id].name
	UI.sfx("event", { volume = 0.5 })
	tween(golden, { size = vec2(144, 144), offset = vec2(33, 183) }, 0.4, { easing = "sine_in_out", loop = true, yoyo = true })
end)
local function hideGolden()
	golden.visible = false
	goldenLabel.visible = false
end
t.on.eventClaimed:connect(hideGolden)
t.on.eventExpired:connect(hideGolden)

t.on.milestone:connect(function(gid: string, at: number, mult: number)
	UI.sfx("milestone")
	ui.toast(C.generators[gid].name .. " ×" .. at .. ": bakes ×" .. mult .. "!", 2)
	UI.burst(vec2(360, 500), { color = PINK, count = 24 })
end)
t.on.achievement:connect(function(id: string)
	UI.sfx("achievement")
	ui.toast("Award: " .. C.achievements[id].name .. " (+5%)", 2.5)
end)
t.on.unlocked:connect(function(gid: string)
	ui.toast("New oven: " .. C.generators[gid].name .. "!", 2)
end)
t.on.purchased:connect(function()
	refreshNow = true
end)

if offline then
	ui.toast("Welcome back! Your chefs baked " .. fmt(offline.earned[C.main] or 0) .. " coins.", 4)
end

-- ---------- loop ----------
local acc = 0
onTick(function(dt: number)
	t:step(dt)
	acc += dt
	if acc < 0.1 and not refreshNow then
		return
	end
	acc = 0
	refreshNow = false
	coinsText.text = fmt(t:get())
	rateText.text = "+" .. fmt(t:income()) .. " /s"
	whiskText.text = fmt(t:get("whisks"))
	tapLabel.text = "TAP TO BAKE  +" .. fmt(t:tapValue())
	local parts = {}
	for _, b in t:activeBoosts() do
		table.insert(parts, (C.events[b.id] and C.events[b.id].name or b.id) .. " " .. math.ceil(b.left) .. "s")
	end
	boostText.text = table.concat(parts, "\n")
	local pe = t:pendingEventInfo()
	if pe then
		goldenLabel.text = C.events[pe.id].name .. " " .. math.ceil(pe.left) .. "s"
	end
	if list then
		list:refresh()
	end
	if prestigePanel then
		prestigePanel.update()
	end
end)

every(5, function()
	Tycoon.persist(t, SAVE_KEY)
end)

showTab("bakery")
