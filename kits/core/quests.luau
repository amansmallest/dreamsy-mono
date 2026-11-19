--!nonstrict
-- Quests (content kind "quests", data/quests/*.json).
-- { id, title, description?, giver?, requires? (condition), autoStart?, repeatable?, hidden?,
--   steps = { { id, text, objectives = { { id, text?, event?, match?, count?, condition? } }, effects? } },
--   rewards? (effects) }
-- Objective: `event` + optional `match` (fields equal in the event data) counts up to `count` (default 1);
-- amount per event = data.count or 1. `condition` objectives are done while the condition holds
-- (re-checked on every event). Steps run in order; the quest completes after the last step.
-- Events: quest_started, quest_step {quest, step}, quest_progress {quest, objective, count, target},
--         quest_completed, quest_failed — all with data.quest = id.
local S = require("./shared")
local Content = require("./content")
local M = {}
local state: { [string]: any } = {} -- id -> { status, step, counts, done = times completed }
local busy, again = false, false

local function q(id) return Content.require("quests", id) end
local function st(id)
	local s = state[id]
	if not s then s = { status = "inactive", step = 0, counts = {}, done = 0 } state[id] = s end
	return s
end
local function emit(name, data) if S.events then S.events.emit(name, data) end end

function M.status(id: string): string
	q(id)
	return if state[id] then state[id].status else "inactive"
end
function M.isActive(id) return M.status(id) == "active" end
function M.isDone(id) return M.status(id) == "done" end
function M.timesCompleted(id) return state[id] and state[id].done or 0 end
function M.step(id: string)
	local s = state[id]
	if not s or s.status ~= "active" then return nil end
	return q(id).steps[s.step]
end
function M.canStart(id: string): boolean
	local d = q(id)
	local s = M.status(id)
	if s == "active" then return false end
	if s == "done" and not d.repeatable then return false end
	if s == "failed" and not d.retryable and not d.repeatable then return false end
	return S.conditions.check(d.requires)
end

local function objDone(s, o)
	if o.condition ~= nil and o.event == nil then return S.conditions.check(o.condition) end
	local ok = (s.counts[o.id] or 0) >= (o.count or 1)
	if ok and o.condition ~= nil then ok = S.conditions.check(o.condition) end
	return ok
end

-- progress(id) -> { {id, text, count, target, done} } for the current step
function M.progress(id: string)
	local s, step = state[id], M.step(id)
	if not step then return {} end
	local out = {}
	for _, o in step.objectives or {} do
		local target = if o.event then (o.count or 1) else 1
		local count = if o.event then math.min(s.counts[o.id] or 0, target) else (if objDone(s, o) then 1 else 0)
		table.insert(out, { id = o.id, text = o.text or step.text, count = count, target = target, done = objDone(s, o) })
	end
	return out
end

local evaluate
function M.start(id: string, force: boolean?): boolean
	local d = q(id)
	if not force and not M.canStart(id) then return false end
	if not d.steps or #d.steps == 0 then error("quest \"" .. id .. "\" has no steps", 2) end
	local s = st(id)
	s.status, s.step, s.counts = "active", 1, {}
	emit("quest_started", { quest = id })
	emit("quest_step", { quest = id, step = d.steps[1].id })
	evaluate()
	return true
end

local function finish(id)
	local d, s = q(id), st(id)
	s.status = "done"
	s.done += 1
	s.step, s.counts = 0, {}
	S.conditions.apply(d.rewards)
	emit("quest_completed", { quest = id })
end

function M.advance(id: string)
	local d, s = q(id), st(id)
	if s.status ~= "active" then return false end
	local step = d.steps[s.step]
	S.conditions.apply(step.effects)
	if s.status ~= "active" then return true end -- effects may have finished/failed it
	if s.step >= #d.steps then finish(id) return true end
	s.step += 1
	s.counts = {}
	emit("quest_step", { quest = id, step = d.steps[s.step].id })
	return true
end
function M.complete(id: string)
	local s = st(id)
	if s.status == "done" then return false end
	finish(id)
	return true
end
function M.fail(id: string)
	local s = st(id)
	if s.status ~= "active" then return false end
	s.status = "failed"
	emit("quest_failed", { quest = id })
	return true
end
function M.reset(id: string) state[id] = nil end

-- list(status?) -> defs with that status ("inactive" | "active" | "done" | "failed"; nil = all), in content order
function M.list(status: string?)
	local out = {}
	for _, d in Content.all("quests") do
		if status == nil or M.status(d.id) == status then table.insert(out, d) end
	end
	return out
end
function M.available()
	local out = {}
	for _, d in Content.all("quests") do if M.canStart(d.id) and not d.hidden then table.insert(out, d) end end
	return out
end

local function matches(m, data)
	if m == nil then return true end
	if type(data) ~= "table" then return false end
	for k, v in m do if data[k] ~= v then return false end end
	return true
end

-- count event objectives, then (re)evaluate step completion + autoStart
local function onEvent(name, data)
	for id, s in table.clone(state) do
		if s.status == "active" then
			local step = q(id).steps[s.step]
			for _, o in step and step.objectives or {} do
				if o.event == name and matches(o.match, data) then
					local target = o.count or 1
					local before = s.counts[o.id] or 0
					if before < target then
						local amt = if type(data) == "table" and type(data.count) == "number" and o.perEvent ~= true then data.count else 1
						s.counts[o.id] = math.min(target, before + amt)
						emit("quest_progress", { quest = id, objective = o.id, count = s.counts[o.id], target = target })
					end
				end
			end
		end
	end
	evaluate()
end

evaluate = function()
	if busy then again = true return end
	busy = true
	local guard = 0
	repeat
		again = false
		guard += 1
		for _, d in Content.all("quests") do
			local s = state[d.id]
			if s and s.status == "active" then
				local step = d.steps[s.step]
				local all = true
				for _, o in step.objectives or {} do if not objDone(s, o) then all = false break end end
				if all and step.objectives and #step.objectives > 0 then M.advance(d.id) again = true end
			elseif d.autoStart and M.canStart(d.id) then
				M.start(d.id)
				again = true
			end
		end
	until not again or guard > 32
	busy = false
end
M.evaluate = function() evaluate() end
M._onEvent = onEvent

function M.serialize()
	local out = {}
	for id, s in state do
		out[id] = { s = s.status, n = s.step, c = table.clone(s.counts), d = s.done }
	end
	return out
end
function M.deserialize(t)
	state = {}
	for id, v in t or {} do
		if Content.get("quests", id) then
			state[id] = { status = v.s, step = v.n, counts = v.c or {}, done = v.d or 0 }
		end
	end
end
function M.resetAll() state = {} end
return M
