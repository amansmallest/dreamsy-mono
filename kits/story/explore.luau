--!nonstrict
-- Point-and-click rooms (data/story/rooms/<id>.json) and mystery boards (data/story/boards/<id>.json). Headless logic;
-- ui.luau draws them. Effects are story command strings ("give rope", "set cut_net", "aff mira 1", "clue footprints").
local Core = require("@kit/core")
local P = require("./parse")

local M = {}

local function lines(v): { string }
	if v == nil then return {} end
	if type(v) == "string" then return { v } end
	return table.clone(v)
end
M.lines = lines

local function runEffects(vm, list)
	for _, e in P.effects(list) do
		if e.op == "core" then Core.apply({ e.effect }) else vm:exec(e) end
	end
end
M.runEffects = runEffects

-- ---------- rooms ----------
local Room = {}
Room.__index = Room

function M.room(story, vm, id: string)
	local def = story.rooms[id]
	if def == nil then error("story: unknown room \"" .. tostring(id) .. "\"", 0) end
	return setmetatable({ story = story, vm = vm, id = id, def = def }, Room)
end

function Room:takenKey(h) return "taken_" .. self.id .. "_" .. h.id end

function Room:visible(h): boolean
	if h["if"] ~= nil and not Core.check(P.cond(h["if"])) then return false end
	if h.take and Core.flags.get(self:takenKey(h)) then return false end
	if Core.flags.get("removed_" .. self.id .. "_" .. h.id) then return false end
	return true
end

-- hotspots() -> visible hotspot defs (each { id, name, rect = {x, y, w, h}, sprite?, … })
function Room:hotspots(): { any }
	local out = {}
	for _, h in self.def.hotspots or {} do if self:visible(h) then table.insert(out, h) end end
	return out
end

function Room:get(hid: string)
	for _, h in self.def.hotspots or {} do if h.id == hid then return h end end
	return nil
end

-- tap(hotspotId, item?) -> { ok, lines, call?, jump?, took?, used?, hotspot }
-- No item: take → look/examine text (+effects, clue) → go/call. With item: use[item] or use["*"] or a "no" line.
function Room:tap(hid: string, item: string?): any
	local h = self:get(hid)
	if h == nil or not self:visible(h) then return { ok = false, lines = {} } end
	local vm = self.vm
	local res = { ok = true, lines = {}, hotspot = hid }
	Core.emit("hotspot_tapped", { room = self.id, hotspot = hid, item = item })
	if item ~= nil then
		local use = h.use and (h.use[item] or h.use["*"])
		if use == nil then
			res.ok = false
			res.lines = lines(self.story.cfg.cantUse or "That doesn't work.")
			return res
		end
		res.used = item
		res.lines = lines(use.text)
		if use.consume then local n = Core.bag:count(item) if n > 0 then Core.bag:remove(item, 1) end end
		runEffects(vm, use.effects)
		if use.remove then Core.flags.set("removed_" .. self.id .. "_" .. h.id, true) end
		res.call, res.jump = use.call, use.go
		Core.emit("item_used_on", { room = self.id, hotspot = hid, item = item })
		return res
	end
	local look = h.look or h.examine
	if type(look) == "string" and string.sub(look, 1, 1) == "@" then res.call = string.sub(look, 2) else res.lines = lines(look) end
	if h.take then
		Core.bag:add(h.take, h.count or 1)
		Core.flags.set(self:takenKey(h), true)
		res.took = h.take
		vm:fxPush("item", { item = h.take, count = h.count or 1 })
	end
	if h.clue then vm:addClue(h.clue) end
	runEffects(vm, h.effects)
	if h.call then res.call = h.call end
	if h.go then res.jump = h.go end
	return res
end

-- combine(a, b) -> { ok, lines, result? } using story.json "combine": [{ items = {a, b}, result, text?, effects?, keep? }]
function M.combine(story, vm, a: string, b: string): any
	for _, r in story.cfg.combine or {} do
		local x, y = r.items[1], r.items[2]
		if (x == a and y == b) or (x == b and y == a) then
			if not Core.bag:has(a) or not Core.bag:has(b) then return { ok = false, lines = {} } end
			if not r.keep then Core.bag:remove(a, 1) Core.bag:remove(b, 1) end
			if r.result then Core.bag:add(r.result, 1) vm:fxPush("item", { item = r.result, count = 1 }) end
			runEffects(vm, r.effects)
			Core.emit("items_combined", { a = a, b = b, result = r.result })
			return { ok = true, lines = lines(r.text), result = r.result }
		end
	end
	return { ok = false, lines = lines(story.cfg.cantCombine or "Those don't go together.") }
end

-- ---------- deduction boards ----------
-- { title, prompt?, clues? (ids offered; default every clue found), links = [{ id, clues = {a, b}, text, effects? }],
--   need? (link ids required; default all), question? { text, options = [{ text, correct? }] },
--   mistakes? (max wrong tries before `failed`), solved = "label", failed? = "label" }
local Board = {}
Board.__index = Board

function M.board(story, vm, id: string)
	local def = story.boards[id]
	if def == nil then error("story: unknown board \"" .. tostring(id) .. "\"", 0) end
	vm.boards[id] = vm.boards[id] or { found = {}, mistakes = 0 }
	return setmetatable({ story = story, vm = vm, id = id, def = def, st = vm.boards[id] }, Board)
end

function Board:clues(): { string }
	local out = {}
	if self.def.clues then
		for _, c in self.def.clues do if table.find(self.vm.clues, c) then table.insert(out, c) end end
	else
		out = table.clone(self.vm.clues)
	end
	return out
end

function Board:need(): { string }
	if self.def.need then return self.def.need end
	local out = {}
	for _, l in self.def.links do table.insert(out, l.id) end
	return out
end

function Board:found(): { any }
	local out = {}
	for _, l in self.def.links do if self.st.found[l.id] then table.insert(out, l) end end
	return out
end

function Board:ready(): boolean
	for _, id in self:need() do if not self.st.found[id] then return false end end
	return true
end

function Board:status(): string
	if self.st.solved then return "solved" end
	if self.st.failed then return "failed" end
	if self:ready() and self.def.question then return "question" end
	return "linking"
end

local function finish(self, res, ok)
	if ok then
		self.st.solved = true
		res.solved = true
		res.jump = self.def.solved
		Core.emit("board_solved", { board = self.id })
	else
		local max = self.def.mistakes
		if max and self.st.mistakes >= max then
			self.st.failed = true
			res.failed = true
			res.jump = self.def.failed
		end
	end
	return res
end

-- connect(a, b) -> { ok, link?, again?, mistakes, solved?, failed?, jump? }
function Board:connect(a: string, b: string): any
	if self.st.solved or self.st.failed then return { ok = false, mistakes = self.st.mistakes } end
	for _, l in self.def.links do
		local x, y = l.clues[1], l.clues[2]
		if (x == a and y == b) or (x == b and y == a) then
			local res = { ok = true, link = l, mistakes = self.st.mistakes }
			if self.st.found[l.id] then res.again = true return res end
			self.st.found[l.id] = true
			runEffects(self.vm, l.effects)
			Core.emit("conclusion_found", { board = self.id, conclusion = l.id })
			if self:ready() and not self.def.question then return finish(self, res, true) end
			return res
		end
	end
	self.st.mistakes += 1
	return finish(self, { ok = false, mistakes = self.st.mistakes }, false)
end

-- answer(i) -> { ok, solved?, failed?, jump? } (only once every needed link is found)
function Board:answer(i: number): any
	local q = self.def.question
	if q == nil or not self:ready() or self.st.solved then return { ok = false } end
	local o = q.options[i]
	if o == nil then return { ok = false } end
	if o.correct then return finish(self, { ok = true }, true) end
	self.st.mistakes += 1
	return finish(self, { ok = false, mistakes = self.st.mistakes }, false)
end

return M
