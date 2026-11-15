-- tower-defense kit: small shared helpers (signals, copies, deterministic rng). Pure Luau, no engine globals.
local U = {}

-- Signal: sig:connect(fn) -> conn (conn:disconnect()), sig:fire(...)
local SignalM = {}
SignalM.__index = SignalM
function U.signal()
	return setmetatable({ fns = {} }, SignalM)
end
function SignalM:connect(fn)
	local entry = { fn = fn }
	table.insert(self.fns, entry)
	return {
		disconnect = function()
			entry.fn = nil
		end,
	}
end
function SignalM:fire(...)
	for _, e in table.clone(self.fns) do
		if e.fn then
			e.fn(...)
		end
	end
end

-- Event hub: hub.on(name, fn), hub.emit(name, ...)
function U.events()
	local sigs = {}
	local hub = {}
	function hub.on(name, fn)
		local s = sigs[name]
		if not s then
			s = U.signal()
			sigs[name] = s
		end
		return s:connect(fn)
	end
	function hub.emit(name, ...)
		local s = sigs[name]
		if s then
			s:fire(...)
		end
	end
	return hub
end

function U.deepCopy(v)
	if type(v) ~= "table" then
		return v
	end
	local t = {}
	for k, x in v do
		t[k] = U.deepCopy(x)
	end
	return t
end

function U.set(list)
	local s = {}
	for _, v in list or {} do
		s[v] = true
	end
	return s
end

function U.keys(t)
	local ks = {}
	for k in t do
		table.insert(ks, k)
	end
	table.sort(ks, function(a, b)
		return tostring(a) < tostring(b)
	end)
	return ks
end

-- Deterministic LCG (independent of the platform RNG so sims replay exactly).
local RngM = {}
RngM.__index = RngM
function U.rng(seed)
	return setmetatable({ s = (seed or 1) % 2147483647 }, RngM)
end
function RngM:next()
	self.s = (self.s * 48271) % 2147483647
	return self.s / 2147483647
end
function RngM:range(a, b)
	return a + (b - a) * self:next()
end

-- Read "a.b.c" from a table.
function U.getPath(t, path)
	local cur = t
	for part in string.gmatch(path, "[^%.]+") do
		if type(cur) ~= "table" then
			return nil
		end
		cur = cur[part]
	end
	return cur
end

-- Write "a.b.c" into a table (creating sub-tables).
function U.setPath(t, path, value)
	local parts = string.split(path, ".")
	local cur = t
	for i = 1, #parts - 1 do
		local p = parts[i]
		if type(cur[p]) ~= "table" then
			cur[p] = {}
		end
		cur = cur[p]
	end
	cur[parts[#parts]] = value
end

return U
