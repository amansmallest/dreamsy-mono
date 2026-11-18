--!nonstrict
-- Dialog trees (content kind "dialog", data/dialog/*.json).
-- { id, start = "node", speaker?, portrait?, nodes = {
--     <node> = { speaker?, portrait?, text? | lines? (strings or {text, speaker?, portrait?}),
--               effects?, next?, choices? = { { text, next?, condition?, effects?, showLocked? } },
--               branches? = { { condition?, next } } (auto-jump: first passing; no text) } } }
-- Text may use {flag:key} {item:id} {currency:id} {var:key} (ctx.vars).
-- A node without next/choices ends the dialog. "seen" condition: { seen = "tree" } or { seen = "tree/node" }.
local S = require("./shared")
local Content = require("./content")
local M = {}
local seenSet: { [string]: boolean } = {}

function M.seen(key: string): boolean return seenSet[key] == true end

local function interp(text, ctx)
	if type(text) ~= "string" then return text end
	return (string.gsub(text, "{(%a+):([%w_%.]+)}", function(kind, key)
		if kind == "flag" then return tostring(S.flags.get(key, ""))
		elseif kind == "item" then return tostring(S.bag:count(key))
		elseif kind == "currency" then return tostring(S.wallet.get(key))
		elseif kind == "var" then return tostring(ctx and ctx.vars and ctx.vars[key] or "") end
		return nil
	end))
end

local Cursor = {}
Cursor.__index = Cursor

-- open(treeId, ctx?) -> cursor (pure state machine; play() renders it)
--   cursor.done, cursor.nodeId, cursor:view() -> { speaker, portrait, lines = {{text,speaker,portrait}}, choices = {{text, locked, index}} }
--   cursor:advance() (no choices) / cursor:choose(i) (i = index into view().choices)
function M.open(treeId: string, ctx: any?)
	local tree = Content.require("dialog", treeId)
	if type(tree.nodes) ~= "table" then error("dialog \"" .. treeId .. "\" has no nodes", 2) end
	local c = setmetatable({ tree = tree, ctx = ctx or {}, done = false, nodeId = nil, path = {} }, Cursor)
	seenSet[treeId] = true
	c:_enter(tree.start or "start")
	return c
end

function Cursor:_enter(id)
	local guard = 0
	while true do
		guard += 1
		if guard > 64 then error("dialog \"" .. self.tree.id .. "\": branch loop at \"" .. tostring(id) .. "\"", 3) end
		if id == nil or id == "end" then self.done = true self.nodeId = nil return end
		local n = self.tree.nodes[id]
		if not n then error("dialog \"" .. self.tree.id .. "\": no node \"" .. tostring(id) .. "\"", 3) end
		self.nodeId = id
		seenSet[self.tree.id .. "/" .. id] = true
		table.insert(self.path, id)
		S.conditions.apply(n.effects, self.ctx)
		if n.branches then
			local nxt = nil
			for _, b in n.branches do
				if S.conditions.check(b.condition, self.ctx) then nxt = b.next break end
			end
			id = nxt
			if nxt == nil then self.done = true self.nodeId = nil return end
		else
			return
		end
	end
end

function Cursor:node() return self.nodeId and self.tree.nodes[self.nodeId] end

function Cursor:view()
	local n = self:node()
	if not n then return nil end
	local sp = n.speaker or self.tree.speaker
	local po = n.portrait or self.tree.portrait
	local lines = {}
	local src = n.lines or (if n.text then { n.text } else {})
	for _, l in src do
		if type(l) == "string" then table.insert(lines, { text = interp(l, self.ctx), speaker = sp, portrait = po })
		else table.insert(lines, { text = interp(l.text, self.ctx), speaker = l.speaker or sp, portrait = l.portrait or po }) end
	end
	local choices = nil
	if n.choices then
		choices = {}
		for i, ch in n.choices do
			local ok = S.conditions.check(ch.condition, self.ctx)
			if ok or ch.showLocked then
				table.insert(choices, { text = interp(ch.text, self.ctx), locked = not ok, index = i })
			end
		end
	end
	return { speaker = sp, portrait = po, lines = lines, choices = choices }
end

function Cursor:advance()
	local n = self:node()
	if not n or self.done then return end
	if n.choices then error("dialog: node \"" .. self.nodeId .. "\" needs a choice (cursor:choose(i))", 2) end
	self:_enter(n.next)
end

function Cursor:choose(i: number)
	local v = self:view()
	if not v or not v.choices then error("dialog: node has no choices", 2) end
	local pick = v.choices[i]
	if not pick then error("dialog: no choice " .. tostring(i), 2) end
	if pick.locked then return false end
	local ch = self:node().choices[pick.index]
	if S.events then S.events.emit("dialog_choice", { dialog = self.tree.id, node = self.nodeId, choice = pick.index }) end
	S.conditions.apply(ch.effects, self.ctx)
	self:_enter(ch.next)
	return true
end

-- play(treeId, opts?) renders the tree with the engine's ui.dialog/ui.choice (kit fallback otherwise).
-- opts: { ctx?, onEnd?(cursor), speed?, position?, block?, pause? (default true: core.pause while open) }
-- Returns the cursor. Emits "dialog_started"/"dialog_ended" {dialog}.
function M.play(treeId: string, opts)
	opts = opts or {}
	local c = M.open(treeId, opts.ctx)
	local pauseOn = opts.pause ~= false
	if pauseOn then S.pause.push("dialog", true) end
	S.events.emit("dialog_started", { dialog = treeId })
	local engine = type(ui) == "table" and type(ui.dialog) == "function" and type(ui.choice) == "function" and not opts.fallback
	local function finish()
		if pauseOn then S.pause.pop("dialog") end
		S.events.emit("dialog_ended", { dialog = treeId, path = c.path })
		if opts.onEnd then opts.onEnd(c) end
	end
	local step
	step = function()
		if c.done then finish() return end
		local v = c:view()
		local dopts = { speed = opts.speed, position = opts.position, block = opts.block }
		if v.choices and #v.choices > 0 then
			local pre = table.clone(v.lines)
			local prompt = table.remove(pre) or { text = "", speaker = v.speaker, portrait = v.portrait }
			local labels = {}
			for _, ch in v.choices do table.insert(labels, if ch.locked then "(locked) " .. ch.text else ch.text) end
			local function ask()
				if engine then
					ui.choice(prompt, labels, function(i)
						if not c:choose(i or 1) then step() return end
						step()
					end, dopts)
				else
					S.menus.dialogBox({ prompt }, labels, function(i)
						if not c:choose(i or 1) then step() return end
						step()
					end)
				end
			end
			if #pre > 0 then
				if engine then ui.dialog(pre, dopts).done:connect(ask) else S.menus.dialogBox(pre, nil, ask) end
			else ask() end
		elseif #v.lines > 0 then
			local function nxt() c:advance() step() end
			if engine then ui.dialog(v.lines, dopts).done:connect(nxt) else S.menus.dialogBox(v.lines, nil, nxt) end
		else
			c:advance()
			step()
		end
	end
	step()
	return c
end

function M.serialize()
	local out = {}
	for k in seenSet do table.insert(out, k) end
	table.sort(out)
	return out
end
function M.deserialize(t)
	seenSet = {}
	for _, k in t or {} do seenSet[k] = true end
end
function M.reset() seenSet = {} end
return M
