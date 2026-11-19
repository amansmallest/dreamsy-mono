--!nonstrict
-- survival runtime: one call turns a Sim into a playable portrait game.
--   map (TileMap2D, tileset defines every biome/node/structure/POI char), player (Body2D tagged "player"),
--   HUD (needs bars, clock, night counter), hotbar + craft menu + build mode, night overlay + fire glow,
--   night threats (ai chase + combat contact, they break walls), death/respawn, autosave.
local core = require("@kit/core")
local juice = require("@kit/juice")
local combat = require("@kit/combat")
local ai = require("@kit/ai")
local Content = require("./content")

local V = {}

local NEED_COLORS = { health = "#e5484d", hunger = "#f0a03c", thirst = "#4aa3ff", temperature = "#ffd166" }
local NEED_ICONS = { health = "HP", hunger = "Food", thirst = "Water", temperature = "Warm" }

local function itemName(C, id)
	local it = C.items[id]
	if it and it.name then return it.name end
	local s = string.gsub(id, "_", " ")
	return (string.gsub(s, "^%l", string.upper))
end
V.itemName = itemName

local function costText(C, needs)
	local keys = {}
	for k in needs do table.insert(keys, k) end
	table.sort(keys)
	local parts = {}
	for _, k in keys do table.insert(parts, needs[k] .. " " .. itemName(C, k)) end
	return table.concat(parts, ", ")
end
V.costText = costText

--[[ play(s, opts) -> handle
  opts: { map = TileMap2D (default entity("map")), player = Body2D (default first "player"-tagged),
          hotbar = 5 (slots), glow = "asset:glow"? (sprite under fires at night), stashSprite = "asset:..."?,
          ghost = "#..."? , autosave = 30 (s; 0 = off), sfx = { hit, break, craft, build, hurt, night, dawn, pickup }?,
          onAction?(name, data) (extension: "gather"/"craft"/"build"/"kill"/"night"/"dawn"), toasts = true } ]]
function V.play(s, opts)
	opts = opts or {}
	local C, cfg = s.C, s.cfg
	local TS = cfg.world.tile
	local map = opts.map or entity("map")
	local player = opts.player or entitiesTagged("player")[1]
	local SFX = opts.sfx or {}
	local function play(id) if id then juice.sfx(id) end end
	local function toast(t, sec) if opts.toasts ~= false then core.menus.toast(t, sec or 1.4) end end
	local H = { s = s, enemies = {}, selected = nil, building = nil, markers = {} }

	local objects = opts.objects -- optional second TileMap2D drawn above `map`: map = biomes, objects = nodes/structures/POIs
	map.tile_size = TS
	map.position = vec2(0, 0)
	map.data = s:tileString(if objects then "ground" else nil)
	if objects then
		objects.tile_size = TS
		objects.position = vec2(0, 0)
		objects.data = s:tileString("objects")
	end
	local function cellCenter(x, y) return vec2((x + 0.5) * TS, (y + 0.5) * TS) end
	local function cellOf(p) return math.floor(p.x / TS), math.floor(p.y / TS) end
	player.position = cellCenter(s.player.x, s.player.y)
	pcall(camera.snap)

	-- enemy path grid (doors + walls block); rebuilt cell by cell on tile changes
	local function gridText()
		local rows = {}
		for y = 0, s.world.h - 1 do
			local r = table.create(s.world.w)
			for x = 0, s.world.w - 1 do r[x + 1] = if s:passable(x, y, true) then "." else "#" end
			rows[y + 1] = table.concat(r)
		end
		return table.concat(rows, "\n")
	end
	local grid = ai.grid(gridText(), { solid = "#", tileSize = TS })
	H.grid = grid
	local glows = {}
	local function refreshGlow(x, y)
		if not opts.glow then return end
		local key = x .. "," .. y
		local st = s:structureAt(x, y)
		local warm = st and C.structuresById[st.id].warmth
		if warm and not glows[key] then
			local r = C.structuresById[st.id].radius
			glows[key] = spawn("Sprite2D", { texture = opts.glow, position = cellCenter(x, y), size = vec2((r * 2 + 1) * TS, (r * 2 + 1) * TS), modulate = color("#ffb34700"), z_index = 41 })
		elseif not warm and glows[key] then
			glows[key]:destroy()
			glows[key] = nil
		end
	end
	for _, st in s.structures do refreshGlow(st.x, st.y) end
	s.onTile = function(x, y)
		if objects then objects:setTile(x, y, s:tileChar(x, y, "objects")) else map:setTile(x, y, s:tileChar(x, y)) end
		grid:block(x, y, not s:passable(x, y, true))
		refreshGlow(x, y)
	end

	-- combat: the hero fighter never dies in combat; damage is routed into the Sim's health need
	combat.reset()
	local hero = combat.add(player, { hp = 100000, team = "player", iframes = 0.7, destroyOnDeath = false, radius = TS * 0.35 })
	H.hero = hero
	combat.on("hit", function(info)
		if info.target == hero and (info.dealt or 0) > 0 then
			hero:heal(info.dealt)
			s:hurt(info.dealt, "monsters")
			play(SFX.hurt)
			juice.shake("light")
		elseif info.target ~= hero and (info.amount or 0) > 0 then
			play(SFX.hit)
			if info.target.entity then juice.flash(info.target.entity) end
		end
	end)
	combat.on("death", function(f)
		if f == hero then return end
		local d = f.data and f.data.def
		if d then
			for _, dr in d.drops or {} do
				local n = if type(dr.count) == "table" then dr.count[1] else (dr.count or 1)
				s.bag:add(dr.item, n)
				if f.entity and not f.entity.destroyed then juice.popup("+" .. n .. " " .. itemName(C, dr.item), f.entity.position, { size = 26 }) end
			end
			core.emit("enemy_defeated", { enemy = d.id })
			if opts.onAction then opts.onAction("kill", { enemy = d.id }) end
		end
		for i, e in H.enemies do if e.f == f then table.remove(H.enemies, i) break end end
	end)

	local function spawnEnemy(id, cx, cy)
		local d = C.enemiesById[id]
		if not d then return end
		local size = (d.size or 0.7) * TS
		local body = spawn("Body2D", { position = cellCenter(cx, cy), body = "dynamic", gravity_scale = 0, lock_rotation = true, friction = 0,
			shape = "circle", size = vec2(size, size), z_index = 6, layer = opts.enemyLayer, mask = opts.enemyMask })
		spawn("Sprite2D", { texture = d.sprite, size = vec2(size * 1.25, size * 1.25), modulate = d.tint }, body)
		body:addTag("enemy")
		local f = combat.add(body, { hp = d.hp or 3, team = "enemy", contact = d.contact or { amount = d.damage or 8, knockback = 140 }, radius = size / 2,
			data = { def = d } })
		local spec = table.clone(d)
		spec.params = table.clone(d.params or {})
		spec.params.aggro = spec.params.aggro or 2000
		spec.params.leash = spec.params.leash or 4000
		spec.params.speed = spec.params.speed or d.speed or 70
		local ctl = ai.attach(body, spec, { grid = grid, target = player, sight = false,
			canAct = function() return not f:busy() and not core.pause.isPaused() end,
			speedMult = function() return f:speedMult() end, hp = function() return f.hp, f.maxHp end })
		table.insert(H.enemies, { e = body, f = f, ctl = ctl, def = d, chew = 0 })
		juice.dust(body.position)
	end
	H.spawnEnemy = spawnEnemy

	s.onNight = function(n, wave)
		toast("Night " .. n .. " — " .. #wave.ids .. " shadows stir", 2.2)
		print("night " .. n .. " wave " .. #wave.ids)
		play(SFX.night)
		for _, sp in wave.spawns do after(sp.delay + 1, function() if s:isNight() then spawnEnemy(sp.id, sp.x, sp.y) end end) end
		if opts.onAction then opts.onAction("night", { night = n, wave = wave }) end
	end
	s.onDawn = function(n)
		toast("Dawn! You survived night " .. n, 2)
		play(SFX.dawn)
		for _, e in H.enemies do
			if not e.e.destroyed then
				combat.remove(e.f)
				juice.fadeOut(e.e, 0.6, true)
			end
		end
		H.enemies = {}
		core.save.save()
		if opts.onAction then opts.onAction("dawn", { night = n }) end
	end
	s.onDeath = function(cause, stash, at)
		toast(if cause == "monsters" then "You were overwhelmed…" else "You collapsed from " .. cause .. "…", 2.4)
		player.position = cellCenter(at.x, at.y)
		player.velocity = vec2(0, 0)
		pcall(camera.snap)
		juice.blink(player, 1.2)
		if opts.stashSprite and #stash.items > 0 then
			local m = spawn("Sprite2D", { texture = opts.stashSprite, position = cellCenter(stash.x, stash.y), size = vec2(TS * 0.8, TS * 0.8), z_index = 3 })
			table.insert(H.markers, { e = m, stash = stash })
		end
	end

	-- ---------- HUD ----------
	local hud = spawn("UIPanel", { anchor = "top_left", offset = vec2(16, 16), size = vec2(560, 148), background = "#10131cb0", input_transparent = true, z_index = 200 })
	H.hud = hud
	local bars = {}
	local order = { "health", "hunger", "thirst", "temperature" }
	for i, k in order do
		local col = (i - 1) % 2
		local row = (i - 1) // 2
		local x, y = 16 + col * 272, 14 + row * 40
		spawn("UIText", { anchor = "top_left", offset = vec2(x, y), size = vec2(80, 32), text = NEED_ICONS[k], font_size = 20, color = "#f7f3e9" }, hud)
		spawn("UIPanel", { anchor = "top_left", offset = vec2(x + 74, y + 6), size = vec2(170, 20), background = "#00000088", input_transparent = true }, hud)
		bars[k] = spawn("UIPanel", { anchor = "top_left", offset = vec2(x + 76, y + 8), size = vec2(166, 16), background = NEED_COLORS[k], input_transparent = true }, hud)
	end
	local clock = spawn("UIText", { anchor = "top_left", offset = vec2(16, 98), size = vec2(330, 36), text = "", font_size = 24, color = "#ffd166" }, hud)
	local nightTxt = spawn("UIText", { anchor = "top_left", offset = vec2(330, 98), size = vec2(220, 36), text = "", font_size = 22, color = "#c9d6ff", align = "right" }, hud)
	local objective = spawn("UIText", { anchor = "top_left", offset = vec2(20, 172), size = vec2(560, 34), text = "", font_size = 22, color = "#ffffff",
		outline = "#000000", outline_size = 3, z_index = 200 })
	H.objective = objective
	-- darkness: a world-space sheet over the whole map (z 40); fire glows draw above it (z 41) so they read as light
	local WW, WH = s.world.w * TS, s.world.h * TS
	local overlay = spawn("Sprite2D", { position = vec2(WW / 2, WH / 2), size = vec2(WW + 1600, WH + 1600), modulate = color("#0b103000"), z_index = 40 })
	local function needFrac(k)
		local n, d = s.needs[k], cfg.needs[k]
		if k == "temperature" then
			local mid = (d.min + d.max) / 2
			return math.clamp(1 - math.abs(n - mid) / ((d.max - d.min) / 2 + 6), 0, 1)
		end
		return math.clamp(n / d.max, 0, 1)
	end
	local function refreshHud()
		for k, b in bars do
			local f = needFrac(k)
			b.size = vec2(math.max(2, 166 * f), 16)
			if k == "temperature" then
				local d = cfg.needs.temperature
				b.background = if s.needs.temperature < d.min then "#7cc4ff" elseif s.needs.temperature > d.max then "#ff6b3d" else NEED_COLORS.temperature
			end
		end
		local ph = s:phase()
		clock.text = s:clockText() .. (if ph == "dusk" then "  dusk" elseif ph == "night" then "  night" else "")
		nightTxt.text = if s.stats.nightsSurvived > 0 then "Nights " .. s.stats.nightsSurvived else ""
		if opts.objectives ~= false then
			local m = s:nextMilestone()
			objective.text = if m then "Goal: " .. (m.label or m.id) else (opts.doneText or "You tamed the isle!")
		end
		local dark = s:darkness()
		overlay.modulate = string.format("#0b1030%02x", math.floor(dark * 165))
		for _, g in glows do g.modulate = string.format("#ffb347%02x", math.floor(dark * 110)) end
	end
	H.refreshHud = refreshHud

	-- ---------- hotbar ----------
	local SLOTS = opts.hotbar or 5
	local bar = spawn("UIPanel", { anchor = "bottom", offset = vec2(0, -310), size = vec2(700, 112), background = "#10131cb0", z_index = 210 })
	local slotBtns = {}
	local craftBtn = spawn("UIButton", { anchor = "left", offset = vec2(8, 0), size = vec2(124, 96), text = "Craft", font_size = 28, background = "#c46b2e", color = "#fff8ec" }, bar)
	H.craftButton = craftBtn
	for i = 1, SLOTS do
		local b = spawn("UIButton", { anchor = "left", offset = vec2(140 + (i - 1) * 110, 0), size = vec2(102, 96), text = "", font_size = 20, background = "#2b3142", color = "#ffffff",
			icon_position = "top" }, bar)
		slotBtns[i] = b
	end
	local hotItems = {}
	local ghost = spawn("Sprite2D", { size = vec2(TS, TS), modulate = color("#7dff7a66"), z_index = 8, visible = false })
	local function refreshBar()
		hotItems = {}
		-- placeables + food + tools first
		local list = s.bag:list()
		table.sort(list, function(a, b)
			local function rank(id)
				local d = Content.itemData(C, id)
				return if d.place then 0 elseif d.food then 1 elseif d.tool or d.weapon then 2 else 3
			end
			local ra, rb = rank(a.id), rank(b.id)
			if ra ~= rb then return ra < rb end
			return a.id < b.id
		end)
		for i = 1, SLOTS do
			local st = list[i]
			local b = slotBtns[i]
			hotItems[i] = st and st.id
			if st then
				local def = C.items[st.id]
				b.icon = if def and def.icon then def.icon else nil
				b.text = (if def and def.icon then "" else string.sub(itemName(C, st.id), 1, 7) .. " ") .. "x" .. st.count
				b.background = if H.selected == st.id then "#4f8a5b" else "#2b3142"
			else
				b.icon = nil
				b.text = ""
				b.background = "#2b314288"
			end
		end
	end
	H.refreshBar = refreshBar
	local function select(i)
		local id = hotItems[i]
		if not id then return end
		local d = Content.itemData(C, id)
		if d.food then
			if s:consume(id) then play(SFX.pickup) juice.popup("Yum", player.position + vec2(0, -50), { size = 26 }) end
			H.selected, H.building = nil, nil
		elseif d.place then
			if H.selected == id then H.selected, H.building = nil, nil
			else H.selected, H.building = id, d.place toast("Build: tap a tile next to you (or press Use)", 1.6) end
		else
			H.selected = if H.selected == id then nil else id
			H.building = nil
		end
		refreshBar()
	end
	for i, b in slotBtns do b.pressed:connect(function() select(i) end) end
	s.bag.onChange = function() refreshBar() end

	local function openCraft()
		local items = {}
		local list = s:recipeList()
		table.sort(list, function(a, b)
			local ra, rb = (if a.state == "ready" then 0 else 1), (if b.state == "ready" then 0 else 1)
			if ra ~= rb then return ra < rb end
			if a.depth ~= b.depth then return a.depth < b.depth end
			return a.id < b.id
		end)
		for _, r in list do
			local label = itemName(C, r.gives or r.def.gives)
			local state = r.state
			local detail = costText(C, r.def.needs)
			if state == "station" then detail = "at " .. itemName(C, r.def.station)
			elseif state == "locked" then detail = "locked" end
			table.insert(items, { label = label, detail = detail, disabled = state ~= "ready", recipe = r.id,
				onSelect = function(it, h)
					local ok, why, missing = s:craft(it.recipe)
					if ok then
						play(SFX.craft)
						toast("Crafted " .. label, 1)
						if opts.onAction then opts.onAction("craft", { recipe = it.recipe }) end
					elseif why == "items" then
						local m = missing[1]
						toast("Need " .. (m.need - m.have) .. " more " .. itemName(C, m.item), 1.4)
					else
						toast("Can't craft: " .. tostring(why), 1.2)
					end
				end })
		end
		core.menus.list({ title = "Crafting", items = items, perPage = 6, keepOpen = false })
	end
	H.openCraft = openCraft
	craftBtn.pressed:connect(openCraft)

	-- ---------- interaction ----------
	local facing = { x = 0, y = 1 }
	local swingCd = core.timers.cooldown(cfg.player.swing)
	local function tryPlace(x, y)
		if not H.building then return false end
		local ok, why = s:canPlace(H.building, x, y, { reach = 2 })
		if ok then
			s:place(H.building, x, y)
			play(SFX.build)
			juice.dust(cellCenter(x, y))
			if opts.onAction then opts.onAction("build", { structure = H.building, x = x, y = y }) end
			if not s.bag:has(H.selected, 1) then H.selected, H.building = nil, nil end
			refreshBar()
			return true
		end
		local msg = { terrain = "Can't build on that ground", occupied = "Something is in the way", player = "Step aside first",
			limit = "You can only build " .. (C.structuresById[H.building].limit or 0), adjacent = "Must touch a " .. tostring(C.structuresById[H.building].adjacent),
			reach = "Too far away", item = "Out of " .. itemName(C, H.selected or "") }
		toast(msg[why] or tostring(why), 1.2)
		return false
	end
	local function interactCell(x, y)
		if s:nodeAt(x, y) then
			if not swingCd.use() then return true end
			local r = s:hit(x, y)
			local p = cellCenter(x, y)
			if not r.ok then
				local def = C.nodesById[s:nodeAt(x, y).id]
				toast("Needs a " .. (if def.tier > 1 then "better " else "") .. tostring(def.tool), 1.2)
				return true
			end
			juice.shake("tiny")
			play(SFX.hit)
			juice.dust(p, { n = 5 })
			if r.broken then
				play(SFX["break"])
				for i, d in r.drops do juice.popup("+" .. d.count .. " " .. itemName(C, d.item), p + vec2(0, -30 - i * 28), { size = 26, color = "#fff3c4" }) end
				if opts.onAction then opts.onAction("gather", r) end
			end
			return true
		end
		local poi = s:poiAt(x, y)
		if poi and not poi.found then
			local loot = s:discover(x, y)
			local d = C.poisById[poi.id]
			juice.sparkle(cellCenter(x, y))
			play(SFX.pickup)
			local parts = {}
			for _, l in loot or {} do table.insert(parts, l.count .. " " .. itemName(C, l.item)) end
			toast((d.message or ("Found " .. (d.name or poi.id))) .. (if #parts > 0 then ": " .. table.concat(parts, ", ") else ""), 2)
			return true
		end
		local st = s:structureAt(x, y)
		if st then
			local d = C.structuresById[st.id]
			if d.kind == "station" or d.kind == "fire" then openCraft() return true end
			if d.kind == "bed" then toast("Your bed — you respawn here", 1.2) return true end
		end
		local items = s:collectStash(x, y)
		if items then
			toast("Recovered your things", 1.2)
			play(SFX.pickup)
			for i = #H.markers, 1, -1 do
				local m = H.markers[i]
				if table.find(s.stashes, m.stash) == nil then m.e:destroy() table.remove(H.markers, i) end
			end
			return true
		end
		return false
	end
	local function useAction()
		-- attack enemies in reach first
		local near = combat.query(player.position.x, player.position.y, TS * 1.3, { hostileTo = hero })
		if #near > 0 then
			if swingCd.use() then
				local _, wd = nil, nil
				local dmg = cfg.player.damage
				for _, st in s.bag:list() do
					local w = Content.itemData(C, st.id).weapon
					if w and (w.damage or 0) > dmg then dmg = w.damage end
				end
				local t = near[1]
				local tx, ty = t:pos()
				local dx, dy = tx - player.position.x, ty - player.position.y
				combat.swing(hero, { dir = { x = dx, y = dy }, range = TS * 1.3, arc = 140, amount = dmg, knockback = 200 })
				play(SFX.swing)
			end
			return
		end
		local px, py = s.player.x, s.player.y
		if H.building then
			if tryPlace(px + facing.x, py + facing.y) then return end
			return
		end
		if interactCell(px + facing.x, py + facing.y) then return end
		for _, d in { { 0, 0 }, { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 }, { 1, 1 }, { -1, 1 }, { 1, -1 }, { -1, -1 } } do
			if interactCell(px + d[1], py + d[2]) then return end
		end
	end
	H.use = useAction
	local lastTap = ""
	local function onTap(col, row)
		local key = col .. "," .. row .. "@" .. string.format("%.3f", time())
		if key == lastTap then return end -- both maps may report the same tap
		lastTap = key
		if H.building then tryPlace(col, row) return end
		if s:distance(col, row) <= 1 then interactCell(col, row) end
	end
	map.tileTapped:connect(onTap)
	if objects then objects.tileTapped:connect(onTap) end

	-- ---------- tick ----------
	local hudT, saveT = 0, 0
	local autosave = opts.autosave or 30
	onTick(function(dt)
		if core.pause.isPaused() or juice.stopped() then
			player.velocity = vec2(0, 0)
			return
		end
		local mx, my = input.axis("move_x"), input.axis("move_y")
		local len = math.sqrt(mx * mx + my * my)
		if len > 1 then mx, my = mx / len, my / len end
		local speed = cfg.player.speed * (if s.needs.hunger <= 0 or s.needs.thirst <= 0 then 0.6 else 1)
		player.velocity = vec2(mx * speed, my * speed)
		if len > 0.3 then
			if math.abs(mx) > math.abs(my) then facing = { x = if mx > 0 then 1 else -1, y = 0 } else facing = { x = 0, y = if my > 0 then 1 else -1 } end
		end
		local cx, cy = cellOf(player.position)
		s:setPlayer(cx, cy)
		s:tick(dt)
		if input.pressed("action") then useAction() end
		if input.pressed("action2") then openCraft() end
		-- ghost for build mode
		if H.building then
			local gx, gy = cx + facing.x, cy + facing.y
			ghost.visible = true
			ghost.position = cellCenter(gx, gy)
			ghost.modulate = if s:canPlace(H.building, gx, gy, { reach = 2 }) then "#7dff7a66" else "#ff5a5a66"
		else
			ghost.visible = false
		end
		-- night threats chew through structures they bump into
		for _, e in H.enemies do
			if not e.e.destroyed then
				e.chew += dt
				if e.chew >= 1 then
					e.chew = 0
					local ex, ey = cellOf(e.e.position)
					for _, d in { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } } do
						local st = s:structureAt(ex + d[1], ey + d[2])
						if st and not s:passable(ex + d[1], ey + d[2], true) then
							if s:damageStructure(ex + d[1], ey + d[2], e.def.breakDamage or 4) then juice.dust(cellCenter(ex + d[1], ey + d[2])) end
							break
						end
					end
				end
			end
		end
		hudT += dt
		if hudT >= 0.2 then hudT = 0 refreshHud() end
		if autosave > 0 then
			saveT += dt
			if saveT >= autosave then saveT = 0 core.save.save() end
		end
	end)
	refreshHud()
	refreshBar()
	return H
end

return V
