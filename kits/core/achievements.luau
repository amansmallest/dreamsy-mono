--!nonstrict
-- Achievements (content kind "achievements", data/achievements/*.json).
-- { id, name, description?, icon?, hidden?, condition? , event?, match?, count?, rewards? (effects) }
-- Unlocks when `condition` holds, or after `count` (default 1) matching `event`s. Emits "achievement_unlocked" {achievement}.
local S = require("./shared")
local Content = require("./content")
local M = {}
local unlocked: { [string]: boolean } = {}
local counts: { [string]: number } = {}

function M.isUnlocked(id: string) return unlocked[id] == true end
function M.unlock(id: string): boolean
	local d = Content.require("achievements", id)
	if unlocked[id] then return false end
	unlocked[id] = true
	S.conditions.apply(d.rewards)
	S.events.emit("achievement_unlocked", { achievement = id })
	return true
end
-- progress(id) -> count, target
function M.progress(id: string)
	local d = Content.require("achievements", id)
	if unlocked[id] then return d.count or 1, d.count or 1 end
	if d.event then return counts[id] or 0, d.count or 1 end
	return (if S.conditions.check(d.condition) then 1 else 0), 1
end
function M.list(includeHidden: boolean?)
	local out = {}
	for _, d in Content.all("achievements") do
		if includeHidden or not d.hidden or unlocked[d.id] then
			table.insert(out, { id = d.id, def = d, unlocked = unlocked[d.id] == true })
		end
	end
	return out
end

local function matches(m, data)
	if m == nil then return true end
	if type(data) ~= "table" then return false end
	for k, v in m do if data[k] ~= v then return false end end
	return true
end
function M._onEvent(name, data)
	if name == "achievement_unlocked" then return end
	for _, d in Content.all("achievements") do
		if not unlocked[d.id] then
			if d.event then
				if d.event == name and matches(d.match, data) then
					local amt = if type(data) == "table" and type(data.count) == "number" then data.count else 1
					counts[d.id] = (counts[d.id] or 0) + amt
				end
				if (counts[d.id] or 0) >= (d.count or 1) and S.conditions.check(d.condition) then M.unlock(d.id) end
			elseif d.condition ~= nil and S.conditions.check(d.condition) then
				M.unlock(d.id)
			end
		end
	end
end
function M.serialize() return { u = table.clone(unlocked), c = table.clone(counts) } end
function M.deserialize(t)
	t = t or {}
	unlocked = table.clone(t.u or {})
	counts = table.clone(t.c or {})
end
function M.reset() unlocked = {} counts = {} end
return M
