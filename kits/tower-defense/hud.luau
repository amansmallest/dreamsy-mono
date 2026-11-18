-- tower-defense kit: portrait-friendly HUD (screen-space UI). Top bar: money, lives, wave. Bottom bar: speed
-- toggle (1x/2x/3x) and a big "next wave" button (shows the countdown + early-call bonus). Result banner with
-- stars and buttons (a core.menus modal). Defaults follow dreamsy.toml [ui] (ui.theme()). Everything is optional;
-- a game can build its own HUD from sim events instead.
local menus = require("@kit/core").menus
local Hud = {}
local HudM = {}
HudM.__index = HudM

local DEFAULT = {
	panel = "#1b1b2acc",
	button = "#3a86ff",
	buttonAlt = "#2b2d42",
	text = "#ffffff",
	money = "#ffd166",
	lives = "#ef476f",
	wave = "#8ecae6",
	star = "#ffd166",
	starOff = "#4a4e69",
	font = "default",
	icons = {}, -- { money = "asset:..", lives = "asset:..", wave = "asset:.." }
}

-- opts: { theme = {...}, labels = { start = "START", next = "NEXT" }, onSpeed = fn(speed)?, topHeight = 96, bottomHeight = 120 }
function Hud.new(sim, opts)
	opts = opts or {}
	local th = table.clone(DEFAULT)
	local ut = ui.theme()
	th.button, th.text, th.font = ut.primary, ut.text, ut.font
	for k, v in opts.theme or {} do
		th[k] = v
	end
	local self = setmetatable({ sim = sim, th = th, labels = opts.labels or {}, conns = {}, opts = opts }, HudM)
	local topH = opts.topHeight or 96
	local botH = opts.bottomHeight or 128
	self.top = spawn("UIPanel", { anchor = "top", size = vec2(720, topH), background = th.panel, z_index = 100 })
	local function stat(x, key, col)
		local icon = th.icons[key]
		if icon then
			spawn("UIPanel", { anchor = "left", offset = vec2(x, 0), size = vec2(44, 44), image = icon, background = "#ffffff" }, self.top)
		end
		return spawn("UIText", {
			anchor = "left", offset = vec2(x + (if icon then 52 else 0), 0), size = vec2(170, 56), font_size = 36, color = col,
			font = th.font, outline = "#000000", outline_size = 3,
		}, self.top)
	end
	self.money = stat(24, "money", th.money)
	self.lives = stat(262, "lives", th.lives)
	self.waveText = stat(480, "wave", th.wave)
	self.bottom = spawn("UIPanel", { anchor = "bottom", size = vec2(720, botH), background = th.panel, z_index = 100 })
	self.speedBtn = spawn("UIButton", {
		anchor = "left", offset = vec2(24, 0), size = vec2(168, 88), text = "1x", font_size = 40, background = th.buttonAlt,
		color = th.text, font = th.font,
	}, self.bottom)
	self.nextBtn = spawn("UIButton", {
		anchor = "right", offset = vec2(-24, 0), size = vec2(456, 88), text = self.labels.start or "START", font_size = 38,
		background = th.button, color = th.text, font = th.font,
	}, self.bottom)
	self.speedBtn.pressed:connect(function()
		local s = sim.speed % 3 + 1
		sim:setSpeed(s)
		if opts.onSpeed then
			opts.onSpeed(s)
		end
		self:refresh()
	end)
	self.nextBtn.pressed:connect(function()
		if sim:startWave() then
			self:refresh()
		end
	end)
	self:refresh()
	return self
end

function HudM:refresh()
	local sim = self.sim
	self.money.text = tostring(sim.money)
	self.lives.text = tostring(sim.lives)
	self.waveText.text = if sim.endless then "W" .. sim.wave else sim.wave .. "/" .. sim.waveCount
	self.speedBtn.text = sim.speed .. "x"
	local can = sim:canStartWave()
	self.nextBtn.visible = can
	if can then
		if sim.wave == 0 then
			self.nextBtn.text = self.labels.start or "START"
		else
			local saved = if sim.countdown then sim.countdown else sim.level.between
			local bonus = math.floor((sim.level.early_bonus or 0) * saved)
			local secs = if sim.countdown then string.format(" %ds", math.ceil(sim.countdown)) else ""
			self.nextBtn.text = (self.labels.next or "NEXT") .. secs .. (if bonus > 0 then "  +" .. bonus else "")
		end
	end
end

-- Call every frame (cheap: only touches texts when values change).
function HudM:update()
	local sim = self.sim
	local key = sim.money .. ":" .. sim.lives .. ":" .. sim.wave .. ":" .. sim.speed .. ":" .. tostring(sim:canStartWave()) .. ":" .. math.ceil(sim.countdown or -1)
	if key ~= self.key then
		self.key = key
		self:refresh()
	end
end

-- Result banner (modal: dims the screen, swallows taps): { title, subtitle, stars (0..3, nil = none),
-- buttons = { { text, onPress, primary } } }. Returns the banner panel.
function HudM:banner(spec)
	self:closeBanner()
	local th = self.th
	local h = menus.modal(600, 520, nil, { pause = false })
	local b = h.box
	b.background = "#14142aee"
	menus.text(b, spec.title or "", { offset = vec2(0, 40), size = vec2(560, 70), font_size = 56, color = th.text, font = th.font, outline = "#000000", outline_size = 4 })
	if spec.subtitle then
		menus.text(b, spec.subtitle, { offset = vec2(0, 118), size = vec2(560, 48), font_size = 30, color = "#c9c9e0", font = th.font })
	end
	if spec.stars then
		for i = 1, 3 do
			local on = i <= spec.stars
			local s = spawn("UIPanel", {
				anchor = "top", offset = vec2((i - 2) * 120, 190), size = vec2(96, 96),
				image = th.icons.star, background = if th.icons.star then (if on then "#ffffff" else "#ffffff33") else (if on then th.star else th.starOff),
				z_index = 901,
			}, b)
			if on then
				s.size = vec2(10, 10)
				tween(s, { size = vec2(96, 96) }, 0.35, { easing = "back_out", delay = 0.15 * i })
			end
		end
	end
	local btns = spec.buttons or {}
	for i, bs in btns do
		local w = math.floor((560 - (#btns - 1) * 16) / #btns)
		menus.button(b, bs.text, bs.onPress, {
			anchor = "bottom_left", offset = vec2(20 + (i - 1) * (w + 16), -32), size = vec2(w, 96), font_size = 34,
			background = if bs.primary then th.button else th.buttonAlt, color = th.text, font = th.font,
		})
	end
	self.bannerHandle = h
	return b
end

function HudM:closeBanner()
	if self.bannerHandle then
		self.bannerHandle.close()
		self.bannerHandle = nil
	end
end

function HudM:destroy()
	self:closeBanner()
	for _, e in { self.top, self.bottom } do
		if not e.destroyed then
			e:destroy()
		end
	end
end

return Hud
