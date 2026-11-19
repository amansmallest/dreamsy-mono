-- rpg kit: dialog trees (data/dialog/<id>.json) on top of the engine's ui.dialog / ui.choice.
--
--   { "speaker": "Elder Moss", "portrait": "asset:elder_face", "start": "hello",
--     "nodes": {
--       "hello": { "branches": [ { "if": { "flag": "got_starter" }, "goto": "again" } ],
--                  "lines": [ "Ah, {player}!", { "speaker": "Pip", "text": "Hi!" } ],
--                  "effects": [ { "give_item": "tonic", "count": 2 } ],
--                  "choices": [ { "text": "Yes", "goto": "yes" }, { "text": "No", "goto": "no", "if": {...} } ],
--                  "next": "bye" },
--       ... } }
-- Short form (one node): { "speaker": "...", "lines": [...], "effects": [...], "choices": [...] }.
-- Node order: branches (first match jumps) → lines → effects → choices (the last line is the prompt) → next.
-- A choice may carry its own "effects". "goto": "end" (or none) ends the dialog.
local U = require("./util")
local Content = require("./content")
local Logic = require("./logic")
local Events = require("./events")
local R = require("./runtime")

local D = {}
D.active = false
D.depth = 0

local function normalize(def)
	if def.nodes then return def end
	return { speaker = def.speaker, portrait = def.portrait, start = "start", nodes = { start = def } }
end

local function lineOf(l, node, def)
	if type(l) == "string" then
		return { text = Logic.text(l), speaker = node.speaker or def.speaker, portrait = node.portrait or def.portrait }
	end
	if l["if"] ~= nil and not Logic.check(l["if"]) then return nil end
	return { text = Logic.text(l.text or ""), speaker = l.speaker or node.speaker or def.speaker, portrait = l.portrait or node.portrait or def.portrait }
end

local function speed()
	return Content.config.dialog_speed or 45
end

-- show plain lines; done() after the last is dismissed
function D.say(lines, opts, done: (() -> ())?)
	opts = opts or {}
	local norm = {}
	for _, l in U.list(lines) do
		local x = if type(l) == "string" then { text = Logic.text(l), speaker = opts.speaker, portrait = opts.portrait } else l
		table.insert(norm, x)
	end
	if #norm == 0 then
		if done then done() end
		return
	end
	local d = ui.dialog(norm, { speed = speed(), speaker = opts.speaker, portrait = opts.portrait })
	d.done:connect(function()
		U.sfx(Content.config.sfx and Content.config.sfx.select)
		if done then done() end
	end)
end

-- run a dialog tree by id or definition. opts: { speaker, portrait, start = node, npc = def }
-- done(completed: boolean) — false if an effect aborted (lost battle, warp)
function D.run(idOrDef, opts, done: ((boolean) -> ())?)
	opts = opts or {}
	local id = if type(idOrDef) == "string" then idOrDef else (idOrDef.id or "inline")
	local raw = if type(idOrDef) == "string" then Content.dialog[idOrDef] else idOrDef
	if not raw then
		print("[rpg] unknown dialog \"" .. tostring(idOrDef) .. "\" (add data/dialog/" .. tostring(idOrDef) .. ".json)")
		if done then done(true) end
		return
	end
	local def = normalize(raw)
	def = { speaker = opts.speaker or def.speaker, portrait = opts.portrait or def.portrait, start = def.start, nodes = def.nodes }
	D.active = true
	D.depth += 1
	Events.dialogStarted:fire(id)
	local finished = false
	local function finish(ok: boolean)
		if finished then return end
		finished = true
		D.depth -= 1
		if D.depth <= 0 then D.depth = 0 D.active = false end
		Events.dialogEnded:fire(id)
		if done then done(ok) end
	end
	local steps = 0
	local runNode
	runNode = function(name: string?)
		steps += 1
		if steps > 200 or name == nil or name == "end" then return finish(true) end
		local node = def.nodes[name]
		if not node then return finish(true) end
		if node["if"] ~= nil and not Logic.check(node["if"]) then return runNode(node["else"]) end
		for _, b in node.branches or {} do
			if Logic.check(b["if"]) then return runNode(b.goto) end
		end
		local lines = {}
		for _, l in U.list(node.lines or node.text) do
			local x = lineOf(l, node, def)
			if x then table.insert(lines, x) end
		end
		local choices = {}
		for _, c in node.choices or {} do
			if c["if"] == nil or Logic.check(c["if"]) then table.insert(choices, c) end
		end
		local prompt = nil
		if #choices > 0 then
			prompt = (node.prompt and lineOf(node.prompt, node, def)) or table.remove(lines) or { text = "..." }
		end
		local function afterEffects(ok: boolean)
			if not ok then return finish(false) end
			if #choices == 0 then return runNode(node.next) end
			local labels = {}
			for i, c in choices do labels[i] = Logic.text(c.text) end
			ui.choice(prompt.text, labels, function(i: number)
				U.sfx(Content.config.sfx and Content.config.sfx.select)
				local c = choices[i]
				if not c then return finish(true) end
				Logic.run(c.effects, function(ok2)
					if not ok2 then return finish(false) end
					runNode(c.goto)
				end)
			end, { speed = speed(), speaker = prompt.speaker, portrait = prompt.portrait })
		end
		D.say(lines, nil, function()
			Logic.run(node.effects, afterEffects)
		end)
	end
	runNode(opts.start or def.start or (if def.nodes.start then "start" else U.keys(def.nodes)[1]))
end

return D
