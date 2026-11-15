--!nonstrict
-- match3: swap neighbours to line up 3+; cascades, specials, objectives, move limit. Deterministic: the refill RNG
-- lives in the state (same level + same moves ⇒ same board everywhere).
-- Specials: 4 in a line → line (clears its row "line_h" / column "line_v"), L/T → bomb (3×3), 5 in a line → color orb
-- (swap it with a gem: clears that colour; orb+orb clears the board). Swapping two specials fires both.
-- Level: { w = 7, h = 8, colors = 5, moves = 20, seed, objective = { score = n } | { jelly = true } | { collect = { [color] = n } },
--          jelly? = { cell indices } (1 layer) , grid? = rows of digits 1..colors (authored start; else random, no matches),
--          stars? = { 2★ score, 3★ score }, bonus? (60 points per unused move when won), par? }
-- Move: { a = i, b = j } (adjacent cell indices). Hint/solver: greedy best move by objective progress.
local B = require("./board")
local procgen = require("@kit/procgen")
local M = { id = "match3", name = "Match", stochastic = true }
local ORB = 99
local SPECIALS = { "line_h", "line_v", "bomb", "color" }
M.SPECIALS = SPECIALS

local function newGem(st)
	st.nextUid += 1
	return st.rng:int(1, st.colors), st.nextUid
end

local function runAt(st, i, gem)
	local b = st.board
	local G = b.layers.gem
	local x, y = b:xy(i)
	local h, v = 1, 1
	local k = x - 1 while k >= 0 and G[y * b.w + k + 1] == gem do h += 1 k -= 1 end
	k = x + 1 while k < b.w and G[y * b.w + k + 1] == gem do h += 1 k += 1 end
	k = y - 1 while k >= 0 and G[k * b.w + x + 1] == gem do v += 1 k -= 1 end
	k = y + 1 while k < b.h and G[k * b.w + x + 1] == gem do v += 1 k += 1 end
	return h, v
end

local function makesMatch(st, i)
	local g = st.board.layers.gem[i]
	if g <= 0 or g >= ORB then return false end
	local h, v = runAt(st, i, g)
	return h >= 3 or v >= 3
end

-- all matched groups: { {cells, color, h (longest row run), v (longest column run)} }
local function findGroups(st)
	local b = st.board
	local G, W, H = b.layers.gem, b.w, b.h
	local hl, vl = {}, {}
	for y = 0, H - 1 do
		local x = 0
		while x < W do
			local g = G[y * W + x + 1]
			local e = x
			while e + 1 < W and G[y * W + e + 2] == g do e += 1 end
			if g > 0 and g < ORB and e - x + 1 >= 3 then for k = x, e do hl[y * W + k + 1] = e - x + 1 end end
			x = e + 1
		end
	end
	for x = 0, W - 1 do
		local y = 0
		while y < H do
			local g = G[y * W + x + 1]
			local e = y
			while e + 1 < H and G[(e + 1) * W + x + 1] == g do e += 1 end
			if g > 0 and g < ORB and e - y + 1 >= 3 then for k = y, e do vl[k * W + x + 1] = e - y + 1 end end
			y = e + 1
		end
	end
	local seen, groups = {}, {}
	for i = 1, W * H do
		if (hl[i] or vl[i]) and not seen[i] then
			local g = G[i]
			local grp = { cells = {}, color = g, h = 0, v = 0 }
			local q = { i }
			seen[i] = true
			while #q > 0 do
				local c = table.remove(q)
				table.insert(grp.cells, c)
				grp.h = math.max(grp.h, hl[c] or 0)
				grp.v = math.max(grp.v, vl[c] or 0)
				local cx, cy = b:xy(c)
				for _, n in b:neighbors(cx, cy) do
					if not seen[n.i] and (hl[n.i] or vl[n.i]) and G[n.i] == g then seen[n.i] = true table.insert(q, n.i) end
				end
			end
			table.sort(grp.cells)
			table.insert(groups, grp)
		end
	end
	return groups
end
M.findGroups = findGroups

local function specialFor(grp)
	if grp.h >= 5 or grp.v >= 5 then return 4 end
	if grp.h >= 3 and grp.v >= 3 then return 3 end
	if grp.h == 4 then return 1 end
	if grp.v == 4 then return 2 end
	return 0
end

local function mostCommon(st)
	local cnt, best, bn = {}, 1, -1
	for _, g in st.board.layers.gem do if g > 0 and g < ORB then cnt[g] = (cnt[g] or 0) + 1 end end
	for c = 1, st.colors do if (cnt[c] or 0) > bn then best, bn = c, cnt[c] or 0 end end
	return best
end

-- clear a set of cells, firing specials in them (chain), scoring by cascade level; returns cleared list
local function clearCells(st, start, cascade, keep)
	local b = st.board
	local G, S, J = b.layers.gem, b.layers.special, b.layers.jelly
	local W, H = b.w, b.h
	local inQ, q = {}, {}
	local function add(i) if not inQ[i] and G[i] ~= 0 then inQ[i] = true table.insert(q, i) end end
	for _, i in start do add(i) end
	local head, fired = 1, {}
	while head <= #q do
		local i = q[head]
		head += 1
		local sp = S[i]
		if sp > 0 and not keep[i] then
			local x, y = b:xy(i)
			table.insert(fired, { i = i, special = SPECIALS[sp] })
			if sp == 1 then for k = 0, W - 1 do add(y * W + k + 1) end
			elseif sp == 2 then for k = 0, H - 1 do add(k * W + x + 1) end
			elseif sp == 3 then
				for dy = -1, 1 do for dx = -1, 1 do if b:inside(x + dx, y + dy) then add((y + dy) * W + x + dx + 1) end end end
			elseif sp == 4 then
				local c = st.orbColor or mostCommon(st)
				for k = 1, W * H do if G[k] == c then add(k) end end
			end
		end
	end
	local cleared = {}
	for _, i in q do
		if not keep[i] then
			local g = G[i]
			if g > 0 and g < ORB then st.collected[g] = (st.collected[g] or 0) + 1 end
			if J[i] > 0 then J[i] -= 1 st.jellyCleared += 1 end
			st.score += 10 * cascade
			table.insert(cleared, { i = i, gem = g, uid = b.layers.uid[i] })
			G[i], S[i], b.layers.uid[i] = 0, 0, 0
		end
	end
	st.score += #fired * 30 * cascade
	return cleared, fired
end

local function gravity(st)
	local b = st.board
	local G, S, U = b.layers.gem, b.layers.special, b.layers.uid
	local W, H = b.w, b.h
	for x = 0, W - 1 do
		local wy = H - 1
		for y = H - 1, 0, -1 do
			local i = y * W + x + 1
			if G[i] ~= 0 then
				local j = wy * W + x + 1
				if j ~= i then G[j], S[j], U[j] = G[i], S[i], U[i] G[i], S[i], U[i] = 0, 0, 0 end
				wy -= 1
			end
		end
		for y = wy, 0, -1 do
			local i = y * W + x + 1
			G[i], U[i] = newGem(st)
			S[i] = 0
		end
	end
end

local function resolve(st, swapped, steps)
	local cascade = 1
	while true do
		local groups = findGroups(st)
		if #groups == 0 then break end
		local cells, creates, keep = {}, {}, {}
		for _, g in groups do
			for _, i in g.cells do table.insert(cells, i) end
			local sp = specialFor(g)
			if sp > 0 then
				local at = g.cells[math.ceil(#g.cells / 2)]
				for _, s in swapped or {} do if table.find(g.cells, s) then at = s end end
				creates[at] = { sp = sp, color = g.color }
			end
		end
		local cleared, fired = clearCells(st, cells, cascade, keep)
		local made = {}
		for at, c in creates do
			local b = st.board
			b.layers.gem[at] = if c.sp == 4 then ORB else c.color
			b.layers.special[at] = c.sp
			st.nextUid += 1
			b.layers.uid[at] = st.nextUid
			table.insert(made, { i = at, special = SPECIALS[c.sp] })
		end
		gravity(st)
		table.insert(steps, { cleared = cleared, fired = fired, created = made, cascade = cascade })
		cascade += 1
		swapped = nil
		if cascade > 50 then break end
	end
	st.maxCascade = math.max(st.maxCascade or 0, cascade - 1)
end

local function validSwap(st, a, b2)
	local b = st.board
	local G, S = b.layers.gem, b.layers.special
	if G[a] == ORB or G[b2] == ORB then return true end
	if S[a] > 0 and S[b2] > 0 then return true end
	G[a], G[b2] = G[b2], G[a]
	local ok = makesMatch(st, a) or makesMatch(st, b2)
	G[a], G[b2] = G[b2], G[a]
	return ok
end

-- every valid swap: { {a, b} }
function M.validMoves(st)
	local b = st.board
	local out = {}
	for i = 1, b.w * b.h do
		local x, y = b:xy(i)
		if x < b.w - 1 and validSwap(st, i, i + 1) then table.insert(out, { a = i, b = i + 1 }) end
		if y < b.h - 1 and validSwap(st, i, i + b.w) then table.insert(out, { a = i, b = i + b.w }) end
	end
	return out
end

local function shuffleIfStuck(st)
	for _ = 1, 20 do
		if #M.validMoves(st) > 0 then return false end
		local b = st.board
		local cells = {}
		for i = 1, b.w * b.h do if b.layers.special[i] == 0 then table.insert(cells, i) end end
		local vals = {}
		for _, i in cells do table.insert(vals, { b.layers.gem[i], b.layers.uid[i] }) end
		st.rng:shuffle(vals)
		for k, i in cells do b.layers.gem[i], b.layers.uid[i] = vals[k][1], vals[k][2] end
		resolve(st, nil, {})
	end
	return true
end

function M.load(level)
	local W, H = level.w or 7, level.h or 8
	local b = B.new(W, H)
	b:layer("gem", 0) b:layer("special", 0) b:layer("jelly", 0) b:layer("uid", 0)
	local st = {
		board = b, colors = level.colors or 5, score = 0, movesLeft = level.moves or 20, maxMoves = level.moves or 20,
		objective = level.objective or { score = 1000 }, collected = {}, jellyCleared = 0, nextUid = 0,
		rng = procgen.rng((level.seed or 1) * 104729 + 7), bonus = level.bonus or 60, done = false,
	}
	for _, i in level.jelly or {} do b.layers.jelly[i] = (b.layers.jelly[i] or 0) + 1 end
	if level.grid then
		local rows = if type(level.grid) == "string" then string.split(level.grid, "\n") else level.grid
		for y = 0, H - 1 do
			for x = 0, W - 1 do
				local i = y * W + x + 1
				b.layers.gem[i] = tonumber(string.sub(rows[y + 1], x + 1, x + 1)) or 1
				st.nextUid += 1
				b.layers.uid[i] = st.nextUid
			end
		end
	else
		for i = 1, W * H do
			local g, u
			repeat
				g, u = newGem(st)
				b.layers.gem[i] = g
			until not makesMatch(st, i)
			b.layers.uid[i] = u
		end
	end
	st.jellyTotal = b.layers.jelly and (function() local n = 0 for _, v in b.layers.jelly do n += v end return n end)() or 0
	shuffleIfStuck(st)
	return st
end

function M.isWon(st)
	local o = st.objective
	if o.score and st.score < o.score then return false end
	if o.jelly then for _, v in st.board.layers.jelly do if v > 0 then return false end end end
	if o.collect then for c, n in o.collect do if (st.collected[tonumber(c) or c] or 0) < n then return false end end end
	return true
end
function M.isLost(st) return st.movesLeft <= 0 and not M.isWon(st) end

function M.apply(st, move)
	if type(move) ~= "table" or not move.a or not move.b then return false, "bad move" end
	local b = st.board
	local a, c = move.a, move.b
	if st.movesLeft <= 0 then return false, "no moves left" end
	if a < 1 or c < 1 or a > b.w * b.h or c > b.w * b.h or not b:adjacent(a, c) then return false, "not adjacent" end
	if not validSwap(st, a, c) then return false, "no match" end
	local G, S, U = b.layers.gem, b.layers.special, b.layers.uid
	G[a], G[c] = G[c], G[a]
	S[a], S[c] = S[c], S[a]
	U[a], U[c] = U[c], U[a]
	local steps = {}
	local scoreBefore = st.score
	if G[a] == ORB or G[c] == ORB then
		local orb, other = if G[a] == ORB then a else c, if G[a] == ORB then c else a
		local cells = { orb }
		if G[other] == ORB then
			for i = 1, b.w * b.h do table.insert(cells, i) end
			S[orb], S[other] = 0, 0
		else
			st.orbColor = G[other]
			for i = 1, b.w * b.h do if G[i] == G[other] then table.insert(cells, i) end end
		end
		local cleared, fired = clearCells(st, cells, 1, {})
		st.orbColor = nil
		gravity(st)
		table.insert(steps, { cleared = cleared, fired = fired, created = {}, cascade = 1 })
		resolve(st, nil, steps)
	elseif S[a] > 0 and S[c] > 0 then
		local cleared, fired = clearCells(st, { a, c }, 1, {})
		gravity(st)
		table.insert(steps, { cleared = cleared, fired = fired, created = {}, cascade = 1 })
		resolve(st, nil, steps)
	else
		resolve(st, { a, c }, steps)
	end
	st.movesLeft -= 1
	if M.isWon(st) and not st.done then
		st.done = true
		st.score += st.movesLeft * st.bonus
	end
	shuffleIfStuck(st)
	return true, { cost = 1, steps = steps, cascades = #steps, gained = st.score - scoreBefore, swap = { a, c } }
end

-- how good a resulting state is for the objective (greedy solver + generator)
local function value(st, before)
	local o = st.objective
	local v = (st.score - before.score) / 10
	if o.jelly then v += (st.jellyCleared - before.jellyCleared) * 40 end
	if o.collect then for col, _ in o.collect do local k = tonumber(col) or col v += ((st.collected[k] or 0) - (before.collected[k] or 0)) * 25 end end
	if M.isWon(st) then v += 1e6 end
	return v
end

function M.bestMove(st)
	local best, bv = nil, -math.huge
	for _, mv in M.validMoves(st) do
		local s2 = B.copy(st)
		M.apply(s2, mv)
		local v = value(s2, st)
		if v > bv then best, bv = mv, v end
	end
	return best
end

function M.solve(st) local m = M.bestMove(st) return if m then { moves = { m } } else nil end

-- generate({ seed, w = 7, h = 8, colors = 5, moves = 20, goal = "score" | "jelly" | "collect", target? (0.75: fraction of the
--   greedy solver's result the level asks for; higher = harder), jelly? (cells for jelly goal) })
-- Objectives are calibrated by playing the level with the greedy solver ⇒ always beatable by following hints.
function M.generate(p)
	local W, H = p.w or 7, p.h or 8
	local frac = p.target or 0.75
	local moves = math.floor(p.moves or 20)
	local goal = p.goal or "score"
	for k = 0, 6 do
		local lv = { w = W, h = H, colors = p.colors or 5, moves = moves, seed = (p.seed or 1) * 31 + k, objective = { score = 1e12 } }
		if goal == "jelly" then
			local rng = procgen.rng(lv.seed)
			local n = math.floor(p.jelly or 10)
			local cells = {}
			for i = 1, W * H do table.insert(cells, i) end
			lv.jelly = rng:sample(cells, math.min(n, W * H))
			table.sort(lv.jelly)
			lv.objective = { jelly = true }
		end
		-- calibration run (greedy, no early win)
		local st = M.load(lv)
		local track = {}
		for m = 1, moves do
			local mv = M.bestMove(st)
			if not mv then break end
			M.apply(st, mv)
			track[m] = { score = st.score, collected = table.clone(st.collected), won = M.isWon(st) }
			if goal == "jelly" and track[m].won then break end
		end
		local ok = #track > 0
		if goal == "score" then
			local at = math.max(1, math.floor(#track * frac))
			lv.objective = { score = math.max(100, math.floor(track[at].score / 50) * 50) }
		elseif goal == "collect" then
			local at = math.max(1, math.floor(#track * frac))
			local c, n = 1, -1
			for col, v in track[at].collected do if v > n then c, n = col, v end end
			lv.objective = { collect = { [c] = math.max(5, n) } }
		elseif goal == "jelly" then
			ok = ok and track[#track].won
		end
		if ok and M.calibrate(lv) then
			lv.goal = goal
			return lv
		end
	end
	return nil
end

-- calibrate(level): play it with the greedy solver; par = moves it needed, stars = {0.6, 0.9} × its final score
-- (only fills par/stars that are missing). -> won
function M.calibrate(lv)
	local v = M.load(lv)
	local used = 0
	while not M.isWon(v) and v.movesLeft > 0 do
		local mv = M.bestMove(v)
		if not mv then break end
		M.apply(v, mv)
		used += 1
	end
	if not M.isWon(v) then return false end
	lv.par = lv.par or used
	lv.stars = lv.stars or { math.floor(v.score * 0.6), math.floor(v.score * 0.9) }
	lv.difficulty = lv.difficulty or used / (lv.moves or 20)
	return true
end

-- stars by final score (level.stars = { 2★, 3★ })
function M.stars(session)
	local st = session.state
	local t = session.level.stars or { 0, 0 }
	return if st.score >= t[2] then 3 elseif st.score >= t[1] then 2 else 1
end

function M.swipe(st, x, y, dir)
	local b = st.board
	local d = B.DIRS[dir]
	if not b:inside(x + d[1], y + d[2]) then return nil end
	return { a = b:index(x, y), b = b:index(x + d[1], y + d[2]) }
end
-- tap-tap swapping: first tap selects (view keeps it), second adjacent tap swaps
function M.tap(st, x, y, view)
	local i = st.board:index(x, y)
	if view and view.selected and st.board:adjacent(view.selected, i) then
		local a = view.selected
		view.selected = nil
		return { a = a, b = i }
	end
	if view then view.selected = if view.selected == i then nil else i end
	return nil
end

function M.render(st)
	local b = st.board
	local out = {}
	for i = 1, b.w * b.h do
		local x, y = b:xy(i)
		table.insert(out, { x = x, y = y, kind = "slot", z = 0 })
		if b.layers.jelly[i] > 0 then table.insert(out, { x = x, y = y, kind = "jelly", z = 1 }) end
		local g = b.layers.gem[i]
		if g ~= 0 then
			local sp = b.layers.special[i]
			table.insert(out, { x = x, y = y, kind = if g == ORB then "orb" else "gem", tint = g, id = "g" .. b.layers.uid[i], z = 2, enter = "drop",
				special = if sp > 0 and sp < 4 then SPECIALS[sp] else nil })
		end
	end
	return out
end
function M.hintCells(st, move)
	local ax, ay = st.board:xy(move.a)
	local bx, by = st.board:xy(move.b)
	return { { x = ax, y = ay }, { x = bx, y = by } }
end
function M.status(st)
	local o = st.objective
	if o.jelly then local n = 0 for _, v in st.board.layers.jelly do n += v end return n .. " jelly left" end
	if o.collect then
		for c, n in o.collect do return math.min(st.collected[tonumber(c) or c] or 0, n) .. "/" .. n .. " collected" end
	end
	return st.score .. "/" .. (o.score or 0)
end

return M
