--!nonstrict
-- Story VM: runs a parsed program headlessly. vm:step() executes commands until something must be shown and returns
-- an event; the UI (ui.luau) or a test renders it and calls step()/choose() again. All state is plain data (saveable).
local Core = require("@kit/core")
local P = require("./parse")

local VM = {}
VM.__index = VM

VM.POSITIONS = { farleft = 100, left = 190, midleft = 270, center = 360, midright = 450, right = 530, farright = 620 }
local BACKLOG_MAX = 120

function VM.new(story)
	local self = setmetatable({}, VM)
	self.story = story -- { prog, cfg, gallery, commands, char(id) }
	self:reset()
	return self
end

function VM:reset()
	self.pc = 1
	self.cur = nil
	self.stack = {}
	self.visited = {}
	self.backlog = {}
	self.stage = { bg = nil, chars = {}, cg = nil, music = nil, order = 0 }
	self.charExpr = {}
	self.chapter = nil
	self.room = nil
	self.board = nil
	self.ended = nil
	self.clues = {}
	self.once = {}
	self.boards = {}
	self.fx = {}
	self.event = nil
	self.started = false
end

local function prog(self) return self.story.prog end

function VM:fail(msg, op)
	local where = if op and op.file then op.file .. ":" .. tostring(op.line) .. ": " else ""
	error("story: " .. where .. msg, 0)
end

function VM:labelIndex(label: string, op): number
	local i = prog(self).labels[label]
	if i == nil then self:fail("unknown label \"" .. tostring(label) .. "\"", op) end
	return i
end

-- chapter that contains op idx (last @chapter at or before it)
function VM:chapterAt(idx: number)
	local found = nil
	for _, ch in prog(self).chapters do if ch.at <= idx then found = ch end end
	return found
end

function VM:syncChapter()
	local ch = self:chapterAt(self.pc)
	if ch and ch.id ~= self.chapter then
		self.chapter = ch.id
		self.story.gallery:seeChapter(ch.id)
	end
end

function VM:start(label: string?)
	self:reset()
	self.started = true
	local p = prog(self)
	local l = label or self.story.cfg.start or p.labelList[1]
	self.pc = if l then self:labelIndex(l) else 1
	self:syncChapter()
	return self
end

function VM:jump(label: string)
	self.room, self.board = nil, nil
	self.pc = self:labelIndex(label)
	self.ended = nil
	self:syncChapter()
end

-- call(label, returnIdx?): subroutine; @return resumes at returnIdx (default: the current display op, e.g. the room)
function VM:call(label: string, ret: number?)
	table.insert(self.stack, ret or self.cur or self.pc)
	self.pc = self:labelIndex(label)
end

function VM:fxPush(kind, data)
	data = data or {}
	data.kind = kind
	table.insert(self.fx, data)
	if self.story.onFx then self.story.onFx(data) end
end
function VM:drainFx()
	local f = self.fx
	self.fx = {}
	return f
end

-- ---------- text ----------
function VM:interpolate(text: string): string
	return (string.gsub(text, "{%$([%w_:%.]+)}", function(k)
		local item = string.match(k, "^item:(.+)$")
		if item then return tostring(Core.bag:count(item)) end
		local v = Core.flags.get(k)
		if v == nil then return "" end
		if type(v) == "number" and v == math.floor(v) then return tostring(math.floor(v)) end
		return tostring(v)
	end))
end

function VM:addLog(speaker, text, kind)
	table.insert(self.backlog, { speaker = speaker, text = text, kind = kind })
	while #self.backlog > BACKLOG_MAX do table.remove(self.backlog, 1) end
end

-- ---------- commands ----------
local function num(s, d) return tonumber(s) or d end

function VM:affection(char: string, delta: number)
	local c = self.story.char(char)
	local key = "aff_" .. char
	local v = (Core.flags.get(key, 0) or 0) + delta
	local lo, hi = -100, 100
	if c and c.affection and type(c.affection) == "table" then lo, hi = c.affection.min or lo, c.affection.max or hi end
	v = math.clamp(v, lo, hi)
	Core.flags.set(key, v)
	Core.emit("affection_changed", { character = char, value = v, delta = delta })
	if delta ~= 0 then self:fxPush("affection", { character = char, delta = delta, value = v }) end
	return v
end

function VM:addClue(id: string)
	if table.find(self.clues, id) then return false end
	table.insert(self.clues, id)
	local def = self.story.clue(id)
	Core.emit("clue_found", { clue = id })
	self:fxPush("clue", { clue = id, name = def and def.name or id })
	return true
end

function VM:showChar(id: string, expr: string?, pos: string?)
	local st = self.stage
	local cur = st.chars[id]
	st.order += 1
	local def = self.story.char(id)
	expr = expr or (cur and cur.expr) or self.charExpr[id] or (def and def.default) or "neutral"
	pos = pos or (cur and cur.pos) or (def and def.position) or "center"
	st.chars[id] = { expr = expr, pos = pos, order = if cur then cur.order else st.order }
	self.charExpr[id] = expr
end

function VM:exec(c, idx: number?): any
	local a = c.args
	local n = c.name
	local custom = self.story.commands[n]
	if custom then return custom(self, a, c) end
	if n == "set" then
		local k = a[1] or self:fail("@set needs a flag", c)
		local v: any = true
		if a[2] == "=" then v = a[3] elseif a[2] ~= nil then v = a[2] end
		if type(v) == "string" then v = if tonumber(v) then tonumber(v) elseif v == "true" then true elseif v == "false" then false else v end
		Core.flags.set(k, v)
	elseif n == "unset" then Core.flags.set(a[1], nil)
	elseif n == "add" then Core.flags.add(a[1], num(a[2], 1))
	elseif n == "sub" then Core.flags.add(a[1], -num(a[2], 1))
	elseif n == "aff" then self:affection(a[1] or self:fail("@aff needs a character", c), num(a[2], 1))
	elseif n == "give" then Core.bag:add(a[1], num(a[2], 1)) self:fxPush("item", { item = a[1], count = num(a[2], 1) })
	elseif n == "take" then local cnt = math.min(num(a[2], 1), Core.bag:count(a[1])) if cnt > 0 then Core.bag:remove(a[1], cnt) end
	elseif n == "earn" then Core.wallet.add(a[1], num(a[2], 1))
	elseif n == "spend" then Core.wallet.spend(a[1], num(a[2], 1))
	elseif n == "quest" then Core.apply({ { quest = a[1], action = a[2] or "start" } })
	elseif n == "goto" then self:jump(a[1])
	elseif n == "call" then self:call(a[1], self.pc)
	elseif n == "return" or n == "back" then
		local r = table.remove(self.stack)
		if r == nil then self.pc = #prog(self).ops + 1 else self.pc = r end
	elseif n == "bg" then
		self.stage.bg = a[1]
		self.stage.cg = nil
		self:fxPush("bg", { bg = a[1], transition = a[2] or "fade" })
	elseif n == "show" then
		local id = a[1] or self:fail("@show needs a character", c)
		local expr, pos = nil, nil
		for i = 2, #a do if VM.POSITIONS[a[i]] then pos = a[i] else expr = a[i] end end
		self:showChar(id, expr, pos)
	elseif n == "hide" then
		if a[1] == nil or a[1] == "all" then self.stage.chars = {} else self.stage.chars[a[1]] = nil end
	elseif n == "cg" then
		self.stage.cg = a[1]
		self.story.gallery:seeCg(a[1])
		self:fxPush("cg", { cg = a[1] })
	elseif n == "hidecg" then self.stage.cg = nil
	elseif n == "music" then
		self.stage.music = if a[1] == "stop" or a[1] == nil then nil else a[1]
		self:fxPush("music", { music = self.stage.music })
	elseif n == "sfx" then self:fxPush("sfx", { sfx = a[1] })
	elseif n == "shake" then self:fxPush("shake", { amount = a[1] or "light" })
	elseif n == "flash" then self:fxPush("flash", { color = a[1] or "#ffffff" })
	elseif n == "clue" then self:addClue(a[1])
	elseif n == "emit" then Core.emit(a[1], { story = true })
	elseif n == "unlock" then Core.achievements.unlock(a[1])
	elseif n == "autosave" then if self.story.autosave then self.story.autosave() end
	elseif n == "toast" then self:fxPush("toast", { text = c.raw })
	elseif n == "note" or n == "title" then -- metadata, ignored at runtime
	elseif n == "wait" then return { kind = "wait", seconds = num(a[1], 0.5) }
	elseif n == "explore" then
		self.room = a[1] or self:fail("@explore needs a room", c)
		self.pc = idx or self.pc -- stay on this op: @return from a hotspot script comes back here
		return { kind = "explore", room = self.room }
	elseif n == "deduce" then
		self.board = a[1] or self:fail("@deduce needs a board", c)
		self.pc = idx or self.pc
		return { kind = "deduce", board = self.board }
	elseif n == "end" then
		local id = a[1] or "end"
		local def = self.story.ending(id)
		local title = a[2] or (def and def.title) or id
		self.ended = { id = id, title = title, text = def and def.text }
		self.story.gallery:seeEnding(id)
		Core.emit("story_ended", { ending = id })
		self.pc = #prog(self).ops + 1
		return { kind = "end", ending = self.ended }
	else
		self:fail("unknown command @" .. n .. " (set unset add sub aff give take earn spend quest goto call return bg show hide cg hidecg music sfx shake flash wait clue explore deduce end emit unlock autosave toast note)", c)
	end
	return nil
end

-- ---------- choices ----------
function VM:options(op): { any }
	local out = {}
	for i, o in op.options do
		if o.once and self.once[o.id] then continue end
		if o.cond ~= nil and not Core.check(o.cond) then continue end
		local locked = o.req ~= nil and not Core.check(o.req)
		table.insert(out, { index = i, text = self:interpolate(o.text), locked = locked, hint = o.hint })
	end
	return out
end

function VM:choose(i: number): boolean
	local ev = self.event
	if ev == nil or ev.kind ~= "choice" then return false end
	local shown = ev.options[i]
	if shown == nil or shown.locked then return false end
	local op = prog(self).ops[self.cur]
	local o = op.options[shown.index]
	if o.once then self.once[o.id] = true end
	self:addLog(nil, shown.text, "choice")
	Core.emit("story_choice", { text = shown.text, target = o.target })
	self.pc = self.cur + 1
	self.event = nil
	for _, e in o.effects do self:exec(e) end
	if o.target then self:jump(o.target) end
	return true
end

-- ---------- step ----------
-- returns { kind = "say", speaker?, char?, expr?, text, color? } | { kind = "choice", options }
--       | { kind = "wait", seconds } | { kind = "explore", room } | { kind = "deduce", board } | { kind = "end", ending } | { kind = "done" }
function VM:step(): any
	local p = prog(self)
	local ops = p.ops
	local guard = 0
	self.event = nil
	while true do
		guard += 1
		if guard > 20000 then self:fail("step ran 20000 ops without showing anything (infinite @goto loop?)", ops[self.pc]) end
		local idx = self.pc
		local op = ops[idx]
		if op == nil then
			if #self.stack > 0 then self.pc = table.remove(self.stack) continue end
			self.cur = nil
			self.event = { kind = "done" }
			return self.event
		end
		self.pc = idx + 1
		local kind = op.op
		if kind == "label" then
			self.visited[op.name] = true
		elseif kind == "chapter" then
			self.chapter = op.id
			self.story.gallery:seeChapter(op.id)
			Core.emit("chapter_started", { chapter = op.id })
			self:fxPush("chapter", { id = op.id, title = op.title, index = op.index })
		elseif kind == "jump" then
			self.pc = op.target
		elseif kind == "if" then
			if not Core.check(op.cond) then self.pc = op.target end
		elseif kind == "say" then
			self.cur = idx
			local ev = { kind = "say", text = self:interpolate(op.text) }
			if op.speaker then
				local id, def = self.story.speaker(op.speaker)
				ev.char = id
				ev.speaker = if def then def.name or op.speaker else op.speaker
				ev.color = def and def.color
				if id and op.expr then
					self.charExpr[id] = op.expr
					if self.stage.chars[id] then self.stage.chars[id].expr = op.expr end
				end
				ev.expr = id and (self.charExpr[id])
			end
			if self.resuming then self.resuming = nil else self:addLog(ev.speaker, ev.text, "say") end
			self.event = ev
			return ev
		elseif kind == "choice" then
			local opts = self:options(op)
			if #opts > 0 then
				self.cur = idx
				self.resuming = nil
				self.event = { kind = "choice", options = opts }
				return self.event
			end
		elseif kind == "cmd" then
			local ev = self:exec(op, idx)
			if ev then
				self.cur = idx
				if ev.kind == "explore" or ev.kind == "deduce" then self.pc = idx end
				self.resuming = nil
				self.event = ev
				return ev
			end
		else
			self:fail("bad op " .. tostring(kind), op)
		end
	end
end

-- ---------- save ----------
function VM:serialize()
	local p = prog(self)
	local stack = {}
	for _, r in self.stack do table.insert(stack, P.toPos(p, r)) end
	local at = self.cur or self.pc
	if self.event and self.event.kind == "end" then at = self.pc end
	return {
		pos = P.toPos(p, at), stack = stack, visited = self.visited, backlog = self.backlog,
		stage = self.stage, charExpr = self.charExpr, chapter = self.chapter, clues = self.clues,
		once = self.once, boards = self.boards, ended = self.ended, started = self.started,
		say = self.event ~= nil and self.event.kind == "say",
	}
end

function VM:deserialize(t)
	self:reset()
	if t == nil then return end
	local p = prog(self)
	self.pc = P.fromPos(p, t.pos) or 1
	for _, r in t.stack or {} do table.insert(self.stack, P.fromPos(p, r) or 1) end
	self.visited = t.visited or {}
	self.backlog = t.backlog or {}
	self.stage = t.stage or self.stage
	self.stage.chars = self.stage.chars or {}
	self.stage.order = self.stage.order or 0
	self.charExpr = t.charExpr or {}
	self.chapter = t.chapter
	self.clues = t.clues or {}
	self.once = t.once or {}
	self.boards = t.boards or {}
	self.ended = t.ended
	self.started = t.started or false
	self.resuming = t.say -- the current line is already in the backlog
end

return VM
