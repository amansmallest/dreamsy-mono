-- Cellular-automata caves. Keeps only the largest open region (so the cave is always connected).
local RNG = require("./rng")
local Grid = require("./grid")
local validate = require("./validate")

--[[ opts: { seed|rng, w = 48, h = 48, fill = 0.45, steps = 5, birth = 5, survive = 4, minOpen = 0.35,
            wall = "#", floor = ".", enemies = 8, items = 3, minSpawnDist = 8 }
   -> level { grid, start, exit, spawns = {{kind,x,y}}, openRatio, report } ]]
local function generate(opts: any?): any
	opts = opts or {}
	local rng = RNG.from(opts.rng or opts.seed)
	local W, H = opts.w or 48, opts.h or 48
	local wall, floor = opts.wall or Grid.WALL, opts.floor or Grid.FLOOR
	for attempt = 1, 30 do
		local g = Grid.new(W, H, wall)
		for y = 1, H - 2 do
			for x = 1, W - 2 do
				if not rng:chance(opts.fill or 0.45) then g:set(x, y, floor) end
			end
		end
		for _ = 1, opts.steps or 5 do
			local n = g:clone()
			for y = 1, H - 2 do
				for x = 1, W - 2 do
					local walls = 0
					for _, d in Grid.DIRS8 do if g:get(x + d[1], y + d[2]) == wall then walls += 1 end end
					local isWall = g:get(x, y) == wall
					if isWall then
						n:set(x, y, if walls >= (opts.survive or 4) then wall else floor)
					else
						n:set(x, y, if walls >= (opts.birth or 5) then wall else floor)
					end
				end
			end
			g = n
		end
		local regions = g:regions(function(c) return c == floor end)
		if #regions > 0 then
			local keep = regions[1]
			local open = {}
			for _, c in keep.cells do open[c.y * W + c.x] = true end
			for y = 0, H - 1 do
				for x = 0, W - 1 do
					if g:get(x, y) == floor and not open[y * W + x] then g:set(x, y, wall) end
				end
			end
			local ratio = keep.size / ((W - 2) * (H - 2))
			if ratio >= (opts.minOpen or 0.35) then
				local start = keep.cells[1]
				local seen = g:flood(start.x, start.y, floor)
				local exit, best = start, -1
				for _, c in keep.cells do
					local d = seen[c.y * W + c.x]
					if d > best then exit, best = c, d end
				end
				local spawns = {}
				local cand = {}
				for _, c in keep.cells do
					if seen[c.y * W + c.x] >= (opts.minSpawnDist or 8) and not (c.x == exit.x and c.y == exit.y) then table.insert(cand, c) end
				end
				rng:shuffle(cand)
				local k = 1
				for _, ks in { { "enemy", opts.enemies or 8 }, { "item", opts.items or 3 } } do
					for _ = 1, ks[2] do
						local c = cand[k]
						if c then table.insert(spawns, { kind = ks[1], x = c.x, y = c.y }) end
						k += 1
					end
				end
				local level = { grid = g, w = W, h = H, start = { x = start.x, y = start.y }, exit = { x = exit.x, y = exit.y }, spawns = spawns, openRatio = ratio, seed = opts.seed }
				level.report = validate(g, { pass = floor, from = level.start, targets = { level.exit } })
				if level.report.ok then return level end
			end
		end
	end
	error("procgen.caves: could not generate (lower fill or minOpen)")
end

return generate
