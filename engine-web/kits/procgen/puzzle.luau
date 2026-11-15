-- Puzzle generators with solvers: every generated puzzle is solved before it's returned
-- (solvable by construction AND verified; difficulty = optimal solution length).
local RNG = require("./rng")
local P = {}

local DX = { 0, 1, 0, -1 }
local DY = { -1, 0, 1, 0 }
local DCH = { "u", "r", "d", "l" }

------------------------------------------------------------------ sokoban
-- XSB text: "#" wall, "-" or " " floor, "@" player, "+" player on goal, "$" box, "*" box on goal, "." goal

local function parseSoko(text: string)
	text = string.gsub(text, "\r", "")
	local rows = string.split(text, "\n")
	while #rows > 0 and rows[#rows] == "" do table.remove(rows) end
	local h = #rows
	local w = 0
	for _, r in rows do w = math.max(w, #r) end
	local wall, goals, boxes, player = {}, {}, {}, nil
	for y = 1, h do
		for x = 1, w do
			local c = string.sub(rows[y], x, x)
			local i = (y - 1) * w + (x - 1)
			if c == "#" or c == "" then wall[i] = true end
			if c == "." or c == "+" or c == "*" then table.insert(goals, i) end
			if c == "$" or c == "*" then table.insert(boxes, i) end
			if c == "@" or c == "+" then player = i end
		end
	end
	return { w = w, h = h, wall = wall, goals = goals, boxes = boxes, player = player }
end

local function sokoText(lv, boxes, player): string
	local bset, gset = {}, {}
	for _, b in boxes do bset[b] = true end
	for _, g in lv.goals do gset[g] = true end
	local rows = {}
	for y = 0, lv.h - 1 do
		local row = {}
		for x = 0, lv.w - 1 do
			local i = y * lv.w + x
			local c = "-"
			if lv.wall[i] then c = "#"
			elseif bset[i] then c = if gset[i] then "*" else "$"
			elseif i == player then c = if gset[i] then "+" else "@"
			elseif gset[i] then c = "." end
			table.insert(row, c)
		end
		table.insert(rows, table.concat(row))
	end
	return table.concat(rows, "\n")
end

-- cells from which a lone box can still reach some goal (reverse pulls from goals); others are dead squares
local function liveSquares(lv)
	local live = {}
	local q = {}
	for _, g in lv.goals do live[g] = true table.insert(q, g) end
	local head = 1
	while head <= #q do
		local b = q[head]
		head += 1
		local bx, by = b % lv.w, b // lv.w
		for d = 1, 4 do
			-- pull box from b to b+d: player at b+d moves to b+2d
			local nx, ny = bx + DX[d], by + DY[d]
			local px, py = bx + 2 * DX[d], by + 2 * DY[d]
			if nx >= 0 and ny >= 0 and nx < lv.w and ny < lv.h and px >= 0 and py >= 0 and px < lv.w and py < lv.h then
				local ni, pi = ny * lv.w + nx, py * lv.w + px
				if not lv.wall[ni] and not lv.wall[pi] and not live[ni] then
					live[ni] = true
					table.insert(q, ni)
				end
			end
		end
	end
	return live
end

-- player reachable region given boxes; returns set and min index (normalized position)
local function reach(lv, bset, from)
	local seen = { [from] = true }
	local q = { from }
	local head, minI = 1, from
	while head <= #q do
		local c = q[head]
		head += 1
		if c < minI then minI = c end
		local cx, cy = c % lv.w, c // lv.w
		for d = 1, 4 do
			local nx, ny = cx + DX[d], cy + DY[d]
			if nx >= 0 and ny >= 0 and nx < lv.w and ny < lv.h then
				local ni = ny * lv.w + nx
				if not seen[ni] and not lv.wall[ni] and not bset[ni] then
					seen[ni] = true
					table.insert(q, ni)
				end
			end
		end
	end
	return seen, minI
end

local function walkPath(lv, bset, from, to): string?
	if from == to then return "" end
	local prev = { [from] = -1 }
	local q = { from }
	local head = 1
	while head <= #q do
		local c = q[head]
		head += 1
		if c == to then break end
		local cx, cy = c % lv.w, c // lv.w
		for d = 1, 4 do
			local nx, ny = cx + DX[d], cy + DY[d]
			if nx >= 0 and ny >= 0 and nx < lv.w and ny < lv.h then
				local ni = ny * lv.w + nx
				if prev[ni] == nil and not lv.wall[ni] and not bset[ni] then
					prev[ni] = c * 4 + (d - 1)
					table.insert(q, ni)
				end
			end
		end
	end
	if prev[to] == nil then return nil end
	local s = {}
	local c = to
	while c ~= from do
		local p = prev[c]
		table.insert(s, 1, DCH[(p % 4) + 1])
		c = p // 4
	end
	return table.concat(s)
end

--[[ solveSokoban(text, { maxStates = 200000 }) -> { solvable, pushes, moves = "lurd...", states }
     push-optimal BFS with dead-square pruning. Moves: lowercase walk + uppercase push. ]]
function P.solveSokoban(text: string, opts: any?): any
	opts = opts or {}
	local lv = parseSoko(text)
	assert(lv.player, "sokoban: no player (@)")
	assert(#lv.boxes == #lv.goals and #lv.boxes > 0, "sokoban: boxes and goals must match and be > 0")
	local live = liveSquares(lv)
	local gset = {}
	for _, g in lv.goals do gset[g] = true end
	local function keyOf(boxes, pnorm)
		table.sort(boxes)
		return table.concat(boxes, ",") .. "|" .. pnorm
	end
	local function solved(boxes)
		for _, b in boxes do if not gset[b] then return false end end
		return true
	end
	local startBoxes = table.clone(lv.boxes)
	local bset0 = {}
	for _, b in startBoxes do bset0[b] = true end
	local _, n0 = reach(lv, bset0, lv.player)
	local startKey = keyOf(startBoxes, n0)
	local nodes = { { boxes = startBoxes, player = lv.player, parent = 0, push = nil } }
	local seen = { [startKey] = true }
	if solved(startBoxes) then return { solvable = true, pushes = 0, moves = "", states = 1 } end
	local head = 1
	local maxStates = opts.maxStates or 200000
	while head <= #nodes do
		local node = nodes[head]
		local boxes = node.boxes
		local bset = {}
		for _, b in boxes do bset[b] = true end
		local reg = reach(lv, bset, node.player)
		for bi, b in boxes do
			local bx, by = b % lv.w, b // lv.w
			for d = 1, 4 do
				local px, py = bx - DX[d], by - DY[d]
				local tx, ty = bx + DX[d], by + DY[d]
				if px >= 0 and py >= 0 and tx >= 0 and ty >= 0 and px < lv.w and tx < lv.w and py < lv.h and ty < lv.h then
					local pi, ti = py * lv.w + px, ty * lv.w + tx
					if reg[pi] and not lv.wall[ti] and not bset[ti] and live[ti] then
						local nb = table.clone(boxes)
						nb[bi] = ti
						local nset = {}
						for _, x in nb do nset[x] = true end
						local _, norm = reach(lv, nset, b)
						local k = keyOf(table.clone(nb), norm)
						if not seen[k] then
							seen[k] = true
							table.insert(nodes, { boxes = nb, player = b, parent = head, push = { from = pi, box = b, d = d } })
							if solved(nb) then
								-- reconstruct
								local chain = {}
								local idx = #nodes
								while idx > 1 do table.insert(chain, 1, idx) idx = nodes[idx].parent end
								local moves = {}
								local cur = lv.player
								local cboxes = table.clone(startBoxes)
								for _, ci in chain do
									local nd = nodes[ci]
									local cset = {}
									for _, x in cboxes do cset[x] = true end
									table.insert(moves, walkPath(lv, cset, cur, nd.push.from) or "?")
									table.insert(moves, string.upper(DCH[nd.push.d]))
									cur = nd.push.box
									cboxes = nd.boxes
								end
								return { solvable = true, pushes = #chain, moves = table.concat(moves), states = #nodes }
							end
							if #nodes >= maxStates then return { solvable = false, exhausted = true, states = #nodes } end
						end
					end
				end
			end
		end
		head += 1
	end
	return { solvable = false, states = #nodes }
end

--[[ sokoban({ seed|rng, w = 8, h = 8, boxes = 2, walls = 0.12, minPushes = 4, maxPushes = 20, attempts = 60 })
     -> { text (XSB), pushes, moves, w, h } | nil (no puzzle in range found) ]]
function P.sokoban(opts: any?): any
	opts = opts or {}
	local rng = RNG.from(opts.rng or opts.seed)
	local W, H = opts.w or 8, opts.h or 8
	local nBox = opts.boxes or 2
	local minP, maxP = opts.minPushes or 4, opts.maxPushes or 30
	local best = nil
	for attempt = 1, opts.attempts or 60 do
		local wall = {}
		local floorCells = {}
		for y = 0, H - 1 do
			for x = 0, W - 1 do
				local i = y * W + x
				if x == 0 or y == 0 or x == W - 1 or y == H - 1 or rng:chance(opts.walls or 0.12) then wall[i] = true end
			end
		end
		-- keep the largest open region
		local lv0 = { w = W, h = H, wall = wall }
		local bestReg, bestN = nil, 0
		local labeled = {}
		for i = 0, W * H - 1 do
			if not wall[i] and not labeled[i] then
				local reg = reach(lv0, {}, i)
				local n = 0
				for k in reg do labeled[k] = true n += 1 end
				if n > bestN then bestReg, bestN = reg, n end
			end
		end
		if bestReg and bestN >= nBox * 3 + 4 then
			for i = 0, W * H - 1 do if not bestReg[i] then wall[i] = true end end
			for i = 0, W * H - 1 do if not wall[i] then table.insert(floorCells, i) end end
			rng:shuffle(floorCells)
			local goals = {}
			for k = 1, nBox do goals[k] = floorCells[k] end
			local boxes = table.clone(goals)
			local player = floorCells[nBox + 1]
			local lv = { w = W, h = H, wall = wall, goals = goals }
			-- reverse play: random pulls (and walks)
			local steps = rng:int(opts.minSteps or 20, opts.maxSteps or 120)
			for _ = 1, steps do
				local bset = {}
				for _, b in boxes do bset[b] = true end
				local reg = reach(lv, bset, player)
				local pulls = {}
				for bi, b in boxes do
					local bx, by = b % W, b // W
					for d = 1, 4 do
						-- player stands at b+d, pulls the box toward b+d, ending at b+2d
						local qx, qy = bx + DX[d], by + DY[d]
						local ex, ey = bx + 2 * DX[d], by + 2 * DY[d]
						if ex >= 0 and ey >= 0 and ex < W and ey < H then
							local qi, ei = qy * W + qx, ey * W + ex
							if reg[qi] and not wall[ei] and not bset[ei] then table.insert(pulls, { bi = bi, q = qi, e = ei }) end
						end
					end
				end
				if #pulls == 0 then break end
				local p = rng:pick(pulls)
				boxes[p.bi] = p.q
				player = p.e
			end
			-- randomize the player within its region (the solver doesn't care, the start screen does)
			local onGoals = true
			local gset = {}
			for _, g in goals do gset[g] = true end
			for _, b in boxes do if not gset[b] then onGoals = false end end
			if not onGoals then
				local text = sokoText(lv, boxes, player)
				local sol = P.solveSokoban(text, { maxStates = opts.maxStates or 60000 })
				if sol.solvable then
					local res = { text = text, pushes = sol.pushes, moves = sol.moves, w = W, h = H, boxes = nBox }
					if sol.pushes >= minP and sol.pushes <= maxP then return res end
					if best == nil or math.abs(sol.pushes - minP) < math.abs(best.pushes - minP) then best = res end
				end
			end
		end
	end
	return if opts.strict == false then best else nil
end

------------------------------------------------------------------ sliding tiles (n x n, 0 = blank)

local function manhattan(board, n)
	local s = 0
	for i = 1, n * n do
		local v = board[i]
		if v ~= 0 then
			local gi = v - 1
			local ci = i - 1
			s += math.abs(gi % n - ci % n) + math.abs(gi // n - ci // n)
		end
	end
	return s
end

-- IDA* optimal solve. board: flat list 1..n*n, 0 = blank, solved = 1,2,...,n*n-1,0
-- -> { solvable, moves = number, path = { tile indices moved } } (nil moves when node budget exceeded)
function P.solveSliding(board: { number }, n: number, opts: any?): any
	opts = opts or {}
	-- parity check
	local inv = 0
	local flat = {}
	local blankRow = 0
	for i, v in board do
		if v ~= 0 then table.insert(flat, v) else blankRow = (i - 1) // n end
	end
	for i = 1, #flat do for j = i + 1, #flat do if flat[i] > flat[j] then inv += 1 end end end
	local solvable
	if n % 2 == 1 then solvable = inv % 2 == 0 else solvable = (inv + (n - 1 - blankRow)) % 2 == 0 end
	if not solvable then return { solvable = false } end
	local b = table.clone(board)
	local blank = table.find(b, 0)
	local budget = opts.maxNodes or 400000
	local nodes = 0
	local path = {}
	local h0 = manhattan(b, n)
	local bound = h0
	local FOUND = -1
	local function search(g, h, prevBlank)
		local f = g + h
		if f > bound then return f end
		if h == 0 then return FOUND end
		nodes += 1
		if nodes > budget then return math.huge end
		local minNext = math.huge
		local bx, by = (blank - 1) % n, (blank - 1) // n
		for d = 1, 4 do
			local nx, ny = bx + DX[d], by + DY[d]
			if nx >= 0 and ny >= 0 and nx < n and ny < n then
				local ni = ny * n + nx + 1
				if ni ~= prevBlank then
					local v = b[ni]
					local gi = v - 1
					local before = math.abs(gi % n - nx) + math.abs(gi // n - ny)
					local after = math.abs(gi % n - bx) + math.abs(gi // n - by)
					local old = blank
					b[old], b[ni] = v, 0
					blank = ni
					table.insert(path, ni)
					local t = search(g + 1, h - before + after, old)
					if t == FOUND then return FOUND end
					table.remove(path)
					blank = old
					b[old], b[ni] = 0, v
					if t < minNext then minNext = t end
				end
			end
		end
		return minNext
	end
	while true do
		local t = search(0, h0, -1)
		if t == FOUND then return { solvable = true, moves = #path, path = table.clone(path), nodes = nodes } end
		if t == math.huge then return { solvable = true, moves = nil, exhausted = true, nodes = nodes } end
		bound = t
	end
end

--[[ sliding({ seed|rng, n = 3, minMoves = 8, maxMoves = 20, attempts = 40 })
     -> { board = {..} (flat, 0 = blank), n, moves (optimal), text = "1 2 3\n4 0 5\n..." } | nil ]]
function P.sliding(opts: any?): any
	opts = opts or {}
	local rng = RNG.from(opts.rng or opts.seed)
	local n = opts.n or 3
	local minM, maxM = opts.minMoves or 8, opts.maxMoves or 20
	for _ = 1, opts.attempts or 40 do
		local b = {}
		for i = 1, n * n - 1 do b[i] = i end
		b[n * n] = 0
		local blank = n * n
		local prev = -1
		for _ = 1, rng:int(maxM, maxM * 3) do
			local bx, by = (blank - 1) % n, (blank - 1) // n
			local opts2 = {}
			for d = 1, 4 do
				local nx, ny = bx + DX[d], by + DY[d]
				local ni = ny * n + nx + 1
				if nx >= 0 and ny >= 0 and nx < n and ny < n and ni ~= prev then table.insert(opts2, ni) end
			end
			local ni = rng:pick(opts2)
			b[blank], b[ni] = b[ni], 0
			prev = blank
			blank = ni
		end
		local sol = P.solveSliding(b, n, { maxNodes = opts.maxNodes })
		if sol.solvable and sol.moves and sol.moves >= minM and sol.moves <= maxM then
			local rows = {}
			for y = 0, n - 1 do
				local r = {}
				for x = 1, n do table.insert(r, tostring(b[y * n + x])) end
				table.insert(rows, table.concat(r, " "))
			end
			return { board = b, n = n, moves = sol.moves, path = sol.path, text = table.concat(rows, "\n") }
		end
	end
	return nil
end

------------------------------------------------------------------ lights out (press toggles cell + 4 neighbours)

-- GF(2) solve; returns min-press solution (list of 1-based cell indices) or nil if unsolvable
function P.solveLightsOut(lit: { boolean }, w: number, h: number?): any
	h = h or w
	local N = w * h
	-- augmented matrix rows: A[r][c] in {0,1}, A[r][N+1] = b
	local A = {}
	for r = 1, N do
		local row = table.create(N + 1, 0)
		local x, y = (r - 1) % w, (r - 1) // w
		row[r] = 1
		if x > 0 then row[r - 1] = 1 end
		if x < w - 1 then row[r + 1] = 1 end
		if y > 0 then row[r - w] = 1 end
		if y < h - 1 then row[r + w] = 1 end
		row[N + 1] = if lit[r] then 1 else 0
		A[r] = row
	end
	local pivotCol = {}
	local rank = 0
	local isPivot = {}
	for c = 1, N do
		local pr = nil
		for r = rank + 1, N do if A[r][c] == 1 then pr = r break end end
		if pr then
			rank += 1
			A[rank], A[pr] = A[pr], A[rank]
			for r = 1, N do
				if r ~= rank and A[r][c] == 1 then
					local rr, pv = A[r], A[rank]
					for k = c, N + 1 do rr[k] = (rr[k] + pv[k]) % 2 end
				end
			end
			pivotCol[rank] = c
			isPivot[c] = true
		end
	end
	for r = rank + 1, N do if A[r][N + 1] == 1 then return nil end end
	local free = {}
	for c = 1, N do if not isPivot[c] then table.insert(free, c) end end
	local best, bestN = nil, math.huge
	local combos = 2 ^ math.min(#free, 12)
	for mask = 0, combos - 1 do
		local x = table.create(N, 0)
		for i, c in free do x[c] = (mask // (2 ^ (i - 1))) % 2 end
		for r = rank, 1, -1 do
			local c = pivotCol[r]
			local v = A[r][N + 1]
			for _, fc in free do v = (v + A[r][fc] * x[fc]) % 2 end
			x[c] = v
		end
		local cnt = 0
		for i = 1, N do cnt += x[i] end
		if cnt < bestN then
			bestN = cnt
			best = {}
			for i = 1, N do if x[i] == 1 then table.insert(best, i) end end
		end
	end
	return best
end

function P.pressLightsOut(lit: { boolean }, w: number, h: number, i: number)
	local x, y = (i - 1) % w, (i - 1) // w
	lit[i] = not lit[i]
	if x > 0 then lit[i - 1] = not lit[i - 1] end
	if x < w - 1 then lit[i + 1] = not lit[i + 1] end
	if y > 0 then lit[i - w] = not lit[i - w] end
	if y < h - 1 then lit[i + w] = not lit[i + w] end
end

--[[ lightsOut({ seed|rng, w = 5, h = 5, minPresses = 4, maxPresses = 8 })
     -> { lit = { boolean } (flat), w, h, presses (optimal), solution = { cell indices }, text = "o.o..\n..." } | nil ]]
function P.lightsOut(opts: any?): any
	opts = opts or {}
	local rng = RNG.from(opts.rng or opts.seed)
	local w, h = opts.w or 5, opts.h or opts.w or 5
	local minP, maxP = opts.minPresses or 4, opts.maxPresses or 8
	local cells = {}
	for i = 1, w * h do cells[i] = i end
	for _ = 1, opts.attempts or 60 do
		local lit = table.create(w * h, false)
		for _, i in rng:sample(cells, rng:int(minP, maxP + 2)) do P.pressLightsOut(lit, w, h, i) end
		local sol = P.solveLightsOut(lit, w, h)
		if sol and #sol >= minP and #sol <= maxP then
			local rows = {}
			for y = 0, h - 1 do
				local r = {}
				for x = 1, w do table.insert(r, if lit[y * w + x] then "o" else ".") end
				table.insert(rows, table.concat(r))
			end
			return { lit = lit, w = w, h = h, presses = #sol, solution = sol, text = table.concat(rows, "\n") }
		end
	end
	return nil
end

return P
