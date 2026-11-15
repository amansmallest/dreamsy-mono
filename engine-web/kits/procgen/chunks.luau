-- Platformer level chunk sequencing (difficulty-ramped) + a jump-reachability check.
local RNG = require("./rng")
local Grid = require("./grid")

local C = {}

-- chunks: list of { id, grid = "text", difficulty = 0..10, weight?, tags? ("start"/"end") } (all the same height)
local function prep(chunks)
	local out = {}
	local h = nil
	for i, c in chunks do
		local g = Grid.fromString(c.grid, ".")
		h = h or g.h
		if g.h ~= h then error(`procgen.chunks: chunk "{c.id or i}" is {g.h} rows, expected {h}`) end
		table.insert(out, { id = c.id or tostring(i), g = g, difficulty = c.difficulty or 0, weight = c.weight or 1, tags = c.tags or {} })
	end
	return out, h
end

-- ground height = first solid row from the top in a column (h if none = pit)
local function ground(g, x, solid)
	for y = 0, g.h - 1 do if solid(g:get(x, y)) then return y end end
	return g.h
end

--[[ opts: { chunks (required), seed|rng, length = 8 (middle chunks), from = 1, to = 6 (difficulty ramp),
            spread = 1.5 (how far from the target difficulty picks may stray), solid = "#=" (solid chars),
            maxStep = 3 (max ground-height change between chunks), noRepeat = true }
   -> { grid, sequence = { chunk ids }, difficulties = { number }, width, height } ]]
function C.sequence(opts: any): any
	local rng = RNG.from(opts.rng or opts.seed)
	local chunks, H = prep(opts.chunks)
	local solid = Grid.passFn(opts.solid or "#=")
	local starts, ends, mids = {}, {}, {}
	for _, c in chunks do
		if table.find(c.tags, "start") then table.insert(starts, c)
		elseif table.find(c.tags, "end") then table.insert(ends, c)
		else table.insert(mids, c) end
	end
	assert(#mids > 0, "procgen.chunks: need at least one chunk without start/end tags")
	local n = opts.length or 8
	local seq = {}
	table.insert(seq, if #starts > 0 then rng:weighted(starts) else nil)
	local prev = seq[1]
	for i = 1, n do
		local t = if n == 1 then (opts.from or 1) else (opts.from or 1) + ((opts.to or 6) - (opts.from or 1)) * (i - 1) / (n - 1)
		local spread = opts.spread or 1.5
		local pool = {}
		for _, c in mids do
			local d = math.abs(c.difficulty - t)
			if d <= spread then
				local ok = true
				if prev then
					local gL = ground(prev.g, prev.g.w - 1, solid)
					local gR = ground(c.g, 0, solid)
					if gL < H and gR < H and math.abs(gL - gR) > (opts.maxStep or 3) then ok = false end
					if opts.noRepeat ~= false and prev.id == c.id and #mids > 1 then ok = false end
				end
				if ok then table.insert(pool, { c = c, weight = c.weight * (spread + 0.5 - d) }) end
			end
		end
		if #pool == 0 then
			-- fall back: closest difficulty
			local best, bd = mids[1], math.huge
			for _, c in mids do
				local d = math.abs(c.difficulty - t)
				if d < bd then best, bd = c, d end
			end
			pool = { { c = best, weight = 1 } }
		end
		local pick = rng:weighted(pool).c
		table.insert(seq, pick)
		prev = pick
	end
	if #ends > 0 then table.insert(seq, rng:weighted(ends)) end
	local W = 0
	for _, c in seq do W += c.g.w end
	local g = Grid.new(W, H, ".")
	local x = 0
	local ids, diffs = {}, {}
	for _, c in seq do
		g:blit(c.g, x, 0)
		x += c.g.w
		table.insert(ids, c.id)
		table.insert(diffs, c.difficulty)
	end
	return { grid = g, sequence = ids, difficulties = diffs, width = W, height = H }
end

--[[ Approximate platformer reachability: standable cells (open cell with solid below) connected when
     the jump fits (dx <= run, rise <= jump, any drop), with headroom ignored.
     opts: { solid = "#=", jump = 3, run = 4, from = {x,y}?, to = {x,y}? (default: leftmost / rightmost standable) }
     -> { ok, reached = n, standable = n, from, to } ]]
function C.reachable(g: any, opts: any?): any
	opts = opts or {}
	if type(g) == "string" then g = Grid.fromString(g, ".") end
	local solid = Grid.passFn(opts.solid or "#=")
	local hazard = Grid.passFn(opts.hazard or "^")
	local stand = {}
	local list = {}
	for x = 0, g.w - 1 do
		for y = 0, g.h - 2 do
			local c = g:get(x, y)
			if not solid(c) and not hazard(c) and solid(g:get(x, y + 1)) then
				stand[y * g.w + x] = true
				table.insert(list, { x = x, y = y })
			end
		end
	end
	if #list == 0 then return { ok = false, reached = 0, standable = 0 } end
	local from = opts.from or list[1]
	local to = opts.to or list[#list]
	local jump, run = opts.jump or 3, opts.run or 4
	local seen = { [from.y * g.w + from.x] = true }
	local q = { from }
	local head = 1
	while head <= #q do
		local c = q[head]
		head += 1
		for dx = -run, run do
			for dy = -jump, g.h do
				local nx, ny = c.x + dx, c.y + dy
				local k = ny * g.w + nx
				if stand[k] and not seen[k] and (dy >= -jump) and (math.abs(dx) <= run + math.max(0, dy // 2)) then
					seen[k] = true
					table.insert(q, { x = nx, y = ny })
				end
			end
		end
	end
	return { ok = seen[to.y * g.w + to.x] == true, reached = #q, standable = #list, from = from, to = to }
end

return C
