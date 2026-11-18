--!nonstrict
-- In-stage HUD (portrait-first, top edge; the top-right 120 px stay free for the platform pause button):
-- score + multiplier/chain bar (top-left), lives + bombs + power (top, right of centre), boss bar, centre banners.
local M = {}

local function theme()
	local ok, t = pcall(function() return ui.theme() end)
	return if ok and t then t else { primary = "#5e7ed6", accent = "#ffd34d", text = "#ffffff", font = "bold" }
end

local function text(props)
	local p = { anchor = "top_left", size = vec2(300, 48), font_size = 32, color = "#ffffff", outline = "#0b1020", outline_size = 3, z_index = 200, font = "bold" }
	for k, v in props do p[k] = v end
	return spawn("UIText", p)
end

-- new(ctl, opts?) -> hud { update(dt), banner(text, seconds), bossBar(name | nil), bossFill(frac) }
function M.new(ctl, opts)
	opts = opts or {}
	local th = theme()
	local run = ctl.run
	local h = {}
	local frame = spawn("UIPanel", { anchor = "top", size = vec2(720, 132), offset = vec2(0, 0), background = "#0b102099", input_transparent = true, z_index = 190 })
	local score = text({ offset = vec2(24, 14), size = vec2(330, 50), font_size = 40, text = "0" })
	local mult = text({ offset = vec2(24, 66), size = vec2(330, 34), font_size = 24, color = th.accent or "#ffd34d", text = "" })
	local barBg = spawn("UIPanel", { anchor = "top_left", offset = vec2(24, 104), size = vec2(200, 10), background = "#ffffff22", input_transparent = true, z_index = 200 })
	local bar = spawn("UIPanel", { anchor = "top_left", offset = vec2(24, 104), size = vec2(0, 10), background = th.accent or "#ffd34d", input_transparent = true, z_index = 201 })
	local lives = text({ anchor = "top_left", offset = vec2(370, 14), size = vec2(220, 40), font_size = 28, text = "" })
	local bombs = text({ anchor = "top_left", offset = vec2(370, 52), size = vec2(220, 34), font_size = 24, color = "#ff9b7a", text = "" })
	local power = text({ anchor = "top_left", offset = vec2(370, 86), size = vec2(220, 34), font_size = 24, color = "#9ff3ff", text = "" })
	local icon = run.ship.sprite
	local lifeIcons = {}
	if icon then
		for i = 1, 6 do
			local e = spawn("UIPanel", { anchor = "top_left", offset = vec2(370 + (i - 1) * 36, 16), size = vec2(32, 32), image = icon, background = "#ffffff00", input_transparent = true, z_index = 201 })
			e.visible = false
			table.insert(lifeIcons, e)
		end
	end
	local banner = text({ anchor = "center", offset = vec2(0, -160), size = vec2(700, 100), font_size = 64, align = "center", text = "", outline_size = 5, z_index = 260 })
	banner.visible = false
	local bannerT = 0
	local bossName, bossBg, bossFill = nil, nil, nil

	function h.update(self, dt)
		local s = run.score
		score.text = tostring(s.score)
		mult.text = if s.combo > 0 then "x" .. s.mult .. "  chain " .. s.combo else ""
		bar.size = vec2(200 * s:fraction(), 10)
		barBg.visible = s.combo > 0
		if #lifeIcons > 0 then
			for i, e in lifeIcons do e.visible = i <= math.max(0, run.lives) end
			lives.text = if run.lives > 6 then "         x" .. run.lives else ""
		else
			lives.text = "Lives " .. run.lives
		end
		bombs.text = "BOMB " .. run.bombs
		power.text = "POWER " .. run.weapon.level .. "/" .. #(run.weapon.def.levels or { 1 })
		if bannerT > 0 then
			bannerT -= dt
			if bannerT <= 0 then banner.visible = false end
		end
	end
	function h.banner(self, t, seconds)
		banner.text = t
		banner.visible = true
		bannerT = seconds or 1.4
		pcall(function()
			banner.scale = vec2(1.4, 1.4)
			tween(banner, { scale = vec2(1, 1) }, 0.25, "back_out")
		end)
	end
	function h.bossBar(self, name)
		if bossBg then bossBg:destroy() bossBg = nil end
		if bossName then bossName:destroy() bossName = nil end
		if name == nil then return end
		bossName = text({ anchor = "top", offset = vec2(0, 140), size = vec2(600, 30), font_size = 22, align = "center", text = name, color = "#ffd0d8" })
		bossBg = spawn("UIPanel", { anchor = "top", offset = vec2(0, 174), size = vec2(600, 16), background = "#00000088", input_transparent = true, z_index = 200 })
		bossFill = spawn("UIPanel", { anchor = "top_left", offset = vec2(0, 0), size = vec2(600, 16), background = "#ff4d6d", input_transparent = true, z_index = 201 }, bossBg)
	end
	function h.bossFill(self, frac)
		if bossFill and not bossFill.destroyed then bossFill.size = vec2(600 * math.clamp(frac, 0, 1), 16) end
	end
	h.frame = frame
	h:update(0)
	return h
end

return M
