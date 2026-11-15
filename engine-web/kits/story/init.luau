--!nonstrict
-- story kit: visual novels, point-and-click adventures and mysteries. See KIT.md.
-- Content: data/story/*.story.txt (scripts), data/story/story.json (config: characters, backgrounds, cgs, endings, clues,
-- combine), data/story/characters/*.json, data/story/rooms/*.json, data/story/boards/*.json, data/story/clues/*.json,
-- items in data/items/*.json (core). Built on core (flags, bag, conditions, save, events, menus) + juice.
local Core = require("@kit/core")
local P = require("./parse")
local VM = require("./vm")
local X = require("./explore")
local Gallery = require("./gallery")

local Story = { VERSION = "0.1.0" }
Story.parse = P
Story.VM = VM

local st = nil -- the loaded story { prog, cfg, characters, rooms, boards, clues, gallery, commands, … }

local function hasData() return type(data) == "table" and type(data.list) == "function" end
local function idOf(path: string): string
	local base = string.match(path, "([^/]+)$") or path
	return (string.gsub(base, "%.story%.txt$", ""):gsub("%.json$", ""):gsub("%.txt$", ""))
end
local function readDir(dir: string, pattern: string): { [string]: any }
	local out = {}
	if not hasData() then return out end
	for _, p in data.list(dir) do
		local rel = string.sub(p, #dir + 2)
		if not string.find(rel, "/") and string.match(p, pattern) then out[idOf(p)] = data.read(p) end
	end
	return out
end
local function merge(into, from) for k, v in from or {} do into[k] = v end return into end

-- ---------- setup ----------
-- setup(opts?) -> Story. opts (all optional):
--   content = { config = {...}, scripts = { name = text } | {text…}, characters, rooms, boards, clues }  (tests; else data/story/**)
--   commands = { name = fn(vm, args, cmd) -> event? }   custom @commands
--   galleryKey = "story_gallery", start = "label", save = core save config passthrough
function Story.setup(opts)
	opts = opts or {}
	local c = opts.content or {}
	local cfg = c.config
	if cfg == nil and hasData() and data.exists("data/story/story.json") then cfg = data.read("data/story/story.json") end
	cfg = cfg or {}
	if opts.start then cfg.start = opts.start end
	local chars = merge(merge({}, cfg.characters), c.characters or readDir("data/story/characters", "%.json$"))
	local rooms = merge({}, c.rooms or readDir("data/story/rooms", "%.json$"))
	local boards = merge({}, c.boards or readDir("data/story/boards", "%.json$"))
	local clues = merge(merge({}, cfg.clues), c.clues or readDir("data/story/clues", "%.json$"))
	for id, r in rooms do r.id = r.id or id end
	-- scripts (sorted by name so 01_*.story.txt comes first)
	local scripts = {}
	if c.scripts then
		if type(c.scripts) == "string" then table.insert(scripts, { "main", c.scripts })
		elseif #c.scripts > 0 then for i, t in c.scripts do table.insert(scripts, { "script" .. i, t }) end
		else for k, t in c.scripts do table.insert(scripts, { k, t }) end end
	elseif hasData() then
		for _, p in data.list("data/story") do
			if string.match(p, "%.story%.txt$") then table.insert(scripts, { p, data.read(p) }) end
		end
	end
	table.sort(scripts, function(a, b) return a[1] < b[1] end)
	local prog = P.new()
	for _, s in scripts do P.parse(s[2], s[1], prog) end
	local problems = P.finish(prog)
	-- speaker lookup by id or display name (case-insensitive)
	local byName = {}
	for id, d in chars do
		byName[string.lower(id)] = id
		if d.name then byName[string.lower(d.name)] = id end
	end
	st = {
		prog = prog, cfg = cfg, characters = chars, rooms = rooms, boards = boards, clues = clues,
		gallery = Gallery.new(opts.galleryKey or cfg.galleryKey), commands = opts.commands or {}, problems = problems,
	}
	function st.char(id) return chars[id] end
	function st.clue(id) return clues[id] end
	function st.ending(id) return cfg.endings and cfg.endings[id] end
	function st.speaker(name)
		local id = byName[string.lower(name)]
		return id, id and chars[id]
	end
	st.autosave = function() Story.save("auto") end
	Story.vm = VM.new(st)
	Story.story = st
	if #problems > 0 then for _, p in problems do print("[story] " .. p) end end
	return Story
end

local function vm()
	if Story.vm == nil then error("story: call Story.setup() first", 0) end
	return Story.vm
end

-- ---------- conditions (core) ----------
Core.conditions.registerCondition("storyClue", function(c) return Story.vm ~= nil and table.find(Story.vm.clues, c.storyClue) ~= nil end)
Core.conditions.registerCondition("storyVisited", function(c) return Story.vm ~= nil and Story.vm.visited[c.storyVisited] == true end)
Core.conditions.registerCondition("storyEnding", function(c) return st ~= nil and st.gallery:hasEnding(c.storyEnding) end)
Core.conditions.registerCondition("storySolved", function(c)
	local b = Story.vm and Story.vm.boards[c.storySolved]
	return b ~= nil and b.solved == true
end)
Core.conditions.registerCondition("storyConclusion", function(c)
	if Story.vm == nil then return false end
	for _, b in Story.vm.boards do if b.found[c.storyConclusion] then return true end end
	return false
end)

-- save section: VM state (flags, bag, quests are saved by core)
Core.save.section("story", {
	serialize = function() return if Story.vm then Story.vm:serialize() else nil end,
	deserialize = function(_, t) if Story.vm then Story.vm:deserialize(t) end end,
	reset = function() if Story.vm then Story.vm:reset() end end,
})

-- ---------- flow ----------
function Story.start(label: string?)
	Core.newGame()
	vm():start(label)
	return Story.vm
end
function Story.step() return vm():step() end
function Story.choose(i: number) return vm():choose(i) end
function Story.event() return vm().event end
function Story.jump(label: string) vm():jump(label) end
function Story.backlog() return vm().backlog end
function Story.stage() return vm().stage end
function Story.clues(): { any }
	local out = {}
	for _, id in vm().clues do
		local d = st.clues[id] or {}
		table.insert(out, { id = id, name = d.name or id, text = d.text or "", icon = d.icon })
	end
	return out
end
function Story.affection(char: string): number return Core.flags.get("aff_" .. char, 0) end
function Story.chapters() return st.prog.chapters end
function Story.words(): number return P.wordCount(st.prog) end
function Story.problems() return st.problems end
function Story.command(name: string, fn) st.commands[name] = fn end

-- after a room/board result: perform its goto / call (returns to the room on @return)
local function follow(res)
	local v = vm()
	if res.jump then v:jump(res.jump)
	elseif res.call then v:call(res.call, v.cur) end
	return res
end

-- rooms
function Story.room(id: string?) return X.room(st, vm(), id or vm().room) end
function Story.tap(hotspot: string, item: string?) return follow(Story.room():tap(hotspot, item)) end
function Story.combine(a: string, b: string) return X.combine(st, vm(), a, b) end
-- boards
function Story.board(id: string?) return X.board(st, vm(), id or vm().board) end
function Story.connect(a: string, b: string) return follow(Story.board():connect(a, b)) end
function Story.answer(i: number) return follow(Story.board():answer(i)) end

-- ---------- save slots ----------
local SLOTS_KEY = "story_slots"
local function slotMeta() return (type(save) == "table" and save.get(SLOTS_KEY)) or {} end
function Story.save(slot: string?): boolean
	slot = slot or "1"
	local ok = Core.save.save("story_" .. slot)
	local v = vm()
	local meta = slotMeta()
	local line = v.event and v.event.kind == "say" and v.event.text or ""
	local chTitle = nil
	for _, ch in st.prog.chapters do if ch.id == v.chapter then chTitle = ch.title end end
	meta[slot] = { chapter = chTitle or v.chapter, text = string.sub(line, 1, 60), time = (type(time) == "function" and math.floor(time())) or 0 }
	if type(save) == "table" then save.set(SLOTS_KEY, meta) end
	return ok
end
function Story.load(slot: string?): boolean
	slot = slot or "1"
	return Core.save.load("story_" .. slot)
end
function Story.hasSave(slot: string?): boolean return Core.save.exists("story_" .. (slot or "1")) end
function Story.deleteSave(slot: string?)
	slot = slot or "1"
	Core.save.delete("story_" .. slot)
	local meta = slotMeta()
	meta[slot] = nil
	if type(save) == "table" then save.set(SLOTS_KEY, meta) end
end
-- slots(n) -> { {slot, exists, chapter?, text?} }
function Story.slots(n: number?)
	local meta = slotMeta()
	local out = {}
	for i = 1, n or 3 do
		local s = tostring(i)
		local m = meta[s] or {}
		table.insert(out, { slot = s, exists = Story.hasSave(s), chapter = m.chapter, text = m.text })
	end
	return out
end

-- ---------- gallery ----------
function Story.gallery() return st.gallery end
function Story.endings() return st.gallery:list(st.cfg.endings or {}, "endings") end
function Story.cgs() return st.gallery:list(st.cfg.cgs or {}, "cgs") end

-- ---------- asset helpers ----------
local function asset(id: string?, map, prefix: string): string?
	if id == nil then return nil end
	if string.sub(id, 1, 6) == "asset:" or string.sub(id, 1, 1) == "#" then return id end
	local m = map and map[id]
	if type(m) == "table" then m = m.image end
	if m then return m end
	return "asset:" .. prefix .. id
end
function Story.bgImage(id: string?) return asset(id, st.cfg.backgrounds, "bg_") end
function Story.cgImage(id: string?) return asset(id, st.cfg.cgs, "cg_") end
function Story.charImage(id: string, expr: string?): string?
	local d = st.characters[id]
	local e = d and d.expressions
	if e and expr and e[expr] then return e[expr] end
	if e and d.default and e[d.default] then return e[d.default] end
	if e then for _, v in e do return v end end
	return "asset:" .. id .. "_" .. (expr or "neutral")
end

-- validate() -> problems: unknown labels, rooms/boards/combine pointing at missing labels/items/clues
function Story.validate(): { string }
	local out = table.clone(st.problems)
	local labels = st.prog.labels
	local function lab(l, where) if l and not labels[l] then table.insert(out, where .. ": unknown label \"" .. l .. "\"") end end
	for id, r in st.rooms do
		for _, h in r.hotspots or {} do
			local w = "rooms/" .. id .. "/" .. tostring(h.id)
			if type(h.look) == "string" and string.sub(h.look, 1, 1) == "@" then lab(string.sub(h.look, 2), w) end
			lab(h.go, w) lab(h.call, w)
			if h.clue and not st.clues[h.clue] then table.insert(out, w .. ": unknown clue \"" .. h.clue .. "\"") end
			for item, u in h.use or {} do lab(u.go, w .. "/use/" .. item) lab(u.call, w .. "/use/" .. item) end
		end
	end
	for id, b in st.boards do
		lab(b.solved, "boards/" .. id) lab(b.failed, "boards/" .. id)
		for _, l in b.links or {} do for _, c in l.clues do if not st.clues[c] then table.insert(out, "boards/" .. id .. ": unknown clue \"" .. c .. "\"") end end end
	end
	for _, op in st.prog.ops do
		if op.op == "cmd" then
			if op.name == "explore" and not st.rooms[op.args[1]] then table.insert(out, op.file .. ":" .. op.line .. ": unknown room \"" .. tostring(op.args[1]) .. "\"") end
			if op.name == "deduce" and not st.boards[op.args[1]] then table.insert(out, op.file .. ":" .. op.line .. ": unknown board \"" .. tostring(op.args[1]) .. "\"") end
			if op.name == "clue" and not st.clues[op.args[1]] then table.insert(out, op.file .. ":" .. op.line .. ": unknown clue \"" .. tostring(op.args[1]) .. "\"") end
			if op.name == "end" and st.cfg.endings and not st.cfg.endings[op.args[1] or ""] then table.insert(out, op.file .. ":" .. op.line .. ": ending \"" .. tostring(op.args[1]) .. "\" not in story.json endings") end
		end
	end
	return out
end

-- ---------- UI ----------
-- play(opts) — portrait reading UI driving the VM (see ui.luau). Call from the scene script.
function Story.play(opts)
	local UI = require("./ui")
	return UI.play(Story, opts)
end

-- headless auto-play: picks choices with pickFn(options, vm) -> index (default first unlocked); rooms/boards via
-- opts.room(Story, roomId) / opts.board(Story, boardId) callbacks. Returns { ending?, steps, lines, log }.
function Story.autoplay(opts)
	opts = opts or {}
	local v = vm()
	local steps, lines = 0, 0
	local log = {}
	while steps < (opts.maxSteps or 5000) do
		steps += 1
		local ev = v:step()
		if ev.kind == "say" then lines += 1
		elseif ev.kind == "choice" then
			local i = if opts.pick then opts.pick(ev.options, v) else nil
			if i == nil then for k, o in ev.options do if not o.locked then i = k break end end end
			table.insert(log, "choice:" .. ev.options[i].text)
			v:choose(i)
		elseif ev.kind == "explore" then
			table.insert(log, "explore:" .. ev.room)
			if not opts.room then return { stuck = "room " .. ev.room, steps = steps, lines = lines, log = log } end
			opts.room(Story, ev.room)
		elseif ev.kind == "deduce" then
			table.insert(log, "deduce:" .. ev.board)
			if not opts.board then return { stuck = "board " .. ev.board, steps = steps, lines = lines, log = log } end
			opts.board(Story, ev.board)
		elseif ev.kind == "end" then
			return { ending = ev.ending.id, steps = steps, lines = lines, log = log }
		elseif ev.kind == "done" then
			return { done = true, steps = steps, lines = lines, log = log }
		end
	end
	return { stuck = "maxSteps", steps = steps, lines = lines, log = log }
end

return Story
