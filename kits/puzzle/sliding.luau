--!nonstrict
-- sliding tiles (n×n, "15 puzzle"). Generator + optimal IDA* solver from procgen.puzzle.
-- Level: { n, board = { flat numbers, 0 = blank } } or text "1 2 3\n4 0 5\n7 8 6". Move = cell index (1-based) of the
-- tile that slides into the blank. Par = optimal moves.
local B = require("./board")
local procgen = require("@kit/procgen")
local M = { id = "sliding", name = "Slide" }

function M.parse(text: string)
	local rows = string.split((string.gsub(text, "\r", "")), "\n")
	local board = {}
	local n = 0
	for _, r in rows do
		if string.match(r, "%S") then
			n += 1
			for tok in string.gmatch(r, "%S+") do table.insert(board, tonumber(tok) or 0) end
		end
	end
	return { n = n, board = board }
end

function M.load(level)
	local n = level.n
	local b = B.new(n, n)
	local L = b:layer("tile", 0)
	for i = 1, n * n do L[i] = level.board[i] end
	return { board = b, n = n }
end

local function blank(state) return table.find(state.board.layers.tile, 0) end

function M.apply(state, move)
	local i = tonumber(move)
	local b = state.board
	local z = blank(state)
	if not i or i < 1 or i > b.w * b.h or not b:adjacent(i, z) then return false, "not next to the gap" end
	local L = b.layers.tile
	L[z], L[i] = L[i], 0
	return true, { cost = 1, tile = L[z], from = i, to = z }
end

function M.isWon(state)
	local L = state.board.layers.tile
	local N = #L
	for i = 1, N - 1 do if L[i] ~= i then return false end end
	return L[N] == 0
end

function M.solve(state)
	local sol = procgen.puzzle.solveSliding(state.board.layers.tile, state.n)
	if not sol.solvable or not sol.moves then return nil end
	return { moves = sol.path }
end

-- generate({ seed, n = 3, moves (difficulty = optimal moves, default 8), spread? (3) })
function M.generate(p)
	local mv = math.floor(p.moves or 8)
	for k = 0, 8 do
		local g = procgen.puzzle.sliding({ seed = (p.seed or 1) * 17 + k, n = p.n or 3, minMoves = mv, maxMoves = mv + (p.spread or 3) + k })
		if g then return { n = g.n, board = g.board, par = g.moves, difficulty = g.moves, solution = g.path } end
	end
	return nil
end

-- tap a tile in the gap's row/column: slides the whole run (one undo step)
function M.tap(state, x, y)
	local b = state.board
	local zx, zy = b:xy(blank(state))
	if x ~= zx and y ~= zy or (x == zx and y == zy) then return nil end
	local sx, sy = math.sign(x - zx), math.sign(y - zy)
	local path = { steps = true }
	local cx, cy = zx, zy
	while cx ~= x or cy ~= y do
		cx += sx
		cy += sy
		table.insert(path, b:index(cx, cy))
	end
	return if #path == 1 then path[1] else path
end
-- swipe dir moves the tile on the opposite side of the gap in that direction
function M.swipe(state, x, y, dir)
	local b = state.board
	local zx, zy = b:xy(blank(state))
	local d = B.DIRS[dir]
	local tx, ty = zx - d[1], zy - d[2]
	if not b:inside(tx, ty) then return nil end
	return b:index(tx, ty)
end

function M.render(state)
	local b = state.board
	local out = {}
	for i = 1, b.w * b.h do
		local x, y = b:xy(i)
		table.insert(out, { x = x, y = y, kind = "slot", z = 0 })
		local v = b.layers.tile[i]
		if v ~= 0 then table.insert(out, { x = x, y = y, kind = "tile", id = "t" .. v, text = tostring(v), z = 2, on = v == i }) end
	end
	return out
end
function M.hintCells(state, move) local x, y = state.board:xy(move) return { { x = x, y = y } } end

return M
