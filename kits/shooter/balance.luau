--!nonstrict
-- Headless pacing / balance estimates (pure): stage length, enemy HP vs expected DPS, boss time-to-kill,
-- bullet density, credits vs shop prices, and the whole campaign's play time.
local Emitter = require("./emitter")
local Weapons = require("./weapons")
local Stage = require("./stage")
local M = {}

-- bullets per second of an emitter (2 s preview, ignores delay)
function M.bulletRate(def)
	local d = table.clone(def)
	d.delay = 0
	d.duration = nil
	return #Emitter.preview(d, 2, { x = 0, y = 0, tx = 0, ty = 100 }) / 2
end

--[[ stage(C, id, opts?) -> row
   opts: { weapon = id (ship weapon), level = 1, accuracy = 0.7, procgen? (arena waves) }
   row: { id, mode, enemies, enemyHp, scriptLength (s), killTime (s of pure shooting), tanky = { ids whose on-screen time < TTK },
          boss?, bossHp, bossTTK, bossPhases, peakBullets (/s), maxScore, credits, est (s) } ]]
function M.stage(C, id, opts)
	opts = opts or {}
	local def = C.stages[id]
	local wdef = C.weapons[opts.weapon or C.ships[C.config.startShip].weapon or C.weaponsOrder[1]]
	local dps = Weapons.dps(wdef, opts.level or 1, opts.accuracy)
	local tl = Stage.timeline(def, C.enemies, opts.procgen)
	local row = { id = id, mode = def.mode or "shmup", enemies = 0, enemyHp = 0, killTime = 0, tanky = {}, maxScore = 0, peakBullets = 0,
		credits = (def.reward and def.reward.credits) or 0, dps = dps }
	local last = 0
	for _, e in tl do
		last = math.max(last, e.t)
		local d = C.enemies[e.id or ""]
		if e.kind == "enemy" and d then
			row.enemies += 1
			row.enemyHp += d.hp or 1
			row.maxScore += d.score or 100
			row.credits += ((d.drops and d.drops.coins) or 0)
			local ttk = (d.hp or 1) / dps
			row.killTime += ttk
			local sp = (e.path and e.path.speed) or (d.path and d.path.speed) or d.speed or 120
			local onScreen = if (d.path and d.path.kind == "stop") or (e.path and e.path.kind == "stop") then ((d.path and d.path.hold) or 2) + 2 else 1100 / sp
			if row.mode == "shmup" and ttk > onScreen and not table.find(row.tanky, e.id) then table.insert(row.tanky, e.id) end
			for _, em in d.emitters or {} do
				local ed = if type(em) == "string" then C.emitters[em] else em
				row.peakBullets = math.max(row.peakBullets, M.bulletRate(ed))
			end
		elseif e.kind == "boss" and d then
			row.boss = e.id
			row.bossHp = d.hp or 100
			row.bossTTK = row.bossHp / (dps * 0.85)
			row.bossPhases = #(d.phases or {})
			row.maxScore += d.score or 10000
			local rate = 0
			for _, ph in d.phases or {} do
				for _, st in ph.pattern or {} do
					for _, em in st.emitters or (if st.emitter then { st.emitter } else {}) do
						local ed = if type(em) == "string" then C.emitters[em] else em
						rate = math.max(rate, M.bulletRate(ed))
					end
				end
			end
			row.peakBullets = math.max(row.peakBullets, rate)
		end
	end
	row.scriptLength = last
	-- arena waves wait for clears: time ≈ shooting time (+ spawn gaps); shmup: the script runs on its clock
	local body = if row.mode == "arena" then math.max(last * 0.5, row.killTime * 1.3) + last * 0.5 else last
	row.est = body + (row.bossTTK or 0) + 4
	return row
end

--[[ campaign(C, opts?) -> { rows, total (s, one clear), withRetries (s), shopSpend, creditsEarned, ok, notes }
   opts: { stages? (default config.campaign + arenas), retries = 0.6 (expected extra attempts per stage), shopSeconds = 30,
           accuracy = 0.7, levelPerStage = 1 (power ups gained per stage), procgen?, target = {3600, 7200} } ]]
function M.campaign(C, opts)
	opts = opts or {}
	local ids = opts.stages
	if ids == nil then
		ids = table.clone(C.config.campaign)
		for _, id in C.stagesOrder do if not table.find(ids, id) then table.insert(ids, id) end end
	end
	local rows, total, credits = {}, 0, 0
	local wdef = C.weapons[C.ships[C.config.startShip].weapon or C.weaponsOrder[1]]
	local maxL = Weapons.maxLevel(wdef)
	for i, id in ids do
		local lvl = math.min(maxL, 1 + math.floor((i - 1) * (opts.levelPerStage or 1)))
		local r = M.stage(C, id, { level = lvl, accuracy = opts.accuracy, procgen = opts.procgen })
		r.level = lvl
		table.insert(rows, r)
		total += r.est
		credits += r.credits
	end
	local shopCost = 0
	for _, it in C.config.shop do shopCost += (it.cost or 0) * math.min(it.max or 1, 3) end
	local retries = opts.retries or 0.6
	local withRetries = total * (1 + retries) + (opts.shopSeconds or 30) * #ids
	local target = opts.target or { 3600, 7200 }
	local notes = {}
	for _, r in rows do
		if #r.tanky > 0 then table.insert(notes, r.id .. ": enemies outlive their screen time: " .. table.concat(r.tanky, ", ")) end
		if r.bossTTK and (r.bossTTK < 20 or r.bossTTK > 150) then table.insert(notes, r.id .. ": boss time-to-kill " .. math.floor(r.bossTTK) .. "s (aim 30–120)") end
	end
	return { rows = rows, total = total, withRetries = withRetries, creditsEarned = credits, shopSpend = shopCost,
		ok = withRetries >= target[1] and withRetries <= target[2], notes = notes }
end

function M.fmt(s)
	s = math.floor(s + 0.5)
	if s >= 3600 then return string.format("%dh %02dm", s // 3600, (s % 3600) // 60) end
	return string.format("%dm %02ds", s // 60, s % 60)
end

return M
