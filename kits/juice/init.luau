--!nonstrict
-- juice kit: game-feel presets on top of engine tween / particles / camera. Every function is safe to call
-- headless and degrades to a no-op (or an instant change) when an engine feature or the entity is missing.
local J = { VERSION = "0.1.0" }

local core = nil
do
	local ok, c = pcall(require, "@kit/core")
	if ok and type(c) == "table" and c.pause then core = c end
end

local UI = { UIText = true, UIButton = true, UIPanel = true }
local function alive(e) return isEntity(e) and not e.destroyed end
local function hasTween() return type(tween) == "function" end
local function tw(e, props, s, opts)
	if not alive(e) then return nil end
	if not hasTween() then
		for k, v in props do pcall(function() e[k] = v end) end
		return nil
	end
	local ok, t = pcall(tween, e, props, s, opts)
	return if ok then t else nil
end
local function later(s, fn) if type(after) == "function" then after(s, fn) else fn() end end
local function destroyLater(e, s) later(s, function() if alive(e) then e:destroy() end end) end
local function try(fn, ...) local ok, r = pcall(fn, ...) return if ok then r else nil end
local function col(c) if type(c) == "string" then return color(c) end return c end
local function withAlpha(c, a) c = col(c) return color(string.sub(c:toHex(), 1, 7) .. string.format("%02x", math.floor(math.clamp(a, 0, 1) * 255))) end
local function tagged(e, prop) -- remember an entity's resting value so repeated effects don't compound
	J._base = J._base or {}
	local b = J._base[e.id]
	if not b then
		b = { _e = e }
		J._base[e.id] = b
		J._nBase = (J._nBase or 0) + 1
		if J._nBase > 256 then -- forget dead entities (many short-lived enemies / list rows)
			local n = 0
			for id, x in J._base do if x._e.destroyed then J._base[id] = nil else n += 1 end end
			J._nBase = n
		end
	end
	if b[prop] == nil then b[prop] = e[prop] end
	return b[prop]
end

-- ---------- time ----------
-- hitstop / slow-mo drive the engine's game.timeScale (freezes physics, tweens, timers, anims, onTick dt).
-- Durations are real seconds: a session onTick counts fixed 60 Hz ticks, which keep firing (dt = 0) while frozen.
local TICK = 1 / 60
local effect = nil -- { scale, left (real s), restore (scale to put back) }
local function setScale(v) if type(game) == "table" then game.timeScale = v end end
local function getScale() return if type(game) == "table" then game.timeScale or 1 else 1 end
local function endEffect()
	if not effect then return end
	local wasStop = effect.scale == 0
	-- restore only if nobody changed game.timeScale meanwhile (e.g. a 2x speed button)
	if getScale() == effect.scale then setScale(effect.restore) end
	effect = nil
	if wasStop and core then core.pause.pop("hitstop") end
end
local function startEffect(scale, seconds)
	if effect then
		if effect.scale == scale then effect.left = math.max(effect.left, seconds) return end
		if effect.scale < scale and effect.left >= seconds then return end -- a stronger effect is running
		local restore = effect.restore
		endEffect()
		effect = { scale = scale, left = seconds, restore = restore }
	else
		effect = { scale = scale, left = seconds, restore = getScale() }
	end
	setScale(scale)
	if scale == 0 and core then core.pause.push("hitstop", true) end
end
if type(onTick) == "function" then
	onTick(function()
		if not effect then return end
		effect.left -= TICK
		if effect.left <= 1e-6 then endEffect() end
	end)
end
-- hitstop(seconds = 0.06): freeze the game (game.timeScale = 0) for a few real frames on big hits.
-- Also pushes core.pause "hitstop" when the core kit is enabled.
function J.hitstop(seconds: number?) startEffect(0, seconds or 0.06) end
-- slowmo(scale = 0.3, seconds = 0.5): bullet time for `seconds` real seconds.
function J.slowmo(scale: number?, seconds: number?) startEffect(math.clamp(scale or 0.3, 0.05, 1), seconds or 0.5) end
function J.stopped(): boolean return effect ~= nil and effect.scale == 0 end
function J.timeScale(): number return getScale() end

-- ---------- camera ----------
J.SHAKES = { tiny = { 3, 0.1 }, light = { 5, 0.15 }, medium = { 9, 0.25 }, heavy = { 16, 0.4 }, explosion = { 26, 0.6 } }
-- shake(profile = "medium" | intensity, seconds?)
function J.shake(p, seconds: number?)
	local i, s
	if type(p) == "number" then i, s = p, seconds or 0.3
	else
		local prof = J.SHAKES[p or "medium"] or J.SHAKES.medium
		i, s = prof[1], seconds or prof[2]
	end
	if type(camera) == "table" and type(camera.shake) == "function" then try(camera.shake, i, s) end
end
function J.zoomPunch(amount: number?, seconds: number?)
	if type(camera) ~= "table" or type(camera.current) ~= "function" then return end
	local cam = try(camera.current)
	if not cam then return end
	local z = tagged(cam, "zoom")
	cam.zoom = z * (1 + (amount or 0.06))
	tw(cam, { zoom = z }, seconds or 0.25, "quad_out")
end

-- ---------- entity feedback ----------
-- squash(e, { amount = 0.25, seconds = 0.3, stretch = false }): scale punch that settles back (2D); UI: size punch
function J.squash(e, opts)
	if not alive(e) then return end
	opts = opts or {}
	local a = opts.amount or 0.25
	if opts.stretch then a = -a end
	if UI[e.type] then return J.bounce(e, opts) end
	local base = tagged(e, "scale")
	if not base then return end
	try(function() e.scale = vec2(base.x * (1 + a), base.y * (1 - a)) end)
	return tw(e, { scale = base }, opts.seconds or 0.3, opts.easing or "back_out")
end
function J.stretch(e, opts) opts = table.clone(opts or {}) opts.stretch = true return J.squash(e, opts) end
-- punch(e, amount = 0.2): uniform scale pop
function J.punch(e, amount: number?, seconds: number?)
	if not alive(e) then return end
	if UI[e.type] then return J.bounce(e, { amount = amount }) end
	local base = tagged(e, "scale")
	if not base then return end
	try(function() e.scale = base * (1 + (amount or 0.2)) end)
	return tw(e, { scale = base }, seconds or 0.25, "back_out")
end
-- flash(e, color = "#ffffff", seconds = 0.12): tint then fade back (Sprite2D modulate; UIPanel/UIButton background)
function J.flash(e, c, seconds: number?)
	if not alive(e) then return end
	local prop = if e.type == "UIPanel" or e.type == "UIButton" then "background" elseif e.type == "Text2D" or e.type == "UIText" then "color" else "modulate"
	local base = tagged(e, prop)
	if base == nil then return end
	try(function() e[prop] = col(c or "#ffffff") end)
	return tw(e, { [prop] = base }, seconds or 0.12, "linear")
end
-- blink(e, seconds = 1, rate = 12): toggle visibility (i-frames); ends visible
function J.blink(e, seconds: number?, rate: number?)
	if not alive(e) or type(every) ~= "function" then return end
	local n = math.floor((seconds or 1) * (rate or 12))
	local i = 0
	local t
	t = every(1 / (rate or 12), function()
		i += 1
		if not alive(e) then t:cancel() return end
		if i >= n then e.visible = true t:cancel() return end
		e.visible = not e.visible
	end)
	return t
end
-- bounce(e, { amount = 0.15, seconds = 0.35 }): UI size pop around its anchor (or 2D scale pop)
function J.bounce(e, opts)
	if not alive(e) then return end
	opts = opts or {}
	local a = opts.amount or 0.15
	if not UI[e.type] then return J.punch(e, a, opts.seconds) end
	local base = tagged(e, "size")
	try(function() e.size = base * (1 + a) end)
	return tw(e, { size = base }, opts.seconds or 0.35, "back_out")
end
-- pulse(e, { amount = 0.08, seconds = 0.6 }) -> Tween (loop; :cancel() then e.scale/size resets on next bounce)
function J.pulse(e, opts)
	if not alive(e) then return end
	opts = opts or {}
	local a = opts.amount or 0.08
	if UI[e.type] then
		local base = tagged(e, "size")
		return tw(e, { size = base * (1 + a) }, opts.seconds or 0.6, { easing = "sine_in_out", loop = true, yoyo = true })
	end
	local base = tagged(e, "scale")
	return tw(e, { scale = base * (1 + a) }, opts.seconds or 0.6, { easing = "sine_in_out", loop = true, yoyo = true })
end
-- float(e, { height = 8, seconds = 1 }): idle bob (2D position)
function J.float(e, opts)
	if not alive(e) or UI[e.type] then return end
	opts = opts or {}
	local base = tagged(e, "position")
	return tw(e, { position = base + vec2(0, -(opts.height or 8)) }, opts.seconds or 1, { easing = "sine_in_out", loop = true, yoyo = true })
end
function J.fadeOut(e, seconds: number?, destroy: boolean?)
	if not alive(e) then return end
	local prop = if e.type == "UIPanel" or e.type == "UIButton" then "background" elseif e.type == "Text2D" or e.type == "UIText" then "color" else "modulate"
	local c = try(function() return e[prop] end)
	if c == nil then return end
	local t = tw(e, { [prop] = withAlpha(c, 0) }, seconds or 0.3, "quad_out")
	if destroy then destroyLater(e, (seconds or 0.3) + 0.02) end
	return t
end

-- ---------- popups ----------
-- popup(text, worldPos, { color = "#ffffff", size = 32, rise = 70, seconds = 0.8, outline = "#000000", font = "bold", drift? })
function J.popup(text, pos, opts)
	if type(spawn) ~= "function" then return nil end
	opts = opts or {}
	local c = col(opts.color or "#ffffff")
	local e = try(spawn, "Text2D", { position = pos, text = tostring(text), font_size = opts.size or 32, color = c, font = opts.font or "bold",
		outline = col(opts.outline or "#000000"), outline_size = opts.outlineSize or 3, z_index = opts.z or 500 })
	if not e then return nil end
	local s = opts.seconds or 0.8
	local drift = opts.drift or (random(-1, 1) * 16)
	if opts.pop ~= false then try(function() e.scale = vec2(1.5, 1.5) end) tw(e, { scale = vec2(1, 1) }, 0.18, "back_out") end
	tw(e, { position = pos + vec2(drift, -(opts.rise or 70)) }, s, "quad_out")
	tw(e, { color = withAlpha(c, 0) }, s * 0.5, { easing = "quad_in", delay = s * 0.5 })
	destroyLater(e, s + 0.05)
	return e
end
-- damage(n, worldPos, { crit?, heal?, miss? }): styled damage number
function J.damage(n, pos, opts)
	opts = opts or {}
	if opts.miss then return J.popup("miss", pos, { color = "#c8d0dc", size = 26 }) end
	if opts.heal then return J.popup("+" .. tostring(n), pos, { color = "#5fe08a", size = 32 }) end
	if opts.crit then
		local e = J.popup(tostring(n) .. "!", pos, { color = "#ffd23f", size = 46, rise = 90, seconds = 1 })
		return e
	end
	return J.popup(tostring(n), pos, { color = opts.color or "#ffffff", size = 34 })
end

-- ---------- particles ----------
local function emitter(pos, props, n, life)
	if type(spawn) ~= "function" then return nil end
	local p = { position = pos, emitting = false, shape = "circle", z_index = 400 }
	for k, v in props do p[k] = v end
	local e = try(spawn, "Particles2D", p)
	if not e then return nil end
	try(function() e:burst(n) end)
	destroyLater(e, (p.lifetime or 0.6) + (p.lifetime_random or 0) + 0.2)
	return e
end
J.emitter = emitter
-- sparkle(worldPos, { color = "#ffe066", n = 10 })
function J.sparkle(pos, opts)
	opts = opts or {}
	return emitter(pos, { start_color = col(opts.color or "#ffe066"), end_color = col("#ffffff00"), speed = 90, speed_random = 40, spread = 360,
		lifetime = 0.45, start_size = 8, end_size = 0 }, opts.n or 10)
end
-- dust(worldPos): landing puff
function J.dust(pos, opts)
	opts = opts or {}
	return emitter(pos, { start_color = col(opts.color or "#d8cbb0"), end_color = col("#d8cbb000"), speed = 60, spread = 160, direction = -90,
		lifetime = 0.4, start_size = 10, end_size = 0, gravity = vec2(0, 200) }, opts.n or 8)
end
-- coinBurst(worldPos, { n = 12, color = "#ffd34d", texture?, collectTo? (world Vec2), onArrive?(i), size = 20 })
-- particles always; with collectTo, n coin sprites spray out then fly to the target (HUD counters).
function J.coinBurst(pos, opts)
	opts = opts or {}
	local n = opts.n or 12
	emitter(pos, { start_color = col(opts.color or "#ffd34d"), end_color = col("#ffb30000"), speed = 220, speed_random = 80, spread = 360,
		direction = -90, gravity = vec2(0, 500), lifetime = 0.7, start_size = 10, end_size = 4 }, n)
	if not opts.collectTo or type(spawn) ~= "function" then return end
	local sz = opts.size or 20
	for i = 1, math.min(n, 16) do
		local props = { position = pos, size = vec2(sz, sz), z_index = 450 }
		if opts.texture then props.texture = opts.texture else props.modulate = col(opts.color or "#ffd34d") end
		local c = try(spawn, "Sprite2D", props)
		if c then
			local a = random(0, math.pi * 2)
			local out = pos + vec2(math.cos(a), math.sin(a)) * random(30, 80)
			tw(c, { position = out }, 0.25, "quad_out")
			later(0.25 + i * 0.03, function()
				if not alive(c) then return end
				local t = tw(c, { position = opts.collectTo, scale = vec2(0.6, 0.6) }, 0.4, "quad_in")
				later(0.4, function()
					if alive(c) then c:destroy() end
					if opts.onArrive then opts.onArrive(i) end
				end)
			end)
		end
	end
end
J.CONFETTI = { "#ff5d73", "#ffd23f", "#3ec7ff", "#7bed6b", "#c58bff" }
-- confetti(worldPos?, { n = 60, colors? }): celebration burst (default: top of the current view)
function J.confetti(pos, opts)
	opts = opts or {}
	if pos == nil then
		local c = if type(camera) == "table" and type(camera.center) == "function" then try(camera.center) else nil
		pos = if c then c + vec2(0, -560) else vec2(360, 80)
	end
	local colors = opts.colors or J.CONFETTI
	local per = math.ceil((opts.n or 60) / #colors)
	for _, hex in colors do
		emitter(pos, { shape = "square", start_color = col(hex), end_color = withAlpha(hex, 0.6), speed = 380, speed_random = 160, spread = 120,
			direction = 90, gravity = vec2(0, 420), damping = 0.6, lifetime = 1.8, lifetime_random = 0.6, start_size = 12, end_size = 8,
			emission_size = vec2(500, 10) }, per)
	end
end

-- ---------- UI text ----------
-- typewriter(textEntity, text, { cps = 40, onDone?, sfx? (id, every 2 chars) }) -> { skip(), cancel(), done }
function J.typewriter(e, text: string, opts)
	opts = opts or {}
	local h = { done = false }
	local function finish()
		if h.done then return end
		h.done = true
		if alive(e) then e.text = text end
		if opts.onDone then opts.onDone() end
	end
	if not alive(e) then h.skip = function() end h.cancel = function() end h.done = true return h end
	if type(every) ~= "function" or (opts.cps or 40) <= 0 then finish() h.skip = function() end h.cancel = function() end return h end
	local n, len = 0, #text
	e.text = ""
	local t
	t = every(1 / (opts.cps or 40), function()
		if h.done or not alive(e) then t:cancel() return end
		n += 1
		e.text = string.sub(text, 1, n)
		if opts.sfx and n % 2 == 0 then pcall(sfx.play, opts.sfx, { volume = 0.4 }) end
		if n >= len then t:cancel() finish() end
	end)
	function h.skip() t:cancel() finish() end
	function h.cancel() t:cancel() h.done = true end
	return h
end
-- rollup(textEntity, from, to, { seconds = 0.6, prefix = "", suffix = "", format?(n) -> string, onDone? }) -> { cancel() }
function J.rollup(e, from: number, to: number, opts)
	opts = opts or {}
	local fmt = opts.format or function(v) return tostring(math.floor(v + 0.5)) end
	local function set(v) if alive(e) then e.text = (opts.prefix or "") .. fmt(v) .. (opts.suffix or "") end end
	local h = {}
	if type(every) ~= "function" or type(time) ~= "function" then set(to) h.cancel = function() end return h end
	local start, dur = time(), opts.seconds or 0.6
	set(from)
	local t
	t = every(1 / 30, function()
		local k = math.clamp((time() - start) / dur, 0, 1)
		k = 1 - (1 - k) ^ 3
		set(from + (to - from) * k)
		if k >= 1 then t:cancel() if opts.onDone then opts.onDone() end end
	end)
	function h.cancel() t:cancel() end
	return h
end

-- ---------- scene transitions ----------
-- transition(kind = "fade" | "wipe" | "iris", { scene?, params?, seconds = 0.35, color = "#000000", onCovered? })
-- Covers the screen, then loadScene(scene, params) (or onCovered()), then reveals on the new scene.
-- Call it from a session (unattached) script so the reveal survives the scene switch; otherwise call juice.reveal(kind)
-- at the top of the new scene's script.
local Z = 3000
local function cover(kind, c, s, reveal)
	if type(spawn) ~= "function" then return {} end
	local W, H = 1400, 1400
	local panels = {}
	local function mk(props) local p = try(spawn, "UIPanel", props) if p then table.insert(panels, p) end return p end
	if kind == "wipe" then
		local p = mk({ anchor = if reveal then "right" else "left", size = vec2(if reveal then W else 0, 4000), background = c, z_index = Z })
		if p then tw(p, { size = vec2(if reveal then 0 else W, 4000) }, s, "quad_in_out") end
	elseif kind == "iris" then
		for _, a in { "top", "bottom", "left", "right" } do
			local vert = a == "top" or a == "bottom"
			local full = if vert then vec2(4000, H * 0.55) else vec2(W * 0.55, 4000)
			local zero = if vert then vec2(4000, 0) else vec2(0, 4000)
			local p = mk({ anchor = a, size = if reveal then full else zero, background = c, z_index = Z })
			if p then tw(p, { size = if reveal then zero else full }, s, if reveal then "quad_out" else "quad_in") end
		end
	else
		local p = mk({ anchor = "center", size = vec2(4000, 4000), background = withAlpha(c, if reveal then 1 else 0), z_index = Z })
		if p then tw(p, { background = withAlpha(c, if reveal then 0 else 1) }, s, "linear") end
	end
	return panels
end
local pending = nil
function J.reveal(kind: string?, opts)
	opts = opts or pending or {}
	pending = nil
	local s = opts.seconds or 0.35
	local panels = cover(kind or opts.kind or "fade", col(opts.color or "#000000"), s, true)
	for _, p in panels do destroyLater(p, s + 0.05) end
end
function J.transition(kind: string?, opts)
	opts = opts or {}
	kind = kind or "fade"
	local s = opts.seconds or 0.35
	local c = col(opts.color or "#000000")
	local panels = cover(kind, c, s, false)
	local ok = #panels > 0
	if ok and core then core.pause.push("transition", true) end
	later(s, function()
		if ok and core then core.pause.pop("transition") end
		if opts.scene then
			pending = { kind = kind, seconds = s, color = opts.color }
			if type(game) == "table" and game.sceneLoaded then
				local conn
				conn = game.sceneLoaded:connect(function()
					conn:disconnect()
					if pending then J.reveal(kind) end
				end)
			end
			loadScene(opts.scene, opts.params)
		else
			if opts.onCovered then opts.onCovered() end
			for _, p in panels do if alive(p) then p:destroy() end end
			J.reveal(kind, { seconds = s, color = opts.color })
		end
	end)
end

-- sfx(id, opts?): sfx.play that never errors (missing ids are ignored)
function J.sfx(id: string, opts) if type(sfx) == "table" then pcall(sfx.play, id, opts) end end

return J
