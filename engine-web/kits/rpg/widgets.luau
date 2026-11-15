-- rpg kit: tiny UI toolkit over UIPanel / UIText / UIButton (screen-space, reference pixels).
-- Colors: the game's dreamsy.toml [ui] theme (ui.theme()), overridable in data/rpg.json "ui".
local U = require("./util")
local Content = require("./content")

local W = {}

local DEFAULT = {
	primary = "#3b5dc9",
	accent = "#ffcd75",
	background = "#1a1c2c",
	text = "#f4f4f4",
	muted = "#94b0c2",
	good = "#38b764",
	warn = "#ef7d57",
	bad = "#b13e53",
	surface = "#262b44",
	surface2 = "#333c57",
}

-- dreamsy.toml [ui] (ui.theme()) < data/rpg.json "ui" overrides; extra kit colors keep their defaults
function W.theme()
	local th = ui.theme()
	local t = {}
	local c = Content.config.ui or {}
	for k, v in DEFAULT do t[k] = c[k] or th[k] or v end
	return t
end

-- a live entity (not nil, not destroyed by destroy() or a scene change)
function W.alive(e): boolean
	return isEntity(e) and not e.destroyed
end

-- reference screen size (720×1280 portrait / 1280×720 landscape)
function W.screen(): Vec2
	return camera.worldToScreen(camera.center()) * 2
end

local function alpha(hex: string, a: number): string
	local h = string.sub(hex, 1, 7)
	return h .. string.format("%02x", math.clamp(math.floor(a * 255 + 0.5), 0, 255))
end
W.alpha = alpha

function W.panel(parent, o)
	o = o or {}
	return spawn("UIPanel", {
		anchor = o.anchor or "top_left",
		offset = o.offset or vec2(0, 0),
		size = o.size or vec2(100, 100),
		background = o.bg or alpha(W.theme().background, 0.94),
		z_index = o.z or 0,
		image = o.image,
		visible = if o.visible == nil then true else o.visible,
	}, parent)
end

function W.text(parent, o)
	local t = W.theme()
	return spawn("UIText", {
		anchor = o.anchor or "top_left",
		offset = o.offset or vec2(0, 0),
		size = o.size or vec2(200, 40),
		text = o.text or "",
		font_size = o.font_size or 26,
		color = o.color or t.text,
		align = o.align or "left",
		z_index = o.z or 1,
		outline = o.outline,
		outline_size = o.outline_size,
	}, parent)
end

-- onPress() runs on tap/click (plays data/rpg.json sfx.select when set)
function W.button(parent, o)
	local t = W.theme()
	local b = spawn("UIButton", {
		anchor = o.anchor or "top_left",
		offset = o.offset or vec2(0, 0),
		size = o.size or vec2(200, 80),
		text = o.text or "",
		font_size = o.font_size or 28,
		color = o.color or t.text,
		background = o.bg or t.primary,
		z_index = o.z or 1,
		visible = if o.visible == nil then true else o.visible,
	}, parent)
	if o.onPress then
		b.pressed:connect(function()
			U.sfx(Content.config.sfx and Content.config.sfx.select)
			o.onPress()
		end)
	end
	return b
end

-- tappable row (UIPanel); onTap()
function W.row(parent, o)
	local p = W.panel(parent, o)
	if o.onTap then
		p.tapped:connect(function()
			U.sfx(Content.config.sfx and Content.config.sfx.select)
			o.onTap()
		end)
	end
	return p
end

-- image (UIPanel with an image, transparent background)
function W.image(parent, o)
	return spawn("UIPanel", {
		anchor = o.anchor or "top_left",
		offset = o.offset or vec2(0, 0),
		size = o.size or vec2(64, 64),
		background = "#00000000",
		image = o.image,
		z_index = o.z or 1,
	}, parent)
end

-- horizontal bar: returns { root, set(fraction, seconds?), color(hex) }
function W.bar(parent, o)
	local t = W.theme()
	local size = o.size or vec2(200, 16)
	local root = W.panel(parent, { anchor = o.anchor, offset = o.offset, size = size, bg = o.back or "#00000088", z = o.z or 1 })
	local inset = o.inset or 3
	local inner = size - vec2(inset * 2, inset * 2)
	local fill = W.panel(root, { anchor = "left", offset = vec2(inset, 0), size = vec2(inner.x, inner.y), bg = o.color or t.good, z = 1 })
	local bar = { root = root, fill = fill, value = 1 }
	function bar.set(v: number, seconds: number?)
		v = math.clamp(v, 0, 1)
		bar.value = v
		local target = vec2(math.max(0, inner.x * v), inner.y)
		if seconds and seconds > 0 then
			tween(fill, { size = target }, seconds, "quad_out")
		else
			fill.size = target
		end
	end
	function bar.color(c: string)
		fill.background = c
	end
	bar.set(o.value or 1)
	return bar
end

-- HP color by fraction
function W.hpColor(f: number): string
	local t = W.theme()
	if f > 0.5 then return t.good end
	if f > 0.2 then return t.accent end
	return t.bad
end

function W.destroy(e): boolean
	if not W.alive(e) then return false end
	e:destroy()
	return true
end

-- full-screen dim/fade layer
function W.fade(toAlpha: number, seconds: number, done: (() -> ())?)
	if not W.alive(W._fade) then
		local s = W.screen()
		W._fade = W.panel(nil, { anchor = "top_left", offset = vec2(-200, -200), size = s + vec2(400, 400), bg = "#00000000", z = 5000 })
	end
	local f = W._fade
	f.visible = true
	local tw = tween(f, { background = color(alpha("#000000", toAlpha)) }, seconds, "linear")
	U.after(seconds, function()
		if toAlpha <= 0 and W.alive(f) then f.visible = false end
		if done then done() end
	end)
	return tw
end

return W
