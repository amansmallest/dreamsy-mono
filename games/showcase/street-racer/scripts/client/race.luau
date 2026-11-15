-- race.luau: owns the race. World build, countdown, car physics, AI, collisions, laps, HUD, results.
local C = require("../shared/config")
local Track = require("../shared/track")
local State = require("../shared/state")

local layer = entity("track_layer")
local cam = entity("race_cam")
local L = Track.length

local function sp(tex, x, y, w, h, rot, z, mod, parent)
	local props: any = { position = vec2(x, y), size = vec2(w, h), rotation = rot, z_index = z }
	if tex then props.texture = tex end
	if mod then props.modulate = mod end
	return spawn("Sprite2D", props, parent or layer)
end

-- scenery is grouped into 1024px chunks; only chunks near the camera stay visible
local CHUNK = 1024
local chunks = {}
local chunkList = {}
local function chunkFor(x, y)
	local cx, cy = math.floor(x / CHUNK), math.floor(y / CHUNK)
	local key = cx .. "," .. cy
	local ch = chunks[key]
	if not ch then
		ch = { e = spawn("Node2D", { position = vec2(0, 0) }, layer), cx = cx, cy = cy, vis = true }
		chunks[key] = ch
		table.insert(chunkList, ch)
	end
	return ch.e
end
local function cullChunks(camX, camY)
	for _, ch in chunkList do
		local x0, y0 = ch.cx * CHUNK, ch.cy * CHUNK
		local vis = camX + 800 > x0 and camX - 800 < x0 + CHUNK and camY + 520 > y0 and camY - 520 < y0 + CHUNK
		if vis ~= ch.vis then
			ch.vis = vis
			ch.e.visible = vis
		end
	end
end

local function wrapAngle(a)
	a = (a + math.pi) % (2 * math.pi)
	return a - math.pi
end

local function fmtTime(t)
	if not t then return "--:--.--" end
	local m = math.floor(t / 60)
	local s = math.floor(t % 60)
	local cs = math.floor((t * 100) % 100)
	return string.format("%02d:%02d.%02d", m, s, cs)
end

---------------------------------------------------------------- world
local minX, minY, maxX, maxY = Track.bounds()
local PAD = 800
spawn("Sprite2D", {
	position = vec2((minX + maxX) / 2, (minY + maxY) / 2),
	size = vec2(maxX - minX + PAD * 2 + 600, maxY - minY + PAD * 2 + 600),
	modulate = "#c6955b",
	z_index = -30,
}, layer)

for _, p in Track.pieces do
	if p.kind == "straight" then
		sp("asset:road_straight", p.x, p.y, 256, 256, p.rot, -10)
	else
		sp("asset:road_corner", p.x, p.y, 512, 512, p.rot, -11)
	end
end

local BLD = {
	{ "asset:bld_warehouse", 96 }, { "asset:bld_containers", 96 }, { "asset:bld_brown", 96 },
	{ "asset:bld_white", 96 }, { "asset:bld_warehouse", 96 }, { "asset:bld_containers", 96 },
}
local function placeCell(x, y)
	x += random(-8, 8)
	y += random(-8, 8)
	local d = Track.distance(x, y)
	if d > 196 then
		if math.random() < 0.15 then
			sp("asset:bld_small", x, y, 64, 64, math.random(0, 3) * 90, -20, nil, chunkFor(x, y))
		else
			local b = BLD[math.random(1, #BLD)]
			sp(b[1], x, y, b[2], b[2], math.random(0, 1) * 180, -20, nil, chunkFor(x, y))
		end
	elseif d > 174 then
		sp("asset:bld_small", x, y, 64, 64, math.random(0, 3) * 90, -20, nil, chunkFor(x, y))
	end
end
do
	local PADB = 700
	local gx = minX - PADB
	while gx <= maxX + PADB do
		local gy = minY - PADB
		while gy <= maxY + PADB do
			local d = Track.distance(gx, gy)
			if d > 322 then
				local tex = if math.random() < 0.5 then "asset:block_a" else "asset:block_b"
				sp(tex, gx, gy, 256, 256, math.random(0, 3) * 90, -20, nil, chunkFor(gx, gy))
			else
				for _, o in { { -64, -64 }, { 64, -64 }, { -64, 64 }, { 64, 64 } } do
					placeCell(gx + o[1], gy + o[2])
				end
			end
			gy += 256
		end
		gx += 256
	end
end

for _, cs in Track.cornerStarts do
	local x, y, tx, ty = Track.pointAt(cs - 220)
	local deg = math.deg(math.atan2(tx, -ty))
	for _, lat in { -60, 60 } do
		sp("asset:road_arrow", x - ty * lat, y + tx * lat, 32, 48, deg, -9)
	end
end

do
	local x, y, tx, ty = Track.pointAt(Track.startS)
	sp("asset:finish_line", x, y, 256, 16, math.deg(math.atan2(tx, -ty)), -9)
end

local oils = {}
for _, o in { { 0.2, -40 }, { 0.45, 45 }, { 0.66, -15 }, { 0.87, 55 } } do
	local x, y, tx, ty = Track.pointAt(L * o[1])
	x += -ty * o[2]
	y += tx * o[2]
	sp("asset:oil", x, y, 48, 32, math.deg(math.atan2(tx, -ty)) + 20, -8)
	table.insert(oils, { x = x, y = y })
end

---------------------------------------------------------------- cars
local cars = {}
local player

local function makeCar(tex, name, isPlayer, k, maxSpeed)
	local row = math.floor((k - 1) / 2)
	local lat = if k % 2 == 1 then -50 else 50
	local s = Track.startS - 80 - row * 100
	local x, y, tx, ty = Track.pointAt(s)
	x += -ty * lat
	y += tx * lat
	local a = math.atan2(tx, -ty)
	local car = {
		name = name, isPlayer = isPlayer, x = x, y = y, a = a, va = a, s = 0,
		sh = sp(tex, x + 3, y + 5, 32, 48, math.deg(a), 4, "#3b333877"),
		e = sp(tex, x, y, 32, 48, math.deg(a), 6),
		idx = 0, lastS = 0, prog = 0, lat = lat, tx = tx, ty = ty,
		maxSpeed = maxSpeed, lane = lat, laneTarget = lat, laneT = random(1, 3), target = maxSpeed,
		spin = 0, spinDir = 1, oilCD = 0, drifting = false, hardTurn = false,
		finished = false, finishT = 0, fxT = 0, wasAhead = true, lastPassProg = -99999, lastHit = -10,
	}
	local idx, ts = Track.closest(x, y, nil)
	car.idx = idx
	car.lastS = ts
	car.prog = ts - Track.startS
	table.insert(cars, car)
	return car
end

local RIVALS = {
	{ "asset:car_blue", "BLUE" }, { "asset:car_green", "GREEN" }, { "asset:car_orange", "ORANGE" },
	{ "asset:car_yellow", "YELLOW" }, { "asset:car_white", "WHITE" },
}
for i, r in RIVALS do
	makeCar(r[1], r[2], false, i, C.maxSpeed * C.aiFactors[6 - i])
end
player = makeCar("asset:car_red", "YOU", true, 6, C.maxSpeed)
if C.debugFast then
	for _, c in cars do c.prog += L * 0.55 end
end

---------------------------------------------------------------- fx
local parts = {}
local function particle(tex, x, y, vx, vy, life, size, z)
	if #parts > 140 then return end
	local e = sp(tex, x, y, size, size, random(0, 360), z)
	table.insert(parts, { e = e, x = x, y = y, vx = vx, vy = vy, life = life, max = life })
end

local function sparks(x, y, n)
	for _ = 1, n do
		local ang = random(0, math.pi * 2)
		local sp2 = random(120, 320)
		particle("asset:spark", x, y, math.cos(ang) * sp2, math.sin(ang) * sp2, random(0.2, 0.4), 12, 9)
	end
end

local function updateParticles(dt)
	for i = #parts, 1, -1 do
		local p = parts[i]
		p.life -= dt
		if p.life <= 0 then
			p.e:destroy()
			table.remove(parts, i)
		else
			p.x += p.vx * dt
			p.y += p.vy * dt
			p.vx *= 0.92
			p.vy *= 0.92
			p.e.position = vec2(p.x, p.y)
			p.e.modulate = string.format("#ffffff%02x", math.floor(255 * p.life / p.max))
		end
	end
end

---------------------------------------------------------------- physics
local function setVel(c, vx, vy)
	c.s = math.sqrt(vx * vx + vy * vy)
	if c.s > 1 then c.va = math.atan2(vx, -vy) end
end

local function drive(c, ta, thr, boost, dt)
	c.hardTurn = false
	if c.spin > 0 then
		c.spin -= dt
		c.a = wrapAngle(c.a + c.spinDir * 8 * dt)
		c.s = math.max(0, c.s - 250 * dt)
	else
		if ta then
			local diff = wrapAngle(ta - c.a)
			local rate = C.turnRate * math.clamp(0.4 + c.s / 320, 0.4, 1)
			c.a = wrapAngle(c.a + math.clamp(diff, -rate * dt, rate * dt))
			local ad = math.abs(diff)
			c.hardTurn = ad > 0.5
			if thr > 0 then
				if ad > 2.3 and c.s > 150 then
					c.s -= C.brake * dt
				else
					local acc = if boost then C.boostAccel else C.accel
					c.s += acc * thr * (0.35 + 0.65 * math.max(0, math.cos(diff))) * dt
				end
			end
		end
		if thr < 0 then
			c.s -= C.brake * 0.5 * dt
		elseif thr == 0 then
			c.s -= C.coast * dt
		end
	end
	local top = if boost then C.boostSpeed else c.maxSpeed
	if c.s > top then c.s = math.max(top, c.s - 420 * dt) end
	if c.s < 0 then c.s = 0 end
	local slip = wrapAngle(c.a - c.va)
	local k = C.grip
	if c.spin > 0 then
		k = 0.6
	elseif c.hardTurn and c.s > C.driftMin then
		k = C.driftGrip
	end
	c.va = wrapAngle(c.va + slip * (1 - math.exp(-k * dt)))
	local as = math.abs(slip)
	c.drifting = c.s > C.driftMin and as > 0.2 and c.spin <= 0
	if as > 0.15 then c.s -= c.s * C.driftDrag * as * dt end
	if as > 1.6 then c.s *= 0.94 end
	c.x += math.sin(c.va) * c.s * dt
	c.y -= math.cos(c.va) * c.s * dt
end

local function aiControl(c, dt)
	c.laneT -= dt
	if c.laneT <= 0 then
		c.laneT = random(1.5, 4)
		c.laneTarget = random(-70, 70)
	end
	for _, o in cars do
		if o ~= c then
			local dp = o.prog - c.prog
			if dp > 0 and dp < 140 and math.abs(o.lat - c.lane) < 44 then
				local want = if o.lat > 0 then o.lat - 80 else o.lat + 80
				c.laneTarget = math.clamp(want, -80, 80)
			end
		end
	end
	c.lane += (c.laneTarget - c.lane) * math.min(1, 2 * dt)
	local la = 110 + c.s * 0.35
	local x1, y1, tx1, ty1 = Track.pointAt(c.lastS + la)
	local _, _, tx2, ty2 = Track.pointAt(c.lastS + la + 260)
	local gx, gy = x1 - ty1 * c.lane, y1 + tx1 * c.lane
	local ta = math.atan2(gx - c.x, -(gy - c.y))
	local bend = math.abs(wrapAngle(math.atan2(tx2, -ty2) - math.atan2(c.tx, -c.ty)))
	local target = c.maxSpeed
	if bend > 0.6 then target = math.min(target, C.aiCornerSpeed) end
	if not c.isPlayer and not player.finished then
		local gap = c.prog - player.prog
		if gap > 900 then
			target *= 0.88
		elseif gap < -700 then
			target *= 1.08
		end
	end
	c.target = target
	local thr = 1
	if c.s > target + 40 then thr = -1 elseif c.s > target then thr = 0 end
	return ta, thr
end

---------------------------------------------------------------- race state
local phase = "countdown"
local cd = 3.5
local lastCd = 0
local raceT = 0
local lapStart = 0
local lapsDone = 0
local bestLap = nil
local points = 0
local boost = C.startBoost
local boosting = false
local shake = 0
local camX, camY = player.x, player.y - 100
local popupT = 0
local goT = 0
local driftAcc = 0
local skidT = 0
local wrongT = 0
local finishPlace = 6
local resultsT = -1

local textCache = {}
local function setText(id, t)
	if textCache[id] == t then return end
	textCache[id] = t
	local e = entity(id)
	if e then e.text = t end
	local s = entity(id .. "_sh")
	if s then s.text = t end
end
local function setVisible(id, v)
	local e = entity(id)
	if e then e.visible = v end
	local s = entity(id .. "_sh")
	if s then s.visible = v end
end

local function popup(t)
	setText("popup_text", t)
	setVisible("popup_text", true)
	popupT = 1.3
end

local ORD = { "1ST", "2ND", "3RD", "4TH", "5TH", "6TH" }

local function rankKey(c)
	if c.finished then return 1e9 - c.finishT end
	return c.prog
end

local function placeOf(c)
	local p = 1
	local k = rankKey(c)
	for _, o in cars do
		if o ~= c and rankKey(o) > k then p += 1 end
	end
	return p
end

local RESULTS = { "res_dim", "res_bg", "res_title", "res_place", "res_time", "res_best", "res_points", "res_msg", "btn_again", "btn_menu" }
local function showResults(v)
	for _, id in RESULTS do
		local e = entity(id)
		if e then e.visible = v end
	end
end
showResults(false)
setVisible("popup_text", false)
setVisible("wrong_text", false)

entity("btn_again").pressed:connect(function()
	sfx.play("select")
	loadScene("scenes/race.scene.json")
end)
entity("btn_menu").pressed:connect(function()
	sfx.play("select")
	loadScene("scenes/main.scene.json")
end)

music.play("race", { fade = 0.5 })

---------------------------------------------------------------- per-car track update
local function trackUpdate(c, dt)
	local idx, s, lat, nx, ny, tx, ty = Track.closest(c.x, c.y, c.idx)
	c.idx = idx
	c.tx = tx
	c.ty = ty
	local lim = C.railLimit
	if math.abs(lat) > lim then
		local sg = if lat > 0 then 1 else -1
		local ox, oy = nx * sg, ny * sg
		local over = math.abs(lat) - lim
		c.x -= ox * over
		c.y -= oy * over
		lat = lim * sg
		local vx, vy = math.sin(c.va) * c.s, -math.cos(c.va) * c.s
		local vn = vx * ox + vy * oy
		if vn > 0 then
			vx -= ox * vn * 1.35
			vy -= oy * vn * 1.35
			setVel(c, vx, vy)
			c.s *= 0.95
			c.a = wrapAngle(c.a + wrapAngle(c.va - c.a) * 0.4)
			if vn > 60 then
				sparks(c.x + ox * 18, c.y + oy * 18, math.clamp(math.floor(vn / 50), 3, 8))
				if c.isPlayer then
					sfx.play("crash", { volume = math.min(1, vn / 300) })
					shake = math.max(shake, math.min(14, vn / 25))
					c.lastHit = raceT
				end
			end
		end
	end
	c.lat = lat
	local ds = s - c.lastS
	if ds > L / 2 then ds -= L elseif ds < -L / 2 then ds += L end
	c.prog += ds
	c.lastS = s

	if c.oilCD > 0 then c.oilCD -= dt end
	if c.oilCD <= 0 and c.spin <= 0 then
		for _, o in oils do
			local dx, dy = c.x - o.x, c.y - o.y
			if dx * dx + dy * dy < 30 * 30 then
				c.spin = 0.75
				c.spinDir = if random() < 0.5 then -1 else 1
				c.oilCD = 1.5
				c.s *= 0.8
				if c.isPlayer then
					sfx.play("oil")
					popup("OIL SLICK!")
					c.lastHit = raceT
				end
			end
		end
	end

	if not c.isPlayer and not c.finished and c.prog >= C.LAPS * L then
		c.finished = true
		c.finishT = raceT
	end
end

local function carCollisions()
	local D = C.carRadius * 2
	for i = 1, #cars do
		local a = cars[i]
		for j = i + 1, #cars do
			local b = cars[j]
			local dx, dy = b.x - a.x, b.y - a.y
			local d2 = dx * dx + dy * dy
			if d2 < D * D and d2 > 0.01 then
				local d = math.sqrt(d2)
				local nx, ny = dx / d, dy / d
				local push = (D - d) * 0.5
				a.x -= nx * push
				a.y -= ny * push
				b.x += nx * push
				b.y += ny * push
				local avx, avy = math.sin(a.va) * a.s, -math.cos(a.va) * a.s
				local bvx, bvy = math.sin(b.va) * b.s, -math.cos(b.va) * b.s
				local rel = (bvx - avx) * nx + (bvy - avy) * ny
				if rel < 0 then
					local imp = -1.4 * rel * 0.5
					setVel(a, avx - nx * imp, avy - ny * imp)
					setVel(b, bvx + nx * imp, bvy + ny * imp)
					if -rel > 50 then
						sparks((a.x + b.x) / 2, (a.y + b.y) / 2, 5)
						if a.isPlayer or b.isPlayer then
							sfx.play("bump")
							shake = math.max(shake, math.min(10, -rel / 30))
							player.lastHit = raceT
						end
					end
				end
			end
		end
	end
end

---------------------------------------------------------------- HUD
local function updateHud()
	setText("hud_points", tostring(points) .. " PTS")
	setText("hud_pos", ORD[placeOf(player)] .. " / 6")
	setText("hud_lap", "LAP " .. math.clamp(lapsDone + 1, 1, C.LAPS) .. "/" .. C.LAPS)
	local cur = if phase == "countdown" then 0 else raceT - lapStart
	if player.finished then cur = 0 end
	setText("hud_cur", "CURRENT " .. fmtTime(cur))
	setText("hud_best", "BEST    " .. fmtTime(bestLap))
	setText("hud_speed", tostring(math.floor(player.s * C.kmh)) .. " KM/H")
	local segs = math.ceil(boost * 10 - 0.001)
	for i = 1, 10 do
		local e = entity("hud_boost_" .. i)
		if e then
			local col = "#3b3338cc"
			if i <= segs then
				col = if boosting then "#f4f4f0" else (if i <= 3 then "#e0a030" else "#ffd84a")
			end
			if textCache["b" .. i] ~= col then
				textCache["b" .. i] = col
				e.background = col
			end
		end
	end
end

local function finishRace()
	player.finished = true
	player.finishT = raceT
	phase = "done"
	finishPlace = placeOf(player)
	points += C.placeBonus[finishPlace]
	sfx.play("finish")
	popup("FINISH!")
	if not State.bestTime or raceT < State.bestTime then State.bestTime = raceT end
	if bestLap and (not State.bestLap or bestLap < State.bestLap) then State.bestLap = bestLap end
	State.lastPoints = points
	resultsT = 1.6
	setText("res_place", ORD[finishPlace] .. " PLACE")
	setText("res_time", "TIME  " .. fmtTime(raceT))
	setText("res_best", "BEST LAP  " .. fmtTime(bestLap))
	setText("res_points", "POINTS  " .. points .. "  (+" .. C.placeBonus[finishPlace] .. " place bonus)")
	local msg = "CHAMPION OF THE CITY!"
	if finishPlace == 2 or finishPlace == 3 then
		msg = "ON THE PODIUM! GO FOR GOLD!"
	elseif finishPlace > 3 then
		msg = "USE BOOST AND DRIFTS - TRY AGAIN!"
	end
	setText("res_msg", msg)
end

---------------------------------------------------------------- main loop
local function syncSprites()
	for _, c in cars do
		local deg = math.deg(c.a)
		c.e.position = vec2(c.x, c.y)
		c.e.rotation = deg
		c.sh.position = vec2(c.x + 3, c.y + 5)
		c.sh.rotation = deg
	end
end

onTick(function(dt)
	if phase == "countdown" then
		cd -= dt
		local n = math.min(3, math.ceil(cd))
		if cd <= 0 then
			phase = "race"
			setText("countdown_text", "GO!")
			sfx.play("go")
			goT = 0.9
		elseif n ~= lastCd then
			lastCd = n
			setText("countdown_text", tostring(n))
			sfx.play("beep")
		end
	else
		if goT > 0 then
			goT -= dt
			if goT <= 0 then setVisible("countdown_text", false) end
		end
		if not player.finished then raceT += dt end

		-- player input
		local ta, thr = nil, 0
		local wantBoost = false
		if player.finished or C.debugFast then
			ta, thr = aiControl(player, dt)
		else
			local sx, sy = input.axis("move_x"), input.axis("move_y")
			local m = math.sqrt(sx * sx + sy * sy)
			if m > 0.25 then
				ta = math.atan2(sx, -sy)
				thr = math.min(1, m)
			end
			wantBoost = (input.held("action") or input.held("jump")) and boost > 0.01 and player.spin <= 0
			if wantBoost and not ta then
				ta = player.a
				thr = 1
			end
		end
		if wantBoost and not boosting then sfx.play("boost") end
		boosting = wantBoost
		if boosting then boost = math.max(0, boost - C.boostDrain * dt) end
		drive(player, ta, thr, boosting, dt)
		for _, c in cars do
			if not c.isPlayer then
				local a, t = aiControl(c, dt)
				drive(c, a, t, false, dt)
			end
		end
		carCollisions()
		for _, c in cars do
			trackUpdate(c, dt)
		end

		-- drift rewards
		if player.drifting and not player.finished then
			boost = math.min(1, boost + C.driftFill * dt)
			driftAcc += dt
			if driftAcc >= 0.5 then
				driftAcc -= 0.5
				points += C.driftPoints
			end
			skidT -= dt
			if skidT <= 0 then
				skidT = 0.25
				sfx.play("skid")
			end
		else
			driftAcc = 0
		end

		-- overtakes
		if not player.finished then
			local pk = rankKey(player)
			for _, c in cars do
				if not c.isPlayer then
					local ahead = rankKey(c) > pk
					if c.wasAhead and not ahead and player.prog > c.lastPassProg + 600 then
						c.lastPassProg = player.prog
						if raceT - player.lastHit > 1.2 then
							points += C.passPoints
							boost = math.min(1, boost + C.passFill)
							popup("CLEAN PASS +" .. C.passPoints)
						else
							points += C.dirtyPassPoints
							popup("PASS +" .. C.dirtyPassPoints)
						end
						sfx.play("pass")
					end
					c.wasAhead = ahead
				end
			end
		end

		-- laps
		if not player.finished then
			local done = math.floor(player.prog / L)
			if done > lapsDone then
				lapsDone = done
				local lt = raceT - lapStart
				lapStart = raceT
				local newBest = not bestLap or lt < bestLap
				if newBest then bestLap = lt end
				if lapsDone >= C.LAPS then
					finishRace()
				else
					sfx.play("lap")
					if lapsDone == C.LAPS - 1 then
						popup("FINAL LAP!")
					elseif newBest then
						popup("NEW BEST LAP!")
					else
						popup("LAP " .. (lapsDone + 1))
					end
				end
			end
		end

		-- wrong way
		local fx, fy = math.sin(player.a), -math.cos(player.a)
		if fx * player.tx + fy * player.ty < -0.4 and player.s > 60 and not player.finished then
			wrongT += dt
		else
			wrongT = 0
		end
		setVisible("wrong_text", wrongT > 0.8)

		-- particles from cars
		for _, c in cars do
			c.fxT -= dt
			if c.fxT <= 0 then
				local rx, ry = c.x - math.sin(c.a) * 22, c.y + math.cos(c.a) * 22
				if c.isPlayer and boosting then
					particle("asset:flame", rx + random(-4, 4), ry + random(-4, 4), -math.sin(c.a) * 80, math.cos(c.a) * 80, 0.18, 14, 5)
					c.fxT = 0.03
				elseif c.drifting or c.spin > 0 then
					particle("asset:smoke", rx + random(-8, 8), ry + random(-8, 8), random(-20, 20), random(-20, 20), 0.5, 16, 3)
					c.fxT = 0.06
				else
					c.fxT = 0.1
				end
			end
		end

		if popupT > 0 then
			popupT -= dt
			if popupT <= 0 then setVisible("popup_text", false) end
		end

		if resultsT > 0 then
			resultsT -= dt
			if resultsT <= 0 then
				showResults(true)
				music.play("title", { fade = 1 })
			end
		end
	end

	updateParticles(dt)
	syncSprites()
	updateHud()

	-- camera with look-ahead and shake
	local lx = math.sin(player.va) * player.s * 0.4
	local ly = -math.cos(player.va) * player.s * 0.4
	local tx, ty = player.x + lx, player.y + ly
	local f = math.min(1, 5 * dt)
	camX += (tx - camX) * f
	camY += (ty - camY) * f
	local ox, oy = 0, 0
	if shake > 0.2 then
		ox, oy = random(-shake, shake), random(-shake, shake)
		shake *= 0.88
	else
		shake = 0
	end
	cam.position = vec2(math.floor(camX + ox), math.floor(camY + oy))
	cullChunks(camX, camY)
end)
