-- Top-down terrain / biome maps from elevation + moisture noise.
local RNG = require("./rng")
local Grid = require("./grid")
local Noise = require("./noise")
local validate = require("./validate")

-- default biome table: first match wins (elevation e and moisture m in [0,1])
local DEFAULT_BIOMES = {
	{ name = "deep_water", char = "~", maxE = 0.28, walkable = false },
	{ name = "water", char = "w", maxE = 0.36, walkable = false },
	{ name = "sand", char = "s", maxE = 0.41 },
	{ name = "mountain", char = "M", minE = 0.78, walkable = false },
	{ name = "snow", char = "S", minE = 0.70 },
	{ name = "desert", char = "d", maxM = 0.30 },
	{ name = "forest", char = "f", minM = 0.62 },
	{ name = "grass", char = "g" },
}

--[[ opts: { seed|rng, w = 64, h = 64, scale = 0.06, octaves = 4, biomes = DEFAULT_BIOMES, island = 0..1 (edge falloff),
            connect = true (unwalkable-pocket cleanup: only the largest walkable region stays walkable; the rest becomes `fillChar`) }
   biome: { name, char, minE?, maxE?, minM?, maxM?, walkable = true }
   -> { grid, biomes = { [char] = biome }, biomeAt(x,y) -> biome, start = {x,y}, walkable = n, report } ]]
local function generate(opts: any?): any
	opts = opts or {}
	local rng = RNG.from(opts.rng or opts.seed)
	local W, H = opts.w or 64, opts.h or 64
	local biomes = opts.biomes or DEFAULT_BIOMES
	local s1, s2 = rng:int(1, 99999), rng:int(1, 99999)
	local sc = opts.scale or 0.06
	local g = Grid.new(W, H, biomes[#biomes].char)
	local byChar = {}
	for _, b in biomes do byChar[b.char] = b end
	for y = 0, H - 1 do
		for x = 0, W - 1 do
			local e = (Noise.fbm2(x, y, { seed = s1, scale = sc, octaves = opts.octaves or 4 }) + 1) / 2
			local m = (Noise.fbm2(x, y, { seed = s2, scale = sc * 0.8, octaves = 3 }) + 1) / 2
			if opts.island then
				local dx, dy = (x / (W - 1)) * 2 - 1, (y / (H - 1)) * 2 - 1
				local d = math.min(1, math.sqrt(dx * dx + dy * dy))
				e = e * (1 - opts.island) + e * opts.island * (1 - d * d) - opts.island * d * d * 0.3
			end
			for _, b in biomes do
				if (b.minE == nil or e >= b.minE) and (b.maxE == nil or e < b.maxE) and (b.minM == nil or m >= b.minM) and (b.maxM == nil or m < b.maxM) then
					g:set(x, y, b.char)
					break
				end
			end
		end
	end
	local walk = function(c) local b = byChar[c] return b ~= nil and b.walkable ~= false end
	local regions = g:regions(walk)
	local res = { grid = g, biomes = byChar, w = W, h = H, seed = opts.seed }
	function res.biomeAt(x, y) return byChar[g:get(x, y) or ""] end
	if #regions == 0 then
		res.report = { ok = false, problems = { "no walkable land" } }
		return res
	end
	if opts.connect ~= false then
		local fillChar = opts.fillChar
		if fillChar == nil then
			for _, b in biomes do if b.walkable == false then fillChar = b.char break end end
		end
		for i = 2, #regions do
			for _, c in regions[i].cells do g:set(c.x, c.y, fillChar or "~") end
		end
	end
	-- start: walkable cell nearest the map centre
	local best, bd = regions[1].cells[1], math.huge
	for _, c in regions[1].cells do
		local d = math.abs(c.x - W / 2) + math.abs(c.y - H / 2)
		if d < bd then best, bd = c, d end
	end
	res.start = { x = best.x, y = best.y }
	res.walkable = regions[1].size
	res.report = validate(g, { pass = walk, from = res.start, requireAll = opts.connect ~= false })
	return res
end

return { generate = generate, DEFAULT_BIOMES = DEFAULT_BIOMES }
