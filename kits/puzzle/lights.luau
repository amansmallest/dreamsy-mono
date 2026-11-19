--!nonstrict
-- lights (lights-out / toggle): tapping a cell toggles it and its 4 neighbours; clear the board.
-- Level: { w, h, lit = { flat booleans } } or text rows ("o" lit, "." off). Move = cell index. Par = minimum presses (GF(2) solver).
local B = require("./board")
local procgen = require("@kit/procgen")
local M = { id = "lights", name = "Lights" }

function M.parse(text: string)
	local rows = string.split((string.gsub(text, "\r", "")), "\n")
	while #rows > 0 and rows[#rows] == "" do table.remove(rows) end
	local lit = {}
	for _, r in rows do for x = 1, #rows[1] do table.insert(lit, string.sub(r, x, x) == "o") end end
	return { w = #rows[1], h = #rows, lit = lit }
end

function M.load(level)
	local b = B.new(level.w, level.h)
	local L = b:layer("lit", false)
	for i = 1, level.w * level.h do L[i] = level.lit[i] == true end
	return { board = b }
end

function M.apply(state, move)
	local i = tonumber(move)
	local b = state.board
	if not i or i < 1 or i > b.w * b.h then return false, "outside" end
	procgen.puzzle.pressLightsOut(b.layers.lit, b.w, b.h, i)
	return true, { cost = 1 }
end

function M.isWon(state) return state.board:count("lit", true) == 0 end

function M.solve(state)
	local b = state.board
	local sol = procgen.puzzle.solveLightsOut(b.layers.lit, b.w, b.h)
	if not sol then return nil end
	return { moves = sol }
end

-- generate({ seed, w = 5, h?, presses (difficulty = min presses, default 4), spread? (1) })
function M.generate(p)
	local pr = math.floor(p.presses or 4)
	for k = 0, 8 do
		local g = procgen.puzzle.lightsOut({ seed = (p.seed or 1) * 13 + k, w = p.w or 5, h = p.h or p.w or 5, minPresses = pr, maxPresses = pr + (p.spread or 1) + k })
		if g then return { w = g.w, h = g.h, lit = g.lit, par = g.presses, difficulty = g.presses, solution = g.solution } end
	end
	return nil
end

function M.tap(state, x, y) return state.board:index(x, y) end

function M.render(state)
	local b = state.board
	local out = {}
	for i = 1, b.w * b.h do
		local x, y = b:xy(i)
		table.insert(out, { x = x, y = y, kind = if b.layers.lit[i] then "on" else "off", z = 1 })
	end
	return out
end
function M.hintCells(state, move) local x, y = state.board:xy(move) return { { x = x, y = y } } end
function M.status(state) return state.board:count("lit", true) .. " lit" end

return M
