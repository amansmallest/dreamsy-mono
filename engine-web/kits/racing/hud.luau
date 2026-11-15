--!nonstrict
-- Portrait race HUD: lap, position, timer, best/split, mini-map, speed + nitro bar, countdown, banners, results podium.
-- Built from engine UI entities; theme from ui.theme() (dreamsy.toml [ui]) unless opts.theme. Read-only to the sim.
local U = require("./util")
local M = {}

local function theme(o)
	local t = { primary = "#e4572e", accent = "#ffd23f", background = "#1d2340", text = "#ffffff", font = "bold" }
	if type(ui) == "table" and type(ui.theme) == "function" then
		local ok, th = pcall(ui.theme)
		if ok and type(th) == "table" then for k, v in th do if type(v) == "string" then t[k] = v end end end
	end
	for k, v in o or {} do t[k] = v end
	if t.font == "default" then t.font = "bold" end
	return t
end
M.theme = theme

local function text(parent, props)
	local p = { size = vec2(200, 48), font_size = 32, color = "#ffffff", outline = "#00000099", outline_size = 3, z_index = 50 }
	for k, v in props do p[k] = v end
	return spawn("UIText", p, parent)
end
local function panel(parent, props)
	local p = { background = "#00000000", z_index = 40, input_transparent = true }
	for k, v in props do p[k] = v end
	return spawn("UIPanel", p, parent)
end
M.text, M.panel = text, panel

-- new(race, track, { theme?, minimap = true, speedScale = 0.36 (px/s → km/h), playerId? }) -> hud with :update(dt) :banner(text, s?) :results(list, opts)
function M.new(race, track, o)
	o = o or {}
	local th = theme(o.theme)
	local h = { race = race, track = track, th = th, cache = {}, bannerT = 0, speedScale = o.speedScale or 0.36, acc = 0 }
	local top = panel(nil, { offset = vec2(0, 0), size = vec2(720, 128), background = string.sub(th.background, 1, 7) .. "cc" })
	h.top = top
	text(top, { offset = vec2(20, 8), size = vec2(120, 30), font_size = 22, text = "LAP", color = th.accent, font = th.font })
	h.lap = text(top, { offset = vec2(20, 36), size = vec2(170, 64), font_size = 50, text = "1/3", font = th.font })
	text(top, { offset = vec2(200, 8), size = vec2(170, 30), font_size = 22, text = "POS", color = th.accent, font = th.font })
	h.pos = text(top, { offset = vec2(200, 30), size = vec2(170, 76), font_size = 64, text = "1st", font = th.font })
	h.posOf = text(top, { offset = vec2(318, 62), size = vec2(80, 40), font_size = 26, text = "/4", color = th.text, font = th.font })
	text(top, { offset = vec2(400, 8), size = vec2(200, 30), font_size = 22, text = "TIME", color = th.accent, font = th.font })
	h.time = text(top, { offset = vec2(400, 34), size = vec2(210, 44), font_size = 36, text = "0:00.00", font = th.font })
	h.best = text(top, { offset = vec2(400, 80), size = vec2(210, 34), font_size = 22, text = "BEST --:--.--", color = th.text, font = th.font })
	h.split = text(nil, { offset = vec2(400, 132), size = vec2(300, 40), font_size = 28, text = "", font = th.font, z_index = 51 })
	-- mini-map
	if o.minimap ~= false then
		local W, H = 150, 230
		local mm = panel(nil, { offset = vec2(12, 140), size = vec2(W + 12, H + 12), background = string.sub(th.background, 1, 7) .. "88" })
		local x0, y0, x1, y1 = track:bounds()
		local sc = math.min(W / (x1 - x0), H / (y1 - y0))
		local ox, oy = 6 + (W - (x1 - x0) * sc) / 2, 6 + (H - (y1 - y0) * sc) / 2
		h.mm = { panel = mm, sc = sc, ox = ox - x0 * sc, oy = oy - y0 * sc, dots = {} }
		for _, p in track:sample(48) do
			panel(mm, { offset = vec2(h.mm.ox + p.x * sc - 3, h.mm.oy + p.y * sc - 3), size = vec2(6, 6), background = "#ffffff77", z_index = 41 })
		end
		local fx, fy = track:pointAt(track.startS0)
		panel(mm, { offset = vec2(h.mm.ox + fx * sc - 6, h.mm.oy + fy * sc - 2), size = vec2(12, 4), background = "#ffffff", z_index = 42 })
		for _, r in race.racers do
			local c = if r.player then th.accent else (r.color or "#9fb4ff")
			local sz = if r.player then 14 else 10
			h.mm.dots[r.id] = panel(mm, { offset = vec2(0, 0), size = vec2(sz, sz), background = c, z_index = if r.player then 44 else 43 })
		end
	end
	-- speed + nitro (bottom centre, between the stick and the buttons)
	h.speed = text(nil, { anchor = "bottom", offset = vec2(0, -150), size = vec2(240, 60), font_size = 48, align = "center", text = "0", font = th.font })
	h.speedLabel = text(nil, { anchor = "bottom", offset = vec2(0, -112), size = vec2(240, 30), font_size = 20, align = "center", text = "KM/H", color = th.accent, font = th.font })
	local nb = panel(nil, { anchor = "bottom", offset = vec2(0, -84), size = vec2(220, 22), background = "#00000088" })
	h.nitro = panel(nb, { offset = vec2(3, 3), size = vec2(214, 16), background = "#3fd0ff", z_index = 41 })
	h.item = text(nil, { anchor = "bottom", offset = vec2(0, -46), size = vec2(260, 34), font_size = 22, align = "center", text = "", color = th.accent, font = th.font })
	-- centre banner + countdown
	h.bannerE = text(nil, { anchor = "center", offset = vec2(0, -260), size = vec2(700, 120), font_size = 96, align = "center", text = "", font = th.font, outline_size = 6, z_index = 60 })
	h.sub = text(nil, { anchor = "center", offset = vec2(0, -170), size = vec2(700, 60), font_size = 36, align = "center", text = "", color = th.accent, font = th.font, z_index = 60 })
	h.wrong = text(nil, { anchor = "center", offset = vec2(0, 120), size = vec2(700, 70), font_size = 48, align = "center", text = "", color = "#ff5050", font = th.font, z_index = 60 })
	setmetatable(h, { __index = M })
	return h
end

local function set(h, e, key, v)
	if h.cache[key] ~= v then h.cache[key] = v e.text = v end
end

function M:banner(t: string, seconds: number?, sub: string?)
	self.bannerE.text = t
	self.sub.text = sub or ""
	self.bannerT = seconds or 1.2
	pcall(function()
		self.bannerE.scale = vec2(1.4, 1.4)
		tween(self.bannerE, { scale = vec2(1, 1) }, 0.25, "back_out")
	end)
end
function M:splitText(delta: number?)
	if delta == nil then return end
	self.split.text = (if delta <= 0 then "-" else "+") .. string.format("%.2f", math.abs(delta))
	self.split.color = if delta <= 0 then "#5dff8a" else "#ff6b6b"
	self.splitT = 2
end

function M:update(dt: number, player)
	local race = self.race
	if self.bannerT > 0 then
		self.bannerT -= dt
		if self.bannerT <= 0 then self.bannerE.text = "" self.sub.text = "" end
	end
	if self.splitT then self.splitT -= dt if self.splitT <= 0 then self.split.text = "" self.splitT = nil end end
	self.acc += dt
	if self.acc < 1 / 15 then return end
	self.acc = 0
	if player then
		local lap = math.min(player.lap + 1, race.laps)
		set(self, self.lap, "lap", lap .. "/" .. race.laps)
		local n = #race.racers
		if race.mode == "time_trial" or n <= 1 then
			set(self, self.pos, "pos", "TT") set(self, self.posOf, "of", "")
		else
			local p = if player.finished then player.place else race:positionOf(player.id)
			set(self, self.pos, "pos", U.ordinal(p)) set(self, self.posOf, "of", "/" .. n)
		end
		local t = if race.phase == "racing" then (if player.finished then player.time else race.t) else 0
		set(self, self.time, "time", U.time(t))
		set(self, self.best, "best", "BEST " .. U.time(player.best))
		local c = player.car
		set(self, self.speed, "spd", tostring(math.floor(math.max(0, c:speed()) * self.speedScale + 0.5)))
		self.nitro.size = vec2(math.max(0, 214 * c.nitro), 16)
		self.nitro.background = if c.usingNitro then "#ffffff" else "#3fd0ff"
		set(self, self.item, "item", if player.item then "ITEM: " .. string.upper(player.item) .. " (B)" else "")
		set(self, self.wrong, "wrong", if player.wrongWay > 0.8 then "WRONG WAY!" else "")
	end
	if self.mm then
		for _, r in race.racers do
			local d = self.mm.dots[r.id]
			if d then
				local sz = d.size.x
				d.offset = vec2(self.mm.ox + r.car.x * self.mm.sc - sz / 2, self.mm.oy + r.car.y * self.mm.sc - sz / 2)
				d.visible = not r.out
			end
		end
	end
end

-- results(list = race:results(), { title?, names?, extra = fn(row) -> string?, buttons = { {label, onPress} } }) -> panel
function M:results(list, o)
	o = o or {}
	local th = self.th
	-- clear the live HUD below the panel
	self.bannerE.text = "" self.sub.text = "" self.wrong.text = "" self.split.text = "" self.bannerT = 0
	for _, e in { self.speed, self.item } do e.visible = false end
	if self.nitro and self.nitro.parent then self.nitro.parent.visible = false end
	if self.speedLabel then self.speedLabel.visible = false end
	if self.resultsRoot then pcall(function() self.resultsRoot:destroy() end) end
	local root = spawn("UIPanel", { anchor = "center", size = vec2(660, 900), background = string.sub(th.background, 1, 7) .. "f2", z_index = 200 })
	text(root, { anchor = "top", offset = vec2(0, 24), size = vec2(620, 80), font_size = 60, align = "center", text = o.title or "RESULTS", color = th.accent, font = th.font, z_index = 201 })
	-- podium: 2nd, 1st, 3rd
	local podium = { { 2, -200, 110 }, { 1, 0, 160 }, { 3, 200, 80 } }
	for _, pd in podium do
		local row = list[pd[1]]
		if row then
			local x = 330 + pd[2] - 90
			spawn("UIPanel", { offset = vec2(x, 380 - pd[3]), size = vec2(180, pd[3]), background = if pd[1] == 1 then th.accent else th.primary, z_index = 201 }, root)
			text(root, { offset = vec2(x, 380 - pd[3] + 6), size = vec2(180, 60), font_size = 48, align = "center", text = tostring(pd[1]), color = th.background, outline_size = 0, font = th.font, z_index = 202 })
			text(root, { offset = vec2(x - 10, 380 - pd[3] - 50), size = vec2(200, 44), font_size = 28, align = "center", text = (if row.player then "YOU" else (o.names and o.names[row.id]) or row.name), color = if row.player then th.accent else th.text, font = th.font, z_index = 202 })
		end
	end
	local y = 410
	for i, row in list do
		if i > 8 then break end
		local col = if row.player then th.accent else th.text
		local t = if o.value then o.value(row) elseif row.out then "OUT" elseif row.time then U.time(row.time) .. (if row.estimated then "*" else "") else "DNF"
		text(root, { offset = vec2(30, y), size = vec2(80, 44), font_size = 30, text = U.ordinal(i), color = col, font = th.font, z_index = 201 })
		text(root, { offset = vec2(110, y), size = vec2(260, 44), font_size = 30, text = (if row.player then "YOU" else (o.names and o.names[row.id]) or row.name), color = col, font = th.font, z_index = 201 })
		text(root, { offset = vec2(360, y), size = vec2(170, 44), font_size = 28, text = t, color = col, font = th.font, z_index = 201 })
		local ex = o.extra and o.extra(row) or ""
		text(root, { offset = vec2(530, y), size = vec2(110, 44), font_size = 28, align = "right", text = ex, color = th.accent, font = th.font, z_index = 201 })
		y += 50
	end
	if o.note then text(root, { anchor = "top", offset = vec2(0, y + 6), size = vec2(620, 44), font_size = 26, align = "center", text = o.note, color = th.accent, font = th.font, z_index = 201 }) end
	local by = 900 - 24 - 104 * #(o.buttons or {})
	for _, b in o.buttons or {} do
		local btn = spawn("UIButton", { offset = vec2(60, by), size = vec2(540, 92), text = b[1] or b.label, font_size = 34, background = th.primary, color = th.text, font = th.font, z_index = 203 }, root)
		btn.pressed:connect(b[2] or b.onPress)
		by += 104
	end
	self.resultsRoot = root
	return root
end
return M
