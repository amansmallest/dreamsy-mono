-- rpg kit: small helpers shared by every module (signals, scheduler, rng, tables).
local U = {}

-- ---------------------------------------------------------------- signals
-- Script-side signal: sig:connect(fn) -> conn (conn:disconnect()), sig:fire(...).
local SignalM = {}
SignalM.__index = SignalM
function SignalM.connect(s, fn)
	assert(type(fn) == "function", "connect expects a function")
	local conn = { connected = true }
	table.insert(s._fns, { fn = fn, conn = conn })
	function conn.disconnect()
		conn.connected = false
	end
	return conn
end
SignalM.Connect = SignalM.connect
function SignalM.once(s, fn)
	local c
	c = s:connect(function(...)
		c.disconnect()
		fn(...)
	end)
	return c
end
function SignalM.fire(s, ...)
	local list = s._fns
	local alive = {}
	for _, h in list do
		if h.conn.connected then table.insert(alive, h) end
	end
	s._fns = alive
	for _, h in alive do
		if h.conn.connected then h.fn(...) end
	end
end
function U.signal(name: string?)
	return setmetatable({ _fns = {}, name = name }, SignalM)
end

-- ---------------------------------------------------------------- scheduler
-- The kit never uses after()/every(): those belong to whichever script called into the kit and
-- die with it on loadScene. One session-owned onTick drives these instead (rpg.setup installs it).
local timers = {}
local nextTimer = 0
function U.after(seconds: number, fn: () -> ())
	nextTimer += 1
	local t = { id = nextTimer, left = seconds, fn = fn }
	table.insert(timers, t)
	return t
end
function U.cancel(t)
	if t then t.dead = true end
end
function U.clearTimers()
	timers = {}
end
function U.stepTimers(dt: number)
	if #timers == 0 then return end
	local due = {}
	local keep = {}
	for _, t in timers do
		if not t.dead then
			t.left -= dt
			if t.left <= 1e-9 then table.insert(due, t) else table.insert(keep, t) end
		end
	end
	timers = keep
	for _, t in due do
		if not t.dead then t.fn() end
	end
end

-- ---------------------------------------------------------------- rng
-- U.rng(seed) -> function() -> [0,1): deterministic (tests, replays). Default kit rng = random().
function U.rng(seed: number)
	local s = math.floor(seed) % 2147483647
	if s <= 0 then s += 2147483646 end
	return function()
		s = (s * 48271) % 2147483647
		return (s - 1) / 2147483646
	end
end
function U.defaultRng()
	return random()
end
function U.randInt(rng, lo: number, hi: number): number
	return lo + math.floor(rng() * (hi - lo + 1))
end
-- weighted pick: list of entries with .weight (default 1)
function U.weighted(rng, list)
	local total = 0
	for _, e in list do total += (e.weight or 1) end
	if total <= 0 then return nil end
	local r = rng() * total
	for _, e in list do
		r -= (e.weight or 1)
		if r < 0 then return e end
	end
	return list[#list]
end

-- ---------------------------------------------------------------- tables
function U.deepcopy(v)
	if type(v) ~= "table" then return v end
	local out = {}
	for k, x in v do out[k] = U.deepcopy(x) end
	return out
end
function U.keys(t): { string }
	local out = {}
	for k in t do table.insert(out, k) end
	table.sort(out, function(a, b) return tostring(a) < tostring(b) end)
	return out
end
function U.count(t): number
	local n = 0
	for _ in t do n += 1 end
	return n
end
function U.list(v)
	if v == nil then return {} end
	if type(v) == "table" and (#v > 0 or next(v) == nil) then return v end
	return { v }
end
function U.round(x: number): number
	return math.floor(x + 0.5)
end

-- "{name} has {money}$" with values from a table (or a function(key) -> value)
function U.format(text: string, vars): string
	return (string.gsub(text, "{([%w_%.]+)}", function(k)
		local v
		if type(vars) == "function" then v = vars(k) elseif vars then v = vars[k] end
		if v == nil then return "{" .. k .. "}" end
		return tostring(v)
	end))
end

-- sfx/music by id, tolerating missing sounds (content is optional; a warning once per id)
local warned = {}
function U.sfx(id: string?, opts)
	if not id or id == "" then return end
	local ok, err = pcall(sfx.play, id, opts)
	if not ok and not warned[id] then
		warned[id] = true
		print("[rpg] sfx \"" .. id .. "\" not played: " .. tostring(err))
	end
end
function U.music(id: string?, opts)
	if not id or id == "" then return end
	local ok, err = pcall(music.play, id, opts)
	if not ok and not warned["m:" .. id] then
		warned["m:" .. id] = true
		print("[rpg] music \"" .. id .. "\" not played: " .. tostring(err))
	end
end

U.DIRS = {
	up = { 0, -1 },
	down = { 0, 1 },
	left = { -1, 0 },
	right = { 1, 0 },
}
U.OPPOSITE = { up = "down", down = "up", left = "right", right = "left" }

return U
