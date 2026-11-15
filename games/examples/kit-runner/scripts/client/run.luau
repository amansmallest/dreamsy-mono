-- Pebble Dash: title + endless runner (runner kit). Swipe left/right to change lanes, up (or tap) to jump, down to slide.
local core = require("@kit/core")
local R = require("@kit/runner")
local juice = require("@kit/juice")
local G = require("../shared/game")
local config = require("../shared/config")
G.init()

local bg, track = entity("bg"), entity("track")
local hudDist, hudCoins, hudPower, msg, title = entity("hud_dist"), entity("hud_coins"), entity("hud_power"), entity("msg_text"), entity("title_text")
local SPRITES = { player = "asset:runner", shadow = "asset:shadow", block = "asset:crate", low = "asset:hurdle", high = "asset:gate", coin = "asset:coin",
	gem = "asset:gem", magnet = "asset:magnet", shield = "asset:shield", double = "asset:double", bubble = "asset:bubble" }

local sim, view = nil, nil
local decor = {}
local mode = "title" -- "title" (attract run behind the menu) | "run" | "over"
local ctl = R.controls.new()
local botState = {}
local botSkill = { reaction = 0.3, miss = 0.01 }
local biomeId = nil
local tick = 0
local showTitle, startRun -- forward

local function say(text: string, secs: number?)
	msg.text = text
	local mine = text
	after(secs or 1.5, function() if msg.text == mine then msg.text = "" end end)
end

local function setBiome(b)
	if b.id == biomeId then return end
	biomeId = b.id
	bg.texture = b.bg or "asset:bg_meadow"
	table.clear(decor)
	for _, d in b.decor or {} do table.insert(decor, d) end
	if mode == "run" then say(b.name, 1.4) music.play(b.music or "run") end
end

local function newSim(s)
	if view then view.destroy() end
	sim = s
	biomeId = nil
	setBiome(R.track.biomeAt(0))
	view = R.view.endless(sim, { root = track, sprites = SPRITES, decor = decor, horizon = 300, playerY = 1000 })
	local ch = R.meta.character()
	if ch and ch.tint then view.player.modulate = color(ch.tint) end
	botState = {}
end

local function hud()
	if mode ~= "run" or not sim then hudDist.text = "" hudCoins.text = "" hudPower.text = "" return end
	hudDist.text = `{math.floor(sim.dist)} m`
	hudCoins.text = `{sim.coins}c`
	local p = {}
	if sim.power.magnet > 0 then table.insert(p, `MAGNET {math.ceil(sim.power.magnet)}`) end
	if sim.power.double > 0 then table.insert(p, `2X {math.ceil(sim.power.double)}`) end
	if sim.power.shield > 0 then table.insert(p, "SHIELD") end
	hudPower.text = table.concat(p, "   ")
end

local function handleEvents(events)
	for _, e in events do
		local n = e.name
		if mode ~= "run" then continue end
		if n == "jump" then sfx.play("jump") juice.stretch(view.player, { amount = 0.15 })
		elseif n == "slide" then sfx.play("slide")
		elseif n == "lane" then sfx.play("lane", { volume = 0.5 })
		elseif n == "coin" then if tick % 3 == 0 then sfx.play("coin", { pitch = if e.kind == "gem" then 1.5 else 1 }) end
		elseif n == "powerup" then sfx.play("power") say(string.upper(e.kind) .. "!", 1) juice.punch(view.player, 0.3)
		elseif n == "shieldBreak" then sfx.play("shield") juice.shake("light") say("Shield saved you!", 1)
		elseif n == "dead" then sfx.play("hit") juice.shake("heavy") juice.flash(view.player, "#ff5d5d", 0.3)
		end
	end
end

local function summaryScreen(sum)
	local m = core.menus
	local h = m.modal(640, 760, if sum.newBest then "NEW BEST!" else "Run over", { pause = false })
	local lines = { `{sum.distance} m`, `Best {sum.best} m`, `+{sum.coins} coins   (bank {R.coins()})` }
	for _, def in sum.missions or {} do table.insert(lines, "Mission done: " .. def.text) end
	if sum.daily then table.insert(lines, "Daily challenge complete!") elseif sum.dailyTarget then table.insert(lines, `Daily target: {sum.dailyTarget} m`) end
	for i, l in lines do m.text(h.box, l, { offset = vec2(0, 96 + (i - 1) * 62), size = vec2(600, 56), font_size = if i == 1 then 52 else 28, color = if i == 1 then "#ffd23f" else "#ffffff" }) end
	m.button(h.box, "Run again", function() h.close() startRun(sim.daily ~= nil) end, { anchor = "bottom", offset = vec2(0, -128), size = vec2(560, 96) })
	m.button(h.box, "Menu", function() h.close() showTitle() end, { anchor = "bottom", offset = vec2(0, -20), size = vec2(560, 96), background = "#5a5470" })
end

local function endRun()
	mode = "over"
	local sum = R.finish(sim)
	print(`run over: {sum.distance} m coins {sum.coins} best {sum.best} missions {#sum.missions} tier {sum.tier}`)
	hud()
	if config.bot then after(0.5, function() startRun(false) end) return end
	after(1.0, function() summaryScreen(sum) end)
end

function startRun(daily: boolean?)
	title.visible = false
	newSim(R.newRun({ daily = daily, seed = config.seed }))
	mode = "run"
	music.play("run")
	say(if daily then (sim.daily.modifier and sim.daily.modifier.name or "Daily") .. `\nreach {sim.daily.target} m` else "GO!", 1.2)
end

------------------------------------------------------------------ menus
local function charactersMenu()
	local h
	local function items()
		local out = {}
		for _, c in R.characters() do
			local tag = if c.selected then "ON" elseif c.owned then "owned" else c.cost .. "c"
			table.insert(out, { label = c.def.name, detail = tag, onSelect = function()
				if not c.owned then
					local ok = R.buyCharacter(c.id)
					if not ok then core.menus.toast("Need " .. c.cost .. " coins", 1.2) h.refresh(items()) return end
					sfx.play("power")
				end
				R.selectCharacter(c.id)
				core.save.save()
				sfx.play("select")
				h.refresh(items())
			end })
		end
		return out
	end
	h = core.menus.list({ title = `Runners  ({R.coins()}c)`, items = items(), keepOpen = true, pause = false, onClose = function() showTitle() end })
end

local function missionsMenu()
	local items = {}
	for _, m in R.missions() do table.insert(items, { label = m.text, detail = `{math.floor(m.progress)}/{m.target}`, fontSize = 22, disabled = not m.done }) end
	core.menus.list({ title = "Missions", items = items, pause = false, onClose = function() showTitle() end })
end

local function stagesMenu()
	local items = {}
	for i, st in R.stages() do
		local rec = R.stageRecord(st.id)
		local open = R.stageUnlocked(i)
		table.insert(items, { label = st.name, detail = if rec then string.format("%.1fs", rec.best) elseif open then "new" else "locked", disabled = not open, onSelect = function()
			G.stageIndex = i
			loadScene("scenes/obby.scene.json", { stage = st.id })
		end })
	end
	core.menus.list({ title = "Obby stages", items = items, pause = false, onClose = function() showTitle() end })
end

function showTitle()
	mode = "title"
	title.visible = true
	newSim(R.endless.new({ seed = 7, params = R.params() }))
	music.play("run")
	hud()
	if config.bot then
		if config.botMode == "obby" then
			local st = config.stage or R.stages()[1].id
			after(0.1, function() loadScene("scenes/obby.scene.json", { stage = st }) end)
		else
			after(0.1, function() startRun(false) end)
		end
		return
	end
	local d = R.daily()
	core.menus.list({ title = `Best {R.best()} m  ·  {R.coins()}c`, closeLabel = false, pause = false, offsetY = 160, items = {
		{ label = "RUN", onSelect = function() sfx.play("select") startRun(false) end },
		{ label = if d.done then "Daily: done!" else `Daily: {d.modifier and d.modifier.name or ""} {d.target}m`, fontSize = 26, disabled = d.done, onSelect = function() startRun(true) end },
		{ label = "Obby stages", onSelect = function() stagesMenu() end },
		{ label = "Runners", onSelect = function() charactersMenu() end },
		{ label = "Missions", onSelect = function() missionsMenu() end },
	} })
end

------------------------------------------------------------------ tick
onTick(function(dt: number)
	if not sim then return end
	tick += 1
	local action = nil
	if mode == "run" then
		if config.bot then action = R.endless.botAction(sim, botState, botSkill) else action = ctl:poll() end
	elseif mode == "title" then
		action = R.endless.botAction(sim, botState, botSkill) -- attract mode
		if not sim.alive then newSim(R.endless.new({ seed = tick, params = R.params() })) end
	end
	if mode ~= "over" then
		local ev = sim:step(dt, action)
		handleEvents(ev)
		setBiome(R.track.biomeAt(sim.dist))
	end
	view.update()
	if mode == "run" then
		if tick % 30 == 0 then
			for _, def in R.progress(sim:summary(), false) do say("Mission: " .. def.text, 2) sfx.play("mission") end
		end
		if not sim.alive then endRun() end
	end
	hud()
end)

showTitle()
