--!nonstrict
-- flow (connect the pipes / numberlink): join each pair of same-colour endpoints with a pipe; pipes can't cross;
-- with fill = true (default) every cell must be covered. Generator: random Hamiltonian path (backbite moves) cut into
-- segments → solvable by construction (solution stored); DFS solver with region pruning for authored levels + hints.
-- Level: { w, h, ends = { {a, b} per colour (cell indices) }, walls? = { indices }, fill?, solution? = { {cells} } }
--   or text: letters = endpoints (each exactly twice), "." empty, "#" blocked.
-- Move: { color = c, cells = { i1, i2, ... } } — the full path of colour c from one of its endpoints (replaces the old one,
--   cuts other pipes it crosses). A one-cell path (tap an endpoint) clears that pipe. Cost 1 per stroke. Par = colours.
local B = require("./board")
local procgen = require("@kit/procgen")
local M = { id = "flow", name = "Flow" }

function M.parse(text: string)
	local rows = string.split((string.gsub(text, "\r", "")), "\n")
	while #rows > 0 and rows[#rows] == "" do table.remove(rows) end
	local w, h = #rows[1], #rows
	local seen, letters, walls = {}, {}, {}
	for y = 0, h - 1 do
		for x = 0, w - 1 do
			local c = string.sub(rows[y + 1], x + 1, x + 1)
			local i = y * w + x + 1
			if c == "#" then table.insert(walls, i)
			elseif c ~= "." and c ~= "" and c ~= " " then
				if not seen[c] then seen[c] = {} table.insert(letters, c) end
				table.insert(seen[c], i)
			end
		end
	end
	table.sort(letters)
	local ends = {}
	for _, l in letters do
		if #seen[l] ~= 2 then error("flow level: endpoint '" .. l .. "' must appear exactly twice", 2) end
		table.insert(ends, { seen[l][1], seen[l][2] })
	end
	return { w = w, h = h, ends = ends, walls = walls }
end

function M.load(level)
	local b = B.new(level.w, level.h)
	b:layer("wall", false)
	local E = b:layer("ends", 0)
	for c, e in level.ends do E[e[1]] = c E[e[2]] = c end
	for _, i in level.walls or {} do b.layers.wall[i] = true end
	local paths = {}
	for c = 1, #level.ends do paths[c] = {} end
	return { board = b, ends = level.ends, paths = paths, fill = level.fill ~= false, colors = #level.ends }
end

local function connected(state, c): boolean
	local p = state.paths[c]
	if #p < 2 then return false end
	local e = state.ends[c]
	return (p[1] == e[1] and p[#p] == e[2]) or (p[1] == e[2] and p[#p] == e[1])
end
M.connected = connected

function M.apply(state, move)
	if type(move) ~= "table" then return false, "bad move" end
	local c, cells = move.color, move.cells
	local b = state.board
	if not state.ends[c] or type(cells) ~= "table" or #cells == 0 then return false, "bad move" end
	local e = state.ends[c]
	if cells[1] ~= e[1] and cells[1] ~= e[2] then return false, "start at an endpoint" end
	local other = if cells[1] == e[1] then e[2] else e[1]
	local used = {}
	for k, i in cells do
		if used[i] or not b.layers.ends[i] or b.layers.wall[i] then return false, "bad cell" end
		used[i] = true
		if k > 1 and not b:adjacent(cells[k - 1], i) then return false, "not adjacent" end
		local en = b.layers.ends[i]
		if en ~= 0 and en ~= c then return false, "other endpoint" end
		if i == other and k ~= #cells then return false, "past the endpoint" end
	end
	local broke = {}
	for d, p in state.paths do
		if d ~= c then
			for k, i in p do
				if used[i] then
					local was = connected(state, d)
					for _ = k, #p do table.remove(p) end
					if was then table.insert(broke, d) end
					break
				end
			end
		end
	end
	state.paths[c] = if #cells == 1 then {} else table.clone(cells)
	return true, { cost = 1, color = c, connected = connected(state, c), broke = broke }
end

function M.coverage(state): (number, number)
	local b = state.board
	local cov, total = 0, 0
	local on = {}
	for _, p in state.paths do for _, i in p do on[i] = true end end
	for i = 1, b.w * b.h do
		if not b.layers.wall[i] then
			total += 1
			if on[i] or b.layers.ends[i] ~= 0 then cov += 1 end
		end
	end
	return cov, total
end

function M.isWon(state)
	for c = 1, state.colors do if not connected(state, c) then return false end end
	if state.fill then local a, t = M.coverage(state) return a == t end
	return true
end

------------------------------------------------------------------ solver
-- solveLevel(level|state, { maxNodes = 200000 }) -> { [c] = cells } | nil
function M.solveLevel(st, opts)
	if st.board == nil then st = M.load(st) end
	local b, W, H = st.board, st.board.w, st.board.h
	local N = W * H
	local occ = table.create(N, 0)
	for i = 1, N do
		if b.layers.wall[i] then occ[i] = -1 elseif b.layers.ends[i] ~= 0 then occ[i] = b.layers.ends[i] end
	end
	local nbr = {}
	for i = 1, N do
		local x, y = (i - 1) % W, (i - 1) // W
		local l = {}
		if y > 0 then table.insert(l, i - W) end
		if x < W - 1 then table.insert(l, i + 1) end
		if y < H - 1 then table.insert(l, i + W) end
		if x > 0 then table.insert(l, i - 1) end
		nbr[i] = l
	end
	local order = {}
	for c = 1, #st.ends do table.insert(order, c) end
	local function dist(c)
		local e = st.ends[c]
		local ax, ay, bx, by = (e[1] - 1) % W, (e[1] - 1) // W, (e[2] - 1) % W, (e[2] - 1) // W
		return math.abs(ax - bx) + math.abs(ay - by)
	end
	table.sort(order, function(a, c) return dist(a) < dist(c) end)
	local fill = st.fill ~= false
	local nodes, maxNodes = 0, (opts and opts.maxNodes) or 200000
	local result = {}
	local region = table.create(N, 0)
	local function regionsOk(ci, head)
		for i = 1, N do region[i] = 0 end
		local nreg = 0
		for i = 1, N do
			if occ[i] == 0 and region[i] == 0 then
				nreg += 1
				region[i] = nreg
				local q, h = { i }, 1
				while h <= #q do
					local cc = q[h]
					h += 1
					for _, n in nbr[cc] do if occ[n] == 0 and region[n] == 0 then region[n] = nreg table.insert(q, n) end end
				end
			end
		end
		local used = {}
		for k = ci, #order do
			local c = order[k]
			local s = if k == ci then head else st.ends[c][1]
			local t = st.ends[c][2]
			local direct = false
			local rs = {}
			for _, n in nbr[s] do
				if n == t then direct = true end
				if occ[n] == 0 then rs[region[n]] = true end
			end
			local ok = direct
			for _, n in nbr[t] do
				if occ[n] == 0 and rs[region[n]] then ok = true used[region[n]] = true end
			end
			if not ok then return false end
		end
		if fill then for r = 1, nreg do if not used[r] then return false end end end
		return true
	end
	local extend
	local function nextColor(ci)
		if ci > #order then
			if fill then for i = 1, N do if occ[i] == 0 then return false end end end
			return true
		end
		local c = order[ci]
		result[c] = { st.ends[c][1] }
		if not regionsOk(ci, st.ends[c][1]) then return false end
		return extend(ci, st.ends[c][1])
	end
	extend = function(ci, head)
		nodes += 1
		if nodes > maxNodes then return false end
		local c = order[ci]
		local t = st.ends[c][2]
		local path = result[c]
		for _, n in nbr[head] do
			if n == t then
				table.insert(path, t)
				if nextColor(ci + 1) then return true end
				table.remove(path)
			end
		end
		for _, n in nbr[head] do
			if occ[n] == 0 then
				occ[n] = c
				table.insert(path, n)
				if regionsOk(ci, n) and extend(ci, n) then return true end
				table.remove(path)
				occ[n] = 0
			end
		end
		return false
	end
	if nextColor(1) then return result, nodes end
	return nil, nodes
end

local function levelSolution(state, session)
	local lv = session and session.level
	if lv and lv.solution then return lv.solution end
	if lv and lv._solution then return lv._solution end
	local sol = M.solveLevel({ board = state.board, ends = state.ends, fill = state.fill })
	if lv then lv._solution = sol end
	return sol
end

function M.solve(state, opts, session)
	local sol = levelSolution(state, session)
	if not sol then return nil end
	local moves = {}
	for c = 1, state.colors do
		if not B.equal(state.paths[c], sol[c]) then table.insert(moves, { color = c, cells = table.clone(sol[c]) }) end
	end
	return { moves = moves }
end

------------------------------------------------------------------ generator
-- generate({ seed, w = 5, h?, pairs (colours; fewer = longer pipes = harder), minLen? (3) })
function M.generate(p)
	local W, H = math.floor(p.w or 5), math.floor(p.h or p.w or 5)
	local k = math.floor(p.pairs or math.max(2, math.floor(W * H / 6)))
	local minLen = p.minLen or 3
	local rng = procgen.rng((p.seed or 1) * 7919 + W * 101 + k)
	local N = W * H
	if k * minLen > N then error("flow.generate: too many pairs for the grid", 2) end
	for _ = 1, 30 do
		-- serpentine Hamiltonian path, then randomized by backbite moves
		local P = {}
		for y = 0, H - 1 do
			for x0 = 0, W - 1 do
				local x = if y % 2 == 0 then x0 else W - 1 - x0
				table.insert(P, y * W + x + 1)
			end
		end
		local pos = {}
		for _ = 1, N * 12 do
			if rng:chance(0.5) then
				local r = {}
				for i = #P, 1, -1 do table.insert(r, P[i]) end
				P = r
			end
			for i, c in P do pos[c] = i end
			local e = P[1]
			local ex, ey = (e - 1) % W, (e - 1) // W
			local cand = {}
			if ey > 0 then table.insert(cand, e - W) end
			if ex < W - 1 then table.insert(cand, e + 1) end
			if ey < H - 1 then table.insert(cand, e + W) end
			if ex > 0 then table.insert(cand, e - 1) end
			local nb = rng:pick(cand)
			local j = pos[nb]
			if j > 2 then
				local np = {}
				for i = j - 1, 1, -1 do table.insert(np, P[i]) end
				for i = j, #P do table.insert(np, P[i]) end
				P = np
			end
		end
		-- cut into k segments (each ≥ minLen)
		local lens = table.create(k, minLen)
		for _ = 1, N - k * minLen do local i = rng:int(1, k) lens[i] += 1 end
		local segs, at = {}, 1
		for s = 1, k do
			local seg = {}
			for i = at, at + lens[s] - 1 do table.insert(seg, P[i]) end
			at += lens[s]
			table.insert(segs, seg)
		end
		-- reject trivial pairs (endpoints next to each other)
		local ok = true
		for _, seg in segs do
			local a, z = seg[1], seg[#seg]
			if math.abs((a - 1) % W - (z - 1) % W) + math.abs((a - 1) // W - (z - 1) // W) <= 1 then ok = false end
		end
		if ok then
			rng:shuffle(segs)
			local ends, sol = {}, {}
			for c, seg in segs do ends[c] = { seg[1], seg[#seg] } sol[c] = seg end
			return { w = W, h = H, ends = ends, solution = sol, par = k, difficulty = N / k, fill = true }
		end
	end
	return nil
end

------------------------------------------------------------------ input + render
-- drag(cells): cells visited by the finger, in order. Starts on an endpoint (new pipe) or on a pipe (extends it);
-- moving back over the pipe shortens it; stops at the matching endpoint.
function M.drag(state, cells)
	local b = state.board
	local first = cells[1]
	local c = b.layers.ends[first]
	local path
	if c ~= 0 then
		path = { first }
	else
		for d, p in state.paths do
			local k = table.find(p, first)
			if k then
				c = d
				path = {}
				for i = 1, k do path[i] = p[i] end
				break
			end
		end
	end
	if not path then return nil end
	local e = state.ends[c]
	local other = if path[1] == e[1] then e[2] else e[1]
	for k = 2, #cells do
		local i = cells[k]
		if path[#path] == other then break end
		local at = table.find(path, i)
		if at then
			for _ = at + 1, #path do table.remove(path) end
		elseif b:adjacent(path[#path], i) and not b.layers.wall[i] and (b.layers.ends[i] == 0 or i == other) then
			table.insert(path, i)
		else
			break
		end
	end
	return { color = c, cells = path }
end
function M.tap(state, x, y)
	local i = state.board:index(x, y)
	if state.board.layers.ends[i] ~= 0 then return { color = state.board.layers.ends[i], cells = { i } } end
	return nil
end

function M.render(state)
	local b = state.board
	local out = {}
	for i = 1, b.w * b.h do
		local x, y = b:xy(i)
		if b.layers.wall[i] then table.insert(out, { x = x, y = y, kind = "wall", z = 0 })
		else table.insert(out, { x = x, y = y, kind = "cell", z = 0 }) end
		local c = b.layers.ends[i]
		if c ~= 0 then table.insert(out, { x = x, y = y, kind = "end", tint = c, z = 3, on = connected(state, c) }) end
	end
	for c, p in state.paths do
		for k, i in p do
			local x, y = b:xy(i)
			if b.layers.ends[i] == 0 then table.insert(out, { x = x, y = y, kind = "pipe", tint = c, z = 2 }) end
			if k > 1 then
				local px, py = b:xy(p[k - 1])
				table.insert(out, { x = (x + px) / 2, y = (y + py) / 2, kind = if py == y then "link_h" else "link_v", tint = c, z = 1 })
			end
		end
	end
	return out
end
function M.hintCells(state, move)
	local out = {}
	for _, i in move.cells do local x, y = state.board:xy(i) table.insert(out, { x = x, y = y }) end
	return out
end
function M.status(state)
	local n = 0
	for c = 1, state.colors do if connected(state, c) then n += 1 end end
	local a, t = M.coverage(state)
	return n .. "/" .. state.colors .. " linked · " .. math.floor(a / t * 100 + 0.5) .. "%"
end

return M
