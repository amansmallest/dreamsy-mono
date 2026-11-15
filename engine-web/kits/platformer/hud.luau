-- platformer kit: HUD helpers (hearts, counters, timer, boss bar, banner). Spawns UI entities in the
-- current scene; everything is optional and restyleable through opts.
local U = require("./util")

local Hud = {}
Hud.__index = Hud

Hud.DEFAULTS = {
	font_size = 28,
	color = "#ffffff",
	outline = "#000000",
	heart_size = 32,
	show_time = true,
	show_coins = true,
	show_gems = true,
	accent = nil, -- default: ui.theme().accent
	bar = "#e0404a",
}

local function text(props)
	return spawn("UIText", props)
end

function Hud.new(opts, art)
	local self = setmetatable({}, Hud)
	local o = U.merge(Hud.DEFAULTS, opts)
	o.accent = o.accent or ui.theme().accent
	self.o = o
	self.art = art or {}
	self.hearts = {}
	self.maxHearts = 0
	local y = 16
	self.heartRow = y
	self.lines = text({ anchor = "top_left", offset = vec2(16, y + o.heart_size + 8), size = vec2(420, 80), text = "", font_size = o.font_size, color = o.color, outline = o.outline, outline_size = 3, z_index = 50 })
	self.timeText = text({ anchor = "top", offset = vec2(0, 16), size = vec2(240, 40), text = "", font_size = o.font_size, color = o.color, outline = o.outline, outline_size = 3, align = "center", z_index = 50, visible = o.show_time })
	self.banner = text({ anchor = "center", offset = vec2(0, -120), size = vec2(900, 80), text = "", font_size = 48, color = o.accent, outline = o.outline, outline_size = 4, align = "center", z_index = 60, visible = false })
	self.bossPanel = spawn("UIPanel", { anchor = "bottom", offset = vec2(0, -28), size = vec2(520, 26), background = "#000000aa", z_index = 50, visible = false })
	self.bossFill = spawn("UIPanel", { anchor = "left", offset = vec2(3, 0), size = vec2(514, 20), background = o.bar, z_index = 51 }, self.bossPanel)
	self.bossName = text({ anchor = "bottom", offset = vec2(0, -56), size = vec2(520, 32), text = "", font_size = 24, color = o.color, outline = o.outline, outline_size = 3, align = "center", z_index = 51, visible = false })
	return self
end

function Hud:setHearts(n: number, max: number)
	if max ~= self.maxHearts then
		for _, h in self.hearts do h:destroy() end
		self.hearts = {}
		self.maxHearts = max
		for i = 1, max do
			local props = { anchor = "top_left", offset = vec2(16 + (i - 1) * (self.o.heart_size + 6), self.heartRow), size = vec2(self.o.heart_size, self.o.heart_size), z_index = 50, background = "#00000000" }
			if self.art.heart then props.image = self.art.heart else props.background = "#e0404a" end
			table.insert(self.hearts, spawn("UIPanel", props))
		end
	end
	for i, h in self.hearts do
		local full = i <= n
		if self.art.heart then
			local img = if full then self.art.heart else (self.art.heart_empty or self.art.heart)
			if h.image ~= img then h.image = img end
			h.visible = full or self.art.heart_empty ~= nil
		else
			h.background = if full then "#e0404a" else "#40404088"
		end
	end
end

-- stats = { coins, coinsTotal, gems, gemsTotal, time, lives }
function Hud:set(stats)
	local parts = {}
	if self.o.show_coins and stats.coins then table.insert(parts, "COINS " .. stats.coins .. (if stats.coinsTotal then "/" .. stats.coinsTotal else "")) end
	if self.o.show_gems and stats.gemsTotal and stats.gemsTotal > 0 then table.insert(parts, "GEMS " .. (stats.gems or 0) .. "/" .. stats.gemsTotal) end
	if stats.lives then table.insert(parts, "LIVES " .. stats.lives) end
	local s = table.concat(parts, "\n")
	if self.lines.text ~= s then self.lines.text = s end
	if self.o.show_time and stats.time then
		local t = U.formatTime(stats.time)
		if self.timeText.text ~= t then self.timeText.text = t end
	end
end

function Hud:boss(name: string?, frac: number?)
	if name == nil then
		self.bossPanel.visible = false
		self.bossName.visible = false
		return
	end
	self.bossPanel.visible = true
	self.bossName.visible = true
	if self.bossName.text ~= name then self.bossName.text = name end
	self.bossFill.size = vec2(math.max(0, 514 * (frac or 1)), 20)
end

function Hud:showBanner(msg: string, seconds: number?)
	self.banner.text = msg
	self.banner.visible = true
	self.bannerId = (self.bannerId or 0) + 1
	local id = self.bannerId
	if seconds then
		after(seconds, function()
			if self.bannerId == id and not self.banner.destroyed then self.banner.visible = false end
		end)
	end
end

function Hud:hideBanner()
	self.banner.visible = false
end

return Hud
