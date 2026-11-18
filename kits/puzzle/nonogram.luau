--!nonstrict
-- nonogram-lite (picross): fill cells so every row/column matches its run clues. Generator only keeps pictures a
-- line-by-line solver finishes (unique, no guessing). Level: { w, h, solution = { flat booleans } } or text rows
-- ("#" filled, "." empty). Move: { i = cell, v = 0 empty | 1 filled | 2 crossed }; tap cycles 0 → 1 → 2 → 0.
-- Crossing costs 0 moves; par = filled cells.
local B = require("./board")
local procgen = require("@kit/procgen")
local M = { id = "nonogram", name = "Picture" }

function M.parse(text: string)
	local rows = string.split((string.gsub(text, "\r", "")), "\n")
	while #rows > 0 and rows[#rows] == "" do table.remove(rows) end
	local sol = {}
	for _, r in rows do for x = 1, #rows[1] do table.insert(sol, string.sub(r, x, x) == "#") end end
	return { w = #rows[1], h = #rows, solution = sol }
end

local function runs(line)
	local out, n = {}, 0
	for _, v in line do
		if v then n += 1 elseif n > 0 then table.insert(out, n) n = 0 end
	end
	if n > 0 then table.insert(out, n) end
	return out
end

function M.clues(w, h, sol)
	local rows, cols = {}, {}
	for y = 0, h - 1 do
		local l = {}
		for x = 0, w - 1 do table.insert(l, sol[y * w + x + 1] == true) end
		rows[y + 1] = runs(l)
	end
	for x = 0, w - 1 do
		local l = {}
		for y = 0, h - 1 do table.insert(l, sol[y * w + x + 1] == true) end
		cols[x + 1] = runs(l)
	end
	return rows, cols
end

-- line solver: known = { -1 unknown | 0 | 1 } → refined copy, or nil on contradiction
function M.solveLine(clue, known)
	local n = #known
	local canFill, canEmpty = table.create(n, false), table.create(n, false)
	local cur = table.create(n, 0)
	local any = false
	local function place(ci, pos)
		if ci > #clue then
			for k = pos, n do if known[k] == 1 then return end end
			for k = pos, n do cur[k] = 0 end
			any = true
			for k = 1, n do if cur[k] == 1 then canFill[k] = true else canEmpty[k] = true end end
			return
		end
		local len = clue[ci]
		local rest = 0
		for k = ci + 1, #clue do rest += clue[k] + 1 end
		for s = pos, n - len - rest + 1 do
			local ok = true
			for k = pos, s - 1 do if known[k] == 1 then ok = false break end end
			if not ok then break end
			for k = s, s + len - 1 do if known[k] == 0 then ok = false break end end
			if ok and s + len <= n and known[s + len] == 1 then ok = false end
			if ok then
				for k = pos, s - 1 do cur[k] = 0 end
				for k = s, s + len - 1 do cur[k] = 1 end
				if s + len <= n then cur[s + len] = 0 end
				place(ci + 1, s + len + 1)
			end
		end
	end
	place(1, 1)
	if not any then return nil end
	local out = {}
	for k = 1, n do out[k] = if canFill[k] and not canEmpty[k] then 1 elseif canEmpty[k] and not canFill[k] then 0 else -1 end
	return out
end

-- solveClues(rows, cols) -> flat booleans (fully determined by line logic) | nil
function M.solveClues(rows, cols)
	local h, w = #rows, #cols
	local g = table.create(w * h, -1)
	local changed = true
	while changed do
		changed = false
		for y = 0, h - 1 do
			local line = {}
			for x = 0, w - 1 do line[x + 1] = g[y * w + x + 1] end
			local r = M.solveLine(rows[y + 1], line)
			if not r then return nil end
			for x = 0, w - 1 do if g[y * w + x + 1] ~= r[x + 1] then g[y * w + x + 1] = r[x + 1] changed = true end end
		end
		for x = 0, w - 1 do
			local line = {}
			for y = 0, h - 1 do line[y + 1] = g[y * w + x + 1] end
			local r = M.solveLine(cols[x + 1], line)
			if not r then return nil end
			for y = 0, h - 1 do if g[y * w + x + 1] ~= r[y + 1] then g[y * w + x + 1] = r[y + 1] changed = true end end
		end
	end
	local out = {}
	for i = 1, w * h do
		if g[i] == -1 then return nil end
		out[i] = g[i] == 1
	end
	return out
end

function M.load(level)
	local b = B.new(level.w, level.h)
	local S = b:layer("sol", false)
	for i = 1, level.w * level.h do S[i] = level.solution[i] == true end
	b:layer("mark", 0)
	local rows, cols = M.clues(level.w, level.h, S)
	return { board = b, rows = rows, cols = cols }
end

function M.apply(st, move)
	if type(move) ~= "table" then return false, "bad move" end
	local b = st.board
	local i, v = move.i, move.v
	if not i or i < 1 or i > b.w * b.h or (v ~= 0 and v ~= 1 and v ~= 2) then return false, "bad move" end
	if b.layers.mark[i] == v then return false, "same" end
	b.layers.mark[i] = v
	return true, { cost = if v == 1 then 1 else 0 }
end

function M.isWon(st)
	local b = st.board
	local filled = {}
	for i = 1, b.w * b.h do filled[i] = b.layers.mark[i] == 1 end
	local rows, cols = M.clues(b.w, b.h, filled)
	return B.equal(rows, st.rows) and B.equal(cols, st.cols)
end

function M.solve(st)
	local b = st.board
	local moves = {}
	for i = 1, b.w * b.h do
		local want = b.layers.sol[i]
		local m = b.layers.mark[i]
		if not want and m == 1 then table.insert(moves, 1, { i = i, v = 0 }) end
	end
	for i = 1, b.w * b.h do
		if b.layers.sol[i] and b.layers.mark[i] ~= 1 then table.insert(moves, { i = i, v = 1 }) end
	end
	return { moves = moves }
end

-- generate({ seed, w = 5, h?, density? (0.55) }) — difficulty = cells
function M.generate(p)
	local w, h = math.floor(p.w or 5), math.floor(p.h or p.w or 5)
	local rng = procgen.rng((p.seed or 1) * 4099 + w * 7 + h)
	for _ = 1, 80 do
		local sol = {}
		local n = 0
		for i = 1, w * h do sol[i] = rng:chance(p.density or 0.55) if sol[i] then n += 1 end end
		if n > 0 then
			local rows, cols = M.clues(w, h, sol)
			local got = M.solveClues(rows, cols)
			if got and B.equal(got, sol) then return { w = w, h = h, solution = sol, par = n, difficulty = w * h } end
		end
	end
	return nil
end

function M.tap(st, x, y)
	local i = st.board:index(x, y)
	return { i = i, v = (st.board.layers.mark[i] + 1) % 3 }
end
function M.drag(st, cells)
	local v = if st.board.layers.mark[cells[1]] == 1 then 0 else 1
	local out = { steps = true }
	for _, i in cells do if st.board.layers.mark[i] ~= v then table.insert(out, { i = i, v = v }) end end
	return if #out > 0 then out else nil
end

function M.render(st)
	local b = st.board
	local out = {}
	for i = 1, b.w * b.h do
		local x, y = b:xy(i)
		local m = b.layers.mark[i]
		table.insert(out, { x = x, y = y, kind = if m == 1 then "fill" elseif m == 2 then "cross" else "cell", z = 1 })
	end
	for y, r in st.rows do table.insert(out, { x = -1, y = y - 1, kind = "clue_row", text = if #r == 0 then "0" else table.concat(r, " "), z = 1 }) end
	for x, c in st.cols do table.insert(out, { x = x - 1, y = -1, kind = "clue_col", text = if #c == 0 then "0" else table.concat(c, "\n"), z = 1 }) end
	return out
end
function M.hintCells(st, move) local x, y = st.board:xy(move.i) return { { x = x, y = y } } end

return M
