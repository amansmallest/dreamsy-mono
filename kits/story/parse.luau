--!nonstrict
-- Story script parser: `.story.txt` text → program { ops, labels, chapters, files }, and story expressions → core conditions.
-- Format (one statement per line; leading whitespace ignored; see KIT.md "Script format"):
--   # comment | // comment
--   @label name                      jump target (labels are global across files)
--   @chapter id "Title"              chapter marker
--   Name: text | Name (expr): text   dialog line (expr = expression change of a shown character)
--   > text  | any other line          narration
--   * Choice text -> label {if cond} {req cond} {once} {set x} {give y}
--   @if cond / @elseif cond / @else / @endif
--   @<command> args                   set/unset/add/aff/give/take/goto/call/return/end/bg/show/hide/cg/hidecg/
--                                     music/sfx/shake/flash/wait/clue/explore/deduce/emit/unlock/core/autosave/note
local P = {}

local function trim(s: string): string return (string.gsub(s, "^%s+", ""):gsub("%s+$", "")) end
P.trim = trim

-- split "a b \"c d\" e" into words, keeping quoted strings together (quotes stripped)
function P.words(s: string): { string }
	local out = {}
	local i, n = 1, #s
	while i <= n do
		local c = string.sub(s, i, i)
		if c == " " or c == "\t" then
			i += 1
		elseif c == '"' then
			local j = string.find(s, '"', i + 1, true) or (n + 1)
			table.insert(out, string.sub(s, i + 1, j - 1))
			i = j + 1
		else
			local j = string.find(s, "[ \t]", i) or (n + 1)
			table.insert(out, string.sub(s, i, j - 1))
			i = j
		end
	end
	return out
end

-- ---------- expressions → core conditions ----------
-- or / and / not / ( ), atoms:
--   flag                    {flag}            flag OP value   {flag, eq|ne|gt|gte|lt|lte}
--   has item [n]            {item, count}     aff char OP n   {flag = "aff_char", …}
--   clue id                 {storyClue}       visited label   {storyVisited}
--   ending id               {storyEnding}     (seen in any playthrough — gallery)
--   solved board            {storySolved}     found conclusion {storyConclusion}
--   chance 0.3              {chance}          gold >= 5 → {flag="gold"} (use @core for currencies)
local OPS = { [">="] = "gte", ["<="] = "lte", [">"] = "gt", ["<"] = "lt", ["=="] = "eq", ["="] = "eq", ["!="] = "ne", ["~="] = "ne" }

local function tokenize(s: string): { string }
	local toks = {}
	local i, n = 1, #s
	while i <= n do
		local c = string.sub(s, i, i)
		if string.match(c, "%s") then
			i += 1
		elseif c == "(" or c == ")" then
			table.insert(toks, c) i += 1
		elseif string.match(c, "[<>=!~]") then
			local two = string.sub(s, i, i + 1)
			if OPS[two] then table.insert(toks, two) i += 2 else table.insert(toks, c) i += 1 end
		elseif c == '"' then
			local j = string.find(s, '"', i + 1, true) or (n + 1)
			table.insert(toks, '"' .. string.sub(s, i + 1, j - 1)) -- leading quote marks a string literal
			i = j + 1
		else
			local j = string.find(s, "[%s()<>=!~]", i) or (n + 1)
			table.insert(toks, string.sub(s, i, j - 1))
			i = j
		end
	end
	return toks
end

local function literal(tok: string): any
	if string.sub(tok, 1, 1) == '"' then return string.sub(tok, 2) end
	if tok == "true" then return true end
	if tok == "false" then return false end
	local n = tonumber(tok)
	if n ~= nil then return n end
	return tok
end

function P.expr(src: string): any
	if src == nil then return nil end
	local toks = tokenize(src)
	local pos = 1
	local function peek() return toks[pos] end
	local function take() local t = toks[pos] pos += 1 return t end
	local function fail(msg) error("story condition \"" .. src .. "\": " .. msg, 0) end
	local parseOr
	local function cmpTail(cond, key)
		local op = peek()
		if op and OPS[op] then
			take()
			local v = take()
			if v == nil then fail("missing value after " .. op) end
			cond[OPS[op]] = literal(v)
		end
		return cond
	end
	local function atom()
		local t = take()
		if t == nil then fail("unexpected end") end
		if t == "(" then
			local e = parseOr()
			if take() ~= ")" then fail("missing )") end
			return e
		end
		if t == "not" then return { ["not"] = atom() } end
		local nx = peek()
		local word = nx ~= nil and nx ~= ")" and not OPS[nx] and nx ~= "and" and nx ~= "or"
		if t == "has" and word then
			local item = take()
			local c = { item = item }
			local cnt = peek()
			if cnt and tonumber(cnt) then take() c.count = tonumber(cnt) end
			return c
		elseif t == "aff" and word then
			return cmpTail({ flag = "aff_" .. take() }, nil)
		elseif t == "clue" and word then return { storyClue = take() }
		elseif t == "visited" and word then return { storyVisited = take() }
		elseif t == "ending" and word then return { storyEnding = take() }
		elseif t == "solved" and word then return { storySolved = take() }
		elseif t == "found" and word then return { storyConclusion = take() }
		elseif t == "chance" and word then return { chance = tonumber(take()) or 0 }
		end
		return cmpTail({ flag = t }, t)
	end
	local function parseAnd()
		local parts = { atom() }
		while peek() == "and" do take() table.insert(parts, atom()) end
		return if #parts == 1 then parts[1] else { all = parts }
	end
	parseOr = function()
		local parts = { parseAnd() }
		while peek() == "or" do take() table.insert(parts, parseAnd()) end
		return if #parts == 1 then parts[1] else { any = parts }
	end
	local e = parseOr()
	if pos <= #toks then fail("unexpected \"" .. tostring(toks[pos]) .. "\"") end
	return e
end

-- condition: string (story expression) | core condition table | nil
function P.cond(c: any): any
	if type(c) == "string" then return P.expr(c) end
	return c
end

-- ---------- commands ----------
-- "set trust = 3" / "add trust 1" → { name = "set", args = {"trust", "=", "3"}, raw = "trust = 3" }
function P.command(src: string, file: string?, line: number?): any
	src = trim(src)
	local name, rest = string.match(src, "^([%a_][%w_]*)%s*(.*)$")
	if not name then error((file or "story") .. ":" .. tostring(line or 0) .. ": bad command \"" .. src .. "\"", 0) end
	return { op = "cmd", name = string.lower(name), args = P.words(rest), raw = rest, file = file, line = line }
end

-- effect strings in JSON (rooms, boards, combine) use the same command syntax: "give rope", "set cut_net"
function P.effects(list: any): { any }
	local out = {}
	if list == nil then return out end
	if type(list) == "string" then list = { list } end
	for _, e in list do
		if type(e) == "string" then table.insert(out, P.command(e)) else table.insert(out, { op = "core", effect = e }) end
	end
	return out
end

-- ---------- choices ----------
local function parseChoice(body: string, file, line)
	local opt = { text = "", effects = {}, file = file, line = line }
	-- pull {…} groups
	local rest = string.gsub(body, "%b{}", function(g)
		local inner = trim(string.sub(g, 2, -2))
		local kw, arg = string.match(inner, "^(%a+)%s*(.*)$")
		kw = kw and string.lower(kw)
		if kw == "if" then opt.cond = P.expr(arg)
		elseif kw == "req" then opt.req = P.expr(arg)
		elseif kw == "once" then opt.once = true
		elseif kw == "hint" then opt.hint = arg
		else table.insert(opt.effects, P.command(inner, file, line)) end
		return ""
	end)
	local text, target = string.match(rest, "^(.-)%s*%->%s*([%w_%.]+)%s*$")
	if text then opt.text, opt.target = trim(text), target else opt.text = trim(rest) end
	opt.id = (file or "") .. ":" .. tostring(line)
	return opt
end

-- ---------- lines ----------
local SPEAKER_BAD = "[%.!%?,;\"]"
local function dialogLine(s: string)
	local who, expr, text = string.match(s, "^([^:%(]-)%s*%(([%w_]+)%)%s*:%s*(.*)$")
	if not who then who, text = string.match(s, "^([^:]-)%s*:%s+(.*)$") end
	if not who then who, text = string.match(s, "^([^:]-)%s*:%s*$"), "" end
	if who == nil or who == "" or #who > 24 or string.find(who, SPEAKER_BAD) then return nil end
	if not string.match(who, "^[%u%d]") and not string.match(who, "^[%w_]+$") then return nil end
	return trim(who), expr, text
end

-- parse(text, file?, prog?) → appends to prog (or a new one). Call P.finish(prog) after all files.
function P.new() return { ops = {}, labels = {}, labelList = {}, chapters = {}, files = {}, opLabel = {} } end

function P.parse(text: string, file: string?, prog: any?): any
	prog = prog or P.new()
	file = file or "story"
	table.insert(prog.files, file)
	local ops = prog.ops
	local ifStack = {} -- { {condIdx, exits = {jumpIdx…}} }
	local lastChoice = nil
	local ln = 0
	local function err(msg) error(file .. ":" .. ln .. ": " .. msg, 0) end
	local function push(op)
		op.file, op.line = op.file or file, op.line or ln
		table.insert(ops, op)
		return #ops
	end
	text = string.gsub(text, "\r\n?", "\n")
	for raw in string.gmatch(text .. "\n", "([^\n]*)\n") do
		ln += 1
		local s = trim(raw)
		local isChoice = string.sub(s, 1, 1) == "*"
		if s == "" or string.sub(s, 1, 1) == "#" or string.sub(s, 1, 2) == "//" then
			continue -- blank / comment (does not break a choice block)
		end
		if not isChoice then lastChoice = nil end
		if isChoice then
			local opt = parseChoice(trim(string.sub(s, 2)), file, ln)
			if lastChoice == nil then
				lastChoice = { op = "choice", options = {} }
				push(lastChoice)
			end
			table.insert(lastChoice.options, opt)
		elseif string.sub(s, 1, 1) == "@" then
			local c = P.command(string.sub(s, 2), file, ln)
			local n = c.name
			if n == "label" then
				local name = c.args[1] or err("@label needs a name")
				if prog.labels[name] then err("duplicate label \"" .. name .. "\"") end
				prog.labels[name] = #ops + 1
				table.insert(prog.labelList, name)
				push({ op = "label", name = name })
			elseif n == "chapter" then
				local id = c.args[1] or err("@chapter needs an id")
				local ch = { id = id, title = c.args[2] or id, index = #prog.chapters + 1, at = #ops + 1 }
				table.insert(prog.chapters, ch)
				push({ op = "chapter", id = id, title = ch.title, index = ch.index })
			elseif n == "if" then
				local idx = push({ op = "if", cond = P.expr(c.raw) })
				table.insert(ifStack, { cond = idx, exits = {} })
			elseif n == "elseif" or n == "else" then
				local top = ifStack[#ifStack] or err("@" .. n .. " without @if")
				if top.closed then err("@" .. n .. " after @else") end
				table.insert(top.exits, push({ op = "jump" }))
				ops[top.cond].target = #ops + 1
				if n == "elseif" then top.cond = push({ op = "if", cond = P.expr(c.raw) })
				else top.cond = nil top.closed = true end
			elseif n == "endif" or n == "end_if" then
				local top = table.remove(ifStack) or err("@endif without @if")
				if top.cond then ops[top.cond].target = #ops + 1 end
				for _, j in top.exits do ops[j].target = #ops + 1 end
			else
				push(c)
			end
		else
			local narr = string.sub(s, 1, 1) == ">"
			if narr then
				push({ op = "say", text = trim(string.sub(s, 2)) })
			else
				local who, expr, body = dialogLine(s)
				if who then push({ op = "say", speaker = who, expr = expr, text = body })
				else push({ op = "say", text = s }) end
			end
		end
	end
	if #ifStack > 0 then ln = ops[ifStack[#ifStack].cond or 1].line or ln err("@if without @endif") end
	return prog
end

-- finish(prog): resolve label of every op (for save positions), check jump targets. Returns problems list.
function P.finish(prog: any): { string }
	local cur = nil
	for i, op in prog.ops do
		if op.op == "label" then cur = op.name end
		prog.opLabel[i] = cur
	end
	local problems = {}
	local function chk(label, op)
		if label and not prog.labels[label] then
			table.insert(problems, (op.file or "?") .. ":" .. tostring(op.line) .. ": unknown label \"" .. label .. "\"")
		end
	end
	for _, op in prog.ops do
		if op.op == "cmd" and (op.name == "goto" or op.name == "call") then chk(op.args[1], op) end
		if op.op == "choice" then
			for _, o in op.options do
				chk(o.target, o)
				for _, e in o.effects do if e.name == "goto" or e.name == "call" then chk(e.args[1], o) end end
			end
		end
	end
	return problems
end

-- position helpers: index ↔ { label, off } (stable across small edits to other labels)
function P.toPos(prog, idx: number): any
	local l = prog.opLabel[idx]
	if l == nil then return { label = nil, off = idx } end
	return { label = l, off = idx - prog.labels[l] }
end
function P.fromPos(prog, pos: any): number?
	if pos == nil then return nil end
	if pos.label == nil then return pos.off end
	local base = prog.labels[pos.label]
	if base == nil then return nil end
	return base + pos.off
end

-- word count of the say ops (content budgeting)
function P.wordCount(prog): number
	local n = 0
	for _, op in prog.ops do
		if op.op == "say" then for _ in string.gmatch(op.text or "", "%S+") do n += 1 end end
		if op.op == "choice" then for _, o in op.options do for _ in string.gmatch(o.text, "%S+") do n += 1 end end end
	end
	return n
end

return P
