// Luau prelude: installs the platform API (format/LUAU_API.md) as globals before luaL_sandbox.
// Values cross the host boundary as primitives + type tags; everything else lives here.

export const OP = {
  INIT: 1, PRINT: 2, GET: 3, SET: 4, CALL: 5, ENTITY: 6, TAGGED: 7, SPAWN: 8,
  ONTICK: 9, AFTER: 10, EVERY: 11, CANCEL: 12, RANDOM: 13, TIME: 14,
  CONNECT: 15, DISCONNECT: 16, AXIS: 17, PRESSED: 18, HELD: 19, POINTER: 20,
  TOAST: 21, SCREEN: 22, AVATAR: 23, FROMENTITY: 24, REQUIRE: 25, ERROR: 26, SOUND: 27,
  LOADSCENE: 28, STORE: 29, AUDIO: 30, SETTINGS: 31, TWEEN: 32, SAVE: 33, DIALOG: 34, CAMERA: 35, FILES: 36, CLOCK: 37, GAMEPROP: 38, ALIVE: 39, UNTICK: 40, LEADERBOARD: 41, PLATFORM: 42,
  NET: 60,
} as const;

// value tags: 0 plain, 1 vec2, 2 vec3, 3 color(r,g,b,a 0..1), 4 entity handle
export const TAG = { PLAIN: 0, VEC2: 1, VEC3: 2, COLOR: 3, ENTITY: 4 } as const;

export const PRELUDE = /* luau */ `
local H = __host
local OP_INIT, OP_PRINT, OP_GET, OP_SET, OP_CALL, OP_ENTITY, OP_TAGGED, OP_SPAWN = ${OP.INIT}, ${OP.PRINT}, ${OP.GET}, ${OP.SET}, ${OP.CALL}, ${OP.ENTITY}, ${OP.TAGGED}, ${OP.SPAWN}
local OP_ONTICK, OP_AFTER, OP_EVERY, OP_CANCEL, OP_RANDOM, OP_TIME = ${OP.ONTICK}, ${OP.AFTER}, ${OP.EVERY}, ${OP.CANCEL}, ${OP.RANDOM}, ${OP.TIME}
local OP_CONNECT, OP_DISCONNECT, OP_AXIS, OP_PRESSED, OP_HELD, OP_POINTER = ${OP.CONNECT}, ${OP.DISCONNECT}, ${OP.AXIS}, ${OP.PRESSED}, ${OP.HELD}, ${OP.POINTER}
local OP_TOAST, OP_SCREEN, OP_AVATAR, OP_FROMENTITY, OP_REQUIRE, OP_ERROR, OP_SOUND = ${OP.TOAST}, ${OP.SCREEN}, ${OP.AVATAR}, ${OP.FROMENTITY}, ${OP.REQUIRE}, ${OP.ERROR}, ${OP.SOUND}
local OP_LOADSCENE, OP_STORE, OP_AUDIO, OP_SETTINGS = ${OP.LOADSCENE}, ${OP.STORE}, ${OP.AUDIO}, ${OP.SETTINGS}
local OP_TWEEN, OP_SAVE, OP_DIALOG, OP_CAMERA = ${OP.TWEEN}, ${OP.SAVE}, ${OP.DIALOG}, ${OP.CAMERA}
local OP_FILES, OP_CLOCK, OP_GAMEPROP, OP_ALIVE, OP_UNTICK = ${OP.FILES}, ${OP.CLOCK}, ${OP.GAMEPROP}, ${OP.ALIVE}, ${OP.UNTICK}
local OP_LEADERBOARD, OP_PLATFORM = ${OP.LEADERBOARD}, ${OP.PLATFORM}
local OP_NET = ${OP.NET}

local traceback = debug.traceback
local freeze = table.freeze
local sqrt, floor, type_, setmetatable, getmetatable, tostring, select, error = math.sqrt, math.floor, type, setmetatable, getmetatable, tostring, select, error
local pack, unpack = table.pack, table.unpack

-- ---------- Vec2 ----------
local Vec2 = {}
local Vec2M = {}
local function v2(x, y) return freeze(setmetatable({ x = x, y = y }, Vec2M)) end
Vec2M.__index = Vec2
local function isV2(v) return getmetatable(v) == Vec2M end
Vec2M.__add = function(a, b) return v2(a.x + b.x, a.y + b.y) end
Vec2M.__sub = function(a, b) return v2(a.x - b.x, a.y - b.y) end
Vec2M.__mul = function(a, b)
	if type_(a) == "number" then return v2(a * b.x, a * b.y) end
	if type_(b) == "number" then return v2(a.x * b, a.y * b) end
	return v2(a.x * b.x, a.y * b.y)
end
Vec2M.__div = function(a, b)
	if type_(b) == "number" then return v2(a.x / b, a.y / b) end
	return v2(a.x / b.x, a.y / b.y)
end
Vec2M.__unm = function(a) return v2(-a.x, -a.y) end
Vec2M.__eq = function(a, b) return a.x == b.x and a.y == b.y end
Vec2M.__tostring = function(a) return "vec2(" .. tostring(a.x) .. ", " .. tostring(a.y) .. ")" end
function Vec2.length(a) return sqrt(a.x * a.x + a.y * a.y) end
function Vec2.normalized(a)
	local l = sqrt(a.x * a.x + a.y * a.y)
	if l == 0 then return v2(0, 0) end
	return v2(a.x / l, a.y / l)
end
function Vec2.dot(a, b) return a.x * b.x + a.y * b.y end
function Vec2.lerp(a, b, t) return v2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) end
function Vec2.distance(a, b) local dx, dy = a.x - b.x, a.y - b.y return sqrt(dx * dx + dy * dy) end

-- ---------- Vec3 ----------
local Vec3 = {}
local Vec3M = {}
local function v3(x, y, z) return freeze(setmetatable({ x = x, y = y, z = z }, Vec3M)) end
Vec3M.__index = Vec3
local function isV3(v) return getmetatable(v) == Vec3M end
Vec3M.__add = function(a, b) return v3(a.x + b.x, a.y + b.y, a.z + b.z) end
Vec3M.__sub = function(a, b) return v3(a.x - b.x, a.y - b.y, a.z - b.z) end
Vec3M.__mul = function(a, b)
	if type_(a) == "number" then return v3(a * b.x, a * b.y, a * b.z) end
	if type_(b) == "number" then return v3(a.x * b, a.y * b, a.z * b) end
	return v3(a.x * b.x, a.y * b.y, a.z * b.z)
end
Vec3M.__div = function(a, b)
	if type_(b) == "number" then return v3(a.x / b, a.y / b, a.z / b) end
	return v3(a.x / b.x, a.y / b.y, a.z / b.z)
end
Vec3M.__unm = function(a) return v3(-a.x, -a.y, -a.z) end
Vec3M.__eq = function(a, b) return a.x == b.x and a.y == b.y and a.z == b.z end
Vec3M.__tostring = function(a) return "vec3(" .. tostring(a.x) .. ", " .. tostring(a.y) .. ", " .. tostring(a.z) .. ")" end
function Vec3.length(a) return sqrt(a.x * a.x + a.y * a.y + a.z * a.z) end
function Vec3.normalized(a)
	local l = sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
	if l == 0 then return v3(0, 0, 0) end
	return v3(a.x / l, a.y / l, a.z / l)
end
function Vec3.dot(a, b) return a.x * b.x + a.y * b.y + a.z * b.z end
function Vec3.cross(a, b) return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x) end
function Vec3.lerp(a, b, t) return v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t) end
function Vec3.distance(a, b) return (a - b):length() end

-- ---------- Color ----------
local Color = {}
local ColorM = {}
local function col(r, g, b, a) return freeze(setmetatable({ r = r, g = g, b = b, a = a }, ColorM)) end
ColorM.__index = Color
local function isColor(v) return getmetatable(v) == ColorM end
local function hex2(n) return string.format("%02x", math.clamp(floor(n * 255 + 0.5), 0, 255)) end
function Color.toHex(c)
	local s = "#" .. hex2(c.r) .. hex2(c.g) .. hex2(c.b)
	if c.a < 1 then s ..= hex2(c.a) end
	return s
end
function Color.lerp(a, b, t) return col(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t, a.a + (b.a - a.a) * t) end
ColorM.__tostring = function(c) return Color.toHex(c) end
ColorM.__eq = function(a, b) return a.r == b.r and a.g == b.g and a.b == b.b and a.a == b.a end
local function parseHex(s)
	if type_(s) ~= "string" then error("color() expects a hex string like \\"#ff8800\\"", 3) end
	local h = s:gsub("^#", "")
	if #h == 3 then h = h:sub(1,1):rep(2) .. h:sub(2,2):rep(2) .. h:sub(3,3):rep(2) end
	if not (#h == 6 or #h == 8) or h:find("[^%x]") then error("invalid color \\"" .. s .. "\\" (use #rrggbb or #rrggbbaa)", 3) end
	local r, g, b = tonumber(h:sub(1, 2), 16), tonumber(h:sub(3, 4), 16), tonumber(h:sub(5, 6), 16)
	local a = if #h == 8 then tonumber(h:sub(7, 8), 16) else 255
	return col(r / 255, g / 255, b / 255, a / 255)
end

-- ---------- value marshalling ----------
local proxies = setmetatable({}, { __mode = "v" })
local handleOf = setmetatable({}, { __mode = "k" })
local EntityM = {}

local function proxy(h)
	if h == nil then return nil end
	local p = proxies[h]
	if p == nil then
		p = setmetatable({}, EntityM)
		proxies[h] = p
		handleOf[p] = h
	end
	return p
end

local function decode(tag, a, b, c, d)
	if tag == 0 then return a
	elseif tag == 1 then return v2(a, b)
	elseif tag == 2 then return v3(a, b, c)
	elseif tag == 3 then return col(a, b, c, d)
	elseif tag == 4 then return proxy(a)
	end
	return nil
end

-- returns tag, a, b, c, d
local function encode(v)
	local t = type_(v)
	if t == "table" then
		local m = getmetatable(v)
		if m == Vec2M then return 1, v.x, v.y
		elseif m == Vec3M then return 2, v.x, v.y, v.z
		elseif m == ColorM then return 3, v.r, v.g, v.b, v.a
		end
		local h = handleOf[v]
		if h then return 4, h end
		error("cannot store a table in an entity property", 3)
	end
	return 0, v
end

local function handle(e, what)
	local h = handleOf[e]
	if h == nil then error((what or "argument") .. " must be an Entity", 3) end
	return h
end

local function handlesToProxies(hs)
	for i = 1, #hs do hs[i] = proxy(hs[i]) end
	return hs
end

-- ---------- Connection / Signal ----------
local ConnM = { __index = {} }
function ConnM.__index.disconnect(c)
	if c._id then H(OP_DISCONNECT, c._id) c._id = nil end
	if c._tick then H(OP_UNTICK, c._tick) c._tick = nil end
	if c._sig then c._sig.fns[c._fn] = nil c._sig = nil end
	c.connected = false
end

-- entity signals live in the host (fired by physics / UI / input)
local SignalM = { __index = {} }
-- signals whose host args are raw x, y numbers rebuilt into a Vec2 here
local VEC_SIGNALS = { tappedAt = 1, pointerDown = 1, pointerUp = 1, swipe = 2 }
function SignalM.__index.connect(s, fn)
	if type_(fn) ~= "function" then error(s._name .. ":connect expects a function", 2) end
	local vs = VEC_SIGNALS[s._name]
	local f = fn
	if vs == 1 then f = function(x, y) return fn(v2(x, y)) end
	elseif vs == 2 then f = function(a, x, y) return fn(a, v2(x, y)) end end
	local id = H(OP_CONNECT, s._h, s._name, f)
	return setmetatable({ _id = id, connected = true }, ConnM)
end
SignalM.__index.Connect = SignalM.__index.connect

-- script-side signals (players.joined / left)
local LocalSignalM = { __index = {} }
local function localSignal() return setmetatable({ fns = {}, order = {} }, LocalSignalM) end
function LocalSignalM.__index.connect(s, fn)
	s.fns[fn] = true
	table.insert(s.order, fn)
	return setmetatable({ _sig = s, _fn = fn, connected = true }, ConnM)
end
local function reportError(msg)
	H(OP_ERROR, tostring(msg), traceback(tostring(msg), 2))
end
local function fireLocal(s, ...)
	for _, fn in s.order do
		if s.fns[fn] then
			local ok, err = xpcall(fn, function(m) H(OP_ERROR, tostring(m), traceback(tostring(m), 2)) return m end, ...)
		end
	end
end

-- ---------- Entity ----------
local SIGNALS = { bodyEntered = true, bodyExited = true, pressed = true, tapped = true, tileTouched = true, animFinished = true, tileTapped = true, tappedAt = true }
local methods = {}
function methods.children(e) return handlesToProxies(H(OP_CALL, handle(e, "self"), "children")) end
function methods.hasTag(e, tag) return H(OP_CALL, handle(e, "self"), "hasTag", tag) end
function methods.addTag(e, tag) H(OP_CALL, handle(e, "self"), "addTag", tag) end
function methods.removeTag(e, tag) H(OP_CALL, handle(e, "self"), "removeTag", tag) end
function methods.destroy(e) H(OP_CALL, handle(e, "self"), "destroy") end
function methods.clone(e, parent)
	return proxy(H(OP_CALL, handle(e, "self"), "clone", if parent ~= nil then handle(parent, "parent") else nil))
end
function methods.applyImpulse(e, v) H(OP_CALL, handle(e, "self"), "applyImpulse", encode(v)) end
-- sprite animation (Sprite2D anims, or the first descendant sprite that has them)
function methods.play(e, name, restart)
	if type_(name) ~= "string" then error("play expects an animation name string, e.g. e:play(\\"run\\")", 2) end
	H(OP_CALL, handle(e, "self"), "play", name, restart == true)
end
function methods.stop(e) H(OP_CALL, handle(e, "self"), "stop") end
-- Particles2D
function methods.burst(e, n) H(OP_CALL, handle(e, "self"), "burst", n) end
function methods.clearParticles(e) H(OP_CALL, handle(e, "self"), "clearParticles") end
-- TileMap2D (cells are 0-based: col 0 = left, row 0 = top)
local function tilePos(v, name)
	if not isV2(v) then error(name .. " expects a Vec2 world position", 3) end
	return 1, v.x, v.y
end
function methods.tileAt(e, pos) return H(OP_CALL, handle(e, "self"), "tileAt", tilePos(pos, "tileAt")) end
function methods.tagsAt(e, pos) return H(OP_CALL, handle(e, "self"), "tagsAt", tilePos(pos, "tagsAt")) end
function methods.worldToCell(e, pos) return H(OP_CALL, handle(e, "self"), "worldToCell", tilePos(pos, "worldToCell")) end
function methods.cellToWorld(e, c, r) return v2(H(OP_CALL, handle(e, "self"), "cellToWorld", c, r)) end
function methods.getTile(e, c, r) return H(OP_CALL, handle(e, "self"), "getTile", c, r) end
function methods.setTile(e, c, r, ch) H(OP_CALL, handle(e, "self"), "setTile", c, r, ch) end
function methods.isSolid(e, c, r) return H(OP_CALL, handle(e, "self"), "isSolid", c, r) end
function methods.tileDef(e, ch) return H(OP_CALL, handle(e, "self"), "tileDef", ch) end
local signalCache = setmetatable({}, { __mode = "k" })

EntityM.__index = function(e, k)
	local m = methods[k]
	if m then return m end
	if k == "destroyed" then return not H(OP_ALIVE, handleOf[e]) end
	if SIGNALS[k] then
		local c = signalCache[e]
		if not c then c = {} signalCache[e] = c end
		local s = c[k]
		if not s then
			s = setmetatable({ _h = handleOf[e], _name = k }, SignalM)
			c[k] = s
		end
		return s
	end
	return decode(H(OP_GET, handleOf[e], k))
end
EntityM.__newindex = function(e, k, v)
	H(OP_SET, handleOf[e], k, encode(v))
end
EntityM.__tostring = function(e) return "Entity(" .. tostring(decode(H(OP_GET, handleOf[e], "id"))) .. ")" end
EntityM.__metatable = "Entity"

-- ---------- globals ----------
function vec2(x, y) return v2(x or 0, y or 0) end
function vec3(x, y, z) return v3(x or 0, y or 0, z or 0) end
function color(hex) return parseHex(hex) end

function entity(id) return proxy(H(OP_ENTITY, id)) end
function isEntity(v) return type_(v) == "table" and handleOf[v] ~= nil end
function entitiesTagged(tag) return handlesToProxies(H(OP_TAGGED, tag)) end

function spawn(typ, props, parent)
	local ph = if parent ~= nil then handle(parent, "parent") else nil
	local h = H(OP_SPAWN, typ, ph)
	local e = proxy(h)
	if props ~= nil then
		for k, v in props do
			H(OP_SET, h, k, encode(v))
		end
	end
	H(OP_SPAWN, nil, nil, h) -- finish: create physics etc.
	return e
end

function onTick(fn) return setmetatable({ _tick = H(OP_ONTICK, fn), connected = true }, ConnM) end
local TimerM = { __index = {} }
function TimerM.__index.cancel(t) if t._id then H(OP_CANCEL, t._id) t._id = nil end end
TimerM.__index.Cancel = TimerM.__index.cancel
function after(seconds, fn) return setmetatable({ _id = H(OP_AFTER, seconds, fn) }, TimerM) end
function every(seconds, fn) return setmetatable({ _id = H(OP_EVERY, seconds, fn) }, TimerM) end
function random(min, max) return H(OP_RANDOM, min, max) end
function time() return H(OP_TIME) end
function print(...)
	local n = select("#", ...)
	local parts = table.create(n)
	for i = 1, n do parts[i] = tostring((select(i, ...))) end
	H(OP_PRINT, table.concat(parts, "\\t"))
end
warn = print

-- ---------- done signals (tweens, dialogs): fired by the host via doneFire ----------
local doneSignals = {}
local function doneFire(id, arg, dropped)
	local s = doneSignals[id]
	if s == nil then return end
	doneSignals[id] = nil
	if dropped then return end
	if arg ~= nil then fireLocal(s, arg) else fireLocal(s) end
end

-- ---------- tweens ----------
local TweenM = { __index = {} }
function TweenM.__index.cancel(t)
	if t._id then H(OP_TWEEN, "cancel", t._id) doneSignals[t._id] = nil t._id = nil end
end
TweenM.__index.Cancel = TweenM.__index.cancel
function tween(e, props, seconds, opts)
	local h = handle(e, "tween target")
	if type_(props) ~= "table" then error("tween expects a table of target values, e.g. tween(e, { position = vec2(100, 50) }, 0.5)", 2) end
	if type_(seconds) ~= "number" then error("tween expects a duration in seconds", 2) end
	local easing, delay, loop, yoyo = nil, nil, false, false
	if type_(opts) == "string" then easing = opts
	elseif type_(opts) == "table" then easing, delay, loop, yoyo = opts.easing, opts.delay, opts.loop == true, opts.yoyo == true
	elseif opts ~= nil then error("tween's 4th argument is an easing name or { easing, delay, loop, yoyo }", 2) end
	local args, n = {}, 0
	for k, v in props do
		if type_(k) ~= "string" then error("tween property names must be strings", 2) end
		local tag, a, b, c, d = encode(v)
		args[n + 1], args[n + 2], args[n + 3], args[n + 4], args[n + 5], args[n + 6] = k, tag, a, b, c, d
		n += 6
	end
	local id = H(OP_TWEEN, "start", h, seconds, easing, delay, loop, yoyo, unpack(args, 1, n))
	local sig = localSignal()
	doneSignals[id] = sig
	return setmetatable({ _id = id, done = sig }, TweenM)
end

-- ---------- camera ----------
camera = freeze({
	shake = function(intensity, seconds)
		if type_(intensity) ~= "number" then error("camera.shake expects an intensity in world pixels, e.g. camera.shake(8, 0.3)", 2) end
		H(OP_CAMERA, "shake", intensity, seconds)
	end,
	zoomTo = function(z, seconds, easing)
		local c = H(OP_CAMERA, "current")
		if c == nil then error("camera.zoomTo needs a current Camera2D in the scene", 2) end
		return tween(proxy(c), { zoom = z }, seconds or 0.5, easing or "sine_in_out")
	end,
	current = function() return proxy(H(OP_CAMERA, "current")) end,
	center = function() return v2(H(OP_CAMERA, "center")) end,
	snap = function() H(OP_CAMERA, "snap") end,
	viewSize = function() return v2(H(OP_CAMERA, "viewSize")) end,
	screenToWorld = function(p)
		if not isV2(p) then error("camera.screenToWorld expects a Vec2 in screen (UI) pixels", 2) end
		return v2(H(OP_CAMERA, "toWorld", p.x, p.y))
	end,
	worldToScreen = function(p)
		if not isV2(p) then error("camera.worldToScreen expects a Vec2 world position", 2) end
		return v2(H(OP_CAMERA, "toScreen", p.x, p.y))
	end,
	-- 2.5D: the scene's view mode, and screen directions (joystick) -> world directions
	view = function() return H(OP_CAMERA, "view") end,
	screenDirToWorld = function(d)
		if not isV2(d) then error("camera.screenDirToWorld expects a Vec2 direction, e.g. vec2(input.axis('move_x'), input.axis('move_y'))", 2) end
		if H(OP_CAMERA, "view") ~= "iso" then return d end
		-- iso draws (x, y) at (x - y, (x + y) / 2): undo that, keeping the input's length
		local wx, wy = d.y + d.x * 0.5, d.y - d.x * 0.5
		local len = sqrt(wx * wx + wy * wy)
		if len < 1e-9 then return v2(0, 0) end
		local k = sqrt(d.x * d.x + d.y * d.y) / len
		return v2(wx * k, wy * k)
	end,
})
screen = freeze({
	size = function() return v2(H(OP_CAMERA, "screenSize")) end,
})

-- ---------- save data ----------
local function checkJSON(v, depth)
	local t = type_(v)
	if t == "nil" or t == "boolean" or t == "number" or t == "string" then return end
	if t ~= "table" or getmetatable(v) ~= nil then error("save values must be nil, booleans, numbers, strings or plain tables of those (not " .. (if t == "table" then "a Vec2/Color/Entity" else t) .. ")", 3 + depth) end
	if depth > 32 then error("save value nested too deeply", 3) end
	for k, x in v do checkJSON(x, depth + 1) end
end
local function saveKey(k, fn)
	if type_(k) ~= "string" then error("save." .. fn .. " expects a key string", 3) end
	return k
end
save = freeze({
	get = function(key, default) return H(OP_SAVE, "get", saveKey(key, "get"), default) end,
	set = function(key, value) saveKey(key, "set") checkJSON(value, 0) H(OP_SAVE, "set", key, value) end,
	remove = function(key) H(OP_SAVE, "remove", saveKey(key, "remove")) end,
	keys = function() return H(OP_SAVE, "keys") end,
})

-- ---------- dialogs ----------
local DialogM = { __index = {} }
function DialogM.__index.close(d) if d._id then H(OP_DIALOG, "close", d._id) doneSignals[d._id] = nil d._id = nil end end
local function dialogLine(l, opts, i)
	if type_(l) == "string" then return { text = l, speaker = opts.speaker, portrait = opts.portrait } end
	if type_(l) == "table" and type_(l.text) == "string" then
		return { text = l.text, speaker = if l.speaker ~= nil then tostring(l.speaker) else opts.speaker, portrait = if l.portrait ~= nil then tostring(l.portrait) else opts.portrait }
	end
	error("ui.dialog line " .. i .. " must be a string or { text = ..., speaker = ..., portrait = ... }", 3)
end
local function openDialog(kind, lines, options, opts)
	opts = opts or {}
	if type_(opts) ~= "table" then error("dialog options must be a table", 3) end
	local norm = {}
	for i, l in lines do norm[i] = dialogLine(l, opts, i) end
	local id = H(OP_DIALOG, "open", kind, norm, options, opts.speed, opts.position, opts.block)
	local sig = localSignal()
	doneSignals[id] = sig
	return setmetatable({ _id = id, done = sig }, DialogM)
end

input = freeze({
	pointerDown = setmetatable({ _h = 0, _name = "pointerDown" }, SignalM),
	pointerUp = setmetatable({ _h = 0, _name = "pointerUp" }, SignalM),
	swipe = setmetatable({ _h = 0, _name = "swipe" }, SignalM),
	axis = function(name) return H(OP_AXIS, name) end,
	pressed = function(name) return H(OP_PRESSED, name) end,
	held = function(name) return H(OP_HELD, name) end,
	pointer = function() return decode(H(OP_POINTER)) end,
})

ui = freeze({
	dialog = function(lines, opts)
		if type_(lines) == "string" then lines = { lines } end
		if type_(lines) ~= "table" then error("ui.dialog expects a list of lines, e.g. ui.dialog({ \\"Hi!\\", { text = \\"Bye\\", speaker = \\"Fox\\" } })", 2) end
		return openDialog("dialog", lines, nil, opts)
	end,
	choice = function(prompt, options, fn, opts)
		if type_(options) ~= "table" or #options == 0 then error("ui.choice expects a list of option strings, e.g. ui.choice(\\"Fight?\\", { \\"Yes\\", \\"No\\" }, function(i) end)", 2) end
		local labels = {}
		for i, o in options do labels[i] = tostring(o) end
		if type_(fn) == "table" and opts == nil then opts, fn = fn, nil end
		local d = openDialog("choice", { prompt }, labels, opts)
		if type_(fn) == "function" then d.done:connect(fn) end
		return d
	end,
	dialogOpen = function() return H(OP_DIALOG, "isOpen") end,
	theme = function() return H(OP_GAMEPROP, "theme") end,
	toast = function(text, seconds) H(OP_TOAST, tostring(text), seconds) end,
	showScreen = function(id) H(OP_SCREEN, id, true) end,
	hideScreen = function(id) H(OP_SCREEN, id, false) end,
})

sound = freeze({
	play = function(assetId, at) H(OP_SOUND, assetId, encode(at)) end,
})

-- ---------- players + rooms (multiplayer, DREAMSY.MD §4.5) ----------
-- Offline (no room): one local player, events stay in-process. In a room: players/teams from the room server,
-- fireServer goes to the room host's device, fireClient/fireAll are relayed, avatars replicate via room.replicate.
local net = { online = H(OP_NET, "active"), spectator = H(OP_NET, "prop", "isSpectator") == true, objs = {} }
local PlayerM = {}
local localPlayer
function net.playerOf(id)
	if id == nil then return nil end
	local p = net.objs[id]
	if not p then
		local info = H(OP_NET, "player", id)
		p = setmetatable({ id = id, name = if info then info.name else "Player", team = if info then info.team else nil, userId = if info then info.userId else id }, PlayerM)
		net.objs[id] = p
	end
	return p
end
PlayerM.__index = function(p, k)
	if k == "avatar" then return proxy(H(OP_NET, "avatar", rawget(p, "id"))) end
	if k == "isLocal" then return p == localPlayer end
	if k == "isHost" then return H(OP_NET, "host") == rawget(p, "id") end
	return nil
end
PlayerM.__tostring = function(p) return "Player(" .. p.name .. ")" end
-- spectators have no local player: players.local == nil
local selfInfo = if net.spectator then nil else H(OP_NET, "self")
localPlayer = if selfInfo then net.playerOf(selfInfo.id) else nil
local joined, left = localSignal(), localSignal()
function net.all()
	local out = {}
	for i, info in H(OP_NET, "players") do
		local p = net.playerOf(info.id)
		p.name = info.name
		p.team = info.team
		out[i] = p
	end
	return out
end
players = freeze({
	["local"] = localPlayer,
	all = net.all,
	get = function(id) if H(OP_NET, "player", tostring(id)) then return net.playerOf(tostring(id)) end return nil end,
	onTeam = function(team)
		local out = {}
		for _, p in net.all() do if p.team == team then table.insert(out, p) end end
		return out
	end,
	fromEntity = function(e)
		if e == nil then return nil end
		return net.playerOf(H(OP_NET, "fromEntity", handle(e, "entity")))
	end,
	joined = joined,
	left = left,
})

-- ---------- networking ----------
local remotes = {}
local queue = {}
local RemoteEventM = { __index = {} }
local function deliver(fns, ...)
	for _, fn in fns do
		xpcall(fn, function(m) H(OP_ERROR, tostring(m), traceback(tostring(m), 2)) return m end, ...)
	end
end
-- wire encoding: Players → {$p=id}, Vec2 → {$v={x,y}}, nil args → {$nil=true}; Entities can't cross the network
function net.enc(v, d)
	local t = type_(v)
	if t == "table" then
		if d > 16 then error("remoteEvent/room: value is nested too deeply", 0) end
		local mt = getmetatable(v)
		if mt == PlayerM then return { ["$p"] = rawget(v, "id") } end
		if mt == Vec2M then return { ["$v"] = { v.x, v.y } } end
		if handleOf[v] then error("can't send an Entity over the network: send its position or a Player instead", 0) end
		local o = {}
		for k, x in v do o[k] = net.enc(x, d + 1) end
		return o
	elseif t == "function" or t == "userdata" or t == "thread" then
		error("can't send a " .. t .. " over the network", 0)
	end
	return v
end
function net.dec(v)
	if type_(v) ~= "table" then return v end
	if v["$p"] ~= nil then return net.playerOf(v["$p"]) end
	if v["$v"] ~= nil then return v2(v["$v"][1], v["$v"][2]) end
	if v["$nil"] ~= nil then return nil end
	local o = {}
	for k, x in v do o[k] = net.dec(x) end
	return o
end
function net.send(name, to, ...)
	local n = select("#", ...)
	local a = {}
	for i = 1, n do
		local x = select(i, ...)
		local ok, r = pcall(net.enc, x, 0)
		if not ok then error("remoteEvent \\"" .. name .. "\\": " .. tostring(r), 3) end
		a[i] = if x == nil then { ["$nil"] = true } else r
	end
	H(OP_NET, "send", name, to, a)
end
function RemoteEventM.__index.fireServer(r, ...)
	if net.spectator then return end -- spectators only watch
	if net.online and H(OP_NET, "host") ~= localPlayer.id then net.send(r.name, "host", ...) return end
	table.insert(queue, { r.server, true, pack(...) })
end
function RemoteEventM.__index.fireClient(r, player, ...)
	if net.spectator then return end
	if net.online and getmetatable(player) == PlayerM and player ~= localPlayer then net.send(r.name, rawget(player, "id"), ...) return end
	table.insert(queue, { r.client, false, pack(...) })
end
function RemoteEventM.__index.fireAll(r, ...)
	if net.spectator then return end
	if net.online then net.send(r.name, "others", ...) end
	table.insert(queue, { r.client, false, pack(...) })
end
function RemoteEventM.__index.onServer(r, fn) table.insert(r.server, fn) end
function RemoteEventM.__index.onClient(r, fn) table.insert(r.client, fn) end
function remoteEvent(name)
	local r = remotes["e:" .. name]
	if not r then
		r = setmetatable({ name = name, server = {}, client = {} }, RemoteEventM)
		remotes["e:" .. name] = r
	end
	return r
end
local RemoteFunctionM = { __index = {} }
function RemoteFunctionM.__index.invoke(r, ...)
	if not r.handler then
		if net.online then error("remoteFunction \\"" .. r.name .. "\\": invoke only works on the room host in multiplayer v1 — use a remoteEvent and reply with fireClient", 2) end
		error("remoteFunction \\"" .. r.name .. "\\" has no onInvoke handler", 2)
	end
	if net.online and (net.spectator or H(OP_NET, "host") ~= localPlayer.id) then
		error("remoteFunction \\"" .. r.name .. "\\": invoke only works on the room host in multiplayer v1 — use a remoteEvent and reply with fireClient", 2)
	end
	return r.handler(localPlayer, ...)
end
function RemoteFunctionM.__index.onInvoke(r, fn) r.handler = fn end
function remoteFunction(name)
	local r = remotes["f:" .. name]
	if not r then
		r = setmetatable({ name = name }, RemoteFunctionM)
		remotes["f:" .. name] = r
	end
	return r
end
local function flushRemotes()
	if #queue == 0 then return end
	local q = queue
	queue = {}
	for _, item in q do
		if item[2] then
			deliver(item[1], localPlayer, unpack(item[3], 1, item[3].n))
		else
			deliver(item[1], unpack(item[3], 1, item[3].n))
		end
	end
end

-- ---------- room (multiplayer session: replication, shared state, scores, match result) ----------
do
	local stateChanged, scoreChanged, ended, avatarSpawned = localSignal(), localSignal(), localSignal(), localSignal()
	local function teamOrPlayer(k) if k == "red" or k == "blue" then return k end return net.playerOf(k) end
	local function targetKey(t, fn)
		if getmetatable(t) == PlayerM then return rawget(t, "id") end
		if t == "red" or t == "blue" then return t end
		error("room." .. fn .. " expects a Player, \\"red\\" or \\"blue\\"", 3)
	end
	H(OP_NET, "bind", function(kind, a, b, c, d)
		if kind == "ev" then
			local r = remotes["e:" .. a]
			if not r then return end
			local n = if d then #d else 0
			local args = {}
			for i = 1, n do args[i] = net.dec(d[i]) end
			if c then deliver(r.server, net.playerOf(b), unpack(args, 1, n))
			else deliver(r.client, unpack(args, 1, n)) end
		elseif kind == "join" then fireLocal(joined, net.playerOf(a))
		elseif kind == "leave" then fireLocal(left, net.playerOf(a))
		elseif kind == "kv" then fireLocal(stateChanged, a, net.dec(b))
		elseif kind == "score" then fireLocal(scoreChanged, teamOrPlayer(a), b)
		elseif kind == "ended" then
			fireLocal(ended, { winner = net.playerOf(a.winner), team = a.team, draw = a.draw == true, reason = a.reason, scores = a.scores or {} })
		elseif kind == "avatar" then fireLocal(avatarSpawned, net.playerOf(a), proxy(b))
		end
	end)
	local fields = freeze({
		replicate = function(e, opts)
			if opts ~= nil and type_(opts) ~= "table" then error("room.replicate options must be a table like { tint = false }", 2) end
			H(OP_NET, "replicate", handle(e, "entity"), not (opts and opts.tint == false))
		end,
		state = function(k) return net.dec(H(OP_NET, "state", tostring(k))) end,
		setState = function(k, v)
			if type_(k) ~= "string" then error("room.setState expects a key string, e.g. room.setState(\\"round\\", 2)", 2) end
			local ok, r = pcall(net.enc, v, 0)
			if not ok then error("room.setState: " .. tostring(r), 2) end
			H(OP_NET, "setState", k, r)
		end,
		addScore = function(t, n)
			if type_(n) ~= "number" then error("room.addScore expects a number, e.g. room.addScore(player, 1)", 2) end
			H(OP_NET, "addScore", targetKey(t, "addScore"), n)
		end,
		score = function(t) return H(OP_NET, "score", targetKey(t, "score")) end,
		scores = function() return H(OP_NET, "scores") end,
		finish = function(w)
			local key
			if w == nil or w == "draw" then key = "draw"
			elseif w == "red" or w == "blue" then key = w
			elseif getmetatable(w) == PlayerM then key = rawget(w, "id")
			else error("room.finish expects a Player, \\"red\\", \\"blue\\" or \\"draw\\"", 2) end
			H(OP_NET, "finish", key)
		end,
		teamColor = function(team) return color(H(OP_NET, "teamColor", tostring(team))) end,
		host = function() return net.playerOf(H(OP_NET, "host")) end,
		stateChanged = stateChanged, scoreChanged = scoreChanged, ended = ended, avatarSpawned = avatarSpawned,
	})
	local PROPS = { code = true, mode = true, max = true, min = true, isHost = true, match = true, seed = true, spectators = true }
	room = setmetatable({}, {
		__index = function(_, k)
			if k == "active" then return net.online end
			if k == "isSpectator" then return net.spectator end
			if PROPS[k] then return H(OP_NET, "prop", k) end
			return fields[k]
		end,
		__newindex = function(_, k) error("room." .. tostring(k) .. " is read-only", 2) end,
		__metatable = "room",
	})
end

-- ---------- data (in-memory until DataStore exists) ----------
local playerData = {}
local worldData = setmetatable({}, { __index = { save = function() end } })
local function filePath(p, fn)
	if type_(p) ~= "string" then error("data." .. fn .. " expects a package path string like \\"data/creatures\\"", 3) end
	return p
end
files = freeze({
	list = function(dir) return H(OP_FILES, "list", filePath(dir, "list")) end,
	read = function(path) return H(OP_FILES, "read", filePath(path, "read")) end,
	exists = function(path) return H(OP_FILES, "exists", filePath(path, "exists")) end,
})
data = freeze({
	list = files.list,
	read = files.read,
	exists = files.exists,
	player = function(p)
		local d = playerData[p.id]
		if not d then d = setmetatable({}, { __index = { save = function() end } }) playerData[p.id] = d end
		return d
	end,
	world = function() return worldData end,
})

-- ---------- scenes ----------
local scenePath, sceneParamsV, pendingParams = nil, {}, nil
function loadScene(path, params)
	if type_(path) ~= "string" then error("loadScene expects a scene path like \\"scenes/level_2.scene.json\\"", 2) end
	if params ~= nil and type_(params) ~= "table" then error("loadScene params must be a table", 2) end
	H(OP_LOADSCENE, path)
	pendingParams = params or {}
end
function sceneParams() return sceneParamsV end
function currentScene() return scenePath end
local function setScene(path, initial)
	scenePath = path
	sceneParamsV = initial or pendingParams or {}
	pendingParams = nil
end
local function gameSignal(name) return setmetatable({ _h = 0, _name = name }, SignalM) end
local gameFields = freeze({
	sceneLoaded = gameSignal("sceneLoaded"),
	paused = gameSignal("paused"),
	resumed = gameSignal("resumed"),
	restartRequested = gameSignal("restartRequested"),
	-- run fn as session code: onTick/every/after/connect inside it survive scene changes and entity deaths
	session = function(fn)
		if type_(fn) ~= "function" then error("game.session expects a function", 2) end
		H(OP_GAMEPROP, "session", fn)
	end,
})
game = setmetatable({}, {
	__index = function(_, k)
		if k == "timeScale" then return H(OP_GAMEPROP, "getTimeScale") end
		return gameFields[k]
	end,
	__newindex = function(_, k, v)
		if k == "timeScale" then H(OP_GAMEPROP, "setTimeScale", v) return end
		error("game." .. tostring(k) .. " is read-only", 2)
	end,
	__metatable = "game",
})
clock = freeze({
	now = function() return H(OP_CLOCK) end,
})

-- ---------- audio + settings ----------
local function optsTable(opts, fn)
	if opts == nil then return {} end
	if type_(opts) ~= "table" then error(fn .. " options must be a table like { volume = 0.5 }", 3) end
	return opts
end
local function audioId(id, fn)
	if type_(id) ~= "string" then error(fn .. " expects a sound id string (the file name in data/" .. (if fn == "sfx.play" then "sfx" else "music") .. "/)", 3) end
	return id
end
sfx = freeze({
	play = function(id, opts)
		local o = optsTable(opts, "sfx.play")
		H(OP_AUDIO, "sfx", audioId(id, "sfx.play"), o.volume, o.pitch)
	end,
})
music = freeze({
	play = function(id, opts)
		local o = optsTable(opts, "music.play")
		H(OP_AUDIO, "music", audioId(id, "music.play"), o.fade)
	end,
	stop = function(fade) H(OP_AUDIO, "stop", fade) end,
})
settings = freeze({
	get = function(name) return H(OP_SETTINGS, name) end,
})

-- ---------- store (Stars) ----------
local function itemId(id, fn)
	if type_(id) ~= "string" then error("store." .. fn .. " expects an item id string", 3) end
	return id
end
store = freeze({
	items = function() return H(OP_STORE, "items") end,
	owns = function(id) return H(OP_STORE, "owns", itemId(id, "owns")) end,
	prompt = function(id) H(OP_STORE, "prompt", itemId(id, "prompt")) end,
	pending = function() return H(OP_STORE, "pending") end,
	consume = function(purchaseId) H(OP_STORE, "consume", itemId(purchaseId, "consume")) end,
	purchased = setmetatable({ _h = 0, _name = "storePurchased" }, SignalM),
})

-- ---------- leaderboards + ghosts (DREAMSY.MD §13) ----------
local function lbBoard(b, fn, required)
	if b == nil and not required then return nil end
	if type_(b) ~= "string" then error("leaderboard." .. fn .. " expects a board name string like \\"fastest\\"", 3) end
	return b
end
leaderboard = freeze({
	start = function(board, opts)
		if opts ~= nil and type_(opts) ~= "table" then error("leaderboard.start options must be a table like { track = player }", 2) end
		local track = opts and opts.track
		H(OP_LEADERBOARD, "start", lbBoard(board, "start"), if track ~= nil then handle(track, "opts.track") else nil)
	end,
	finish = function(board) return H(OP_LEADERBOARD, "finish", lbBoard(board, "finish")) end,
	submit = function(board, value, opts)
		if type_(value) ~= "number" then error("leaderboard.submit expects a number value, e.g. leaderboard.submit(\\"score\\", 1200)", 2) end
		if opts ~= nil and type_(opts) ~= "table" then error("leaderboard.submit options must be a table like { order = \\"asc\\" }", 2) end
		H(OP_LEADERBOARD, "submit", lbBoard(board, "submit", true), value, opts and opts.order)
	end,
	cancel = function(board) H(OP_LEADERBOARD, "cancel", lbBoard(board, "cancel")) end,
	elapsed = function(board) return H(OP_LEADERBOARD, "elapsed", lbBoard(board, "elapsed")) end,
	running = function(board) return H(OP_LEADERBOARD, "running", lbBoard(board, "running")) end,
	raceGhost = function(which, board)
		if type_(which) ~= "string" then error("leaderboard.raceGhost expects \\"best\\", \\"pb\\" or a run id", 2) end
		H(OP_LEADERBOARD, "raceGhost", which, lbBoard(board, "raceGhost"))
	end,
	result = setmetatable({ _h = 0, _name = "leaderboardResult" }, SignalM),
})

-- ---------- platform (host app) ----------
platform = freeze({
	-- "this run is over" (game over / round done): the host app may show what to play next. reason default "gameover".
	runEnded = function(reason)
		if reason ~= nil and type_(reason) ~= "string" then error("platform.runEnded expects an optional reason string like \\"gameover\\"", 2) end
		H(OP_PLATFORM, "runEnded", reason)
	end,
})

-- math.random goes through the platform's seeded RNG
local mrandom = function(m, n)
	if m == nil then return H(OP_RANDOM) end
	if n == nil then m, n = 1, m end
	return floor(H(OP_RANDOM, m, n + 1))
end
math.random = mrandom
math.randomseed = function() end

-- per-script setup: returns the script table and its require()
local function makeScript(h, path)
	local s = freeze({ entity = proxy(h), path = path })
	local function req(name)
		if type_(name) ~= "string" then error("require expects a path string like \\"../shared/config\\"", 2) end
		return H(OP_REQUIRE, path, name)
	end
	return s, req
end

H(OP_INIT, makeScript, proxy, flushRemotes, function() for _, p in net.all() do fireLocal(joined, p) end end, function(fn, ...) return fn(...) end, localPlayer, setScene, doneFire)

-- trim to the contract (after capturing traceback above)
debug = nil
getfenv = nil
setfenv = nil
loadstring = nil
`;
