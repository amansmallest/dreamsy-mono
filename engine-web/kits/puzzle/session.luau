--!nonstrict
-- Session: one play of one level. Generic over mechanics: move validation (mechanic.apply on a snapshot),
-- undo/redo/restart, move counter, par + stars, solver hints (cached plan), win/lose detection, events.
local B = require("./board")
local core = require("@kit/core")
local M = {}
local Session = {}
Session.__index = Session
M.Session = Session

local function mechOf(m)
	if type(m) == "table" then return m end
	local reg = require("./mechanics")
	local mech = reg.get(m)
	if not mech then error("puzzle: unknown mechanic '" .. tostring(m) .. "' (known: " .. table.concat(reg.ids(), ", ") .. ")", 3) end
	return mech
end

-- new(mechanic (id | table), level (table from mechanic.parse / generate / pack:level), opts?)
-- opts: { pack?, index?, maxHistory? (500), hintPenalty? (0: hints don't cost stars) }
function M.new(mechanic, level, opts)
	opts = opts or {}
	local mech = mechOf(mechanic)
	local s = setmetatable({
		mech = mech, level = level, opts = opts, pack = opts.pack, index = opts.index,
		history = {}, future = {}, moves = 0, hintsUsed = 0, won = false, lost = false, plan = nil,
		events = core.events.new(), startTime = if type(time) == "function" then time() else 0,
	}, Session)
	s.state = mech.load(level)
	s.initial = B.copy(s.state)
	s.par = level.par
	return s
end

function Session:on(name: string, fn) return self.events:on(name, fn) end

local function finish(self, move, info)
	local mech = self.mech
	if mech.isWon(self.state, self) then
		self.won = true
		local stars = self:stars()
		self.events:emit("won", { stars = stars, moves = self.moves, par = self.par })
		core.emit("puzzle_won", { mechanic = mech.id, pack = self.pack, level = self.index, stars = stars, moves = self.moves })
	elseif mech.isLost and mech.isLost(self.state, self) then
		self.lost = true
		self.events:emit("lost", { moves = self.moves })
		core.emit("puzzle_lost", { mechanic = mech.id, pack = self.pack, level = self.index })
	end
end

-- apply(move) -> ok, info. Invalid moves change nothing and return false, reason.
-- A list of moves ({ m1, m2, ... } with `steps = true`) applies as ONE undo step (tap-to-walk paths).
function Session:apply(move)
	if self.won or self.lost then return false, "over" end
	local mech = self.mech
	local before = B.copy(self.state)
	local ok, info
	if type(move) == "table" and move.steps then
		local cost = 0
		ok, info = #move > 0, { steps = {} }
		for k = 1, #move do
			local o, inf = mech.apply(self.state, move[k])
			if not o then ok = false info = inf break end
			cost += (inf and inf.cost) or 1
			table.insert(info.steps, inf)
		end
		if ok then info.cost = cost end
	else
		ok, info = mech.apply(self.state, move)
	end
	if not ok then
		self.state = before
		self.events:emit("invalid", { move = move, reason = info })
		return false, info
	end
	info = info or {}
	table.insert(self.history, { state = before, moves = self.moves })
	if #self.history > (self.opts.maxHistory or 500) then table.remove(self.history, 1) end
	self.future = {}
	self.moves += info.cost or 1
	-- keep following the cached solution while the player does what it says
	if self.plan and #self.plan > 0 and B.equal(self.plan[1], if type(move) == "table" and move.steps then move[1] else move) and not (type(move) == "table" and move.steps and #move > 1) then
		table.remove(self.plan, 1)
	else
		self.plan = nil
	end
	if mech.stochastic then self.plan = nil end
	self.events:emit("moved", { move = move, info = info, moves = self.moves })
	finish(self, move, info)
	return true, info
end

function Session:canUndo(): boolean return #self.history > 0 and not self.won end
function Session:canRedo(): boolean return #self.future > 0 and not self.won end
function Session:undo(): boolean
	if not self:canUndo() then return false end
	local h = table.remove(self.history)
	table.insert(self.future, { state = self.state, moves = self.moves })
	self.state, self.moves, self.lost, self.plan = h.state, h.moves, false, nil
	self.events:emit("undone", { moves = self.moves })
	return true
end
function Session:redo(): boolean
	if not self:canRedo() then return false end
	local f = table.remove(self.future)
	table.insert(self.history, { state = self.state, moves = self.moves })
	self.state, self.moves, self.plan = f.state, f.moves, nil
	self.events:emit("redone", { moves = self.moves })
	finish(self)
	return true
end
function Session:restart()
	self.state = B.copy(self.initial)
	self.history, self.future, self.moves, self.won, self.lost, self.plan = {}, {}, 0, false, false, nil
	self.events:emit("restarted", {})
end

-- solution from the current state: { moves } | nil (cached plan reused while the player follows it)
function Session:solve(opts)
	if self.plan and #self.plan > 0 then return { moves = table.clone(self.plan) } end
	local sol = self.mech.solve(self.state, opts or {}, self)
	if sol and sol.moves then self.plan = table.clone(sol.moves) end
	return sol
end

-- hint() -> next move | nil (counts hintsUsed; the view highlights it via mechanic.hintCells)
function Session:hint()
	if self.won or self.lost then return nil end
	local sol = self:solve()
	if not sol or not sol.moves or #sol.moves == 0 then return nil end
	self.hintsUsed += 1
	self.events:emit("hint", { move = sol.moves[1] })
	return sol.moves[1]
end

-- play one hint move (bots, "auto-solve" button): -> ok
function Session:step(): boolean
	local m = self:hint()
	if m == nil then return false end
	return (self:apply(m))
end

-- stars: 0 until won. mechanic.stars(session) overrides; else level.stars = {3★ max moves, 2★ max moves}
-- (default {par, ceil(par·1.5)}) with opts.hintPenalty stars lost per hint (min 1).
function Session:stars(): number
	if not self.won then return 0 end
	local st
	if self.mech.stars then
		st = self.mech.stars(self)
	else
		local par = self.par or self.moves
		local t = self.level.stars or { par, math.ceil(par * 1.5) }
		st = if self.moves <= t[1] then 3 elseif self.moves <= t[2] then 2 else 1
	end
	if self.opts.hintPenalty and self.opts.hintPenalty > 0 then st -= self.hintsUsed * self.opts.hintPenalty end
	return math.clamp(st, 1, 3)
end

function Session:render() return self.mech.render(self.state, self) end
function Session:status(): string return self.mech.status and self.mech.status(self.state, self) or "" end

return M
