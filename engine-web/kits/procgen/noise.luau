-- Deterministic noise: value noise 1D/2D, simplex 2D, fbm. All return roughly [-1, 1] (fbm normalized).
local RNG = require("./rng")
local N = {}

-- integer lattice hash -> [0,1) (exact double arithmetic)
local function h2(ix: number, iy: number, seed: number): number
	local n = (ix * 374761 + iy * 668265 + seed * 9973) % 2147483647
	n = (n * 48271) % 2147483647
	n = (n * 48271 + 11) % 2147483647
	n = (n * 16807) % 2147483647
	return n / 2147483647
end

local function smooth(t: number): number return t * t * (3 - 2 * t) end
local function seedNum(seed: any): number
	if type(seed) == "string" then return RNG.hash(seed) % 100000 end
	return math.floor(seed or 0) % 100000
end

function N.value1(x: number, seed: any?): number
	local s = seedNum(seed)
	local i = math.floor(x)
	local f = smooth(x - i)
	local a, b = h2(i, 0, s), h2(i + 1, 0, s)
	return (a + (b - a) * f) * 2 - 1
end

function N.value2(x: number, y: number, seed: any?): number
	local s = seedNum(seed)
	local ix, iy = math.floor(x), math.floor(y)
	local fx, fy = smooth(x - ix), smooth(y - iy)
	local a, b = h2(ix, iy, s), h2(ix + 1, iy, s)
	local c, d = h2(ix, iy + 1, s), h2(ix + 1, iy + 1, s)
	local top = a + (b - a) * fx
	local bot = c + (d - c) * fx
	return (top + (bot - top) * fy) * 2 - 1
end

-- simplex 2D (Gustavson), permutation per seed (cached)
local permCache: { [number]: { number } } = {}
local function perm(seed: number): { number }
	local p = permCache[seed]
	if p then return p end
	local r = RNG.new(seed + 1)
	local base = {}
	for i = 0, 255 do base[i + 1] = i end
	r:shuffle(base)
	p = {}
	for i = 0, 511 do p[i] = base[(i % 256) + 1] end
	permCache[seed] = p
	return p
end
local G = { { 1, 1 }, { -1, 1 }, { 1, -1 }, { -1, -1 }, { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }
local F2 = 0.5 * (math.sqrt(3) - 1)
local G2 = (3 - math.sqrt(3)) / 6

function N.simplex2(xin: number, yin: number, seed: any?): number
	local p = perm(seedNum(seed))
	local s = (xin + yin) * F2
	local i, j = math.floor(xin + s), math.floor(yin + s)
	local t = (i + j) * G2
	local x0, y0 = xin - (i - t), yin - (j - t)
	local i1, j1 = if x0 > y0 then 1 else 0, if x0 > y0 then 0 else 1
	local x1, y1 = x0 - i1 + G2, y0 - j1 + G2
	local x2, y2 = x0 - 1 + 2 * G2, y0 - 1 + 2 * G2
	local ii, jj = i % 256, j % 256
	local function corner(gi: number, x: number, y: number): number
		local tt = 0.5 - x * x - y * y
		if tt < 0 then return 0 end
		local g = G[(gi % 8) + 1]
		tt *= tt
		return tt * tt * (g[1] * x + g[2] * y)
	end
	local n0 = corner(p[ii + p[jj]], x0, y0)
	local n1 = corner(p[ii + i1 + p[jj + j1]], x1, y1)
	local n2 = corner(p[ii + 1 + p[jj + 1]], x2, y2)
	return 70 * (n0 + n1 + n2)
end

-- fractal sum. opts: { octaves = 4, lacunarity = 2, gain = 0.5, scale = 1, kind = "simplex"|"value", seed }
function N.fbm2(x: number, y: number, opts: any?): number
	opts = opts or {}
	local oct, lac, gain = opts.octaves or 4, opts.lacunarity or 2, opts.gain or 0.5
	local sc = opts.scale or 1
	local fn = if opts.kind == "value" then N.value2 else N.simplex2
	local amp, freq, sum, norm = 1, sc, 0, 0
	local s = seedNum(opts.seed)
	for o = 1, oct do
		sum += amp * fn(x * freq, y * freq, s + o * 131)
		norm += amp
		amp *= gain
		freq *= lac
	end
	return sum / norm
end

function N.fbm1(x: number, opts: any?): number
	opts = opts or {}
	local oct, amp, freq, sum, norm = opts.octaves or 4, 1, opts.scale or 1, 0, 0
	local s = seedNum(opts.seed)
	for o = 1, oct do
		sum += amp * N.value1(x * freq, s + o * 131)
		norm += amp
		amp *= opts.gain or 0.5
		freq *= opts.lacunarity or 2
	end
	return sum / norm
end

return N
