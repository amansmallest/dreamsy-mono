local cfg = require("../shared/config")
local run = require("../shared/run")
local decor = require("../shared/decor")

local params = sceneParams()
local levelNum = tonumber(params.level) or 1
run.level = levelNum
local L = data.read("data/levels/level_" .. levelNum .. ".json")
local T = cfg.TILE

local world = entity("world")
local layer = entity("blocks_layer")
local hero = entity("hero")
local heroSpr = entity("hero_sprite")
local camTarget = entity("cam_target")
local cam = entity("camera")
local hintPanel = entity("hint_panel")
local hintText = entity("hint_text")
local banner = entity("banner")

run.frozen = true
music.play("sky_tune")

---------------------------------------------------------------- fx
local function emitter(props)
	props.emitting = false
	props.z_index = 40
	return spawn("Particles2D", props, world)
end
local fx = {
	puff = emitter({ shape = "circle", start_color = color("#ffffff"), end_color = color("#dcecf800"), speed = 150, spread = 360, lifetime = 0.8, start_size = 22, end_size = 6, damping = 3, max_particles = 64 }),
	dust = emitter({ shape = "circle", start_color = color("#fff1d0"), end_color = color("#fff1d000"), speed = 70, spread = 360, lifetime = 0.35, start_size = 7, end_size = 2, damping = 4, max_particles = 64 }),
	spark = emitter({ shape = "circle", start_color = color("#ffe3f0"), end_color = color("#ff5fa800"), speed = 120, spread = 360, lifetime = 0.5, start_size = 8, end_size = 1, damping = 2, max_particles = 64, blend = "add" }),
	confetti = emitter({ shape = "square", start_color = color("#ffd84a"), end_color = color("#ff5fa800"), speed = 280, direction = -90, spread = 80, gravity = vec2(0, 520), lifetime = 1.4, start_size = 8, end_size = 5, max_particles = 200 }),
}
local fxCount = { puff = 26, dust = 10, spark = 16, confetti = 70 }
run.fx = function(kind, p, n)
	local e = fx[kind]
	if not e then return end
	e.position = p
	e:burst(n or fxCount[kind])
end

---------------------------------------------------------------- hud
local hintTimer = nil
local function showHint(text, secs)
	hintText.text = text
	hintPanel.visible = true
	hintPanel.scale = vec2(0.7, 0.7)
	tween(hintPanel, { scale = vec2(1, 1) }, 0.25, "back_out")
	if hintTimer then hintTimer:cancel(); hintTimer = nil end
	if secs then
		hintTimer = after(secs, function()
			hintPanel.visible = false
			hintTimer = nil
		end)
	end
end
-- a hint that stays until the player does the thing ("move" / "jump")
local waitFor = nil
local waitStart = nil
local waitJumps = 0
local function waitHint(text, what)
	showHint(text, nil)
	waitFor = what
	waitStart = hero.position
	waitJumps = run.jumps or 0
end

local hearts = cfg.HEARTS
local function updateHearts()
	for i = 1, cfg.HEARTS do
		local h = entity("hud_heart_" .. i)
		if h then h.image = (i <= hearts) and "asset:heart_full" or "asset:heart_empty" end
	end
end

local gems = {}
local got = 0
local function updateGems()
	entity("hud_gems").text = got .. "/" .. #gems
end
entity("hud_level").text = "Level " .. levelNum

---------------------------------------------------------------- build
local blocks = {}
local crumbles = {}
local startBlock = nil
local cols = 0
local rows = #L.rows
local function key(c, r) return c .. "," .. r end

local TEX = {
	N = "asset:block_stone", P = "asset:block_stone", C = "asset:block_check",
	F = "asset:block_goal", X = "asset:block_crumble", S = "asset:block_spring",
}

local function has(flags, ch) return string.find(flags, ch, 1, true) ~= nil end

local function makeGem(pos, top, high)
	local z = top + (high and cfg.GEM_HIGH or cfg.GEM_LOW)
	local area = spawn("Area2D", { position = pos, z = z, height = 20, size = vec2(24, 24), layer = "ghost", mask = "ghost" }, layer)
	local s = spawn("Sprite2D", { texture = "asset:gem", size = vec2(22, 26), anchor = "bottom" }, area)
	tween(s, { z = 6 }, 0.7, { easing = "sine_in_out", loop = true, yoyo = true })
	table.insert(gems, { area = area, spr = s, pos = pos, z = z, taken = false })
end

local function makeBlock(c, r, h, flags)
	local kind = "N"
	for _, k in ipairs({ "F", "S", "X", "C", "P" }) do
		if has(flags, k) then kind = k; break end
	end
	local w = has(flags, "n") and cfg.NARROW or T
	local d = has(flags, "w") and cfg.NARROW or T
	local pos = vec2(c * T + T / 2, r * T + T / 2)
	local body = spawn("Body2D", { position = pos, body = "static", size = vec2(w, d), height = h, layer = "block", mask = "hero" }, layer)
	local spr = spawn("Sprite2D", { texture = TEX[kind], size = vec2(w, d), height = h }, body)
	local b = { c = c, r = r, pos = pos, top = h, kind = kind, body = body, spr = spr }
	blocks[key(c, r)] = b
	if kind == "P" then startBlock = b end
	if kind == "X" then table.insert(crumbles, b) end
	if kind == "C" or kind == "P" then
		b.flag = spawn("Sprite2D", { texture = kind == "P" and "asset:pennant_on" or "asset:pennant_off", size = vec2(28, 40), anchor = "bottom", position = pos + vec2(-20, 6), z = h }, layer)
	elseif kind == "F" then
		b.flag = spawn("Sprite2D", { texture = "asset:goal_flag", size = vec2(40, 64), anchor = "bottom", position = pos + vec2(14, 4), z = h }, layer)
		tween(b.flag, { scale = vec2(1.08, 0.95) }, 0.6, { easing = "sine_in_out", loop = true, yoyo = true })
	elseif kind == "N" and w == T and d == T and random() < 0.5 then
		spawn("Sprite2D", { texture = random() < 0.5 and "asset:tuft" or "asset:flower", size = vec2(16, 12), anchor = "bottom", position = pos + vec2(random(-22, 22), random(4, 24)), z = h }, layer)
	end
	if has(flags, "g") then makeGem(pos, h, false) end
	if has(flags, "j") then makeGem(pos, h, true) end
end

for r, line in ipairs(L.rows) do
	local c = 0
	for tok in string.gmatch(line, "%S+") do
		if tok ~= "." then
			local h = (tonumber(string.sub(tok, 1, 1), 16) or 1) * cfg.UNIT
			makeBlock(c, r - 1, h, string.sub(tok, 2))
		end
		c += 1
	end
	cols = math.max(cols, c)
end
updateGems()
updateHearts()

-- backdrop
local levelW, levelH = cols * T, rows * T
local sky = decor.sky(world)
decor.clouds(world, -260, levelW + 260, -900, levelH + 400, rows * 3 + 30)
local far = spawn("Node2D", {}, world)
for i = 1, 12 do
	local s = random(0.6, 1.2)
	spawn("Sprite2D", { texture = "asset:far_island", size = vec2(96 * s, 64 * s), position = vec2(random(-150, levelW * 0.5 + 150), random(-450, levelH * 0.5 + 200)), z_index = -15, modulate = color("#ffffffcc"), flip_h = random() < 0.5 }, far)
end

-- camera
cam.limit_min = vec2(levelW / 2 - 240, -1000)
cam.limit_max = vec2(levelW / 2 + 240, levelH + 200)

---------------------------------------------------------------- hero placement
local function placeHero(b, dropZ)
	hero.position = b.pos
	hero.velocity = vec2(0, 0)
	hero.z = b.top + (dropZ or 0)
	hero.z_velocity = 0
	run.grace = time() + 0.3
end
local spawnBlock = startBlock
if params.startCol and params.startRow then
	spawnBlock = blocks[key(params.startCol, params.startRow)] or startBlock
end
placeHero(spawnBlock, 0)
local checkpoint = spawnBlock
local camZ = hero.z
camTarget.position = vec2(hero.position.x, hero.position.y - camZ - 60)
camera.snap()

---------------------------------------------------------------- crumbles
local function resetCrumbles()
	for _, b in ipairs(crumbles) do
		if b.tw1 then b.tw1:cancel(); b.tw1 = nil end
		if b.tw2 then b.tw2:cancel(); b.tw2 = nil end
		b.state = nil
		b.body.z = 0
		b.body.layer = "block"
		b.body.mask = "hero"
		b.spr.modulate = color("#ffffff")
		b.spr.position = vec2(0, 0)
	end
end

local function updateCrumbles(dt)
	for _, b in ipairs(crumbles) do
		if b.state == "shake" then
			b.t += dt
			b.spr.position = vec2(random(-2.5, 2.5), random(-1.5, 1.5))
			if b.t >= cfg.CRUMBLE_TIME then
				b.state = "gone"
				b.spr.position = vec2(0, 0)
				b.body.layer = "ghost"
				b.body.mask = "ghost"
				b.tw1 = tween(b.body, { z = -260 }, 0.8, "quad_in")
				b.tw2 = tween(b.spr, { modulate = color("#ffffff00") }, 0.8, "quad_in")
				sfx.play("crumble")
				run.fx("dust", b.pos - vec2(0, b.top), 16)
			end
		end
	end
end

---------------------------------------------------------------- win / lose
local won = false
local function win()
	won = true
	run.frozen = true
	hintPanel.visible = false
	sfx.play("win")
	run.fx("confetti", hero.position - vec2(0, hero.z + 20))
	camera.shake(3, 0.3)
	banner.text = "Level clear!"
	banner.visible = true
	banner.scale = vec2(0.3, 0.3)
	tween(banner, { scale = vec2(1, 1) }, 0.4, "back_out")
	hero.z_velocity = 300
	run.gems[levelNum] = math.max(run.gems[levelNum] or 0, got)
	save.set("gems_" .. levelNum, math.max(save.get("gems_" .. levelNum, 0), got))
	save.set("unlocked", math.max(save.get("unlocked", 1), math.min(levelNum + 1, cfg.LEVELS)))
	if levelNum == 1 then save.set("tutorial_done", true) end
	after(2.6, function()
		if levelNum < cfg.LEVELS then
			loadScene("scenes/level.scene.json", { level = levelNum + 1 })
		else
			loadScene("scenes/win.scene.json")
		end
	end)
end

local function gameOver()
	sfx.play("gameover")
	local p = entity("gameover_panel")
	p.visible = true
	p.scale = vec2(0.5, 0.5)
	tween(p, { scale = vec2(1, 1) }, 0.35, "back_out")
end
entity("go_retry").pressed:connect(function()
	sfx.play("select")
	loadScene("scenes/level.scene.json", { level = levelNum, skipIntro = true })
end)
entity("go_menu").pressed:connect(function()
	sfx.play("select")
	leaderboard.cancel()
	loadScene("scenes/main.scene.json")
end)

run.fell = function()
	if run.frozen then return end
	run.frozen = true
	hearts -= 1
	updateHearts()
	local hh = entity("hud_heart_" .. (hearts + 1))
	if hh then
		hh.scale = vec2(1.5, 1.5)
		tween(hh, { scale = vec2(1, 1) }, 0.3, "back_out")
	end
	sfx.play("fall")
	run.fx("puff", hero.position)
	camera.shake(5, 0.35)
	heroSpr.visible = false
	if hearts > 0 then
		showHint("Oops! Fell into the clouds. Watch your shadow!", 3)
	else
		hintPanel.visible = false
	end
	after(0.9, function()
		if hearts <= 0 then
			gameOver()
			return
		end
		resetCrumbles()
		placeHero(checkpoint, 70)
		heroSpr.visible = true
		run.frozen = false
	end)
end

---------------------------------------------------------------- standing on blocks
local springCD = 0
local function onStand(b)
	if (b.kind == "C" or b.kind == "P") and checkpoint ~= b then
		checkpoint = b
		if b.kind == "C" then
			b.flag.texture = "asset:pennant_on"
			b.flag.scale = vec2(1.4, 1.4)
			tween(b.flag, { scale = vec2(1, 1) }, 0.3, "back_out")
			sfx.play("checkpoint")
			run.fx("spark", b.pos - vec2(0, b.top + 20))
			if not hintPanel.visible and not run.cpHintShown then
				run.cpHintShown = true
				showHint("Checkpoint! If you fall, you come back here.", 3)
			end
		end
	elseif b.kind == "S" and time() > springCD then
		springCD = time() + 0.3
		hero.z_velocity = cfg.SPRING
		sfx.play("spring")
		camera.shake(2, 0.15)
		b.spr.modulate = color("#fff3a0")
		tween(b.spr, { modulate = color("#ffffff") }, 0.3)
		run.fx("dust", b.pos - vec2(0, b.top), 14)
		if cfg.DEBUG then print("SPRING at row", b.r) end
	elseif b.kind == "X" and not b.state then
		b.state = "shake"
		b.t = 0
		sfx.play("crack")
	elseif b.kind == "F" and not won then
		win()
	end
end

---------------------------------------------------------------- start
local bestRow = spawnBlock.r
local lastProgress = time()
local shown = {}

local function begin()
	run.frozen = false
	run.grace = time() + 0.3
	lastProgress = time()
	if levelNum == 1 then leaderboard.start("full_run") end
	if L.start_hint then
		if L.start_wait then waitHint(L.start_hint, L.start_wait) else showHint(L.start_hint, 5) end
	end
end

if params.skipIntro then
	begin()
else
	local lines = {}
	for _, t in ipairs(L.intro) do
		table.insert(lines, { text = t, speaker = "Pip", portrait = "asset:pip_portrait" })
	end
	local d = ui.dialog(lines)
	d.done:connect(begin)
end

---------------------------------------------------------------- tick
onTick(function(dt)
	-- camera follows the drawn hero (ground pos lifted by a smoothed height)
	local tz = hero.onGround and hero.groundZ or math.min(camZ, hero.z)
	camZ += (tz - camZ) * math.min(1, dt * 3)
	camTarget.position = vec2(hero.position.x, hero.position.y - camZ - 60)
	local cc = camera.center()
	sky.position = cc
	far.position = cc * 0.5

	updateCrumbles(dt)
	if run.frozen then return end

	local c = math.floor(hero.position.x / T)
	local r = math.floor(hero.position.y / T)
	if r < bestRow then
		bestRow = r
		lastProgress = time()
	end
	for i, h in ipairs(L.hints) do
		if not shown[i] and bestRow <= h.row then
			shown[i] = true
			if h.wait then waitHint(h.text, h.wait) else showHint(h.text, 5) end
		end
	end
	if waitFor == "move" and (hero.position - waitStart):length() > 40 then
		waitFor = nil
		showHint("Nice! Keep walking up.", 1.5)
	elseif waitFor == "jump" and (run.jumps or 0) > waitJumps then
		waitFor = nil
		showHint("Great jump!", 1.5)
	end
	if time() - lastProgress > 9 then
		lastProgress = time()
		showHint(L.idle_hint or "Head up toward the golden flag!", 4)
	end

	if hero.onGround and hero.groundZ > 1 then
		local b = blocks[key(c, r)]
		if b and b.state ~= "gone" and math.abs(b.top - hero.groundZ) < 3 then
			onStand(b)
		end
	end

	for _, g in ipairs(gems) do
		if not g.taken then
			local dd = hero.position - g.pos
			if math.abs(dd.x) < 26 and math.abs(dd.y) < 26 and hero.z < g.z + 20 and hero.z + cfg.HERO_H > g.z then
				g.taken = true
				got += 1
				updateGems()
				sfx.play("gem", { pitch = 1 + got * 0.05 })
				run.fx("spark", g.pos - vec2(0, g.z + 10))
				local icon = entity("hud_gem_icon")
				icon.scale = vec2(1.4, 1.4)
				tween(icon, { scale = vec2(1, 1) }, 0.3, "back_out")
				local pop = spawn("Text2D", { text = "+1", font_size = 22, font = "bold", color = color("#ffffff"), outline = color("#d63384"), outline_size = 3, position = g.pos + vec2(0, 2), z = g.z + 24, z_index = 50 }, world)
				tween(pop, { z = g.z + 64, color = color("#ffffff00") }, 0.7, "quad_out")
				after(0.75, function() if not pop.destroyed then pop:destroy() end end)
				local tw = tween(g.spr, { scale = vec2(1.8, 1.8), modulate = color("#ffffff00") }, 0.25)
				tw.done:connect(function() if not g.area.destroyed then g.area:destroy() end end)
				if cfg.DEBUG then print("GEM", got, "/", #gems) end
			end
		end
	end
end)
