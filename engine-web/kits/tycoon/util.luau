--!strict
-- tycoon kit: small pure helpers (signals, deterministic rng, table utils). No engine globals.
local U = {}

-- ---------- signals ----------
export type Signal = { connect: (any, (...any) -> ()) -> { disconnect: (any) -> () }, fire: (any, ...any) -> () }

local SignalM = {}
SignalM.__index = SignalM
function SignalM.connect(s, fn)
	local entry = { fn = fn }
	table.insert(s._list, entry)
	return {
		disconnect = function()
			for i, e in s._list do
				if e == entry then
					table.remove(s._list, i)
					return
				end
			end
		end,
	}
end
function SignalM.fire(s, ...)
	for _, e in table.clone(s._list) do
		e.fn(...)
	end
end
function U.signal(): any
	return setmetatable({ _list = {} }, SignalM)
end

-- ---------- deterministic rng (xorshift32; same results headless and in the browser) ----------
local RngM = {}
RngM.__index = RngM
function RngM.next(r): number -- [0, 1)
	local x = r.s
	x = bit32.bxor(x, bit32.lshift(x, 13))
	x = bit32.bxor(x, bit32.rshift(x, 17))
	x = bit32.bxor(x, bit32.lshift(x, 5))
	r.s = x
	return x / 4294967296
end
function RngM.range(r, a: number, b: number): number
	return a + (b - a) * r:next()
end
function U.rng(seed: number?): any
	local s = math.floor(seed or 1) % 4294967296
	if s == 0 then
		s = 2463534242
	end
	return setmetatable({ s = s }, RngM)
end

-- ---------- tables ----------
function U.deepCopy(v: any): any
	if type(v) ~= "table" then
		return v
	end
	local out = {}
	for k, x in v do
		out[k] = U.deepCopy(x)
	end
	return out
end

function U.sortedKeys(t: { [string]: any }): { string }
	local ks = {}
	for k in t do
		table.insert(ks, k)
	end
	table.sort(ks)
	return ks
end

-- JSON-safe number (save.set rejects inf/nan)
function U.finite(n: number): number
	if n ~= n then
		return 0
	end
	if n == math.huge then
		return 1.7e308
	end
	if n == -math.huge then
		return -1.7e308
	end
	return n
end

return U
