-- rpg kit: quests (data/quests/<id>.json). State per quest in the save: { state, step, counters }.
-- Objectives of the current step are re-checked whenever something relevant happens; when all are
-- met the step completes (its "effects" run) and the next step starts; after the last step the
-- quest completes and grants "rewards".
local U = require("./util")
local Content = require("./content")
local State = require("./state")
local Events = require("./events")
local Logic = require("./logic")
local R = require("./runtime")

local Q = {}

local function rec(id: string)
	return State.get().quests[id]
end

function Q.def(id: string)
	local q = Content.quests[id]
	if not q then error("rpg: unknown quest \"" .. tostring(id) .. "\" (add data/quests/" .. tostring(id) .. ".json)", 2) end
	return q
end

function Q.state(id: string): string
	local r = rec(id)
	return if r then r.state else "not_started"
end

function Q.stepId(id: string): string?
	local r = rec(id)
	if not r or r.state ~= "active" then return nil end
	local s = Q.def(id).steps[r.step]
	return s and s.id
end

function Q.currentStep(id: string)
	local r = rec(id)
	if not r or r.state ~= "active" then return nil end
	return Q.def(id).steps[r.step]
end

local checking = false
local dirty = false

function Q.start(id: string): boolean
	local q = Q.def(id)
	if rec(id) then return false end
	State.get().quests[id] = { state = "active", step = 1, counters = {} }
	if not q.silent then R.notify(U.format(Content.config.text and Content.config.text.quest_started or "New quest: {quest}", { quest = q.name })) end
	Events.questUpdated:fire(id, "active", q.steps[1] and q.steps[1].id)
	Q.checkAll()
	return true
end

local function grant(rewards)
	if not rewards then return end
	if rewards.money then State.addMoney(rewards.money) end
	local items = rewards.items
	if items then
		if #items > 0 then
			for _, e in items do State.give(e.item, e.count or 1) end
		else
			for idv, n in items do State.give(idv, n) end
		end
	end
	for _, f in rewards.flags or {} do State.setFlag(f, true) end
	if rewards.creature then State.giveCreature(rewards.creature.creature, rewards.creature.level or 5) end
	if rewards.effects then Logic.run(rewards.effects) end
end

function Q.complete(id: string)
	local q = Q.def(id)
	local r = rec(id)
	if r and r.state == "done" then return end
	if not r then
		r = { state = "active", step = #q.steps, counters = {} }
		State.get().quests[id] = r
	end
	r.state = "done"
	r.step = #q.steps + 1
	grant(q.rewards)
	if not q.silent then
		R.notify(U.format(Content.config.text and Content.config.text.quest_done or "Quest complete: {quest}", { quest = q.name }))
		U.sfx(Content.config.sfx and Content.config.sfx.quest)
	end
	Events.questUpdated:fire(id, "done", nil)
	Events.questCompleted:fire(id)
end

-- finish the current step (runs its effects) and move on
function Q.advance(id: string)
	local q = Q.def(id)
	local r = rec(id)
	if not r then
		Q.start(id)
		r = rec(id)
	end
	if r.state ~= "active" then return end
	local step = q.steps[r.step]
	if step then
		-- consume delivered items
		for _, o in step.objectives do
			if o.type == "item" and o.consume then State.take(o.item, o.count or 1) end
		end
		if step.effects then Logic.run(step.effects) end
	end
	r.step += 1
	r.counters = {}
	if r.step > #q.steps then
		Q.complete(id)
	else
		Events.questUpdated:fire(id, "active", q.steps[r.step].id)
	end
end

-- progress of one objective: have, need
function Q.objectiveProgress(o, r): (number, number)
	local need = o.count or 1
	local t = o.type
	local d = State.get()
	if t == "item" then return math.min(State.count(o.item), need), need
	elseif t == "flag" then return (if d.flags[o.flag] then 1 else 0), 1
	elseif t == "visit" then return (if (r.counters["visit:" .. o.map] or 0) > 0 or d.player.map == o.map then 1 else 0), 1
	elseif t == "talk" then return math.min(r.counters["talk:" .. o.npc] or 0, 1), 1
	elseif t == "defeat" and o.trainer then return (if d.flags["beat_" .. o.trainer] then 1 else 0), 1
	elseif t == "defeat" or t == "catch" then return math.min(r.counters[t .. ":" .. (o.creature or o.creature_type or "*")] or 0, need), need
	elseif t == "party_size" then return math.min(#d.party, need), need
	elseif t == "level" then
		local best = 0
		for _, m in d.party do best = math.max(best, m.level) end
		return math.min(best, o.level or need), o.level or need
	elseif t == "money" then return math.min(d.money, o.amount or need), o.amount or need
	elseif t == "condition" then return (if Logic.check(o["if"]) then 1 else 0), 1
	elseif t == "custom" then
		local hook = Events.hooks.objective[o.id or ""]
		if hook then return math.min(hook(o, r) or 0, need), need end
		return 0, need
	end
	return 0, need
end

local function stepDone(q, r): boolean
	local step = q.steps[r.step]
	if not step then return true end
	if #step.objectives == 0 then return false end -- manual: advanced by an effect
	for _, o in step.objectives do
		local have, need = Q.objectiveProgress(o, r)
		if have < need then return false end
	end
	return true
end

function Q.checkAll()
	if checking then
		dirty = true
		return
	end
	checking = true
	for _ = 1, 20 do
		dirty = false
		-- auto-start
		for id, q in Content.quests do
			if not rec(id) and q.start_if ~= nil and Logic.check(q.start_if) then Q.start(id) end
		end
		for id, q in Content.quests do
			local r = rec(id)
			if r and r.state == "active" and q.steps[r.step] and q.steps[r.step].auto ~= false and stepDone(q, r) then
				Q.advance(id)
				dirty = true
			end
		end
		if not dirty then break end
	end
	checking = false
end

local function bump(key: string, n: number?)
	for id, r in State.get().quests do
		if r.state == "active" then
			r.counters[key] = (r.counters[key] or 0) + (n or 1)
		end
	end
end

local function bumpCreature(kind: string, mon)
	bump(kind .. ":*")
	bump(kind .. ":" .. mon.id)
	local sp = Content.creatures[mon.id]
	for _, t in (sp and sp.types) or {} do bump(kind .. ":" .. t) end
end

-- quest log rows: { id, name, description, state, steps = { { text, done, objectives = { {text, have, need} } } } }
function Q.log()
	local out = {}
	for id, q in Content.quests do
		local r = rec(id)
		if r and not q.hidden then
			local row = { id = id, name = q.name, description = q.description or "", state = r.state, steps = {}, order = q.order or 0 }
			for i, s in q.steps do
				if i <= r.step then
					local objs = {}
					for _, o in s.objectives do
						local have, need = o.count or 1, o.count or 1
						if i == r.step and r.state == "active" then have, need = Q.objectiveProgress(o, r) end
						table.insert(objs, { text = o.text, have = have, need = need })
					end
					table.insert(row.steps, { id = s.id, text = Logic.text(s.text or s.id), done = i < r.step or r.state == "done", objectives = objs })
				end
			end
			table.insert(out, row)
		end
	end
	table.sort(out, function(a, b)
		if (a.state == "active") ~= (b.state == "active") then return a.state == "active" end
		if a.order ~= b.order then return a.order < b.order end
		return a.name < b.name
	end)
	return out
end

-- start quests with "auto_start": true (new game)
function Q.autoStart()
	for id, q in Content.quests do
		if q.auto_start and not rec(id) then Q.start(id) end
	end
end

local wired = false
function Q.wire()
	if wired then return end
	wired = true
	Logic.questState = Q.state
	Logic.questStep = Q.stepId
	Logic.quests = Q
	local function chk() Q.checkAll() end
	Events.itemObtained:connect(chk)
	Events.flagSet:connect(chk)
	Events.moneyChanged:connect(chk)
	Events.levelUp:connect(chk)
	Events.creatureObtained:connect(chk)
	Events.varSet:connect(chk)
	Events.creatureCaught:connect(function(mon)
		bumpCreature("catch", mon)
		Q.checkAll()
	end)
	Events.trainerDefeated:connect(chk)
	Events.mapEntered:connect(function(map)
		bump("visit:" .. map)
		Q.checkAll()
	end)
	Events.interacted:connect(function(kind, def)
		if kind == "npc" and def and def.id then
			bump("talk:" .. def.id)
			Q.checkAll()
		end
	end)
	Events.battleEnded:connect(function(b, result)
		if b.kind == "wild" and result == "win" then
			bumpCreature("defeat", b:active(2))
		end
		Q.checkAll()
	end)
end

return Q
