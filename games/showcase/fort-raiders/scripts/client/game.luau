-- Village Raiders: village building + deterministic raids (single-player)
local C = require("../shared/config")
local Sim = require("../shared/raid_sim")

local T = C.TILE
local G = C.GRID
local CAM_BASE = vec2(C.CAMERA_POS[1], C.CAMERA_POS[2])

local GOLD_BG = "#c98a0aee"
local ELIXIR_BG = "#7b2cbfee"
local SEL_BG = "#2a9d8fff"
local OFF_BG = "#444444cc"
local GOLD_COL = "#ffd23f"
local ELIXIR_COL = "#e07bff"

local TROOP_ORDER = { "brawler", "archer", "giant" }
local BUILD_ORDER = { "mine", "pump", "storage", "wall", "cannon", "tower", "barracks" }

local tilesLayer = entity("tiles_layer")
local villageLayer = entity("village_layer")
local raidLayer = entity("raid_layer")
local fxLayer = entity("fx_layer")
local camera = entity("camera")
local hudGold = entity("hud_gold")
local hudElixir = entity("hud_elixir")
local hudArmy = entity("hud_army")
local hudTrophy = entity("hud_trophy")
local hudRaid = entity("hud_raid")
local hudHint = entity("hud_hint")

local state = {
	mode = "village", -- village | raid | result
	gold = C.START_GOLD,
	elixir = C.START_ELIXIR,
	trophies = 0,
	raids = 0,
	army = { brawler = 0, archer = 0, giant = 0 },
	buildMode = nil,
	removeMode = false,
	selTroop = "brawler",
}
local village = {}
local tiles = {}
local raid = nil
local simAcc = 0
local shakeTime = 0
local lastStars = 0
local floaters = {}
local shots = {}
local lastTap = { t = -1, cx = -1, cy = -1 }
local onCellTap

-- ---------- helpers ----------
local function idx(cx, cy)
	return cy * G + cx
end
local function cellCenter(cx, cy)
	return vec2(cx * T + T / 2, cy * T + T / 2)
end
local function isEdge(cx, cy)
	return cx == 0 or cy == 0 or cx == G - 1 or cy == G - 1
end
local function countKind(kind)
	local n = 0
	for _, b in village do
		if b.kind == kind then
			n += 1
		end
	end
	return n
end
local function capacity()
	return C.TOWNHALL_CAP + countKind("storage") * C.STORAGE_CAP
end
local function armyCap()
	return countKind("barracks") * C.ARMY_PER_BARRACKS
end
local function armyUsed(army)
	local n = 0
	for kind, c in army do
		n += c * C.troops[kind].space
	end
	return n
end
local function getRes(res)
	return res == "gold" and state.gold or state.elixir
end
local function addRes(res, n)
	local cap = capacity()
	if res == "gold" then
		state.gold = math.max(0, math.min(cap, state.gold + n))
	else
		state.elixir = math.max(0, math.min(cap, state.elixir + n))
	end
end
local function resColor(res)
	return res == "gold" and GOLD_COL or ELIXIR_COL
end
local function hint(text)
	hudHint.text = text
end
local function setGroup(id, v)
	local f = entity(id)
	if not f then
		return
	end
	f.visible = v
	for _, c in f:children() do
		c.visible = v
	end
end

-- ---------- visuals ----------
local BUILD_TEX = { townhall = "asset:townhall", mine = "asset:gold_mine", pump = "asset:elixir_pump", storage = "asset:storage", wall = "asset:wall", cannon = "asset:cannon", tower = "asset:archer_tower", barracks = "asset:barracks" }
local TROOP_TEX = { brawler = "asset:troop_brawler", archer = "asset:troop_archer", giant = "asset:troop_giant" }

local function makeBlock(parent, pos, size, fill, label, labelColor, z, tex)
	label = tex and "" or label
	local root = spawn("Node2D", { position = pos, z_index = z }, parent)
	local outline = spawn("Sprite2D", { size = vec2(size + 6, size + 6), modulate = "#1a1a2e" }, root)
	local body = spawn("Sprite2D", { size = vec2(size, size), modulate = fill }, root)
	local shade = spawn("Sprite2D", { position = vec2(0, size * 0.32), size = vec2(size, size * 0.36), modulate = "#00000040" }, root)
	local shine = spawn("Sprite2D", { position = vec2(0, -size * 0.3), size = vec2(size - 10, size * 0.16), modulate = "#ffffff66" }, root)
	local text = nil
	if label ~= nil and label ~= "" then
		text = spawn("Text2D", { text = label, font_size = 11, color = labelColor or "#ffffff" }, root)
	end
	if tex then
		body.texture = tex
		body.modulate = "#ffffff"
		body.size = vec2(size + 6, size + 6)
		outline.visible = false
		shade.visible = false
		shine.visible = false
	end
	return { root = root, outline = outline, body = body, shade = shade, shine = shine, label = text, size = size }
end

local function makeBar(v, w, y)
	v.barBg = spawn("Sprite2D", { position = vec2(0, y), size = vec2(w, 7), modulate = "#1a1a2e", visible = false }, v.root)
	v.bar = spawn("Sprite2D", { position = vec2(0, y), size = vec2(w - 2, 5), modulate = "#7cfc00", visible = false }, v.root)
	v.barW = w - 2
	v.barY = y
end

local function setBar(v, frac)
	if not v or not v.bar then
		return
	end
	frac = math.clamp(frac, 0, 1)
	v.barBg.visible = true
	v.bar.visible = true
	local w = math.max(1, v.barW * frac)
	v.bar.size = vec2(w, 5)
	v.bar.position = vec2(-v.barW / 2 + w / 2, v.barY)
	if frac > 0.5 then
		v.bar.modulate = "#7cfc00"
	elseif frac > 0.25 then
		v.bar.modulate = "#ffd23f"
	else
		v.bar.modulate = "#ff4b4b"
	end
end

local function onTapView(v, fn)
	for _, e in { v.outline, v.body, v.shade, v.shine } do
		e.tapped:connect(fn)
	end
end

local function buildingView(parent, kind, cx, cy)
	local d = C.buildings[kind]
	local v = makeBlock(parent, cellCenter(cx, cy), d.size, d.color, d.label, d.labelColor, 2, BUILD_TEX[kind])
	makeBar(v, 40, -T / 2 + 2)
	onTapView(v, function()
		onCellTap(cx, cy)
	end)
	return v
end

local function floatText(pos, text, color)
	local e = spawn("Text2D", { position = pos, text = text, font_size = 20, color = color, z_index = 30 }, fxLayer)
	table.insert(floaters, { e = e, life = 1.0, x = pos.x, y = pos.y })
end

local function shot(from, to, color, size, dur)
	local e = spawn("Sprite2D", { position = from, size = vec2(size, size), modulate = color, z_index = 25 }, fxLayer)
	table.insert(shots, { e = e, from = from, to = to, t = 0, dur = dur })
end

local function clearShots()
	for _, s in shots do
		s.e:destroy()
	end
	table.clear(shots)
end

local function shake(sec)
	shakeTime = math.max(shakeTime, sec)
end

local function paintTiles(mode)
	for cy = 0, G - 1 do
		for cx = 0, G - 1 do
			local checker = (cx + cy) % 2 == 0
			local col
			if mode == "raid" then
				if isEdge(cx, cy) then
					col = checker and "#ff8a80" or "#ff6f61"
				else
					col = checker and "#e9c46a" or "#dbb65a"
				end
			else
				col = checker and "#8bd65a" or "#79c94a"
			end
			tiles[idx(cx, cy)].modulate = col
		end
	end
end

-- ---------- HUD ----------
local function updateHud()
	local cap = capacity()
	hudGold.text = "GOLD  " .. math.floor(state.gold) .. " / " .. cap
	hudElixir.text = "ELIXIR  " .. math.floor(state.elixir) .. " / " .. cap
	local a = state.army
	hudArmy.text = string.format("ARMY %d/%d   Brawler %d  Archer %d  Giant %d", armyUsed(a), armyCap(), a.brawler, a.archer, a.giant)
	hudTrophy.text = "TROPHIES " .. state.trophies
end

local function refreshBuildButtons()
	for _, kind in BUILD_ORDER do
		local b = entity("btn_" .. kind)
		local d = C.buildings[kind]
		if state.buildMode == kind then
			b.background = SEL_BG
		else
			b.background = d.res == "gold" and GOLD_BG or ELIXIR_BG
		end
	end
	entity("btn_remove").background = state.removeMode and "#c1121fee" or "#555555ee"
end

local function updateRaidHud()
	if not raid then
		return
	end
	local left = math.max(0, C.RAID_TIME - raid.tick * C.SIM_DT)
	hudRaid.text = string.format("DESTROYED %d%%    STARS %d/3    TIME %d:%02d",
		raid.pct, raid.stars, math.floor(left / 60), math.floor(left % 60))
end

local function refreshRaidButtons()
	if not raid then
		return
	end
	for _, kind in TROOP_ORDER do
		local b = entity("btn_sel_" .. kind)
		b.text = C.troops[kind].name .. "\nx" .. raid.army[kind]
		if raid.army[kind] <= 0 then
			b.background = OFF_BG
		elseif state.selTroop == kind then
			b.background = SEL_BG
		else
			b.background = ELIXIR_BG
		end
	end
end

local function autoSelect()
	if not raid or raid.army[state.selTroop] > 0 then
		return
	end
	for _, k in TROOP_ORDER do
		if raid.army[k] > 0 then
			state.selTroop = k
			return
		end
	end
end

-- ---------- village ----------
local function placeVillage(kind, cx, cy)
	local v = buildingView(villageLayer, kind, cx, cy)
	village[idx(cx, cy)] = { kind = kind, view = v, cx = cx, cy = cy }
end

local function clearModes()
	state.buildMode = nil
	state.removeMode = false
	refreshBuildButtons()
end

local function villageTap(cx, cy)
	local i = idx(cx, cy)
	local b = village[i]
	if state.removeMode then
		if not b then
			return
		end
		if b.kind == "townhall" then
			ui.toast("You can't remove the Town Hall!", 1.5)
			return
		end
		local d = C.buildings[b.kind]
		b.view.root:destroy()
		village[i] = nil
		local refund = math.floor(d.cost / 2)
		addRes(d.res, refund)
		state.gold = math.min(state.gold, capacity())
		state.elixir = math.min(state.elixir, capacity())
		floatText(cellCenter(cx, cy), "+" .. refund, resColor(d.res))
		updateHud()
		return
	end
	if state.buildMode then
		local kind = state.buildMode
		local d = C.buildings[kind]
		if b then
			ui.toast("That spot is taken!", 1)
			return
		end
		if countKind(kind) >= d.max then
			ui.toast("You can only have " .. d.max .. " of those!", 1.5)
			return
		end
		if getRes(d.res) < d.cost then
			ui.toast("Not enough " .. d.res .. "! Wait a bit or raid.", 1.5)
			return
		end
		addRes(d.res, -d.cost)
		placeVillage(kind, cx, cy)
		floatText(cellCenter(cx, cy) - vec2(0, 16), "-" .. d.cost, resColor(d.res))
		updateHud()
		return
	end
	if b then
		local d = C.buildings[b.kind]
		ui.toast(d.name .. ": " .. d.info, 2.5)
	else
		hint("Pick a building at right, then tap a grass tile")
	end
end

local function selectBuild(kind)
	if state.buildMode == kind then
		clearModes()
		hint("Build mode off")
		return
	end
	state.buildMode = kind
	state.removeMode = false
	refreshBuildButtons()
	local d = C.buildings[kind]
	hint("Tap empty grass to build a " .. d.name .. " (" .. d.cost .. " " .. d.res .. ")")
end

local function train(kind)
	local d = C.troops[kind]
	if countKind("barracks") == 0 then
		ui.toast("Build a Barracks first!", 1.5)
		return
	end
	if armyUsed(state.army) + d.space > armyCap() then
		ui.toast("Army is full! Build more Barracks.", 1.5)
		return
	end
	if state.elixir < d.cost then
		ui.toast("Not enough elixir!", 1.5)
		return
	end
	state.elixir -= d.cost
	state.army[kind] += 1
	for _, b in village do
		if b.kind == "barracks" then
			floatText(cellCenter(b.cx, b.cy) - vec2(0, 16), "+1 " .. d.name, "#ffffff")
			break
		end
	end
	updateHud()
end

-- ---------- raid ----------
local function wreck(b)
	local v = b.view
	if not v then
		return
	end
	v.outline.size = vec2(v.size * 0.8 + 6, v.size * 0.45 + 6)
	v.body.size = vec2(v.size * 0.8, v.size * 0.45)
	v.body.modulate = "#6d4c41"
	v.shine.visible = false
	v.shade.visible = false
	if v.label then
		v.label.visible = false
	end
	v.barBg.visible = false
	v.bar.visible = false
	if b.kind == "wall" then
		shake(0.08)
	else
		floatText(cellCenter(b.cx, b.cy), "BOOM!", "#ff9f1c")
		shake(0.2)
	end
	if b.kind == "townhall" then
		shake(0.5)
		ui.toast("Town Hall destroyed!", 1.5)
	end
end

local function troopPos(t, alpha)
	return vec2((t.px + (t.x - t.px) * alpha) * T, (t.py + (t.y - t.py) * alpha) * T)
end

local function handleEvents()
	for _, ev in raid.events do
		local k = ev.type
		if k == "spawn" then
			local t = ev.troop
			local d = C.troops[t.kind]
			local v = makeBlock(raidLayer, vec2(t.x * T, t.y * T), d.size, d.color, d.label, d.labelColor, 5, TROOP_TEX[t.kind])
			makeBar(v, d.size + 10, -d.size / 2 - 8)
			t.view = v
			onTapView(v, function()
				local cx, cy = math.floor(t.x), math.floor(t.y)
				if isEdge(cx, cy) then
					onCellTap(cx, cy)
				end
			end)
		elseif k == "bhit" then
			setBar(ev.b.view, ev.b.hp / ev.b.maxhp)
		elseif k == "bdie" then
			wreck(ev.b)
		elseif k == "thit" then
			if ev.t.view then
				setBar(ev.t.view, ev.t.hp / ev.t.maxhp)
			end
		elseif k == "tdie" then
			if ev.t.view then
				floatText(vec2(ev.t.x * T, ev.t.y * T), "X", "#ff4b4b")
				ev.t.view.root:destroy()
				ev.t.view = nil
			end
		elseif k == "tshot" then
			if ev.t.kind == "archer" then
				shot(vec2(ev.t.x * T, ev.t.y * T), cellCenter(ev.b.cx, ev.b.cy), "#2b9348", 6, 0.18)
			elseif ev.t.kind == "giant" then
				shake(0.06)
			end
		elseif k == "dshot" then
			local from = cellCenter(ev.b.cx, ev.b.cy)
			local to = vec2(ev.t.x * T, ev.t.y * T)
			if ev.b.kind == "cannon" then
				shot(from, to, "#111111", 11, 0.2)
			else
				shot(from, to, "#ff1f6b", 6, 0.15)
			end
		end
	end
	table.clear(raid.events)
end

local function startRaid()
	if armyUsed(state.army) == 0 then
		ui.toast("Train some troops first!", 2)
		return
	end
	clearModes()
	state.raids += 1
	local level = math.min(6, 1 + math.floor(state.trophies / 40))
	local seed = 12345 + state.raids * 7919 + state.trophies * 31
	local layout = Sim.generateOutpost(seed, level)
	local army = { brawler = state.army.brawler, archer = state.army.archer, giant = state.army.giant }
	state.army = { brawler = 0, archer = 0, giant = 0 }
	raid = Sim.new(layout, army, level)
	for _, b in raid.buildings do
		b.view = buildingView(raidLayer, b.kind, b.cx, b.cy)
	end
	simAcc = 0
	lastStars = 0
	state.mode = "raid"
	villageLayer.visible = false
	raidLayer.visible = true
	paintTiles("raid")
	setGroup("village_ui", false)
	setGroup("raid_ui", true)
	hudRaid.visible = true
	state.selTroop = "brawler"
	autoSelect()
	refreshRaidButtons()
	hint("Enemy Outpost Lv " .. level .. "  -  tap the RED edge to drop troops!")
	ui.toast("RAID!", 1.2)
	updateHud()
	updateRaidHud()
end

local function finishRaid()
	if state.mode ~= "raid" or not raid then
		return
	end
	raid.over = true
	local pct, stars = raid.pct, raid.stars
	local lg = math.floor(raid.loot.gold * pct / 100)
	local le = math.floor(raid.loot.elixir * pct / 100)
	addRes("gold", lg)
	addRes("elixir", le)
	local dTroph = stars > 0 and stars * 10 or -5
	state.trophies = math.max(0, state.trophies + dTroph)
	state.army = { brawler = raid.army.brawler, archer = raid.army.archer, giant = raid.army.giant }
	state.mode = "result"
	setGroup("raid_ui", false)
	setGroup("result_ui", true)
	local title = entity("result_title")
	title.text = stars > 0 and "VICTORY!" or "DEFEAT"
	title.color = stars > 0 and "#ffd23f" or "#ff6b6b"
	for i = 1, 3 do
		entity("result_star_" .. i).background = i <= stars and "#ffd23f" or "#444444"
	end
	entity("result_detail").text = string.format("%d of 3 stars   -   %d%% destroyed\n+%d gold   +%d elixir\n%s%d trophies",
		stars, pct, lg, le, dTroph >= 0 and "+" or "", dTroph)
	hint("")
	updateRaidHud()
	updateHud()
	if stars == 3 then
		shake(0.6)
	end
end

local function goHome()
	for _, c in raidLayer:children() do
		c:destroy()
	end
	clearShots()
	raid = nil
	state.mode = "village"
	raidLayer.visible = false
	villageLayer.visible = true
	paintTiles("village")
	setGroup("result_ui", false)
	setGroup("village_ui", true)
	hudRaid.visible = false
	hint("Welcome home, Chief! Grow your village and raid again.")
	updateHud()
end

local function raidTap(cx, cy)
	if raid == nil or raid.over then
		return
	end
	if not isEdge(cx, cy) then
		ui.toast("Drop troops on the red edge tiles!", 1.2)
		return
	end
	autoSelect()
	local kind = state.selTroop
	if raid.army[kind] <= 0 then
		ui.toast("No troops left!", 1.2)
		return
	end
	Sim.deploy(raid, kind, cx, cy)
	autoSelect()
	refreshRaidButtons()
end

onCellTap = function(cx, cy)
	local now = time()
	if lastTap.cx == cx and lastTap.cy == cy and now - lastTap.t < 0.08 then
		return
	end
	lastTap.t, lastTap.cx, lastTap.cy = now, cx, cy
	if state.mode == "village" then
		villageTap(cx, cy)
	elseif state.mode == "raid" then
		raidTap(cx, cy)
	end
end

-- ---------- setup ----------
for cy = 0, G - 1 do
	for cx = 0, G - 1 do
		local s = spawn("Sprite2D", { position = cellCenter(cx, cy), size = vec2(T - 2, T - 2), texture = "asset:grass_tile", modulate = "#8bd65a", z_index = 0 }, tilesLayer)
		s.tapped:connect(function()
			onCellTap(cx, cy)
		end)
		tiles[idx(cx, cy)] = s
	end
end

for _, kind in BUILD_ORDER do
	local d = C.buildings[kind]
	local b = entity("btn_" .. kind)
	b.text = d.name .. "\n" .. d.cost .. " " .. (d.res == "gold" and "Gold" or "Elixir")
	b.pressed:connect(function()
		if state.mode == "village" then
			selectBuild(kind)
		end
	end)
end
entity("btn_remove").pressed:connect(function()
	state.removeMode = not state.removeMode
	state.buildMode = nil
	refreshBuildButtons()
	hint(state.removeMode and "Tap a building to remove it (half refund)" or "Remove mode off")
end)
entity("btn_cancel").pressed:connect(function()
	clearModes()
	hint("Tap a building to see what it does")
end)
for _, kind in TROOP_ORDER do
	local d = C.troops[kind]
	local b = entity("btn_train_" .. kind)
	b.text = "Train " .. d.name .. "\n" .. d.cost .. " Elixir"
	b.pressed:connect(function()
		if state.mode == "village" then
			train(kind)
		end
	end)
	entity("btn_sel_" .. kind).pressed:connect(function()
		if raid and raid.army[kind] > 0 then
			state.selTroop = kind
			refreshRaidButtons()
		end
	end)
end
entity("btn_raid").pressed:connect(function()
	if state.mode == "village" then
		startRaid()
	end
end)
entity("btn_end_raid").pressed:connect(finishRaid)
entity("result_home").pressed:connect(function()
	if state.mode == "result" then
		goHome()
	end
end)

-- starting village
placeVillage("townhall", 5, 5)
placeVillage("mine", 3, 5)
placeVillage("pump", 7, 5)
placeVillage("cannon", 5, 7)
placeVillage("barracks", 5, 3)

paintTiles("village")
setGroup("raid_ui", false)
setGroup("result_ui", false)
setGroup("village_ui", true)
hudRaid.visible = false
refreshBuildButtons()
updateHud()
hint("Train troops, then hit RAID! Build to grow your village.")
ui.toast("Welcome, Chief!", 2)

-- resource production
local prodTicks = 0
every(1, function()
	local cap = capacity()
	state.gold = math.min(cap, state.gold + countKind("mine") * C.buildings.mine.rate)
	state.elixir = math.min(cap, state.elixir + countKind("pump") * C.buildings.pump.rate)
	prodTicks += 1
	if prodTicks % 5 == 0 and state.mode == "village" then
		for _, b in village do
			local d = C.buildings[b.kind]
			if d.produces then
				local full = getRes(d.produces) >= cap
				floatText(cellCenter(b.cx, b.cy) - vec2(0, 20), full and "FULL" or ("+" .. d.rate * 5), resColor(d.produces))
			end
		end
	end
	updateHud()
end)

-- main loop
onTick(function(dt)
	if state.mode == "raid" and raid then
		simAcc += dt
		local steps = 0
		while simAcc >= C.SIM_DT and steps < 8 and not raid.over do
			simAcc -= C.SIM_DT
			steps += 1
			Sim.step(raid)
			handleEvents()
		end
		if raid.stars > lastStars then
			lastStars = raid.stars
			ui.toast("STAR EARNED! (" .. raid.stars .. "/3)", 1.2)
			shake(0.3)
		end
		if raid.over then
			finishRaid()
		else
			local alpha = math.min(1, simAcc / C.SIM_DT)
			for _, t in raid.troops do
				if t.alive and t.view then
					t.view.root.position = troopPos(t, alpha)
				end
			end
			updateRaidHud()
		end
	end

	for i = #shots, 1, -1 do
		local s = shots[i]
		s.t += dt
		local k = math.min(1, s.t / s.dur)
		s.e.position = s.from + (s.to - s.from) * k
		if k >= 1 then
			s.e:destroy()
			table.remove(shots, i)
		end
	end
	for i = #floaters, 1, -1 do
		local f = floaters[i]
		f.life -= dt
		f.y -= 40 * dt
		f.e.position = vec2(f.x, f.y)
		if f.life <= 0 then
			f.e:destroy()
			table.remove(floaters, i)
		end
	end
	if shakeTime > 0 then
		shakeTime -= dt
		if shakeTime > 0 then
			camera.position = CAM_BASE + vec2(random(-5, 5), random(-5, 5))
		else
			camera.position = CAM_BASE
		end
	end
end)
