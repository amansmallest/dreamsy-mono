--!nonstrict
-- puzzle kit: grid-puzzle framework (board model, sessions with undo/redo/par/stars/hints, input → moves, juice) +
-- mechanics (push, flow, match3, sliding, lights, nonogram) + authored/generated level packs with difficulty curves,
-- star-gated packs, daily puzzle, progress save. See KIT.md.
local Puzzle = { VERSION = "0.1.0" }

Puzzle.board = require("./board")
Puzzle.mechanics = require("./mechanics")
Puzzle.Session = require("./session")
Puzzle.packs = require("./packs")
Puzzle.progress = require("./progress")
Puzzle.daily = require("./daily")
Puzzle.view = require("./view")
Puzzle.ui = require("./ui")

-- session(mechanic | level, level?, opts?) — Puzzle.session(lv) uses lv.mechanic
function Puzzle.session(a, b, c)
	if type(a) == "table" and a.load == nil then
		return Puzzle.Session.new(a.mechanic, a, b) -- a = level (from a pack / generate / daily)
	end
	return Puzzle.Session.new(a, b, c)
end
function Puzzle.mechanic(id: string) return Puzzle.mechanics.get(id) end
function Puzzle.register(mech) return Puzzle.mechanics.register(mech) end

-- setup({ packs? = "data/packs" | false, load? (true: core.save.load()), autosave? (true) }) -> packs list
function Puzzle.setup(opts)
	opts = opts or {}
	local core = require("@kit/core")
	Puzzle.progress.autosave = opts.autosave ~= false
	local list = {}
	if opts.packs ~= false then
		local dir = if type(opts.packs) == "string" then opts.packs else "data/packs"
		if type(data) == "table" and data.list and #data.list(dir) > 0 then list = Puzzle.packs.load(dir) end
	end
	if opts.load ~= false then pcall(core.save.load) end
	return list
end

-- record a finished session into progress (pack/index from session.level); returns improved
function Puzzle.record(session): boolean
	if not session.won then return false end
	local lv = session.level
	if lv.daily then Puzzle.daily.complete(session:stars(), lv.day) return true end
	if lv.pack and lv.index then return Puzzle.progress.record(lv.pack, lv.index, session:stars(), session.moves) end
	return false
end

-- headless bot: follow hints until won/lost or maxMoves -> won, movesPlayed
function Puzzle.autoplay(session, maxMoves: number?): (boolean, number)
	local n = 0
	while not session.won and not session.lost and n < (maxMoves or 500) do
		if not session:step() then break end
		n += 1
	end
	return session.won, n
end

return Puzzle
