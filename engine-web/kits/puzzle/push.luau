--!nonstrict
-- push (sokoban): walk, push crates onto goals. Generator + solver come from procgen.puzzle (reverse play + BFS).
-- Level: { text = XSB ("#" wall, "-"/" " floor, "@" player, "+" player on goal, "$" crate, "*" crate on goal, "." goal), par? }
-- Moves: "u" | "r" | "d" | "l". Cost 1 per step. Par = solver's move count (push-optimal solution).
local B = require("./board")
local procgen = require("@kit/procgen")
local M = { id = "push", name = "Push" }

local LEGEND = {
	_layers = { wall = false, goal = false, void = false },
	["#"] = { wall = true }, ["-"] = {}, [" "] = {}, ["_"] = {},
	["@"] = { piece = "player" }, ["+"] = { goal = true, piece = "player" },
	["$"] = { piece = "box" }, ["*"] = { goal = true, piece = "box" }, ["."] = { goal = true },
}

function M.parse(text: string) return { text = text } end

function M.load(level)
	local b = B.fromRows(level.text, LEGEND)
	local player = b:piecesOf("player")[1]
	if not player then error("push level has no player (@)", 2) end
	-- cells outside the walls (not reachable by walking, ignoring crates) are void: not drawn
	local seen = { [b:index(player.x, player.y)] = true }
	local q = { { player.x, player.y } }
	while #q > 0 do
		local c = table.remove(q)
		for _, n in b:neighbors(c[1], c[2]) do
			if not seen[n.i] and not b.layers.wall[n.i] then seen[n.i] = true table.insert(q, { n.x, n.y }) end
		end
	end
	for i = 1, b.w * b.h do if not seen[i] and not b.layers.wall[i] then b.layers.void[i] = true end end
	return { board = b }
end

local function player(state) return state.board:piecesOf("player")[1] end
local function blocked(b, x, y) return not b:inside(x, y) or b:get("wall", x, y) or b:get("void", x, y) end

function M.apply(state, move)
	local d = B.DIRS[string.lower(tostring(move))]
	if not d then return false, "bad move" end
	local b = state.board
	local p = player(state)
	local nx, ny = p.x + d[1], p.y + d[2]
	if blocked(b, nx, ny) then return false, "wall" end
	local box = b:pieceAt(nx, ny, "box")
	if box then
		local bx, by = nx + d[1], ny + d[2]
		if blocked(b, bx, by) or b:pieceAt(bx, by, "box") then return false, "stuck" end
		b:movePiece(box, bx, by)
	end
	b:movePiece(p, nx, ny)
	return true, { cost = 1, push = box ~= nil, box = box and box.id, onGoal = box ~= nil and b:get("goal", box.x, box.y) }
end

function M.isWon(state)
	for _, bx in state.board:piecesOf("box") do if not state.board:get("goal", bx.x, bx.y) then return false end end
	return true
end

function M.toText(state): string
	local b = state.board
	return b:toRows(function(x, y, i)
		if b.layers.wall[i] or b.layers.void[i] then return "#" end
		local g = b.layers.goal[i]
		local pc = b:pieceAt(x, y)
		if pc and pc.kind == "box" then return if g then "*" else "$" end
		if pc and pc.kind == "player" then return if g then "+" else "@" end
		return if g then "." else "-"
	end)
end

function M.solve(state, opts)
	local sol = procgen.puzzle.solveSokoban(M.toText(state), { maxStates = opts and opts.maxStates or 60000 })
	if not sol.solvable then return nil end
	local moves = {}
	for i = 1, #sol.moves do table.insert(moves, string.lower(string.sub(sol.moves, i, i))) end
	return { moves = moves, pushes = sol.pushes }
end

-- generate({ seed, pushes (difficulty: optimal pushes, default 4), spread? (2), w?, h?, boxes?, walls?, tries? (2) })
-- Deterministic: the same params give the same level on every device and under any load (no wall-clock cut-off).
-- Work is bounded by attempts: up to `tries` seeds, then keep the closest; only if none built at all, up to 10.
function M.generate(p)
	local pushes = math.floor(p.pushes or 4)
	local tries = math.max(1, math.floor(p.tries or 2))
	local best = nil
	for k = 0, 9 do
		local g = procgen.puzzle.sokoban({ seed = (p.seed or 1) * 31 + k, w = p.w or 7, h = p.h or 7, boxes = p.boxes or 2,
			walls = p.walls or 0.12, minPushes = pushes, maxPushes = pushes + (p.spread or 2) + math.floor(k / 3), attempts = p.attempts or 12,
			maxStates = p.maxStates or 20000, strict = false })
		if g and g.pushes >= pushes and g.pushes <= pushes + (p.spread or 2) + math.floor(k / 3) then best = g break end
		if g and (best == nil or math.abs(g.pushes - pushes) < math.abs(best.pushes - pushes)) then best = g end
		if best and k + 1 >= tries then break end
	end
	if not best then return nil end
	return { text = best.text, par = #best.moves, pushes = best.pushes, solution = best.moves, difficulty = best.pushes }
end

-- input: tap a neighbour = step/push; tap a reachable floor cell = walk there (one undo step)
function M.tap(state, x, y)
	local b = state.board
	local p = player(state)
	local dx, dy = x - p.x, y - p.y
	if math.abs(dx) + math.abs(dy) == 1 then
		for k, v in B.DIRS do if v[1] == dx and v[2] == dy then return k end end
	end
	if blocked(b, x, y) or b:pieceAt(x, y, "box") then return nil end
	local from, to = b:index(p.x, p.y), b:index(x, y)
	local prev = { [from] = false }
	local q, head = { from }, 1
	while head <= #q do
		local c = q[head]
		head += 1
		if c == to then break end
		local cx, cy = b:xy(c)
		for _, n in b:neighbors(cx, cy) do
			if prev[n.i] == nil and not blocked(b, n.x, n.y) and not b:pieceAt(n.x, n.y, "box") then
				prev[n.i] = { c, n.dir }
				table.insert(q, n.i)
			end
		end
	end
	if prev[to] == nil then return nil end
	local path = { steps = true }
	local c = to
	while prev[c] do table.insert(path, 1, prev[c][2]) c = prev[c][1] end
	return path
end
function M.swipe(state, x, y, dir) return dir end
function M.key(state) return state.board:key({}) end

-- render items: { x, y, kind, id?, z? } — kinds: floor, wall, goal, box (on = on goal), player
function M.render(state)
	local b = state.board
	local out = {}
	for i = 1, b.w * b.h do
		local x, y = b:xy(i)
		if b.layers.wall[i] then table.insert(out, { x = x, y = y, kind = "wall", z = 0 })
		elseif not b.layers.void[i] then
			table.insert(out, { x = x, y = y, kind = "floor", z = 0 })
			if b.layers.goal[i] then table.insert(out, { x = x, y = y, kind = "goal", z = 1 }) end
		end
	end
	for _, p in b.pieces do
		table.insert(out, { x = p.x, y = p.y, kind = p.kind, id = p.kind .. p.id, z = 2, on = p.kind == "box" and b:get("goal", p.x, p.y) or nil })
	end
	return out
end

-- cells to highlight for a hint move
function M.hintCells(state, move)
	local p = player(state)
	local d = B.DIRS[move]
	return { { x = p.x + d[1], y = p.y + d[2] } }
end

function M.status(state)
	local n, on = 0, 0
	for _, bx in state.board:piecesOf("box") do n += 1 if state.board:get("goal", bx.x, bx.y) then on += 1 end end
	return on .. "/" .. n .. " crates"
end

return M
