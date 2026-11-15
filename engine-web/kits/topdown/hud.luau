-- topdown kit: HUD — hearts (half-heart steps), rupees/keys/ammo line, equipped item button
-- (tap to cycle), minimap of visited rooms, boss bar, banner. Laid out for portrait (720×1280 UI).
-- Text/accent colors default to the game's [ui] theme (ui.theme()).
local U = require("./util")

local Hud = {}
Hud.__index = Hud

Hud.DEFAULTS = { heart_size = 36, font_size = 28, color = "#ffffff", outline = "#000000", minimap_cell = 14, bar = "#e0404a", accent = "#ffd34a" }

function Hud.new(opts, art)
	local self = setmetatable({}, Hud)
	local th = ui.theme()
	self.o = U.merge(U.merge(Hud.DEFAULTS, { color = th.text, accent = th.accent }), opts)
	self.art = art or {}
	self.hearts = {}
	self.maxHearts = 0
	local o = self.o
	self.line = spawn("UIText", { anchor = "top_left", offset = vec2(20, 24 + o.heart_size + 10), size = vec2(440, 40), text = "", font_size = o.font_size, color = o.color, outline = o.outline, outline_size = 3, z_index = 50 })
	-- equipped item: icon on top, ammo count (or a short name when there is no sprite) as the label
	self.item = spawn("UIButton", { anchor = "top_right", offset = vec2(-96, 20), size = vec2(84, 84), text = "", font_size = 18, color = o.color, background = "#00000088", icon_position = "top", icon_size = 48, z_index = 50 })
	self.map = spawn("UIPanel", { anchor = "top_right", offset = vec2(-20, 116), size = vec2(10, 10), background = "#00000066", z_index = 49, visible = false })
	self.mapCells = {}
	self.banner = spawn("UIText", { anchor = "center", offset = vec2(0, -260), size = vec2(680, 120), text = "", font_size = 40, color = o.accent, outline = o.outline, outline_size = 4, align = "center", z_index = 60, visible = false })
	self.bossPanel = spawn("UIPanel", { anchor = "top", offset = vec2(0, 200), size = vec2(440, 24), background = "#000000aa", z_index = 50, visible = false })
	self.bossFill = spawn("UIPanel", { anchor = "left", offset = vec2(3, 0), size = vec2(434, 18), background = o.bar, z_index = 51 }, self.bossPanel)
	self.bossName = spawn("UIText", { anchor = "top", offset = vec2(0, 160), size = vec2(600, 36), text = "", font_size = 24, align = "center", color = o.color, outline = o.outline, outline_size = 3, z_index = 51, visible = false })
	return self
end

-- hp, max in half hearts
function Hud:setHearts(hp: number, max: number)
	local n = math.ceil(max / 2)
	local s = self.o.heart_size
	if n ~= self.maxHearts then
		for _, h in self.hearts do h:destroy() end
		self.hearts = {}
		self.maxHearts = n
		for i = 1, n do
			local col, row = (i - 1) % 10, math.floor((i - 1) / 10)
			table.insert(self.hearts, spawn("UIPanel", { anchor = "top_left", offset = vec2(20 + col * (s + 4), 20 + row * (s + 4)), size = vec2(s, s), background = "#00000000", z_index = 50 }))
		end
	end
	for i, h in self.hearts do
		local v = hp - (i - 1) * 2
		local key = if v >= 2 then "heart" elseif v == 1 then "heart_half" else "heart_empty"
		local img = self.art[key] or self.art.heart
		if img then
			if h.image ~= img then h.image = img end
			h.visible = v > 0 or self.art.heart_empty ~= nil
		else
			h.background = if v >= 2 then "#e0404a" elseif v == 1 then "#e08080" else "#40404088"
		end
	end
end

function Hud:setLine(s: string)
	if self.line.text ~= s then self.line.text = s end
end

function Hud:setItem(def, count: number?)
	if not def then
		self.item.icon = ""
		self.item.text = ""
		return
	end
	self.item.icon = def.sprite or ""
	if count ~= nil then self.item.text = tostring(count)
	elseif def.sprite then self.item.text = ""
	else self.item.text = string.upper(string.sub(def.name or def.id, 1, 5)) end
end

-- rooms: { {rx, ry, visited, current} }, bounds in room coords
function Hud:setMap(rooms, cols: number, rows: number)
	local cs = self.o.minimap_cell
	self.map.visible = #rooms > 0
	self.map.size = vec2(cols * (cs + 2) + 6, rows * (cs + 2) + 6)
	for _, e in self.mapCells do e:destroy() end
	self.mapCells = {}
	for _, r in rooms do
		if r.visited or r.current then
			table.insert(self.mapCells, spawn("UIPanel", {
				anchor = "top_left", offset = vec2(4 + r.rx * (cs + 2), 4 + r.ry * (cs + 2)), size = vec2(cs, cs),
				background = if r.current then "#ffd34a" elseif r.boss then "#e05060" else "#9ab8d8", z_index = 50,
			}, self.map))
		end
	end
end

function Hud:boss(name: string?, frac: number?)
	self.bossPanel.visible = name ~= nil
	self.bossName.visible = name ~= nil
	if name then
		if self.bossName.text ~= name then self.bossName.text = name end
		self.bossFill.size = vec2(math.max(0, 434 * (frac or 1)), 18)
	end
end

function Hud:showBanner(msg: string, seconds: number?)
	self.banner.text = msg
	self.banner.visible = true
	self.bannerId = (self.bannerId or 0) + 1
	local id = self.bannerId
	if seconds then after(seconds, function() if self.bannerId == id and not self.banner.destroyed then self.banner.visible = false end end) end
end

return Hud
